import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  addMcpServer,
  parseToml,
  removeMcpServer,
  scanCodex,
  setSkillDirectoryEnabled
} from './codex.js';
import { isDir } from './safe-io.js';

type Fixture = {
  home: string;
  codex: string;
  project: string;
};

async function write(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-codex-'));
  const previousHome = process.env.YARD_HOME;
  const previousBin = process.env.YARD_CODEX_BIN;
  process.env.YARD_HOME = dir;
  try {
    await run({
      home: dir,
      codex: path.join(dir, '.codex'),
      project: path.join(dir, 'project')
    });
  } finally {
    restore('YARD_HOME', previousHome);
    restore('YARD_CODEX_BIN', previousBin);
    await rm(dir, { recursive: true, force: true });
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const CONFIG = `# Codex settings
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"

  [projects."/home/ubuntu"]
    trust_level = "trusted"

  [mcp_servers.context7]
    type = "http"
    url = "https://mcp.context7.com/mcp"

    [mcp_servers.context7.http_headers]
      Authorization = "Bearer ctx7sk-secret"

  [mcp_servers.webstorm]
    url = "http://127.0.0.1:64542/stream"

  [mcp_servers.local-tools]
    command = "node"
    args = ["./server.js", "--stdio"]
    cwd = "/srv/tools"
    startup_timeout_ms = 20000
    enabled = false

    [mcp_servers.local-tools.env]
      KEY = "value"
`;

const HOOKS = JSON.stringify(
  {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: 'paseo hooks codex UserPromptSubmit',
              commandWindows: 'paseo.exe hooks codex UserPromptSubmit',
              timeout: 10
            }
          ]
        }
      ],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard bash' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'guard write' }] }
      ]
    }
  },
  null,
  2
);

async function buildFixture(fixture: Fixture): Promise<void> {
  const { codex, project } = fixture;
  await write(path.join(codex, 'config.toml'), CONFIG);
  await write(path.join(codex, 'hooks.json'), HOOKS);
  await write(
    path.join(codex, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: The alpha skill.\n---\n\nBody.\n'
  );
  await write(
    path.join(codex, 'skills.disabled', 'beta', 'SKILL.md'),
    '---\nname: beta\ndescription: The beta skill.\n---\n\nBody.\n'
  );
  await mkdir(path.join(codex, 'skills', 'empty'), { recursive: true });
  await write(
    path.join(codex, 'skills', '.system', 'skill-creator', 'SKILL.md'),
    '---\nname: skill-creator\ndescription: Create or update a skill.\n---\n'
  );
  await write(path.join(codex, 'skills', '.system', '.codex-system-skills.marker'), '');

  const pluginRoot = path.join(codex, 'plugins', 'cache', 'openai-curated', 'github', '0.1.6');
  await write(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'github',
      version: '0.1.6',
      description: 'Triage PRs and issues.',
      skills: './skills/',
      mcpServers: './.mcp.json',
      hooks: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gh cleanup' }] }] } },
      interface: { displayName: 'GitHub' }
    })
  );
  await write(
    path.join(pluginRoot, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        githubWidgets: { command: 'node', args: ['./mcp/server.cjs'], cwd: '.' }
      }
    })
  );
  await write(
    path.join(pluginRoot, 'skills', 'gh-fix-ci', 'SKILL.md'),
    '---\nname: gh-fix-ci\ndescription: Fix failing CI.\n---\n'
  );
  await write(
    path.join(codex, 'plugins', 'cache', 'openai-curated', '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'openai-curated',
      interface: { displayName: 'Codex official' },
      plugins: [
        { name: 'github', source: { source: 'local', path: './plugins/github' } },
        {
          name: 'linear',
          description: 'Linear issues.',
          source: { source: 'local', path: './plugins/linear' },
          policy: { installation: 'AVAILABLE' },
          category: 'Productivity'
        }
      ]
    })
  );

  await write(path.join(codex, 'AGENTS.md'), '# User memory\n');
  await write(path.join(project, 'AGENTS.md'), '# Project memory\n');
}

