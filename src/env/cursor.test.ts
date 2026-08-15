import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CURSOR_HOOK_EVENTS,
  claudeHooksToCursorUser,
  cursorUserHooksToClaude,
  scanCursor,
  setMcpServerEnabled
} from './cursor.js';
import { readJson, readText } from './safe-io.js';

type Fixture = { home: string; project: string };

const USER_MCP = {
  mcpServers: {
    context7: {
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer abc' }
    },
    local: { command: 'npx', args: ['some-server'], env: { TOKEN: 'x' } }
  },
  _disabledMcpServers: {
    parked: { command: 'node', args: ['parked.js'] }
  }
};

const USER_HOOKS = {
  version: 1,
  hooks: {
    afterFileEdit: [{ command: '.cursor/hooks/format.sh' }],
    sessionStart: [{ command: 'ask the user', type: 'prompt', timeout: 30, matcher: 'startup' }],
    notAnEvent: [{ command: './x.sh' }]
  }
};

const PLUGIN_MANIFEST = {
  name: 'shadcn',
  displayName: 'shadcn/ui',
  version: '1.0.0',
  description: 'shadcn/ui components',
  skills: './skills/',
  commands: 'commands',
  mcpServers: { shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] } }
};

const PLUGIN_HOOKS = {
  hooks: {
    SessionStart: [
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"' }]
      }
    ]
  }
};

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`;
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeTextFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

/** A full Cursor install: user config, a project, a bundled skill, and one cached plugin. */
async function buildFixture(root: string): Promise<Fixture> {
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const cursor = path.join(home, '.cursor');

  await writeJsonFile(path.join(cursor, 'mcp.json'), USER_MCP);
  await writeJsonFile(path.join(cursor, 'hooks.json'), USER_HOOKS);
  await writeTextFile(path.join(cursor, 'skills', 'demo', 'SKILL.md'), skill('demo', 'A user skill'));
  await mkdir(path.join(cursor, 'skills', 'empty'), { recursive: true });
  await writeTextFile(
    path.join(cursor, 'skills-cursor', 'bundled', 'SKILL.md'),
    skill('bundled', 'Cursor ships this')
  );
  await writeTextFile(
    path.join(cursor, 'rules', 'style.mdc'),
    '---\ndescription: House style\nglobs: "**/*.ts"\nalwaysApply: false\n---\n\nUse tabs never.\n'
  );
  await writeTextFile(path.join(cursor, 'rules', 'orphan.mdc'), 'No frontmatter at all.\n');
  await writeTextFile(path.join(cursor, 'commands', 'ship.md'), '---\ndescription: Ship it\n---\n\nShip.\n');

  const pluginRoot = path.join(cursor, 'plugins', 'cache', 'cursor-public', 'shadcn', 'sha256-abc');
  await writeJsonFile(path.join(pluginRoot, '.cursor-plugin', 'plugin.json'), PLUGIN_MANIFEST);
  await writeTextFile(
    path.join(pluginRoot, 'skills', 'shadcn', 'SKILL.md'),
    skill('shadcn', 'Add components')
  );
  await writeTextFile(path.join(pluginRoot, 'commands', 'add.md'), '---\ndescription: Add\n---\n\nAdd.\n');
  await writeJsonFile(path.join(pluginRoot, 'hooks', 'hooks.json'), PLUGIN_HOOKS);

  await writeJsonFile(path.join(project, '.cursor', 'mcp.json'), {
    mcpServers: { proj: { command: './bin/proj' } }
  });
  await writeJsonFile(path.join(project, '.cursor', 'hooks.json'), {
    version: 1,
    hooks: { beforeShellExecution: [{ command: './guard.sh', timeout: 10 }] }
  });
  await writeTextFile(
    path.join(project, '.cursor', 'skills', 'proj', 'SKILL.md'),
    skill('proj', 'A project skill')
  );
  await writeTextFile(
    path.join(project, '.cursor', 'rules', 'proj.mdc'),
    '---\nalwaysApply: true\n---\n\nProject rule.\n'
  );
  await writeTextFile(path.join(project, '.cursorrules'), 'Legacy rules.\n');

  return { home, project };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-cursor-'));
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

test('scans skills, rules, commands, and marks Cursor installed', async () => {
  await withFixture(async ({ project }) => {
    const scan = await scanCursor(project);
    assert.equal(scan.installed, true);

    const skills = new Map(scan.skills.map((entry) => [entry.id, entry]));
    const user = skills.get('cursor:user:demo');
    assert.equal(user?.description, 'A user skill');
    assert.equal(user?.scope, 'user');
    assert.ok((user?.bytes ?? 0) > 0);
    assert.equal(skills.get('cursor:project:proj')?.scope, 'project');
    assert.equal(skills.get('cursor:builtin:bundled')?.scope, 'builtin');

    const pluginSkill = skills.get('cursor:plugin:shadcn:shadcn');
    assert.equal(pluginSkill?.plugin, 'shadcn');
    assert.equal(pluginSkill?.qualifiedName, 'shadcn:shadcn');

    assert.deepEqual(
      scan.memory.map((entry) => entry.name).sort(),
      ['.cursorrules', 'orphan.mdc', 'proj.mdc', 'style.mdc']
    );
    assert.deepEqual(
      scan.commands.map((entry) => entry.name).sort(),
      ['add', 'ship']
    );
    // A rules file with no trigger frontmatter is surfaced, not dropped.
    assert.ok(
      scan.warnings.some(
        (warning) => warning.file.endsWith('orphan.mdc') && warning.message.includes('alwaysApply')
      )
    );
    // A directory with no SKILL.md is not a skill. Plugins keep shared material
    // (evals/, scripts/, assets/) beside their skills, so this is silence, not a
    // warning — flagging it buries the real diagnostics.
    assert.ok(!scan.skills.some((skill) => skill.name === 'empty'));
    assert.ok(!scan.warnings.some((warning) => warning.message.includes('empty')));
  });
});

test('infers MCP transport from url and reads the disabled sibling key', async () => {
  await withFixture(async ({ project }) => {
    const scan = await scanCursor(project);
    const servers = new Map(scan.mcpServers.map((entry) => [entry.id, entry]));

    const remote = servers.get('cursor:user:context7');
    assert.equal(remote?.transport, 'http');
    assert.equal(remote?.url, 'https://mcp.context7.com/mcp');
    assert.deepEqual(remote?.headers, { Authorization: 'Bearer abc' });
    assert.equal(remote?.enabled, true);

    const local = servers.get('cursor:user:local');
    assert.equal(local?.transport, 'stdio');
    assert.deepEqual(local?.args, ['some-server']);
    assert.deepEqual(local?.env, { TOKEN: 'x' });

    const parked = servers.get('cursor:user:parked');
    assert.equal(parked?.enabled, false);
    assert.ok(parked?.enabledSource?.endsWith(path.join('.cursor', 'mcp.json')));

    assert.equal(servers.get('cursor:project:proj')?.scope, 'project');
    // Plugins declare MCP inline in the manifest, not in a separate mcp.json.
    const inline = servers.get('cursor:plugin:shadcn:shadcn');
    assert.equal(inline?.command, 'npx');
    assert.ok(inline?.file.endsWith(path.join('.cursor-plugin', 'plugin.json')));
  });
});

test('parses flat user hooks and Claude-shaped plugin hooks', async () => {
  await withFixture(async ({ project }) => {
    const scan = await scanCursor(project);

    const edit = scan.hooks.find((hook) => hook.event === 'afterFileEdit');
    assert.equal(edit?.scope, 'user');
    assert.equal(edit?.command, '.cursor/hooks/format.sh');
    assert.equal(edit?.type, 'command');
    assert.equal(edit?.index, 0);

    const prompt = scan.hooks.find((hook) => hook.event === 'sessionStart' && hook.scope === 'user');
    assert.equal(prompt?.type, 'prompt');
    assert.equal(prompt?.timeout, 30);
    assert.equal(prompt?.matcher, 'startup');

    const projectHook = scan.hooks.find((hook) => hook.scope === 'project');
    assert.equal(projectHook?.event, 'beforeShellExecution');
    assert.equal(projectHook?.timeout, 10);

    const pluginHook = scan.hooks.find((hook) => hook.scope === 'plugin');
    assert.equal(pluginHook?.event, 'SessionStart');
    assert.equal(pluginHook?.plugin, 'shadcn');
    assert.equal(pluginHook?.matcher, 'startup|resume|clear|compact');
    assert.equal(pluginHook?.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"');

    // An unrecognised event is reported but still surfaced.
    assert.ok(scan.hooks.some((hook) => hook.event === 'notAnEvent'));
    assert.ok(scan.warnings.some((warning) => warning.message === 'unknown hook event: notAnEvent'));
    assert.equal(CURSOR_HOOK_EVENTS.length, 20);
  });
});

test('counts what each cached plugin contributes', async () => {
  await withFixture(async ({ project }) => {
    const scan = await scanCursor(project);
    assert.equal(scan.plugins.length, 1);
    const plugin = scan.plugins[0];
    assert.equal(plugin?.name, 'shadcn');
    assert.equal(plugin?.marketplace, 'cursor-public');
    assert.equal(plugin?.version, '1.0.0');
    assert.equal(plugin?.installed, true);
    assert.equal(plugin?.skills, 1);
    assert.equal(plugin?.hooks, 1);
    assert.equal(plugin?.mcpServers, 1);
    assert.ok(plugin?.root?.endsWith('sha256-abc'));
  });
});

test('missing config yields an empty scan, not a throw', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-cursor-'));
  const previous = process.env.YARD_HOME;
  try {
    process.env.YARD_HOME = path.join(root, 'home');
    const scan = await scanCursor(path.join(root, 'project'));
    assert.equal(scan.installed, false);
    assert.deepEqual(scan.skills, []);
    assert.deepEqual(scan.plugins, []);
    assert.deepEqual(scan.mcpServers, []);
    assert.deepEqual(scan.hooks, []);
    assert.deepEqual(scan.memory, []);
    assert.deepEqual(scan.warnings, []);
  } finally {
    if (previous === undefined) {
      delete process.env.YARD_HOME;
    } else {
      process.env.YARD_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed JSON becomes a warning and the rest of the scan survives', async () => {
  await withFixture(async ({ home, project }) => {
    await writeTextFile(path.join(home, '.cursor', 'mcp.json'), '{ "mcpServers": { ');
    await writeTextFile(path.join(project, '.cursor', 'hooks.json'), 'nope');

    const scan = await scanCursor(project);
    assert.ok(
      scan.warnings.some(
        (warning) =>
          warning.client === 'cursor' &&
          warning.file === path.join(home, '.cursor', 'mcp.json') &&
          warning.message.startsWith('invalid JSON')
      )
    );
    assert.ok(
      scan.warnings.some(
        (warning) =>
          warning.file === path.join(project, '.cursor', 'hooks.json') &&
          warning.message.startsWith('invalid JSON')
      )
    );
    // One broken file must not blank the inventory.
    assert.ok(scan.skills.length >= 3);
    assert.ok(scan.mcpServers.some((entry) => entry.name === 'proj'));
    assert.ok(scan.hooks.some((entry) => entry.scope === 'user'));
  });
});

test('claudeHooksToCursorUser maps counterparts and reports the rest', () => {
  const converted = claudeHooksToCursorUser({
    hooks: {
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: './start.sh', timeout: 15 }]
        }
      ],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: './submit.sh' }] }],
      Notification: [{ hooks: [{ type: 'command', command: './notify.sh' }] }],
      PermissionRequest: [{ hooks: [{ type: 'command', command: './ask.sh' }] }]
    }
  });

  assert.equal(converted.version, 1);
  assert.deepEqual(converted.hooks.sessionStart, [
    { command: './start.sh', type: 'command', matcher: 'startup', timeout: 15 }
  ]);
  assert.deepEqual(converted.hooks.beforeSubmitPrompt, [{ command: './submit.sh', type: 'command' }]);
  assert.deepEqual(converted.dropped, ['Notification', 'PermissionRequest']);
});

test('cursorUserHooksToClaude drops Cursor-only events and prompt hooks', () => {
  const converted = cursorUserHooksToClaude({
    version: 1,
    hooks: {
      sessionStart: [{ command: './start.sh', matcher: 'startup', timeout: 15 }],
      stop: [{ command: './stop.sh' }],
      preToolUse: [{ command: 'confirm this', type: 'prompt' }],
      afterFileEdit: [{ command: './format.sh' }],
      beforeMCPExecution: [{ command: './mcp.sh' }]
    }
  });

  assert.deepEqual(converted.hooks.SessionStart, [
    { matcher: 'startup', hooks: [{ type: 'command', command: './start.sh', timeout: 15 }] }
  ]);
  assert.deepEqual(converted.hooks.Stop, [{ hooks: [{ type: 'command', command: './stop.sh' }] }]);
  assert.equal(converted.hooks.PreToolUse, undefined);
  assert.ok(converted.dropped.includes('afterFileEdit'));
  assert.ok(converted.dropped.includes('beforeMCPExecution'));
  assert.ok(converted.dropped.includes('preToolUse: prompt hook'));
});

test('conversion round-trips a mappable event without loss', () => {
  const claude = {
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './log.sh', timeout: 5 }] }]
    }
  };
  const back = cursorUserHooksToClaude(claudeHooksToCursorUser(claude));
  assert.deepEqual(back.hooks, claude.hooks);
  assert.deepEqual(back.dropped, []);
});

test('setMcpServerEnabled parks and restores an entry verbatim', async () => {
  await withFixture(async ({ home, project }) => {
    const file = path.join(home, '.cursor', 'mcp.json');

    const disabled = await setMcpServerEnabled({
      server: 'context7',
      enabled: false,
      scope: 'user',
      projectRoot: project
    });
    assert.equal(disabled.changed, true);
    assert.equal(disabled.file, file);

    const afterDisable = await readJson<{
      mcpServers: Record<string, unknown>;
      _disabledMcpServers: Record<string, unknown>;
    }>(file);
    assert.equal(afterDisable?.mcpServers.context7, undefined);
    assert.deepEqual(afterDisable?._disabledMcpServers.context7, USER_MCP.mcpServers.context7);

    const scan = await scanCursor(project);
    assert.equal(scan.mcpServers.find((entry) => entry.name === 'context7')?.enabled, false);

    const enabled = await setMcpServerEnabled({
      server: 'context7',
      enabled: true,
      scope: 'user',
      projectRoot: project
    });
    assert.equal(enabled.changed, true);

    const afterEnable = await readJson<{
      mcpServers: Record<string, unknown>;
      _disabledMcpServers?: Record<string, unknown>;
    }>(file);
    assert.deepEqual(afterEnable?.mcpServers.context7, USER_MCP.mcpServers.context7);
    assert.deepEqual(Object.keys(afterEnable?._disabledMcpServers ?? {}), ['parked']);
  });
});

test('setMcpServerEnabled honours dryRun and no-ops on an unknown server', async () => {
  await withFixture(async ({ home, project }) => {
    const file = path.join(home, '.cursor', 'mcp.json');
    const before = await readText(file);

    const dry = await setMcpServerEnabled({
      server: 'local',
      enabled: false,
      scope: 'user',
      projectRoot: project,
      dryRun: true
    });
    assert.equal(dry.changed, true);
    assert.equal(await readText(file), before);

    const missing = await setMcpServerEnabled({
      server: 'nothing-here',
      enabled: false,
      scope: 'user',
      projectRoot: project
    });
    assert.equal(missing.changed, false);
    assert.equal(await readText(file), before);
  });
});

test('setMcpServerEnabled refuses to overwrite an unparseable file', async () => {
  await withFixture(async ({ home, project }) => {
    const file = path.join(home, '.cursor', 'mcp.json');
    await writeTextFile(file, '{ oops');
    await assert.rejects(
      setMcpServerEnabled({ server: 'context7', enabled: false, scope: 'user', projectRoot: project }),
      /not valid JSON/
    );
    assert.equal(await readText(file), '{ oops');
  });
});

test('setMcpServerEnabled writes project scope into the project mcp.json', async () => {
  await withFixture(async ({ project }) => {
    const result = await setMcpServerEnabled({
      server: 'proj',
      enabled: false,
      scope: 'project',
      projectRoot: project
    });
    assert.equal(result.file, path.join(project, '.cursor', 'mcp.json'));
    const scan = await scanCursor(project);
    assert.equal(scan.mcpServers.find((entry) => entry.name === 'proj')?.enabled, false);
  });
});
