import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { duplicateSkills, scanEnvironment } from './inventory.js';
import type { Client } from './types.js';

type Fixture = { home: string; project: string };

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`;
}

async function writeTextFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

/** One small but real install of each client, so a merge has something to merge. */
async function buildFixture(root: string): Promise<Fixture> {
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');

  await writeTextFile(path.join(home, '.claude', 'settings.json'), '{}\n');
  await writeTextFile(path.join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), skill('alpha', 'A Claude skill'));
  await writeTextFile(
    path.join(home, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews diffs\n---\n\nReview.\n'
  );
  await writeTextFile(path.join(home, '.claude', 'CLAUDE.md'), 'Claude memory.\n');

  await writeTextFile(
    path.join(home, '.codex', 'config.toml'),
    '[mcp_servers.beta]\ncommand = "node"\nargs = ["beta.js"]\n'
  );
  await writeTextFile(path.join(home, '.codex', 'skills', 'beta', 'SKILL.md'), skill('beta', 'A Codex skill'));
  await writeTextFile(path.join(home, '.codex', 'skills', 'parked', 'SKILL.md'), skill('parked', 'The live copy'));
  await writeTextFile(
    path.join(home, '.codex', 'skills.disabled', 'parked', 'SKILL.md'),
    skill('parked', 'The retired copy')
  );

  await writeTextFile(path.join(home, '.cursor', 'skills', 'twin', 'SKILL.md'), skill('twin', 'The user copy'));
  await writeTextFile(
    path.join(project, '.cursor', 'skills', 'twin', 'SKILL.md'),
    skill('twin', 'The project copy')
  );
  // Codex's project memory file. It stays on disk when Codex is uninstalled,
  // which is what makes the not-installed case worth asserting on.
  await writeTextFile(path.join(project, 'AGENTS.md'), 'Project instructions.\n');

  return { home, project };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-inventory-'));
  const previous = process.env.YARD_HOME;
  try {
    const fixture = await buildFixture(root);
    process.env.YARD_HOME = fixture.home;
    await run(fixture);
  } finally {
    if (previous === undefined) {
      delete process.env.YARD_HOME;
    } else {
      process.env.YARD_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Make one client's scan reject.
 *
 * Every scanner swallows filesystem faults on purpose, so a broken tree is not
 * enough to reach the containment path — the last thing that can still throw is
 * resolving the home directory. `home()` re-reads YARD_HOME on every call and
 * the client that asked for it is on the stack, which is enough to fail exactly
 * one of the three and leave the others alone.
 */
async function withFailingClient<T>(client: Client, run: () => Promise<T>): Promise<T> {
  const real = process.env;
  const trap = new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'YARD_HOME' && new Error().stack?.includes(`${client}.ts`)) {
        throw new Error(`${client} home directory is unreadable`);
      }
      return Reflect.get(target, property, receiver);
    }
  });
  Object.defineProperty(process, 'env', { value: trap, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'env', { value: real, configurable: true, writable: true });
  }
}

test('merges every installed client into one sorted inventory', async () => {
  await withFixture(async ({ project }) => {
    const inventory = await scanEnvironment(project);

    assert.equal(inventory.projectRoot, project);
    assert.deepEqual(inventory.clients, ['claude', 'codex', 'cursor']);

    const ids = inventory.skills.map((entry) => entry.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
    assert.ok(ids.includes('claude:user:alpha'));
    assert.ok(ids.includes('codex:user:beta'));
    assert.ok(ids.includes('cursor:user:twin'));
    assert.ok(ids.includes('cursor:project:twin'));

    assert.ok(inventory.agents.some((entry) => entry.id === 'claude:user:reviewer'));
    assert.ok(inventory.mcpServers.some((entry) => entry.id === 'codex:user:beta'));
    assert.ok(inventory.memory.some((entry) => entry.client === 'claude'));
    assert.ok(inventory.memory.some((entry) => entry.client === 'codex'));
    assert.deepEqual(inventory.warnings, []);
  });
});

test('scanning a subset leaves the other clients out entirely', async () => {
  await withFixture(async ({ project }) => {
    const inventory = await scanEnvironment(project, { clients: ['cursor'] });
    assert.deepEqual(inventory.clients, ['cursor']);
    assert.deepEqual(
      inventory.skills.map((entry) => entry.id),
      ['cursor:project:twin', 'cursor:user:twin']
    );
  });
});

test('a client that is not installed contributes nothing and is absent from clients', async () => {
  await withFixture(async ({ home, project }) => {
    await rm(path.join(home, '.codex'), { recursive: true, force: true });

    const inventory = await scanEnvironment(project);
    assert.deepEqual(inventory.clients, ['claude', 'cursor']);

    const fromCodex = [
      ...inventory.skills,
      ...inventory.plugins,
      ...inventory.mcpServers,
      ...inventory.hooks,
      ...inventory.agents,
      ...inventory.commands,
      ...inventory.memory
    ].filter((entry) => entry.client === 'codex');
    // AGENTS.md is still sitting in the project; without the client it is not
    // loaded by anything, so it must not be billed to one.
    assert.deepEqual(fromCodex, []);
    assert.ok(!inventory.warnings.some((warning) => warning.client === 'codex'));
    assert.ok(inventory.skills.some((entry) => entry.id === 'claude:user:alpha'));
  });
});

test('warnings from every client are merged', async () => {
  await withFixture(async ({ home, project }) => {
    const claudeSettings = path.join(home, '.claude', 'settings.json');
    const codexConfig = path.join(home, '.codex', 'config.toml');
    const cursorMcp = path.join(home, '.cursor', 'mcp.json');
    await writeTextFile(claudeSettings, '{ "hooks": ');
    await writeTextFile(codexConfig, '[[[nope\n');
    await writeTextFile(cursorMcp, '{ "mcpServers": ');

    const inventory = await scanEnvironment(project);

    assert.ok(
      inventory.warnings.some(
        (warning) =>
          warning.client === 'claude' &&
          warning.file === claudeSettings &&
          warning.message.includes('invalid JSON')
      )
    );
    assert.ok(
      inventory.warnings.some(
        (warning) =>
          warning.client === 'codex' && warning.file === codexConfig && warning.message.includes('TOML')
      )
    );
    assert.ok(
      inventory.warnings.some(
        (warning) =>
          warning.client === 'cursor' &&
          warning.file === cursorMcp &&
          warning.message.includes('invalid JSON')
      )
    );

    // Three broken files, and every skill still came back.
    assert.deepEqual(inventory.clients, ['claude', 'codex', 'cursor']);
    assert.ok(inventory.skills.some((entry) => entry.id === 'claude:user:alpha'));
    assert.ok(inventory.skills.some((entry) => entry.id === 'codex:user:beta'));
    assert.ok(inventory.skills.some((entry) => entry.id === 'cursor:user:twin'));
  });
});

test('one client failing outright does not blank the others', async () => {
  await withFixture(async ({ project }) => {
    const inventory = await withFailingClient('codex', () => scanEnvironment(project));

    assert.deepEqual(inventory.clients, ['claude', 'cursor']);
    assert.ok(inventory.skills.some((entry) => entry.id === 'claude:user:alpha'));
    assert.ok(inventory.skills.some((entry) => entry.id === 'cursor:user:twin'));
    assert.ok(inventory.agents.some((entry) => entry.id === 'claude:user:reviewer'));
    assert.ok(!inventory.skills.some((entry) => entry.client === 'codex'));

    const failure = inventory.warnings.find((warning) => warning.client === 'codex');
    assert.ok(failure, 'the failure must be reported, not swallowed');
    assert.ok(failure.message.startsWith('scan failed:'));
    assert.ok(failure.message.includes('codex home directory is unreadable'));
  });
});

test('duplicateSkills finds a name claimed twice and ignores disabled claims', async () => {
  await withFixture(async ({ project }) => {
    const inventory = await scanEnvironment(project);

    assert.deepEqual(duplicateSkills(inventory), [
      { name: 'cursor:twin', ids: ['cursor:project:twin', 'cursor:user:twin'] }
    ]);

    // `parked` is also claimed twice, but one of the two sits in
    // skills.disabled and so never competes for the name.
    const parked = inventory.skills.filter((entry) => entry.qualifiedName === 'parked');
    assert.equal(parked.length, 2);
    assert.deepEqual(
      parked.map((entry) => entry.visibility).sort(),
      ['off', 'on']
    );
  });
});