test('parseToml reads the live config.toml shape', () => {
  const parsed = parseToml(CONFIG);
  assert.equal(parsed['model'], 'gpt-5.6-sol');
  assert.equal(parsed['model_reasoning_effort'], 'xhigh');

  const projects = parsed['projects'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(projects['/home/ubuntu'], { trust_level: 'trusted' });

  const servers = parsed['mcp_servers'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers['context7'], {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
    http_headers: { Authorization: 'Bearer ctx7sk-secret' }
  });
  assert.deepEqual(servers['local-tools'], {
    command: 'node',
    args: ['./server.js', '--stdio'],
    cwd: '/srv/tools',
    startup_timeout_ms: 20000,
    enabled: false,
    env: { KEY: 'value' }
  });
});

test('parseToml handles quoted keys with dots and slashes', () => {
  const parsed = parseToml(
    '[hooks.state."/home/ubuntu/.codex/hooks.json:pre_tool_use:0:0"]\n  trusted_hash = "sha256:abc"\n'
  );
  const state = (parsed['hooks'] as Record<string, Record<string, unknown>>)['state'];
  assert.deepEqual(state, {
    '/home/ubuntu/.codex/hooks.json:pre_tool_use:0:0': { trusted_hash: 'sha256:abc' }
  });
});

test('parseToml handles scalars, arrays, inline tables and comments', () => {
  const parsed = parseToml(
    [
      '# leading comment',
      '',
      'count = 42            # trailing comment',
      'negative = -7',
      'ratio = 0.5',
      'exponent = 1e3',
      'hex = 0xff',
      'yes = true',
      'no = false',
      'when = 2024-01-02T03:04:05Z',
      'literal = \'C:\\path\\raw\'',
      'escaped = "line\\nbreak"',
      'inline = { a = 1, b = "two" }',
      'spread = [',
      '  "one",',
      '  "two",   # comment inside',
      ']',
      '',
      '[[step]]',
      'name = "first"',
      '',
      '[[step]]',
      'name = "second"'
    ].join('\n')
  );

  assert.equal(parsed['count'], 42);
  assert.equal(parsed['negative'], -7);
  assert.equal(parsed['ratio'], 0.5);
  assert.equal(parsed['exponent'], 1000);
  assert.equal(parsed['hex'], 255);
  assert.equal(parsed['yes'], true);
  assert.equal(parsed['no'], false);
  assert.equal(parsed['when'], '2024-01-02T03:04:05Z');
  assert.equal(parsed['literal'], 'C:\\path\\raw');
  assert.equal(parsed['escaped'], 'line\nbreak');
  assert.deepEqual(parsed['inline'], { a: 1, b: 'two' });
  assert.deepEqual(parsed['spread'], ['one', 'two']);
  assert.deepEqual(parsed['step'], [{ name: 'first' }, { name: 'second' }]);
});

test('parseToml reads values that span several lines', () => {
  const parsed = parseToml(
    [
      'basic = """',
      'line one',
      'line two\\',
      '   joined"""',
      "literal = '''",
      'C:\\raw\\path',
      "'''",
      'table = { x = 1,',
      '  y = "two" }',
      'rows = [',
      '  { name = "a" },',
      '  { name = "b" }',
      ']',
      'after = 1'
    ].join('\n')
  );

  // A trailing backslash swallows the newline and the indent after it.
  assert.equal(parsed['basic'], 'line one\nline twojoined');
  assert.equal(parsed['literal'], 'C:\\raw\\path\n');
  assert.deepEqual(parsed['table'], { x: 1, y: 'two' });
  assert.deepEqual(parsed['rows'], [{ name: 'a' }, { name: 'b' }]);
  // Parsing resumed on the right line after each multi-line value.
  assert.equal(parsed['after'], 1);
  assert.equal(parseToml('a = "\\u00e9\\U0001F600"\n')['a'], 'é😀');
});

test('parseToml reports where a malformed line is', () => {
  assert.throws(() => parseToml('a = """\nnever closed\n'), /line 3: unterminated multi-line string/);
  assert.throws(() => parseToml('a = [1,\n2,\n'), /line 3: unterminated array/);
  assert.throws(() => parseToml('a = "\\q"\n'), /line 1: unknown escape/);
  assert.throws(() => parseToml('[]\n'), /line 1/);
  assert.throws(() => parseToml('model = "gpt"\nbroken\n'), /line 2/);
  assert.throws(() => parseToml('[unterminated\n'), /line 1/);
});

test('scanCodex reads a complete install', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    const scan = await scanCodex(fixture.project);

    assert.equal(scan.installed, true);

    const context7 = scan.mcpServers.find((entry) => entry.name === 'context7');
    assert.equal(context7?.transport, 'http');
    assert.equal(context7?.url, 'https://mcp.context7.com/mcp');
    assert.deepEqual(context7?.headers, { Authorization: 'Bearer ctx7sk-secret' });
    assert.equal(context7?.enabled, true);
    assert.equal(context7?.enabledSource, undefined);

    // No `type`, but a url: still an HTTP server.
    assert.equal(scan.mcpServers.find((entry) => entry.name === 'webstorm')?.transport, 'http');

    const local = scan.mcpServers.find((entry) => entry.name === 'local-tools');
    assert.equal(local?.transport, 'stdio');
    assert.equal(local?.command, 'node');
    assert.deepEqual(local?.args, ['./server.js', '--stdio']);
    assert.deepEqual(local?.env, { KEY: 'value' });
    assert.equal(local?.cwd, '/srv/tools');
    assert.equal(local?.enabled, false);
    assert.equal(local?.enabledSource, path.join(fixture.codex, 'config.toml'));

    const pluginMcp = scan.mcpServers.find((entry) => entry.name === 'githubWidgets');
    assert.equal(pluginMcp?.scope, 'plugin');
    assert.equal(pluginMcp?.plugin, 'github');
    assert.ok(pluginMcp?.file.endsWith('.mcp.json'));
    // The probe needs this to resolve `cwd: "."` and any plugin-root variable
    // against the plugin's own directory instead of Yard's process cwd.
    assert.equal(
      pluginMcp?.pluginRoot,
      path.join(fixture.codex, 'plugins/cache/openai-curated/github/0.1.6')
    );

    assert.deepEqual(
      scan.hooks.map((hook) => [hook.event, hook.index, hook.command]),
      [
        ['UserPromptSubmit', 0, 'paseo hooks codex UserPromptSubmit'],
        ['PreToolUse', 0, 'guard bash'],
        ['PreToolUse', 1, 'guard write'],
        // Declared inline in the plugin manifest rather than in a hooks.json.
        ['Stop', 0, 'gh cleanup']
      ]
    );
    const pluginHook = scan.hooks.find((hook) => hook.event === 'Stop');
    assert.equal(pluginHook?.scope, 'plugin');
    assert.equal(pluginHook?.plugin, 'github');
    assert.ok(pluginHook?.file.endsWith(path.join('.codex-plugin', 'plugin.json')));
    assert.equal(
      pluginHook?.pluginRoot,
      path.join(fixture.codex, 'plugins/cache/openai-curated/github/0.1.6')
    );
    const [first] = scan.hooks;
    assert.equal(first?.timeout, 10);
    assert.equal(first?.matcher, '');
    assert.equal(first?.scope, 'user');
    // hooks.json is never rewritten, so `commandWindows` survives on disk even
    // though HookEntry has nowhere to put it.
    assert.equal('commandWindows' in (first ?? {}), false);
    assert.equal(scan.hooks.every((hook) => hook.enabled), true);

    const alpha = scan.skills.find((skill) => skill.name === 'alpha');
    assert.equal(alpha?.visibility, 'on');
    assert.equal(alpha?.scope, 'user');
    assert.equal(alpha?.description, 'The alpha skill.');
    assert.equal(alpha?.id, 'codex:user:alpha');
    assert.ok((alpha?.bytes ?? 0) > 0);

    const beta = scan.skills.find((skill) => skill.name === 'beta');
    assert.equal(beta?.visibility, 'off');
    assert.equal(beta?.visibilitySource, path.join(fixture.codex, 'skills.disabled'));

    const builtin = scan.skills.find((skill) => skill.name === 'skill-creator');
    assert.equal(builtin?.scope, 'builtin');
    assert.equal(builtin?.visibility, 'on');
    // `.system` itself is not a skill.
    assert.equal(scan.skills.some((skill) => skill.name === '.system'), false);

    const pluginSkill = scan.skills.find((skill) => skill.name === 'gh-fix-ci');
    assert.equal(pluginSkill?.scope, 'plugin');
    assert.equal(pluginSkill?.qualifiedName, 'github:gh-fix-ci');
    assert.equal(pluginSkill?.plugin, 'github');

    const github = scan.plugins.find((plugin) => plugin.name === 'github');
    assert.equal(github?.installed, true);
    assert.equal(github?.version, '0.1.6');
    assert.equal(github?.marketplace, 'openai-curated');
    assert.equal(github?.skills, 1);
    assert.equal(github?.mcpServers, 1);
    assert.equal(github?.hooks, 1);
    // No "apps" field declared, so this must stay absent rather than 0 — the
    // doctor's plugin-empty check treats presence, not value, as the signal.
    assert.equal(github?.otherContributions, undefined);
    // The manifest lives one version directory below the plugin directory.
    assert.equal(github?.root, path.join(fixture.codex, 'plugins/cache/openai-curated/github/0.1.6'));

    const linear = scan.plugins.find((plugin) => plugin.name === 'linear');
    assert.equal(linear?.installed, false);
    assert.equal(linear?.root, undefined);
    assert.equal(scan.plugins.filter((plugin) => plugin.name === 'github').length, 1);

    assert.deepEqual(
      scan.memory.map((entry) => [entry.scope, entry.name]),
      [
        ['user', 'AGENTS.md'],
        ['project', 'AGENTS.md']
      ]
    );

    assert.deepEqual(scan.agents, []);
    assert.deepEqual(scan.commands, []);

    // The one skill directory without a SKILL.md is the only complaint.
    assert.deepEqual(
      scan.warnings.map((warning) => warning.file),
      [path.join(fixture.codex, 'skills', 'empty', 'SKILL.md')]
    );
  });
});

