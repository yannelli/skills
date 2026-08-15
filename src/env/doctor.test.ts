import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudePaths, codexPaths } from './client-paths.js';
import { diagnose, type Severity } from './doctor.js';
import { emptyInventory } from './types.js';
import type {
  AgentEntry,
  Client,
  HookEntry,
  Inventory,
  McpEntry,
  PluginEntry,
  ScanWarning,
  Scope,
  SkillEntry
} from './types.js';

/**
 * The doctor reads an inventory, not the disk — except for hook scripts, whose
 * whole point is whether the file is still there. Those tests get a real tree;
 * the rest build inventories directly. Nothing here probes.
 */
const PROJECT = '/repo';

function inventoryWith(parts: Partial<Inventory>): Inventory {
  return Object.assign(emptyInventory(PROJECT), { clients: ['claude'] as Client[] }, parts);
}

function skill(spec: {
  name: string;
  description: string;
  file?: string;
  scope?: Scope;
  /** Override the parsed frontmatter, to model a malformed SKILL.md. */
  frontmatter?: Record<string, string>;
}): SkillEntry {
  const file = spec.file ?? `${PROJECT}/.claude/skills/${spec.name}/SKILL.md`;
  const scope = spec.scope ?? 'user';
  return {
    id: `claude:${scope}:${spec.name}`,
    client: 'claude',
    scope,
    name: spec.name,
    qualifiedName: spec.name,
    description: spec.description,
    file,
    dir: path.dirname(file),
    visibility: 'on',
    frontmatter: spec.frontmatter ?? { name: spec.name, description: spec.description },
    bytes: Buffer.byteLength(spec.description, 'utf8')
  };
}

/** A project-scoped Claude server declared in .mcp.json but never approved. */
function projectMcp(spec: { name: string; enabled: boolean; enabledSource?: string }): McpEntry {
  return {
    id: `claude:project:${spec.name}`,
    client: 'claude',
    scope: 'project',
    name: spec.name,
    transport: 'stdio',
    command: 'node',
    args: [`${spec.name}.js`],
    file: `${PROJECT}/.mcp.json`,
    enabled: spec.enabled,
    ...(spec.enabledSource ? { enabledSource: spec.enabledSource } : {})
  };
}

function hook(spec: {
  event: string;
  command: string;
  file: string;
  index?: number;
  plugin?: string;
  pluginRoot?: string;
}): HookEntry {
  const index = spec.index ?? 0;
  const scope: Scope = spec.plugin ? 'plugin' : 'user';
  return {
    id: `claude:${scope}:${spec.plugin ? `${spec.plugin}:` : ''}${spec.event}:${index}`,
    client: 'claude',
    scope,
    event: spec.event,
    type: 'command',
    command: spec.command,
    file: spec.file,
    ...(spec.plugin ? { plugin: spec.plugin } : {}),
    ...(spec.pluginRoot ? { pluginRoot: spec.pluginRoot } : {}),
    enabled: true,
    index
  };
}

function plugin(spec: {
  name: string;
  enabled: boolean;
  installed: boolean;
  otherContributions?: number;
}): PluginEntry {
  return {
    id: `claude:user:${spec.name}@market`,
    client: 'claude',
    scope: 'user',
    name: spec.name,
    marketplace: 'market',
    qualifiedName: `${spec.name}@market`,
    description: `The ${spec.name} plugin`,
    version: '1.0.0',
    root: `${PROJECT}/.claude/plugins/cache/market/${spec.name}`,
    enabled: spec.enabled,
    enabledSource: `${PROJECT}/.claude/settings.json`,
    installed: spec.installed,
    skills: 0,
    hooks: 0,
    mcpServers: 0,
    ...(spec.otherContributions !== undefined ? { otherContributions: spec.otherContributions } : {})
  };
}

function pluginAgent(name: string, owner: string): AgentEntry {
  return {
    id: `claude:plugin:${owner}:${name}`,
    client: 'claude',
    scope: 'plugin',
    name,
    description: `Subagent shipped by ${owner}`,
    file: `${PROJECT}/.claude/plugins/cache/market/${owner}/agents/${name}.md`,
    plugin: owner,
    bytes: 128
  };
}

