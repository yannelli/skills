import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isDir, readJson } from './safe-io.js';
import {
  CLAUDE_HOOK_EVENTS,
  claudeSettingsFiles,
  claudeSettingsTarget,
  scanClaude,
  setMcpEnabled,
  setPluginEnabled,
  setSkillDirectoryEnabled,
  setSkillVisibility
} from './claude.js';

type Fixture = { home: string; project: string; pluginRoot: string };

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-claude-'));
  const fixture: Fixture = {
    home: path.join(dir, 'home'),
    project: path.join(dir, 'project'),
    pluginRoot: path.join(dir, 'home', '.claude', 'plugins', 'cache', 'acme', 'demo')
  };
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

async function write(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;
}

async function buildInstall(fixture: Fixture): Promise<void> {
  const claude = path.join(fixture.home, '.claude');

  await writeJson(path.join(claude, 'settings.json'), {
    skillOverrides: { alpha: 'name-only', 'demo:deploy': 'off' },
    skillListingMaxDescChars: 800,
    enabledPlugins: { 'demo@acme': true },
    enabledMcpjsonServers: ['approved'],
    disabledMcpjsonServers: ['rejected'],
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo start', timeout: 5 }] }]
    }
  });
  await writeJson(path.join(claude, 'settings.local.json'), {
    skillOverrides: { alpha: 'off' }
  });
  await writeJson(path.join(fixture.project, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }]
    }
  });
  await writeJson(path.join(fixture.home, '.claude.json'), {
    numStartups: 12,
    enableAllProjectMcpServers: false
  });

  await write(path.join(claude, 'skills', 'alpha', 'SKILL.md'), skill('alpha', 'First skill.'));
  await write(
    path.join(claude, 'skills.disabled', 'beta', 'SKILL.md'),
    skill('beta', 'Parked skill.')
  );
  await write(
    path.join(fixture.project, '.claude', 'skills', 'gamma', 'SKILL.md'),
    skill('gamma', 'Project skill.')
  );

  await write(path.join(claude, 'agents', 'reviewer.md'), skill('reviewer', 'Reviews diffs.'));
  await write(path.join(claude, 'commands', 'ship.md'), skill('ship', 'Ships it.'));
  await write(path.join(claude, 'commands', 'git', 'sync.md'), skill('sync', 'Syncs remotes.'));

  await write(path.join(claude, 'CLAUDE.md'), '# user memory\n');
  await write(path.join(fixture.project, 'CLAUDE.md'), '# project memory\n');

  await writeJson(path.join(fixture.project, '.mcp.json'), {
    mcpServers: {
      approved: { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } },
      rejected: { type: 'sse', url: 'https://example.test/sse', headers: { Auth: 'y' } },
      pending: { command: 'python' }
    }
  });

  await writeJson(path.join(claude, 'plugins', 'known_marketplaces.json'), {
    acme: {
      source: { source: 'github', repo: 'acme/plugins' },
      installLocation: path.dirname(fixture.pluginRoot),
      lastUpdated: '2026-01-01T00:00:00.000Z'
    }
  });
  await writeJson(path.join(claude, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'demo@acme': [
        {
          scope: 'user',
          installPath: fixture.pluginRoot,
          version: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-02T00:00:00.000Z'
        }
      ]
    }
  });

  await writeJson(path.join(fixture.pluginRoot, '.claude-plugin', 'plugin.json'), {
    name: 'demo',
    description: 'Demo plugin.',
    version: '1.2.3'
  });
  await write(
    path.join(fixture.pluginRoot, 'skills', 'deploy', 'SKILL.md'),
    skill('deploy', 'Deploys things.')
  );
  await write(
    path.join(fixture.pluginRoot, 'skills', 'alpha', 'SKILL.md'),
    skill('alpha', 'Shares a name with a personal skill.')
  );
  await write(path.join(fixture.pluginRoot, 'agents', 'helper.md'), skill('helper', 'Helps.'));
  await writeJson(path.join(fixture.pluginRoot, 'hooks', 'hooks.json'), {
    hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'format.sh' }] }] }
  });
  await writeJson(path.join(fixture.pluginRoot, '.mcp.json'), {
    mcpServers: { 'demo-server': { command: 'demo', args: ['--stdio'] } }
  });
}