test('scanCodex reports nothing when Codex is not installed', async () => {
  await withFixture(async (fixture) => {
    const scan = await scanCodex(fixture.project);
    assert.deepEqual(scan, {
      installed: false,
      skills: [],
      plugins: [],
      mcpServers: [],
      hooks: [],
      agents: [],
      commands: [],
      memory: [],
      warnings: []
    });
  });
});

test('a malformed config.toml warns instead of blanking the inventory', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    await write(path.join(fixture.codex, 'config.toml'), 'model = "gpt"\n[mcp_servers.oops\n');
    const scan = await scanCodex(fixture.project);

    assert.equal(scan.mcpServers.some((entry) => entry.scope === 'user'), false);
    // Everything that does not come from config.toml is still there.
    assert.equal(scan.hooks.length, 4);
    assert.equal(scan.skills.length, 4);
    assert.equal(scan.plugins.length, 2);
    const warning = scan.warnings.find(
      (item) => item.file === path.join(fixture.codex, 'config.toml')
    );
    assert.equal(warning?.client, 'codex');
    assert.match(warning?.message ?? '', /could not parse TOML/);
  });
});

test('a malformed hooks.json warns instead of throwing', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    await write(path.join(fixture.codex, 'hooks.json'), '{ "hooks": { ');
    const scan = await scanCodex(fixture.project);

    assert.equal(scan.hooks.some((hook) => hook.scope === 'user'), false);
    assert.equal(scan.mcpServers.length, 4);
    const warning = scan.warnings.find(
      (item) => item.file === path.join(fixture.codex, 'hooks.json')
    );
    assert.match(warning?.message ?? '', /could not parse JSON/);
  });
});