function warning(client: Client, file: string, message: string): ScanWarning {
  return { client, file, message };
}

function rank(severity: Severity): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

async function withHookTree(run: (root: string, settings: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-doctor-'));
  try {
    const settings = path.join(root, '.claude', 'settings.json');
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await writeFile(settings, '{}\n', 'utf8');
    await writeFile(path.join(root, '.claude', 'hooks', 'present.sh'), '#!/bin/sh\necho ok\n', 'utf8');
    await run(root, settings);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a hook whose script is gone is an error, and one that is there is silent', async () => {
  await withHookTree(async (root, settings) => {
    const found = await diagnose(
      inventoryWith({
        hooks: [
          hook({ event: 'PreToolUse', command: './hooks/present.sh', file: settings }),
          hook({ event: 'PostToolUse', command: 'bash ./hooks/gone.sh', file: settings, index: 1 })
        ]
      })
    );

    const missing = found.filter((entry) => entry.code === 'hook-script-missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.severity, 'error');
    assert.equal(missing[0]?.client, 'claude');
    assert.equal(missing[0]?.file, settings);
    assert.ok(missing[0]?.summary.includes('PostToolUse'));
    assert.ok(missing[0]?.summary.includes('./hooks/gone.sh'));
    assert.ok(missing[0]?.remedy?.includes(path.join(root, '.claude', 'hooks', 'gone.sh')));
  });
});

test('a hook that is a shell one-liner or has an unexpanded variable is not flagged', async () => {
  await withHookTree(async (_root, settings) => {
    const found = await diagnose(
      inventoryWith({
        hooks: [
          hook({ event: 'SessionStart', command: 'if [ -d .git ]; then ./hooks/gone.sh; fi', file: settings }),
          hook({
            event: 'PreToolUse',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/gone.mjs"',
            file: settings,
            index: 1
          }),
          hook({ event: 'PostToolUse', command: 'cat notes.md | ./hooks/gone.sh', file: settings, index: 2 }),
          hook({ event: 'Stop', command: './hooks/$TOOL_NAME.sh', file: settings, index: 3 })
        ]
      })
    );

    // Every one of those names a path that does not exist. None of them is a
    // path the doctor can resolve, so none of them is a finding.
    assert.deepEqual(found, []);
  });
});

async function withPluginHookTree(
  run: (pluginRoot: string, hooksFile: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-doctor-plugin-'));
  try {
    const pluginRoot = path.join(root, 'plugins', 'cache', 'market', 'demo');
    await mkdir(path.join(pluginRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(pluginRoot, 'scripts', 'hello.sh'), '#!/bin/sh\necho hello\n', 'utf8');
    await run(pluginRoot, path.join(pluginRoot, 'hooks', 'hooks.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a quoted plugin-root variable glued to an unquoted suffix resolves as one shell word', async () => {
  await withPluginHookTree(async (pluginRoot, hooksFile) => {
    const found = await diagnose(
      inventoryWith({
        hooks: [
          hook({
            event: 'SessionStart',
            command: '"${CLAUDE_PLUGIN_ROOT}"/scripts/hello.sh',
            file: hooksFile,
            plugin: 'demo',
            pluginRoot
          })
        ]
      })
    );

    // The script is right there once the variable is expanded, so there is
    // nothing to report — a naive tokenizer that split the quoted variable
    // from the path suffix would test a nonexistent `/scripts/hello.sh` and
    // report a false positive here.
    assert.deepEqual(found, []);
  });
});

test('a plugin hook script missing after variable expansion names the resolved path', async () => {
  await withPluginHookTree(async (pluginRoot, hooksFile) => {
    const found = await diagnose(
      inventoryWith({
        hooks: [
          hook({
            event: 'SessionStart',
            command: 'node "${CLAUDE_PLUGIN_ROOT}"/scripts/missing.mjs',
            file: hooksFile,
            plugin: 'demo',
            pluginRoot
          })
        ]
      })
    );

    assert.equal(found.length, 1);
    const missing = found[0];
    assert.equal(missing?.code, 'hook-script-missing');
    assert.equal(missing?.severity, 'error');
    assert.ok(missing?.summary.includes(`${pluginRoot}/scripts/missing.mjs`));
    assert.ok(missing?.remedy?.includes(path.join(pluginRoot, 'scripts', 'missing.mjs')));
  });
});

test('a plugin hook without an explicit pluginRoot falls back to the hooks.json-relative heuristic', async () => {
  await withPluginHookTree(async (pluginRoot, hooksFile) => {
    const found = await diagnose(
      inventoryWith({
        hooks: [
          // No `pluginRoot` set — this is what a scanner that has not been
          // updated to populate the field yet still produces.
          hook({
            event: 'SessionStart',
            command: '"${CLAUDE_PLUGIN_ROOT}"/scripts/hello.sh',
            file: hooksFile,
            plugin: 'demo'
          })
        ]
      })
    );

    assert.deepEqual(found, []);
  });
});

test('a skill with no description is an error and an over-long one is a warning', async () => {
  const overlong = 'x'.repeat(1200);
  const found = await diagnose(
    inventoryWith({
      skills: [
        skill({ name: 'blank', description: '' }),
        skill({ name: 'verbose', description: overlong }),
        skill({ name: 'healthy', description: 'Use when cutting a release.' })
      ]
    })
  );

  const blank = found.filter((entry) => entry.code === 'skill-missing-description');
  assert.equal(blank.length, 1);
  assert.equal(blank[0]?.severity, 'error');
  assert.ok(blank[0]?.summary.startsWith('claude:user:blank'));
  assert.equal(blank[0]?.file, `${PROJECT}/.claude/skills/blank/SKILL.md`);

  const verbose = found.filter((entry) => entry.code === 'skill-description-long');
  assert.equal(verbose.length, 1);
  assert.equal(verbose[0]?.severity, 'warning');
  assert.ok(verbose[0]?.summary.includes('1200-char'));

  // A blank description is reported once, not twice: there is nothing to
  // measure the length of.
  assert.ok(!found.some((entry) => entry.summary.includes('claude:user:healthy')));
  assert.equal(found.length, 2);
});

test('a skill whose frontmatter has no name is an error', async () => {
  const found = await diagnose(
    inventoryWith({
      skills: [
        // The directory is called `nameless`, but SKILL.md never says so — the
        // client cannot address the skill by a name it was not given.
        skill({
          name: 'nameless',
          description: 'Use when auditing.',
          frontmatter: { description: 'Use when auditing.' }
        }),
        skill({ name: 'healthy', description: 'Use when cutting a release.' })
      ]
    })
  );

  assert.equal(found.length, 1);
  const missing = found[0];
  assert.equal(missing?.code, 'skill-missing-name');
  assert.equal(missing?.severity, 'error');
  assert.equal(missing?.client, 'claude');
  assert.equal(missing?.file, `${PROJECT}/.claude/skills/nameless/SKILL.md`);
  assert.ok(missing?.summary.includes('claude:user:nameless'));
  assert.ok(missing?.remedy?.includes('name: nameless'));
});

test('a project MCP server that was never approved is reported as pending', async () => {
  const found = await diagnose(
    inventoryWith({
      mcpServers: [
        projectMcp({ name: 'pending', enabled: false }),
        // Approved, so it loads and there is nothing to say.
        projectMcp({ name: 'approved', enabled: true }),
        // Declined on purpose: a settings file decided it, so it is not pending.
        projectMcp({
          name: 'declined',
          enabled: false,
          enabledSource: `${PROJECT}/.claude/settings.local.json`
        })
      ]
    })
  );

  assert.equal(found.length, 1);
  const pending = found[0];
  assert.equal(pending?.code, 'mcp-pending-approval');
  assert.equal(pending?.severity, 'info');
  assert.equal(pending?.client, 'claude');
  assert.equal(pending?.file, `${PROJECT}/.mcp.json`);
  assert.ok(pending?.summary.includes('pending'));
  assert.ok(pending?.summary.includes('not been approved'));
  assert.equal(pending?.remedy, 'yard mcp enable pending');
});

test('a skill name claimed twice by one client is a warning naming both', async () => {
  const found = await diagnose(
    inventoryWith({
      skills: [
        skill({ name: 'review', description: 'The user copy.', scope: 'user' }),
        skill({
          name: 'review',
          description: 'The project copy.',
          scope: 'project',
          file: `${PROJECT}/.claude/skills/review/SKILL.md`
        }),
        skill({ name: 'unique', description: 'Claimed once.' })
      ]
    })
  );

  const duplicates = found.filter((entry) => entry.code === 'duplicate-skill');
  assert.equal(duplicates.length, 1);
  const duplicate = duplicates[0];
  assert.equal(duplicate?.severity, 'warning');
  assert.equal(duplicate?.client, 'claude');
  assert.ok(duplicate?.summary.includes('claude:review'));
  assert.ok(duplicate?.summary.includes('defined 2 times'));
  assert.ok(duplicate?.remedy?.includes('claude:user:review'));
  assert.ok(duplicate?.remedy?.includes('claude:project:review'));
  // The name claimed once is not dragged in.
  assert.ok(!found.some((entry) => entry.summary.includes('unique')));
});

test('a plugin that is enabled but not on disk is an error', async () => {
  const found = await diagnose(
    inventoryWith({
      plugins: [plugin({ name: 'ghost', enabled: true, installed: false })]
    })
  );

  const missing = found.filter((entry) => entry.code === 'plugin-not-installed');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.severity, 'error');
  assert.ok(missing[0]?.summary.includes('ghost@market'));
  assert.equal(missing[0]?.file, `${PROJECT}/.claude/settings.json`);
  // It is not on disk, so it cannot also be reported as contributing nothing.
  assert.ok(!found.some((entry) => entry.code === 'plugin-empty'));
});

test('a plugin whose only contribution is an agent is not reported as empty', async () => {
  const found = await diagnose(
    inventoryWith({
      plugins: [
        plugin({ name: 'agentic', enabled: true, installed: true }),
        plugin({ name: 'hollow', enabled: true, installed: true })
      ],
      agents: [pluginAgent('reviewer', 'agentic')]
    })
  );

  const empty = found.filter((entry) => entry.code === 'plugin-empty');
  assert.equal(empty.length, 1);
  assert.equal(empty[0]?.severity, 'info');
  assert.ok(empty[0]?.summary.includes('hollow@market'));
  assert.ok(!empty.some((entry) => entry.summary.includes('agentic')));
  // Claude Code is the only client that keeps plugin enablement in settings,
  // so it is the only one this command works for.
  assert.equal(empty[0]?.remedy, 'yard plugin disable hollow@market');
});

test('a plugin whose only contribution is an app or LSP server is not reported as empty', async () => {
  const found = await diagnose(
    inventoryWith({
      plugins: [
        plugin({ name: 'app-only', enabled: true, installed: true, otherContributions: 1 }),
        plugin({ name: 'hollow', enabled: true, installed: true })
      ]
    })
  );

  const empty = found.filter((entry) => entry.code === 'plugin-empty');
  assert.equal(empty.length, 1);
  assert.ok(empty[0]?.summary.includes('hollow@market'));
  assert.ok(!empty.some((entry) => entry.summary.includes('app-only')));
});

test('scan warnings surface as unreadable-config with the file in the summary', async () => {
  const file = '/home/dev/.cursor/mcp.json';
  const found = await diagnose(
    inventoryWith({
      clients: ['cursor'],
      warnings: [warning('cursor', file, 'invalid JSON: Unexpected end of JSON input')]
    })
  );

  assert.equal(found.length, 1);
  const entry = found[0];
  assert.equal(entry?.code, 'unreadable-config');
  assert.equal(entry?.severity, 'warning');
  assert.equal(entry?.client, 'cursor');
  assert.equal(entry?.file, file);
  assert.ok(entry?.summary.startsWith(`${file}: `));
  assert.ok(entry?.summary.includes('invalid JSON'));
  assert.ok(entry?.remedy);
});

test('broken links under a disabled-skill parking directory are one info finding, not one per link', async () => {
  const previousHome = process.env.YARD_HOME;
  const home = await mkdtemp(path.join(tmpdir(), 'yard-doctor-home-'));
  process.env.YARD_HOME = home;
  try {
    const disabledDir = codexPaths(PROJECT).userSkillsDisabled;
    const brokenLinks = Array.from({ length: 31 }, (_, index) =>
      warning('codex', path.join(disabledDir, `firecrawl-${index}`), 'skill symlink does not resolve to a directory')
    );
    const activeWarning = warning('codex', `${PROJECT}/.codex/config.toml`, 'could not parse TOML: line 3');

    const found = await diagnose(
      inventoryWith({ clients: ['codex'], warnings: [...brokenLinks, activeWarning] })
    );

    const aggregated = found.filter((entry) => entry.code === 'disabled-dir-noise');
    assert.equal(aggregated.length, 1);
    assert.equal(aggregated[0]?.severity, 'info');
    assert.equal(aggregated[0]?.client, 'codex');
    assert.equal(aggregated[0]?.file, disabledDir);
    assert.ok(aggregated[0]?.summary.includes('31 stale entries'));
    assert.ok(aggregated[0]?.summary.includes(disabledDir));

    // The unrelated warning is untouched, and is not swallowed by the rollup.
    const unrelated = found.filter((entry) => entry.code === 'unreadable-config');
    assert.equal(unrelated.length, 1);
    assert.equal(unrelated[0]?.file, `${PROJECT}/.codex/config.toml`);

    // No per-link warning leaked through.
    assert.ok(!found.some((entry) => entry.file?.includes('firecrawl-')));
  } finally {
    restoreEnv('YARD_HOME', previousHome);
    await rm(home, { recursive: true, force: true });
  }
});

test('a single broken link under a disabled-skill directory is still singular', async () => {
  const previousHome = process.env.YARD_HOME;
  const home = await mkdtemp(path.join(tmpdir(), 'yard-doctor-home-'));
  process.env.YARD_HOME = home;
  try {
    const disabledDir = claudePaths(PROJECT).userSkillsDisabled;
    const found = await diagnose(
      inventoryWith({
        warnings: [warning('claude', path.join(disabledDir, 'old-skill'), 'broken symlink; nothing is loaded from it')]
      })
    );

    const aggregated = found.filter((entry) => entry.code === 'disabled-dir-noise');
    assert.equal(aggregated.length, 1);
    assert.equal(aggregated[0]?.client, 'claude');
    assert.ok(aggregated[0]?.summary.includes('1 stale entry '));
    assert.ok(!aggregated[0]?.summary.includes('1 stale entries'));
  } finally {
    restoreEnv('YARD_HOME', previousHome);
    await rm(home, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test('results are sorted errors first', async () => {
  await withHookTree(async (_root, settings) => {
    const found = await diagnose(
      inventoryWith({
        skills: [
          skill({ name: 'blank', description: '' }),
          skill({ name: 'verbose', description: 'x'.repeat(1200) })
        ],
        hooks: [hook({ event: 'PreToolUse', command: './hooks/gone.sh', file: settings })],
        plugins: [plugin({ name: 'hollow', enabled: true, installed: true })],
        warnings: [warning('codex', '/home/dev/.codex/config.toml', 'could not parse TOML: line 1')]
      })
    );

    const severities = found.map((entry) => entry.severity);
    assert.deepEqual(severities, [...severities].sort((a, b) => rank(a) - rank(b)));
    assert.deepEqual(severities, ['error', 'error', 'warning', 'warning', 'info']);
    assert.deepEqual(
      found.map((entry) => entry.code),
      [
        'hook-script-missing',
        'skill-missing-description',
        'skill-description-long',
        'unreadable-config',
        'plugin-empty'
      ]
    );
  });
});