test('hook event names cover the PascalCase 2026 set', () => {
  assert.ok(CLAUDE_HOOK_EVENTS.includes('PostToolUseFailure'));
  assert.ok(CLAUDE_HOOK_EVENTS.includes('WorktreeRemove'));
  assert.equal(new Set(CLAUDE_HOOK_EVENTS).size, CLAUDE_HOOK_EVENTS.length);
  for (const event of CLAUDE_HOOK_EVENTS) {
    assert.match(event, /^[A-Z][A-Za-z]+$/);
  }
});

test('settings files resolve in increasing precedence', async () => {
  await withFixture(async (fixture) => {
    const files = claudeSettingsFiles(fixture.project).map((entry) => entry.level);
    // Managed policy is last because it is the layer nothing local can override.
    assert.deepEqual(files, ['user', 'userLocal', 'project', 'projectLocal', 'managed']);
    assert.equal(
      claudeSettingsTarget('user', fixture.project),
      path.join(fixture.home, '.claude', 'settings.json')
    );
    assert.equal(
      claudeSettingsTarget('project', fixture.project),
      path.join(fixture.project, '.claude', 'settings.json')
    );
    assert.equal(
      claudeSettingsTarget('local', fixture.project),
      path.join(fixture.project, '.claude', 'settings.local.json')
    );
  });
});

test('a higher layer wins key by key, and says which file decided it', async () => {
  await withFixture(async (fixture) => {
    const userSettings = path.join(fixture.home, '.claude', 'settings.json');
    const userLocal = path.join(fixture.home, '.claude', 'settings.local.json');
    const projectSettings = path.join(fixture.project, '.claude', 'settings.json');
    const projectLocal = path.join(fixture.project, '.claude', 'settings.local.json');

    await writeJson(userSettings, {
      skillListingMaxDescChars: 100,
      skillListingBudgetFraction: 0.5,
      skillOverrides: { alpha: 'off', beta: 'off' },
      enabledPlugins: { 'one@acme': true, 'two@acme': true }
    });
    await writeJson(userLocal, { skillListingMaxDescChars: 200 });
    await writeJson(projectSettings, {
      skillListingMaxDescChars: 300,
      skillOverrides: { alpha: 'name-only' }
    });
    await writeJson(projectLocal, {
      skillListingMaxDescChars: 400,
      enabledPlugins: { 'one@acme': false }
    });

    const { settings } = await scanClaude(fixture.project);

    assert.equal(settings.skillListingMaxDescChars, 400);
    assert.equal(settings.sources.skillListingMaxDescChars, projectLocal);
    // A key only the lowest layer sets survives the merge.
    assert.equal(settings.skillListingBudgetFraction, 0.5);
    assert.equal(settings.sources.skillListingBudgetFraction, userSettings);

    assert.deepEqual(settings.skillOverrides, { alpha: 'name-only', beta: 'off' });
    assert.equal(settings.sources.skillOverrides.alpha, projectSettings);
    assert.equal(settings.sources.skillOverrides.beta, userSettings);

    assert.deepEqual(settings.enabledPlugins, { 'one@acme': false, 'two@acme': true });
    assert.equal(settings.sources.enabledPlugins['one@acme'], projectLocal);
    assert.deepEqual(settings.loaded, [userSettings, userLocal, projectSettings, projectLocal]);
  });
});