test('a malformed plugin manifest warns and the plugin still lists', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    const manifest = path.join(
      fixture.codex,
      'plugins/cache/openai-curated/github/0.1.6/.codex-plugin/plugin.json'
    );
    await write(manifest, '{ "name": ');
    const scan = await scanCodex(fixture.project);

    const github = scan.plugins.find((plugin) => plugin.root?.includes('github'));
    assert.equal(github?.name, 'github');
    assert.equal(github?.version, '0.1.6');
    assert.match(
      scan.warnings.find((item) => item.file === manifest)?.message ?? '',
      /could not parse JSON/
    );
  });
});

test('a plugin whose only contribution is an "apps" mapping reports it instead of reading as empty', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    const root = path.join(fixture.codex, 'plugins/cache/openai-curated/datadog/0.3.0');
    await write(
      path.join(root, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'datadog',
        version: '0.3.0',
        description: 'Monitor dashboards and incidents from Codex.',
        apps: './.app.json'
      })
    );
    await write(
      path.join(root, '.app.json'),
      JSON.stringify({ apps: { datadog: { id: 'asdk_app_69a1d78e929881919bba0dbda1f6436d' } } })
    );

    const scan = await scanCodex(fixture.project);

    const datadog = scan.plugins.find((plugin) => plugin.name === 'datadog');
    assert.equal(datadog?.installed, true);
    assert.equal(datadog?.skills, 0);
    assert.equal(datadog?.mcpServers, 0);
    assert.equal(datadog?.hooks, 0);
    assert.equal(datadog?.otherContributions, 1);
  });
});

