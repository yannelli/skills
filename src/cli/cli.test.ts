import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'src', 'cli.ts');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

type Run = { code: number; stdout: string; stderr: string };

type Fixture = { home: string; project: string };

/**
 * A whole fake machine: YARD_HOME points the environment layer at it, so these
 * runs never read or write the developer's real client config.
 */
async function withFixture(run: (fixture: Fixture, exec: (args: string[]) => Promise<Run>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-cli-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');

  await mkdir(path.join(home, '.claude', 'skills', 'demo'), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({}, null, 2)}\n`);
  await writeFile(
    path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'),
    ['---', 'name: demo', 'description: demo skill for the cli test', '---', '', 'body', ''].join('\n')
  );
  await writeFile(
    path.join(project, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['-e', ''] } } }, null, 2)}\n`
  );

  const exec = (args: string[]): Promise<Run> =>
    new Promise((resolve, reject) => {
      // node --import rather than npx, so npm's own chatter never lands on the
      // stderr these tests assert about. tsx is resolved to an absolute path
      // from this file, because the child runs with cwd inside the fixture
      // where a bare "tsx" specifier has no node_modules to resolve against.
      const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], {
        env: { ...process.env, YARD_HOME: home, NO_COLOR: '1' },
        // In the fixture project, so the --project default is exercised too.
        cwd: project
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });

  try {
    await run({ home, project }, exec);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('no arguments prints usage and exits 0', async () => {
  await withFixture(async (_fixture, exec) => {
    const result = await exec([]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /usage: yard <command>/);
  });
});

test('an unknown verb prints usage to stderr and exits 1', async () => {
  await withFixture(async (_fixture, exec) => {
    const result = await exec(['wat']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown command "wat"/);
  });
});

test('scan --json is parseable and lists what the client loads', async () => {
  await withFixture(async (_fixture, exec) => {
    // No --project: this is the working-directory default.
    const result = await exec(['scan', '--json']);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout) as {
      clients: string[];
      items: Array<{ kind: string; name: string }>;
      counts: Record<string, Record<string, number>>;
    };
    assert.deepEqual(payload.clients, ['claude']);
    assert.ok(payload.items.some((item) => item.kind === 'skill' && item.name === 'demo'));
    assert.equal(payload.counts.claude?.skill, 1);
  });
});

test('scan --kind filters, and the default view is an aligned table', async () => {
  await withFixture(async (fixture, exec) => {
    const result = await exec(['scan', '--kind=skill', `--project=${fixture.project}`]);
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split('\n');
    assert.ok(lines.some((line) => line.startsWith('kind ')), 'expected an inventory table header');
    assert.ok(lines.some((line) => line.includes('demo')));
    assert.equal(lines.some((line) => line.includes('mcp   ')), false, 'mcp rows should be filtered out');
  });
});

test('context ends with the command that turns the top offender off', async () => {
  await withFixture(async (fixture, exec) => {
    const result = await exec(['context', `--project=${fixture.project}`]);
    assert.equal(result.code, 0);
    const lines = result.stdout.trimEnd().split('\n');
    assert.match(lines[0] ?? '', /estimated tokens per turn/);
    assert.match(lines.at(-1) ?? '', /^next: yard /);
  });
});

test('context --json reports a total and a breakdown', async () => {
  await withFixture(async (fixture, exec) => {
    const result = await exec(['context', '--json', `--project=${fixture.project}`]);
    const payload = JSON.parse(result.stdout) as { total: number; byKind: Record<string, number> };
    assert.ok(payload.total > 0);
    assert.ok((payload.byKind.skill ?? 0) > 0);
  });
});

test('doctor exits 0 when nothing is an error', async () => {
  await withFixture(async (fixture, exec) => {
    const result = await exec(['doctor', '--json', `--project=${fixture.project}`]);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout) as { diagnoses: Array<{ severity: string }> };
    assert.equal(payload.diagnoses.some((item) => item.severity === 'error'), false);
  });
});

test('a mutation with --dry-run reports the change and writes nothing', async () => {
  await withFixture(async (fixture, exec) => {
    const settings = path.join(fixture.home, '.claude', 'settings.json');
    const before = await readFile(settings, 'utf8');

    const result = await exec(['skill', 'demo', 'off', '--dry-run', `--project=${fixture.project}`]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /dry run/);
    assert.match(result.stdout, /demo → off/);
    assert.equal(await readFile(settings, 'utf8'), before);
  });
});

test('a mutation writes the settings file it names', async () => {
  await withFixture(async (fixture, exec) => {
    const result = await exec(['skill', 'demo', 'off', `--project=${fixture.project}`]);
    assert.equal(result.code, 0);
    const settings = JSON.parse(await readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf8')) as {
      skillOverrides?: Record<string, string>;
    };
    assert.equal(settings.skillOverrides?.demo, 'off');
  });
});

test('an unknown leading flag is an error, not a server on the default port', async () => {
  await withFixture(async (_fixture, exec) => {
    // The legacy surface is --stdio and --port=<port>. Anything else used to
    // fall through to `serve`, so a typo bound port 4372 and hung.
    const result = await exec(['--jsonn']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown flag "--jsonn"/);
  });
});

test('--client narrows the search instead of skipping it', async () => {
  await withFixture(async (fixture, exec) => {
    const settings = path.join(fixture.home, '.claude', 'settings.json');
    const before = await readFile(settings, 'utf8');

    // Without the existence check this wrote skillOverrides for a skill that
    // does not exist, and reported success.
    const result = await exec(['skill', 'ghost', 'off', '--client=claude', `--project=${fixture.project}`]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /skill "ghost" not found in claude/);
    assert.equal(await readFile(settings, 'utf8'), before);
  });
});

test('an unknown name fails with one line on stderr and exit 1', async () => {
  await withFixture(async (fixture, exec) => {
    const result = await exec(['mcp', 'disable', 'nope', `--project=${fixture.project}`]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.match(result.stderr, /^yard: /);
  });
});