test('scans a populated install', async () => {
  await withFixture(async (fixture) => {
    await buildInstall(fixture);
    const scan = await scanClaude(fixture.project);

    assert.deepEqual(scan.warnings, []);
    assert.equal(scan.installed, true);

    const alpha = scan.skills.find((entry) => entry.name === 'alpha');
    assert.ok(alpha);
    assert.equal(alpha.scope, 'user');
    assert.equal(alpha.description, 'First skill.');
    // settings.local.json outranks settings.json.
    assert.equal(alpha.visibility, 'off');
    assert.equal(alpha.visibilitySource, path.join(fixture.home, '.claude', 'settings.local.json'));

    const beta = scan.skills.find((entry) => entry.name === 'beta');
    assert.ok(beta);
    assert.equal(beta.visibility, 'off');
    assert.equal(beta.visibilitySource, path.join(fixture.home, '.claude', 'skills.disabled'));

    const gamma = scan.skills.find((entry) => entry.name === 'gamma');
    assert.ok(gamma);
    assert.equal(gamma.scope, 'project');
    assert.equal(gamma.visibility, 'on');
    assert.equal(gamma.visibilitySource, undefined);

    const deploy = scan.skills.find((entry) => entry.name === 'deploy');
    assert.ok(deploy);
    assert.equal(deploy.scope, 'plugin');
    assert.equal(deploy.qualifiedName, 'demo:deploy');
    assert.equal(deploy.plugin, 'demo');
    // A plugin skill is keyed `<plugin>:<skill>` in skillOverrides.
    assert.equal(deploy.visibility, 'off');
    assert.equal(deploy.visibilitySource, path.join(fixture.home, '.claude', 'settings.json'));

    // ...and only by that key: the bare-name override for the personal skill
    // `alpha` must not reach the plugin's own skill of the same name.
    const pluginAlpha = scan.skills.find((entry) => entry.id === 'claude:plugin:demo:alpha');
    assert.ok(pluginAlpha);
    assert.equal(pluginAlpha.visibility, 'on');
    assert.equal(pluginAlpha.visibilitySource, undefined);

    assert.equal(scan.settings.skillListingMaxDescChars, 800);
    assert.equal(scan.settings.skillListingBudgetFraction, 0.01);
    assert.equal(
      scan.settings.sources.skillListingMaxDescChars,
      path.join(fixture.home, '.claude', 'settings.json')
    );
    assert.equal(scan.settings.enableAllProjectMcpServers, false);
    assert.deepEqual(scan.settings.enabledMcpjsonServers, ['approved']);
    assert.deepEqual(scan.settings.disabledMcpjsonServers, ['rejected']);

    const plugin = scan.plugins.find((entry) => entry.qualifiedName === 'demo@acme');
    assert.ok(plugin);
    assert.equal(plugin.name, 'demo');
    assert.equal(plugin.marketplace, 'acme');
    assert.equal(plugin.version, '1.2.3');
    assert.equal(plugin.description, 'Demo plugin.');
    assert.equal(plugin.enabled, true);
    assert.equal(plugin.installed, true);
    assert.equal(plugin.root, fixture.pluginRoot);
    assert.deepEqual(
      [plugin.skills, plugin.hooks, plugin.mcpServers],
      [2, 1, 1]
    );

    const approved = scan.mcpServers.find((entry) => entry.name === 'approved');
    assert.ok(approved);
    assert.equal(approved.transport, 'stdio');
    assert.deepEqual(approved.args, ['server.js']);
    assert.deepEqual(approved.env, { TOKEN: 'x' });
    assert.equal(approved.enabled, true);
    assert.equal(approved.enabledSource, path.join(fixture.home, '.claude', 'settings.json'));

    const rejected = scan.mcpServers.find((entry) => entry.name === 'rejected');
    assert.ok(rejected);
    assert.equal(rejected.transport, 'sse');
    assert.equal(rejected.url, 'https://example.test/sse');
    assert.equal(rejected.enabled, false);
    assert.equal(rejected.enabledSource, path.join(fixture.home, '.claude', 'settings.json'));

    const pending = scan.mcpServers.find((entry) => entry.name === 'pending');
    assert.ok(pending);
    assert.equal(pending.enabled, false);
    assert.equal(pending.enabledSource, undefined);

    const pluginServer = scan.mcpServers.find((entry) => entry.name === 'demo-server');
    assert.ok(pluginServer);
    assert.equal(pluginServer.scope, 'plugin');
    assert.equal(pluginServer.enabled, true);

    const sessionStart = scan.hooks.find((entry) => entry.event === 'SessionStart');
    assert.ok(sessionStart);
    assert.equal(sessionStart.scope, 'user');
    assert.equal(sessionStart.command, 'echo start');
    assert.equal(sessionStart.timeout, 5);
    assert.equal(sessionStart.enabled, true);
    assert.equal(sessionStart.index, 0);

    const preToolUse = scan.hooks.find((entry) => entry.event === 'PreToolUse');
    assert.ok(preToolUse);
    assert.equal(preToolUse.scope, 'project');
    assert.equal(preToolUse.matcher, 'Bash');

    const pluginHook = scan.hooks.find((entry) => entry.event === 'PostToolUse');
    assert.ok(pluginHook);
    assert.equal(pluginHook.plugin, 'demo');
    assert.equal(pluginHook.enabled, true);

    assert.deepEqual(
      scan.agents.map((entry) => entry.name).sort(),
      ['helper', 'reviewer']
    );
    assert.deepEqual(
      scan.commands.map((entry) => entry.name).sort(),
      ['git:sync', 'ship']
    );
    assert.deepEqual(
      scan.memory.map((entry) => entry.scope).sort(),
      ['project', 'user']
    );
  });
});