test('an "apps" reference outside the plugin directory warns instead of resolving', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    const root = path.join(fixture.codex, 'plugins/cache/openai-curated/rogue-app/1.0.0');
    await write(
      path.join(root, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'rogue-app', apps: '/etc/shadow' })
    );

    const scan = await scanCodex(fixture.project);

    const rogue = scan.plugins.find((plugin) => plugin.name === 'rogue-app');
    assert.equal(rogue?.otherContributions, undefined);
    assert.match(
      scan.warnings.find((item) => item.file.endsWith(path.join('rogue-app/1.0.0/.codex-plugin/plugin.json')))
        ?.message ?? '',
      /points outside the plugin directory/
    );
  });
});

test('a symlinked skill is scanned, and a dangling link is reported', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    // Sharing one skill directory across clients by symlink is routine, and
    // readdir reports a symlink as a link rather than as a directory.
    const shared = path.join(fixture.home, 'shared', 'linked');
    await write(path.join(shared, 'SKILL.md'), '---\nname: linked\ndescription: Shared.\n---\n');
    await symlink(shared, path.join(fixture.codex, 'skills', 'linked'));
    await symlink(path.join(fixture.home, 'gone'), path.join(fixture.codex, 'skills', 'dangling'));

    const scan = await scanCodex(fixture.project);

    const linked = scan.skills.find((skill) => skill.name === 'linked');
    assert.equal(linked?.description, 'Shared.');
    assert.equal(linked?.scope, 'user');
    assert.equal(linked?.visibility, 'on');
    assert.equal(
      scan.skills.some((skill) => skill.name === 'dangling'),
      false
    );
    assert.match(
      scan.warnings.find(
        (item) => item.file === path.join(fixture.codex, 'skills', 'dangling')
      )?.message ?? '',
      /does not resolve to a directory/
    );
  });
});

