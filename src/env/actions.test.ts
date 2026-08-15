import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  mcpActionBlocked,
  pluginActionBlocked,
  setMcpEnabled,
  setPluginEnabled,
  setSkillEnabled,
  setSkillVisibility,
  skillActionBlocked
} from './actions.js';
import { scanEnvironment } from './inventory.js';
import type { Client, McpEntry, PluginEntry, SkillEntry } from './types.js';

/**
 * Coverage for the orchestration layer itself — `resolveEntry`'s id/name
 * resolution, the client/origin action matrix, and postcondition
 * verification — as opposed to the per-client file writers, which
 * claude.test.ts / codex.test.ts / cursor.test.ts already cover. Every
 * end-to-end test here goes through a real `scanEnvironment`, the same as
 * the HTTP API does, rather than a hand-built `Inventory`: the defect this
 * layer exists to catch is a mismatch between what a write *reports* and
 * what a fresh scan actually sees, and a synthetic inventory cannot see that.
 */

type Fixture = { home: string; project: string };

async function write(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nBody.\n`;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-actions-'));
  const fixture: Fixture = { home: path.join(dir, 'home'), project: path.join(dir, 'project') };
  const previous = process.env.YARD_HOME;
  process.env.YARD_HOME = fixture.home;
  try {
    await mkdir(fixture.home, { recursive: true });
    await mkdir(fixture.project, { recursive: true });
    await run(fixture);
  } finally {
    if (previous === undefined) {
      delete process.env.YARD_HOME;
    } else {
      process.env.YARD_HOME = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The same plugin, "toolkit" — with a plugin skill "beta" and a plugin MCP
 * server "ops" — installed for all three clients, plus a standalone skill
 * "alpha" and a standalone MCP server "docs" for each. Same names across
 * clients on purpose: it is what lets one fixture exercise id-vs-name
 * resolution (a bare name is ambiguous across clients; an id never is) and
 * every cell of the action matrix (each client treats its own copy
 * differently) without hand-building an Inventory.
 */
async function buildMatrixFixture(fixture: Fixture): Promise<void> {
  await buildClaudeMatrix(fixture);
  await buildCodexMatrix(fixture);
  await buildCursorMatrix(fixture);
}

async function buildClaudeMatrix({ home, project }: Fixture): Promise<void> {
  const claude = path.join(home, '.claude');
  const pluginRoot = path.join(claude, 'plugins', 'cache', 'acme', 'toolkit');
  const soloRoot = path.join(claude, 'plugins', 'cache', 'acme', 'solo');

  await write(path.join(claude, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha'));

  await writeJson(path.join(claude, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'toolkit@acme': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }],
      'solo@acme': [{ scope: 'user', installPath: soloRoot, version: '1.0.0' }]
    }
  });
  await writeJson(path.join(claude, 'settings.json'), {
    enabledPlugins: { 'toolkit@acme': true, 'solo@acme': true }
  });
  await writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), {
    name: 'toolkit',
    description: 'Shared toolkit plugin.',
    version: '1.0.0'
  });
  await write(path.join(pluginRoot, 'skills', 'beta', 'SKILL.md'), skillMd('beta'));
  await writeJson(path.join(pluginRoot, '.mcp.json'), {
    mcpServers: { ops: { command: 'node', args: ['ops.js'] } }
  });

  // Claude-only, so a bare-name lookup scoped to another client can report
  // "not found in codex — it is in claude" instead of "not found anywhere".
  await writeJson(path.join(soloRoot, '.claude-plugin', 'plugin.json'), {
    name: 'solo',
    description: 'Claude-only plugin.',
    version: '1.0.0'
  });
  await write(path.join(soloRoot, 'skills', 'gamma', 'SKILL.md'), skillMd('gamma'));

  await writeJson(path.join(home, '.claude.json'), {
    mcpServers: { docs: { command: 'node', args: ['docs.js'] } }
  });

  // Two scopes of the same bare skill name, within one client, so a
  // client-scoped-but-not-id-scoped lookup is still ambiguous.
  await write(path.join(claude, 'skills', 'dup', 'SKILL.md'), skillMd('dup'));
  await write(path.join(project, '.claude', 'skills', 'dup', 'SKILL.md'), skillMd('dup'));
}

async function buildCodexMatrix({ home }: Fixture): Promise<void> {
  const codex = path.join(home, '.codex');
  await write(
    path.join(codex, 'config.toml'),
    ['[mcp_servers.docs]', 'command = "node"', 'args = ["docs.js"]', ''].join('\n')
  );
  await write(path.join(codex, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha'));

  const pluginRoot = path.join(codex, 'plugins', 'cache', 'acme', 'toolkit', '1.0.0');
  await writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'toolkit',
    version: '1.0.0',
    description: 'Shared toolkit plugin.',
    mcpServers: './.mcp.json'
  });
  await write(path.join(pluginRoot, 'skills', 'beta', 'SKILL.md'), skillMd('beta'));
  await writeJson(path.join(pluginRoot, '.mcp.json'), {
    mcpServers: { ops: { command: 'node', args: ['ops.js'] } }
  });
}

async function buildCursorMatrix({ home }: Fixture): Promise<void> {
  const cursor = path.join(home, '.cursor');
  await writeJson(path.join(cursor, 'mcp.json'), {
    mcpServers: { docs: { command: 'node', args: ['docs.js'] } }
  });
  await write(path.join(cursor, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha'));

  const pluginRoot = path.join(cursor, 'plugins', 'cache', 'acme', 'toolkit', 'sha256-abc');
  await writeJson(path.join(pluginRoot, '.cursor-plugin', 'plugin.json'), {
    name: 'toolkit',
    version: '1.0.0',
    description: 'Shared toolkit plugin.',
    mcpServers: { ops: { command: 'node', args: ['ops.js'] } }
  });
  await write(path.join(pluginRoot, 'skills', 'beta', 'SKILL.md'), skillMd('beta'));
}

function findSkill(
  entries: SkillEntry[],
  client: Client,
  scope: string,
  qualifiedName: string
): SkillEntry {
  const entry = entries.find(
    (item) => item.client === client && item.scope === scope && item.qualifiedName === qualifiedName
  );
  assert.ok(entry, `expected a ${client}/${scope} skill "${qualifiedName}" in the fixture`);
  return entry;
}

function findMcp(entries: McpEntry[], client: Client, name: string): McpEntry {
  const entry = entries.find((item) => item.client === client && item.name === name);
  assert.ok(entry, `expected a ${client} mcp server "${name}" in the fixture`);
  return entry;
}

function findPlugin(entries: PluginEntry[], client: Client, name: string): PluginEntry {
  const entry = entries.find((item) => item.client === client && item.name === name);
  assert.ok(entry, `expected a ${client} plugin "${name}" in the fixture`);
  return entry;
}

/* ------------------------------------------------------------------ */
/* The action matrix as pure predicates                                */
/* ------------------------------------------------------------------ */

test('skillActionBlocked: a plugin skill has no lever in any client; a Cursor skill has none at all', () => {
  const of = (client: Client, scope: 'user' | 'plugin'): Pick<SkillEntry, 'client' | 'scope' | 'plugin'> => ({
    client,
    scope,
    ...(scope === 'plugin' ? { plugin: 'toolkit' } : {})
  });

  assert.equal(skillActionBlocked(of('claude', 'user')), undefined);
  assert.equal(skillActionBlocked(of('codex', 'user')), undefined);
  assert.match(skillActionBlocked(of('cursor', 'user')) ?? '', /no skill visibility setting/);

  for (const client of ['claude', 'codex', 'cursor'] as const) {
    assert.match(
      skillActionBlocked(of(client, 'plugin')) ?? '',
      /enable or disable the "toolkit" plugin/
    );
  }
});

test('pluginActionBlocked: only Claude Code stores plugin enablement in settings', () => {
  assert.equal(pluginActionBlocked({ client: 'claude' }), undefined);
  assert.match(pluginActionBlocked({ client: 'codex' }) ?? '', /codex plugin add\/remove/);
  assert.match(pluginActionBlocked({ client: 'cursor' }) ?? '', /cursor plugin add\/remove/);
});

test('mcpActionBlocked: Codex owns config.toml outright; a plugin server adds a client-specific rule', () => {
  const of = (client: Client, scope: 'user' | 'plugin'): Pick<McpEntry, 'client' | 'scope' | 'plugin'> => ({
    client,
    scope,
    ...(scope === 'plugin' ? { plugin: 'toolkit' } : {})
  });

  // Non-plugin: Codex is blocked regardless of scope; the others are not.
  assert.equal(mcpActionBlocked(of('claude', 'user')), undefined);
  assert.equal(mcpActionBlocked(of('cursor', 'user')), undefined);
  assert.match(mcpActionBlocked(of('codex', 'user')) ?? '', /codex owns config\.toml/);

  // Plugin-scoped: Claude Code's disabledMcpServers still reaches a plugin's
  // own server, so Claude is not blocked here even though Cursor and Codex are.
  assert.equal(mcpActionBlocked(of('claude', 'plugin')), undefined);
  assert.match(mcpActionBlocked(of('cursor', 'plugin')) ?? '', /manages it through the "toolkit" plugin/);
  assert.match(mcpActionBlocked(of('codex', 'plugin')) ?? '', /enable or disable the "toolkit" plugin/);
});

/* ------------------------------------------------------------------ */
/* resolveEntry: id beats name; name resolution refuses rather than guesses */
/* ------------------------------------------------------------------ */

test('an id resolves directly, ignoring whatever name is also passed', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);
    const claudeAlpha = findSkill(scan.skills, 'claude', 'user', 'alpha');

    // The name argument is deliberately wrong; only the id should matter.
    const result = await setSkillVisibility({
      id: claudeAlpha.id,
      skill: 'this-name-does-not-exist',
      visibility: 'off',
      projectRoot: fixture.project,
      dryRun: true
    });
    assert.equal(result.changed, true);
  });
});

test('an id that belongs to another client is refused rather than silently switched', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);
    const claudeAlpha = findSkill(scan.skills, 'claude', 'user', 'alpha');

    await assert.rejects(
      setSkillVisibility({
        id: claudeAlpha.id,
        skill: 'alpha',
        visibility: 'off',
        client: 'codex',
        projectRoot: fixture.project,
        dryRun: true
      }),
      /belongs to claude, not codex/
    );
  });
});

test('an unknown id names itself in the error, not just "not found"', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    await assert.rejects(
      setSkillVisibility({
        id: 'claude:user:ghost',
        skill: 'alpha',
        visibility: 'off',
        projectRoot: fixture.project,
        dryRun: true
      }),
      /no item with id "claude:user:ghost"/
    );
  });
});

test('a bare name ambiguous across clients is refused, naming every client it matched', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    // "alpha" is a standalone skill in all three clients.
    await assert.rejects(
      setSkillVisibility({ skill: 'alpha', visibility: 'off', projectRoot: fixture.project, dryRun: true }),
      /ambiguous across claude, codex, cursor/
    );
    // "docs" is a standalone MCP server in all three.
    await assert.rejects(
      setMcpEnabled({ server: 'docs', enabled: false, projectRoot: fixture.project, dryRun: true }),
      /ambiguous across claude, codex, cursor/
    );
    // "toolkit" is installed for all three.
    await assert.rejects(
      setPluginEnabled({ plugin: 'toolkit', enabled: false, projectRoot: fixture.project, dryRun: true }),
      /ambiguous across claude, codex, cursor/
    );
  });
});

test('a bare name ambiguous within one client is refused even with client given, suggesting an id', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    // "dup" is a personal and a project skill, both in Claude, both named "dup".
    await assert.rejects(
      setSkillVisibility({
        skill: 'dup',
        visibility: 'off',
        client: 'claude',
        projectRoot: fixture.project,
        dryRun: true
      }),
      /ambiguous within claude.*pass its id instead/
    );
  });
});

test('a name absent from the requested client, but present in another, says which', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    // "gamma" only exists inside Claude's "solo" plugin.
    await assert.rejects(
      setSkillVisibility({
        skill: 'gamma',
        visibility: 'off',
        client: 'codex',
        projectRoot: fixture.project,
        dryRun: true
      }),
      /not found in codex — it is in claude/
    );
  });
});

test('a name absent everywhere is refused rather than treated as a no-op', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    await assert.rejects(
      setMcpEnabled({ server: 'nonexistent', enabled: false, projectRoot: fixture.project, dryRun: true }),
      /not found in any installed client/
    );
  });
});

/* ------------------------------------------------------------------ */
/* The matrix end to end: a real write, then an independent rescan     */
/* ------------------------------------------------------------------ */

test('Claude: a standalone skill switches, and the rescan agrees', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const before = await scanEnvironment(fixture.project);
    const alpha = findSkill(before.skills, 'claude', 'user', 'alpha');

    const result = await setSkillVisibility({
      id: alpha.id,
      skill: alpha.qualifiedName,
      visibility: 'name-only',
      projectRoot: fixture.project
    });
    assert.equal(result.changed, true);

    const after = await scanEnvironment(fixture.project);
    assert.equal(findSkill(after.skills, 'claude', 'user', 'alpha').visibility, 'name-only');
  });
});

test('Claude: a plugin skill is refused in every form the API offers', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);
    const beta = findSkill(scan.skills, 'claude', 'plugin', 'toolkit:beta');

    await assert.rejects(
      setSkillVisibility({ id: beta.id, skill: beta.qualifiedName, visibility: 'off', projectRoot: fixture.project }),
      /plugin skill.*enable or disable the "toolkit" plugin/
    );
    await assert.rejects(
      setSkillEnabled({ id: beta.id, skill: beta.qualifiedName, enabled: false, projectRoot: fixture.project }),
      /toolkit/
    );
  });
});

test('every client refuses a plugin skill the same way, by id', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);
    for (const client of ['claude', 'codex', 'cursor'] as const) {
      const beta = findSkill(scan.skills, client, 'plugin', 'toolkit:beta');
      await assert.rejects(
        setSkillVisibility({ id: beta.id, skill: beta.qualifiedName, visibility: 'off', projectRoot: fixture.project }),
        /toolkit/,
        `${client} plugin skill must be refused`
      );
    }
  });
});

test('Codex: a standalone skill moves directory, and the rescan agrees', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const before = await scanEnvironment(fixture.project);
    const alpha = findSkill(before.skills, 'codex', 'user', 'alpha');
    assert.equal(alpha.visibility, 'on');

    const result = await setSkillEnabled({
      id: alpha.id,
      skill: alpha.qualifiedName,
      enabled: false,
      projectRoot: fixture.project
    });
    assert.equal(result.changed, true);

    const after = await scanEnvironment(fixture.project);
    assert.equal(findSkill(after.skills, 'codex', 'user', 'alpha').visibility, 'off');
  });
});

test('Cursor: a skill has no lever at all, standalone or not', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);
    const alpha = findSkill(scan.skills, 'cursor', 'user', 'alpha');

    await assert.rejects(
      setSkillVisibility({ id: alpha.id, skill: alpha.qualifiedName, visibility: 'off', projectRoot: fixture.project }),
      /cursor has no skill visibility setting/
    );
    await assert.rejects(
      setSkillEnabled({ id: alpha.id, skill: alpha.qualifiedName, enabled: false, projectRoot: fixture.project }),
      /cursor has no skill visibility setting/
    );
  });
});

test('Claude: a plugin enables and disables in settings, and a repeat call is a no-op', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);
    const toolkit = findPlugin(scan.plugins, 'claude', 'toolkit');
    assert.equal(toolkit.enabled, true);

    // Already enabled: reported as a no-op, not a redundant write.
    const noop = await setPluginEnabled({
      id: toolkit.id,
      plugin: toolkit.qualifiedName,
      enabled: true,
      projectRoot: fixture.project
    });
    assert.equal(noop.changed, false);
    assert.match(noop.detail, /already enabled/);

    const result = await setPluginEnabled({
      id: toolkit.id,
      plugin: toolkit.qualifiedName,
      enabled: false,
      projectRoot: fixture.project
    });
    assert.equal(result.changed, true);

    const after = await scanEnvironment(fixture.project);
    assert.equal(findPlugin(after.plugins, 'claude', 'toolkit').enabled, false);
  });
});

test('Codex and Cursor plugins are refused, naming their own install lever', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);

    const codexToolkit = findPlugin(scan.plugins, 'codex', 'toolkit');
    await assert.rejects(
      setPluginEnabled({ id: codexToolkit.id, plugin: 'toolkit', enabled: false, projectRoot: fixture.project }),
      /codex plugin remove/
    );

    const cursorToolkit = findPlugin(scan.plugins, 'cursor', 'toolkit');
    await assert.rejects(
      setPluginEnabled({ id: cursorToolkit.id, plugin: 'toolkit', enabled: false, projectRoot: fixture.project }),
      /cursor plugin remove/
    );
  });
});

test('Claude: a plugin\'s own MCP server can still be switched off independently, via disabledMcpServers', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const before = await scanEnvironment(fixture.project);
    const ops = findMcp(before.mcpServers, 'claude', 'ops');
    assert.equal(ops.scope, 'plugin');
    assert.equal(ops.enabled, true);

    const result = await setMcpEnabled({
      id: ops.id,
      server: 'ops',
      enabled: false,
      projectRoot: fixture.project
    });
    assert.equal(result.changed, true);

    const after = await scanEnvironment(fixture.project);
    assert.equal(findMcp(after.mcpServers, 'claude', 'ops').enabled, false);
  });
});

test('Cursor and Codex refuse a plugin\'s own MCP server, unlike Claude', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);

    const cursorOps = findMcp(scan.mcpServers, 'cursor', 'ops');
    await assert.rejects(
      setMcpEnabled({ id: cursorOps.id, server: 'ops', enabled: false, projectRoot: fixture.project }),
      /manages plugin servers through the plugin itself/
    );

    const codexOps = findMcp(scan.mcpServers, 'codex', 'ops');
    await assert.rejects(
      setMcpEnabled({ id: codexOps.id, server: 'ops', enabled: false, projectRoot: fixture.project }),
      /codex mcp remove.*would report no such server/
    );
  });
});

test('Codex refuses even a standalone MCP server: config.toml is not written here', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const scan = await scanEnvironment(fixture.project);
    const docs = findMcp(scan.mcpServers, 'codex', 'docs');

    await assert.rejects(
      setMcpEnabled({ id: docs.id, server: 'docs', enabled: false, projectRoot: fixture.project }),
      /Codex owns ~\/\.codex\/config\.toml.*codex mcp remove docs/
    );
  });
});

test('Claude and Cursor standalone MCP servers switch off, and the rescan agrees', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const before = await scanEnvironment(fixture.project);

    const claudeDocs = findMcp(before.mcpServers, 'claude', 'docs');
    await setMcpEnabled({ id: claudeDocs.id, server: 'docs', enabled: false, projectRoot: fixture.project });

    const cursorDocs = findMcp(before.mcpServers, 'cursor', 'docs');
    await setMcpEnabled({ id: cursorDocs.id, server: 'docs', enabled: false, projectRoot: fixture.project });

    const after = await scanEnvironment(fixture.project);
    assert.equal(findMcp(after.mcpServers, 'claude', 'docs').enabled, false);
    assert.equal(findMcp(after.mcpServers, 'cursor', 'docs').enabled, false);
  });
});

test('a dry run reports what would change, writes nothing, and skips the rescan', async () => {
  await withFixture(async (fixture) => {
    await buildMatrixFixture(fixture);
    const settingsFile = path.join(fixture.home, '.claude', 'settings.json');
    const scan = await scanEnvironment(fixture.project);
    const alpha = findSkill(scan.skills, 'claude', 'user', 'alpha');

    const before = await readFile(settingsFile, 'utf8');
    const result = await setSkillVisibility({
      id: alpha.id,
      skill: alpha.qualifiedName,
      visibility: 'off',
      projectRoot: fixture.project,
      dryRun: true
    });

    assert.equal(result.changed, true);
    assert.equal(result.dryRun, true);
    assert.equal(await readFile(settingsFile, 'utf8'), before, 'a dry run must not touch the file');

    // Nothing on disk moved, so a verifying rescan would (wrongly) fail —
    // which is exactly why dry runs skip it rather than reporting that failure.
    const after = await scanEnvironment(fixture.project);
    assert.equal(findSkill(after.skills, 'claude', 'user', 'alpha').visibility, 'on');
  });
});

/* ------------------------------------------------------------------ */
/* The safety net: a write that "succeeds" but a higher-precedence layer  */
/* shadows it must be reported as a failure, not as changed: true.        */
/* ------------------------------------------------------------------ */

test('a skill write shadowed by a higher-precedence settings layer is reported as a failure', async () => {
  await withFixture(async (fixture) => {
    // Claude Code merges settings user < userLocal < project < projectLocal,
    // later layers winning. A personal skill with a *project*-scope override
    // already in place cannot be moved by writing the *user*-scope file, even
    // though that write "succeeds" as a file edit.
    await write(path.join(fixture.home, '.claude', 'skills', 'shadowed', 'SKILL.md'), skillMd('shadowed'));
    await writeJson(path.join(fixture.project, '.claude', 'settings.json'), {
      skillOverrides: { shadowed: 'name-only' }
    });

    const scan = await scanEnvironment(fixture.project);
    const shadowed = findSkill(scan.skills, 'claude', 'user', 'shadowed');
    assert.equal(shadowed.visibility, 'name-only', 'the project override must already be in force');

    // No explicit scope: setSkillVisibility defaults to the user-scope file,
    // which the project-scope override outranks.
    await assert.rejects(
      setSkillVisibility({ id: shadowed.id, skill: 'shadowed', visibility: 'off', projectRoot: fixture.project }),
      /rescanning found "claude:user:shadowed" still name-only instead of off/
    );

    // The write happened — this is a targeting defect, not a write failure —
    // it is just outranked by the file the action layer did not touch.
    const written = JSON.parse(
      await readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf8')
    ) as { skillOverrides?: Record<string, string> };
    assert.equal(written.skillOverrides?.shadowed, 'off');
  });
});

test('an MCP write shadowed by a project-scope approval is reported as a failure, not a false success', async () => {
  await withFixture(async (fixture) => {
    // `scanEnvironment` only reports a client's inventory once it looks
    // installed (`isDir(~/.claude)`) — every other test gets this for free
    // by writing some file under the home `.claude` tree, but this fixture
    // only touches the project directory, so it needs an explicit mkdir.
    await mkdir(path.join(fixture.home, '.claude'), { recursive: true });
    await writeJson(path.join(fixture.project, '.mcp.json'), {
      mcpServers: { 'shadowed-mcp': { command: 'node', args: ['-e', '1'] } }
    });
    // Approved at project scope — a *higher* precedence layer than the
    // user-scope disabledMcpjsonServers list setMcpEnabled defaults to writing.
    await writeJson(path.join(fixture.project, '.claude', 'settings.json'), {
      enabledMcpjsonServers: ['shadowed-mcp']
    });

    const scan = await scanEnvironment(fixture.project);
    const server = findMcp(scan.mcpServers, 'claude', 'shadowed-mcp');
    assert.equal(server.scope, 'project');
    assert.equal(server.enabled, true);

    await assert.rejects(
      setMcpEnabled({ id: server.id, server: 'shadowed-mcp', enabled: false, projectRoot: fixture.project }),
      /rescanning found ".*shadowed-mcp" still enabled/
    );
  });
});