test('enableAllProjectMcpServers approves pending .mcp.json servers', async () => {
  await withFixture(async (fixture) => {
    await writeJson(path.join(fixture.home, '.claude.json'), { enableAllProjectMcpServers: true });
    await writeJson(path.join(fixture.project, '.mcp.json'), {
      mcpServers: { pending: { command: 'python' } }
    });
    const scan = await scanClaude(fixture.project);
    const pending = scan.mcpServers.find((entry) => entry.name === 'pending');
    assert.ok(pending);
    assert.equal(pending.enabled, true);
    assert.equal(pending.enabledSource, path.join(fixture.home, '.claude.json'));
  });
});

test('disableAllHooks turns every hook off and names the file that did it', async () => {
  await withFixture(async (fixture) => {
    await buildInstall(fixture);
    await writeJson(path.join(fixture.project, '.claude', 'settings.local.json'), {
      disableAllHooks: true
    });
    const scan = await scanClaude(fixture.project);
    const local = path.join(fixture.project, '.claude', 'settings.local.json');
    assert.ok(scan.hooks.length > 0);
    for (const hook of scan.hooks) {
      assert.equal(hook.enabled, false);
      assert.equal(hook.enabledSource, local);
    }
    assert.equal(scan.settings.sources.disableAllHooks, local);
  });
});

test('a bare home directory scans to an empty inventory', async () => {
  await withFixture(async (fixture) => {
    const scan = await scanClaude(fixture.project);
    assert.equal(scan.installed, false);
    assert.deepEqual(scan.skills, []);
    assert.deepEqual(scan.plugins, []);
    assert.deepEqual(scan.mcpServers, []);
    assert.deepEqual(scan.hooks, []);
    assert.deepEqual(scan.agents, []);
    assert.deepEqual(scan.commands, []);
    assert.deepEqual(scan.memory, []);
    assert.deepEqual(scan.warnings, []);
    assert.deepEqual(scan.settings.loaded, []);
    assert.equal(scan.settings.skillListingMaxDescChars, 1536);
    assert.equal(scan.settings.skillListingBudgetFraction, 0.01);
  });
});

test('malformed files become warnings and do not blank the inventory', async () => {
  await withFixture(async (fixture) => {
    await buildInstall(fixture);
    await write(path.join(fixture.home, '.claude', 'settings.json'), '{ "skillOverrides": ');
    await write(path.join(fixture.project, '.mcp.json'), 'not json at all');
    await write(
      path.join(fixture.home, '.claude', 'plugins', 'installed_plugins.json'),
      '{ "plugins": '
    );

    const scan = await scanClaude(fixture.project);

    const broken = scan.warnings.map((warning) => warning.file);
    assert.ok(broken.includes(path.join(fixture.home, '.claude', 'settings.json')));
    assert.ok(broken.includes(path.join(fixture.project, '.mcp.json')));
    assert.ok(broken.includes(path.join(fixture.home, '.claude', 'plugins', 'installed_plugins.json')));
    for (const warning of scan.warnings) {
      assert.equal(warning.client, 'claude');
      assert.match(warning.message, /invalid JSON/);
    }

    // The rest of the scan survived the broken files.
    assert.ok(scan.skills.some((entry) => entry.name === 'alpha'));
    assert.ok(scan.skills.some((entry) => entry.name === 'gamma'));
    assert.ok(scan.hooks.some((entry) => entry.event === 'PreToolUse'));
    assert.equal(scan.mcpServers.length, 0);
  });
});