test('a file Codex cannot read is a warning, not an empty inventory', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    const config = path.join(fixture.codex, 'config.toml');
    await chmod(config, 0o000);
    // A directory where a file belongs reads as ENOTDIR/EISDIR, which is just
    // as unreadable.
    await rm(path.join(fixture.codex, 'hooks.json'));
    await mkdir(path.join(fixture.codex, 'hooks.json'), { recursive: true });
    await mkdir(path.join(fixture.codex, 'skills', 'alpha', 'SKILL.md.d'), { recursive: true });

    const scan = await scanCodex(fixture.project);

    // Everything readable is still reported.
    assert.equal(scan.skills.length, 4);
    assert.equal(scan.plugins.length, 2);
    const unreadable = scan.warnings.filter((item) => /could not be read/.test(item.message));
    const files = unreadable.map((item) => item.file);
    if (process.getuid?.() !== 0) {
      assert.ok(files.includes(config), `expected a warning for ${config}, got ${files.join()}`);
      assert.equal(
        scan.mcpServers.some((entry) => entry.scope === 'user'),
        false
      );
    }
    assert.ok(files.includes(path.join(fixture.codex, 'hooks.json')));
    await chmod(config, 0o600);
  });
});

test('config.toml oddities warn rather than disappear', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    const config = path.join(fixture.codex, 'config.toml');

    // A byte-order mark must not cost the developer their whole config.
    await write(config, `﻿model = "gpt"\n[mcp_servers.a]\ncommand = "node"\n`);
    const withBom = await scanCodex(fixture.project);
    assert.deepEqual(
      withBom.mcpServers.filter((entry) => entry.scope === 'user').map((entry) => entry.name),
      ['a']
    );

    // `mcp_servers` written as an array of tables is not a table, and silence
    // would read as "you have no MCP servers".
    await write(config, '[[mcp_servers]]\nname = "a"\n');
    const wrongShape = await scanCodex(fixture.project);
    assert.equal(
      wrongShape.mcpServers.some((entry) => entry.scope === 'user'),
      false
    );
    assert.match(
      wrongShape.warnings.find((item) => item.file === config)?.message ?? '',
      /mcp_servers is not a table/
    );

    // An empty config is a legitimate state, not a problem to report.
    await write(config, '');
    const empty = await scanCodex(fixture.project);
    assert.deepEqual(
      empty.warnings.filter((item) => item.file === config),
      []
    );
  });
});

test('a plugin manifest cannot point the scan outside the plugin directory', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    // A skill sitting outside every Codex path. Nothing in a manifest should
    // be able to pull it into the inventory.
    await write(
      path.join(fixture.home, 'outside', 'SKILL.md'),
      '---\nname: outside\ndescription: Not a Codex skill.\n---\n'
    );
    const root = path.join(fixture.codex, 'plugins/cache/openai-curated/rogue/1.0.0');
    await write(
      path.join(root, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'rogue',
        skills: ['../../../../../outside', './skills/'],
        mcpServers: '/etc/hosts',
        hooks: '../../../../../../hooks.json',
        apps: '/etc/shadow'
      })
    );

    const scan = await scanCodex(fixture.project);

    assert.equal(
      scan.skills.some((skill) => skill.name === 'outside'),
      false
    );
    const escapes = scan.warnings.filter((item) =>
      /points outside the plugin directory/.test(item.message)
    );
    assert.equal(escapes.length, 4, JSON.stringify(scan.warnings, null, 2));
    assert.equal(
      escapes.every((item) => item.file === path.join(root, '.codex-plugin', 'plugin.json')),
      true
    );
    // The plugin itself still lists, just with nothing in it.
    const rogue = scan.plugins.find((plugin) => plugin.name === 'rogue');
    assert.equal(rogue?.skills, 0);
    assert.equal(rogue?.mcpServers, 0);
    assert.equal(rogue?.hooks, 0);
    assert.equal(rogue?.otherContributions, undefined);
  });
});