test('an unknown hook event warns but still reports the hook', async () => {
  await withFixture(async (fixture) => {
    await writeJson(path.join(fixture.home, '.claude', 'settings.json'), {
      hooks: { preToolUse: [{ hooks: [{ type: 'command', command: 'oops' }] }] }
    });
    const scan = await scanClaude(fixture.project);
    assert.equal(scan.hooks.length, 1);
    assert.equal(scan.warnings.length, 1);
    assert.match(scan.warnings[0]?.message ?? '', /unknown hook event "preToolUse"/);
  });
});

test('setSkillVisibility writes an override and drops it again for "on"', async () => {
  await withFixture(async (fixture) => {
    const file = path.join(fixture.home, '.claude', 'settings.json');

    const off = await setSkillVisibility({
      skill: 'alpha',
      visibility: 'off',
      projectRoot: fixture.project
    });
    assert.equal(off.file, file);
    assert.equal(off.created, true);
    assert.deepEqual((await readJson<{ skillOverrides: unknown }>(file))?.skillOverrides, {
      alpha: 'off'
    });

    await setSkillVisibility({
      skill: 'beta',
      visibility: 'user-invocable-only',
      projectRoot: fixture.project
    });
    const back = await setSkillVisibility({
      skill: 'alpha',
      visibility: 'on',
      projectRoot: fixture.project
    });
    assert.equal(back.changed, true);
    assert.deepEqual((await readJson<{ skillOverrides: unknown }>(file))?.skillOverrides, {
      beta: 'user-invocable-only'
    });

    // The last override leaving takes the key with it.
    await setSkillVisibility({ skill: 'beta', visibility: 'on', projectRoot: fixture.project });
    assert.deepEqual(await readJson(file), {});
  });
});

test('setSkillVisibility honours dryRun and scope', async () => {
  await withFixture(async (fixture) => {
    const local = path.join(fixture.project, '.claude', 'settings.local.json');
    const result = await setSkillVisibility({
      skill: 'alpha',
      visibility: 'name-only',
      scope: 'local',
      projectRoot: fixture.project,
      dryRun: true
    });
    assert.equal(result.file, local);
    assert.equal(result.changed, true);
    assert.match(result.after, /"name-only"/);
    assert.equal(await isDir(path.dirname(local)), false);
  });
});

test('setPluginEnabled resolves an unqualified name and rejects an ambiguous one', async () => {
  await withFixture(async (fixture) => {
    await buildInstall(fixture);

    const result = await setPluginEnabled({
      plugin: 'demo',
      enabled: false,
      projectRoot: fixture.project
    });
    const settings = await readJson<{ enabledPlugins: Record<string, boolean> }>(result.file);
    assert.equal(settings?.enabledPlugins['demo@acme'], false);

    await writeJson(path.join(fixture.project, '.claude', 'settings.json'), {
      enabledPlugins: { 'demo@other': true }
    });
    await assert.rejects(
      setPluginEnabled({ plugin: 'demo', enabled: true, projectRoot: fixture.project }),
      /ambiguous.*demo@acme.*demo@other/s
    );
    await assert.rejects(
      setPluginEnabled({ plugin: 'nope', enabled: true, projectRoot: fixture.project }),
      /unknown plugin "nope"/
    );

    const qualified = await setPluginEnabled({
      plugin: 'demo@other',
      enabled: true,
      projectRoot: fixture.project
    });
    const after = await readJson<{ enabledPlugins: Record<string, boolean> }>(qualified.file);
    assert.equal(after?.enabledPlugins['demo@other'], true);
  });
});

test('setMcpEnabled moves a server between the approval lists', async () => {
  await withFixture(async (fixture) => {
    const file = path.join(fixture.home, '.claude', 'settings.json');
    await writeJson(file, {
      enabledMcpjsonServers: ['beta', 'alpha', 'alpha'],
      disabledMcpjsonServers: ['gamma']
    });

    await setMcpEnabled({ server: 'alpha', enabled: false, projectRoot: fixture.project });
    let settings = await readJson<{
      enabledMcpjsonServers: string[];
      disabledMcpjsonServers: string[];
    }>(file);
    assert.deepEqual(settings?.enabledMcpjsonServers, ['beta']);
    assert.deepEqual(settings?.disabledMcpjsonServers, ['alpha', 'gamma']);

    await setMcpEnabled({ server: 'gamma', enabled: true, projectRoot: fixture.project });
    await setMcpEnabled({ server: 'gamma', enabled: true, projectRoot: fixture.project });
    settings = await readJson(file);
    assert.deepEqual(settings?.enabledMcpjsonServers, ['beta', 'gamma']);
    assert.deepEqual(settings?.disabledMcpjsonServers, ['alpha']);

    await setMcpEnabled({ server: 'alpha', enabled: true, projectRoot: fixture.project });
    settings = await readJson(file);
    assert.equal(settings?.disabledMcpjsonServers, undefined);
  });
});

test('setSkillDirectoryEnabled moves a personal skill both ways', async () => {
  await withFixture(async (fixture) => {
    await buildInstall(fixture);
    const enabledDir = path.join(fixture.home, '.claude', 'skills', 'alpha');
    const disabledDir = path.join(fixture.home, '.claude', 'skills.disabled', 'alpha');

    const dry = await setSkillDirectoryEnabled({
      skill: 'alpha',
      enabled: false,
      projectRoot: fixture.project,
      dryRun: true
    });
    assert.deepEqual(dry, { from: enabledDir, to: disabledDir, moved: false });
    assert.equal(await isDir(enabledDir), true);

    const off = await setSkillDirectoryEnabled({
      skill: 'alpha',
      enabled: false,
      projectRoot: fixture.project
    });
    assert.equal(off.moved, true);
    assert.equal(await isDir(enabledDir), false);
    assert.equal(await isDir(disabledDir), true);
    assert.equal(
      await readFile(path.join(disabledDir, 'SKILL.md'), 'utf8'),
      skill('alpha', 'First skill.')
    );

    const again = await setSkillDirectoryEnabled({
      skill: 'alpha',
      enabled: false,
      projectRoot: fixture.project
    });
    assert.deepEqual(again, { from: disabledDir, to: disabledDir, moved: false });

    const on = await setSkillDirectoryEnabled({
      skill: 'alpha',
      enabled: true,
      projectRoot: fixture.project
    });
    assert.equal(on.moved, true);
    assert.equal(await isDir(enabledDir), true);
  });
});

test('setSkillDirectoryEnabled refuses plugin, project, and unknown skills', async () => {
  await withFixture(async (fixture) => {
    await buildInstall(fixture);
    await assert.rejects(
      setSkillDirectoryEnabled({
        skill: 'demo:deploy',
        enabled: false,
        projectRoot: fixture.project
      }),
      /plugin skill/
    );
    await assert.rejects(
      setSkillDirectoryEnabled({ skill: 'gamma', enabled: false, projectRoot: fixture.project }),
      /project skill/
    );
    await assert.rejects(
      setSkillDirectoryEnabled({ skill: 'missing', enabled: false, projectRoot: fixture.project }),
      /no personal skill "missing"/
    );
    await assert.rejects(
      setSkillDirectoryEnabled({ skill: '../escape', enabled: false, projectRoot: fixture.project }),
      /not a plain skill directory name/
    );
  });
});

test('mutators refuse to edit a settings file they cannot parse', async () => {
  await withFixture(async (fixture) => {
    await write(path.join(fixture.home, '.claude', 'settings.json'), '{ oops');
    await assert.rejects(
      setSkillVisibility({ skill: 'alpha', visibility: 'off', projectRoot: fixture.project }),
      /refusing to edit/
    );
  });
});