test('a plugin named differently from its cache directory is listed once', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    const marketplace = path.join(fixture.codex, 'plugins/cache/openai-curated');
    await write(
      path.join(marketplace, 'linear', '0.2.0', '.codex-plugin', 'plugin.json'),
      // The cache directory is `linear`; the manifest calls it `linear`, and
      // the marketplace lists it — one entry, not two.
      JSON.stringify({ name: 'linear', version: '0.2.0' })
    );
    await write(
      path.join(marketplace, 'gh-pr', '0.1.0', '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'github', version: '0.1.0' })
    );

    const scan = await scanCodex(fixture.project);

    assert.deepEqual(
      scan.plugins.filter((plugin) => plugin.name === 'linear').map((plugin) => plugin.installed),
      [true]
    );
    // Two installed plugins both calling themselves `github` keep distinct
    // ids, so indexing the inventory by id cannot lose one.
    assert.deepEqual(
      scan.plugins.filter((plugin) => plugin.name === 'github').map((plugin) => plugin.id),
      ['codex:plugin:github', 'codex:plugin:github@openai-curated']
    );
    const ids = scan.plugins.map((plugin) => plugin.id);
    assert.equal(new Set(ids).size, ids.length, ids.join());
  });
});

test('setSkillDirectoryEnabled moves the skill directory both ways', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);
    const enabled = path.join(fixture.codex, 'skills', 'alpha');
    const disabled = path.join(fixture.codex, 'skills.disabled', 'alpha');

    const dry = await setSkillDirectoryEnabled({ skill: 'alpha', enabled: false, dryRun: true });
    assert.deepEqual(dry, { from: enabled, to: disabled, moved: false });
    assert.equal(await isDir(enabled), true);

    const off = await setSkillDirectoryEnabled({ skill: 'alpha', enabled: false });
    assert.equal(off.moved, true);
    assert.equal(await isDir(enabled), false);
    assert.equal(await isDir(disabled), true);

    // Already disabled: nothing left to move.
    assert.equal((await setSkillDirectoryEnabled({ skill: 'alpha', enabled: false })).moved, false);

    const on = await setSkillDirectoryEnabled({ skill: 'alpha', enabled: true });
    assert.equal(on.moved, true);
    assert.equal(await isDir(enabled), true);
  });
});

test('setSkillDirectoryEnabled refuses anything that is not a plain skill name', async () => {
  await withFixture(async (fixture) => {
    await buildFixture(fixture);

    // A typo must not report success: nothing was disabled.
    await assert.rejects(
      () => setSkillDirectoryEnabled({ skill: 'ghost', enabled: false }),
      /no personal skill "ghost"/
    );
    // A path, not a name. Before this check both sides resolved outside the
    // skills directories entirely.
    for (const skill of ['../evil', '../../evil', 'nested/skill', '.hidden', '']) {
      await assert.rejects(
        () => setSkillDirectoryEnabled({ skill, enabled: false }),
        /is not a plain skill directory name/,
        skill
      );
    }
    await assert.rejects(
      () => setSkillDirectoryEnabled({ skill: 'github:gh-fix-ci', enabled: false }),
      /is a plugin skill/
    );
    // Nothing above touched disk.
    assert.equal(await isDir(path.join(fixture.codex, 'skills', 'alpha')), true);
    assert.equal(await isDir(path.join(fixture.home, 'evil')), false);

    await mkdir(path.join(fixture.codex, 'skills.disabled', 'alpha'), { recursive: true });
    await assert.rejects(
      () => setSkillDirectoryEnabled({ skill: 'alpha', enabled: false }),
      /exists in both/
    );
  });
});

async function fakeCodex(fixture: Fixture): Promise<string> {
  const log = path.join(fixture.home, 'argv.log');
  const bin = path.join(fixture.home, 'codex-fake.cjs');
  await write(
    bin,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "process.stdout.write('added');"
    ].join('\n')
  );
  await chmod(bin, 0o755);
  process.env.YARD_CODEX_BIN = bin;
  return log;
}

async function loggedArgv(log: string): Promise<string[][]> {
  const raw = await readFile(log, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

test('addMcpServer delegates stdio and HTTP servers to the codex CLI', async () => {
  await withFixture(async (fixture) => {
    const log = await fakeCodex(fixture);

    const stdio = await addMcpServer({
      name: 'local-tools',
      command: 'node',
      args: ['./server.js', '--stdio'],
      env: { KEY: 'value' }
    });
    assert.equal(stdio.ran, true);
    assert.equal(stdio.stdout, 'added');

    await addMcpServer({
      name: 'context7',
      url: 'https://mcp.context7.com/mcp',
      bearerTokenEnvVar: 'CONTEXT7_TOKEN'
    });
    await removeMcpServer('context7');

    assert.deepEqual(await loggedArgv(log), [
      ['mcp', 'add', 'local-tools', '--env', 'KEY=value', '--', 'node', './server.js', '--stdio'],
      [
        'mcp',
        'add',
        'context7',
        '--bearer-token-env-var',
        'CONTEXT7_TOKEN',
        '--url',
        'https://mcp.context7.com/mcp'
      ],
      ['mcp', 'remove', 'context7']
    ]);
  });
});

test('a dry run reports the command without running it', async () => {
  await withFixture(async (fixture) => {
    const log = await fakeCodex(fixture);
    const result = await addMcpServer({ name: 'x', command: 'node', dryRun: true });
    assert.equal(result.ran, false);
    assert.deepEqual(result.argv, ['mcp', 'add', 'x', '--', 'node']);
    assert.deepEqual(await removeMcpServer('x', { dryRun: true }), {
      argv: ['mcp', 'remove', 'x'],
      ran: false,
      stdout: '',
      stderr: ''
    });
    await assert.rejects(() => readFile(log, 'utf8'));
  });
});

test('addMcpServer refuses an ambiguous server definition', async () => {
  await withFixture(async () => {
    await assert.rejects(
      () => addMcpServer({ name: 'x', command: 'node', url: 'https://example.com' }),
      /exactly one of command or url/
    );
    await assert.rejects(() => addMcpServer({ name: 'x' }), /exactly one of command or url/);
    // A name that looks like a flag would be read as one by the CLI.
    await assert.rejects(
      () => addMcpServer({ name: '--url', command: 'node', dryRun: true }),
      /is not a usable MCP server name/
    );
    await assert.rejects(
      () => removeMcpServer('', { dryRun: true }),
      /is not a usable MCP server name/
    );
  });
});

test('a missing codex binary names the config file to edit by hand', async () => {
  await withFixture(async (fixture) => {
    process.env.YARD_CODEX_BIN = path.join(fixture.home, 'no-such-codex');
    await assert.rejects(
      () => removeMcpServer('context7'),
      (error: Error) => {
        assert.match(error.message, /not installed or not on PATH/);
        assert.ok(error.message.includes(path.join(fixture.codex, 'config.toml')));
        return true;
      }
    );
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a hanging codex invocation is killed, not left running', async () => {
  await withFixture(async (fixture) => {
    const pidFile = path.join(fixture.home, 'child.pid');
    const bin = path.join(fixture.home, 'codex-hangs.cjs');
    await write(
      bin,
      [
        '#!/usr/bin/env node',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'setInterval(() => {}, 1000);'
      ].join('\n')
    );
    await chmod(bin, 0o755);
    process.env.YARD_CODEX_BIN = bin;

    await assert.rejects(() => removeMcpServer('slow', { timeoutMs: 250 }), /failed/);

    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(pid > 0);
    for (let attempt = 0; attempt < 40 && alive(pid); attempt += 1) {
      await delay(25);
    }
    assert.equal(alive(pid), false, `codex child ${pid} outlived its timeout`);
  });
});

test('a failing codex invocation surfaces its stderr', async () => {
  await withFixture(async (fixture) => {
    const bin = path.join(fixture.home, 'codex-fails.cjs');
    await write(
      bin,
      ['#!/usr/bin/env node', "process.stderr.write('no such server');", 'process.exit(1);'].join('\n')
    );
    await chmod(bin, 0o755);
    process.env.YARD_CODEX_BIN = bin;
    await assert.rejects(() => removeMcpServer('ghost'), /no such server/);
  });
});
