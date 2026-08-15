import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---/;

const catalogs = [
  {
    file: path.join(root, '.claude-plugin', 'marketplace.json'),
    sourceOf: (entry) => (typeof entry.source === 'string' ? entry.source : entry.source?.path)
  },
  {
    file: path.join(root, '.agents/plugins/marketplace.json'),
    sourceOf: (entry) => (typeof entry.source === 'string' ? entry.source : entry.source?.path)
  },
  {
    file: path.join(root, '.cursor-plugin/marketplace.json'),
    sourceOf: (entry) => (typeof entry.source === 'string' ? entry.source : entry.source?.path)
  }
];

const errors = [];

function fail(message) {
  errors.push(message);
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function mcpKeys(raw) {
  const wrapped = raw?.mcpServers;
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    return Object.keys(wrapped).sort();
  }
  return Object.keys(raw ?? {})
    .filter((key) => key !== '$schema')
    .sort();
}

function parseFrontmatter(raw) {
  const match = FENCE.exec(raw);
  if (!match) {
    return {};
  }
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyed = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (keyed) {
      data[keyed[1]] = keyed[2];
    }
  }
  return data;
}

const loaded = [];
for (const catalog of catalogs) {
  const json = JSON.parse(await readFile(catalog.file, 'utf8'));
  if (!json.name || !Array.isArray(json.plugins)) {
    fail(`${catalog.file} missing name or plugins`);
    continue;
  }
  loaded.push({
    file: catalog.file,
    names: json.plugins.map((plugin) => plugin.name).sort(),
    plugins: json.plugins,
    sourceOf: catalog.sourceOf
  });
}

if (loaded.length === 3) {
  const [first, ...rest] = loaded;
  for (const other of rest) {
    if (JSON.stringify(other.names) !== JSON.stringify(first.names)) {
      fail(`catalog plugin names diverge: ${path.relative(root, first.file)} vs ${path.relative(root, other.file)}`);
    }
  }
}

const seen = new Set();
for (const entry of loaded[0]?.plugins ?? []) {
  if (seen.has(entry.name)) {
    fail(`duplicate plugin ${entry.name}`);
  }
  seen.add(entry.name);
  const source = loaded[0].sourceOf(entry);
  if (!source) {
    fail(`${entry.name} has no source`);
    continue;
  }
  const pluginRoot = path.resolve(root, source);
  if (!(await exists(pluginRoot))) {
    fail(`missing plugin dir ${source}`);
    continue;
  }

  const manifests = [
    'plugin.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '.cursor-plugin/plugin.json'
  ];
  const versions = [];
  for (const rel of manifests) {
    const file = path.join(pluginRoot, rel);
    if (!(await exists(file))) {
      fail(`${entry.name} missing ${rel}`);
      continue;
    }
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    if (manifest.name !== entry.name) {
      fail(`${rel} name ${manifest.name} != ${entry.name}`);
    }
    if (!NAME_RE.test(manifest.name ?? '')) {
      fail(`${rel} name is not kebab-case`);
    }
    versions.push(manifest.version);
  }
  if (new Set(versions.filter(Boolean)).size > 1) {
    fail(`${entry.name} manifest versions diverge: ${versions.join(', ')}`);
  }

  const skillsDir = path.join(pluginRoot, 'skills');
  if (await exists(skillsDir)) {
    for (const dirent of await readdir(skillsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const skill = path.join(skillsDir, dirent.name, 'SKILL.md');
      if (!(await exists(skill))) {
        fail(`${entry.name} skill ${dirent.name} missing SKILL.md`);
        continue;
      }
      const raw = await readFile(skill, 'utf8');
      const data = parseFrontmatter(raw);
      if (!data.name || !data.description) {
        fail(`${skill} needs name and description frontmatter`);
      }
    }
  }

  // Plugin hooks are a single PascalCase hooks/hooks.json. Claude Code, Codex,
  // and Cursor all read that same file from a plugin; the camelCase form is the
  // developer's own .cursor/hooks.json, which is not a plugin file.
  if (await exists(path.join(pluginRoot, 'hooks/claude-hooks.json'))) {
    fail(`${entry.name} still has hooks/claude-hooks.json — plugin hooks belong in hooks/hooks.json`);
  }
  const hooksFile = path.join(pluginRoot, 'hooks/hooks.json');
  if (await exists(hooksFile)) {
    const hooks = JSON.parse(await readFile(hooksFile, 'utf8'));
    for (const event of Object.keys(hooks.hooks ?? {})) {
      if (event[0] !== event[0].toUpperCase()) {
        fail(`${entry.name} hooks/hooks.json event "${event}" must be PascalCase`);
      }
    }
  }

  const cursorManifest = JSON.parse(
    await readFile(path.join(pluginRoot, '.cursor-plugin/plugin.json'), 'utf8')
  );
  const codexManifest = JSON.parse(
    await readFile(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8')
  );
  if (await exists(skillsDir)) {
    for (const [label, manifest] of [
      ['.cursor-plugin', cursorManifest],
      ['.codex-plugin', codexManifest]
    ]) {
      if (!manifest.skills) {
        fail(`${entry.name} ${label}/plugin.json must declare "skills" so the client finds skills/`);
      }
    }
  }

  // .mcp.json is what Claude Code and Codex load. Cursor loads neither MCP
  // file — it reads mcpServers out of its own manifest — so a plugin shipping
  // MCP has to inline them there too.
  const claudeMcp = path.join(pluginRoot, '.mcp.json');
  const agentMcp = path.join(pluginRoot, 'mcp.json');
  if (!(await exists(claudeMcp)) && (await exists(agentMcp))) {
    fail(`${entry.name} ships mcp.json but no .mcp.json, so Claude Code and Codex load nothing`);
  }
  if (await exists(claudeMcp)) {
    const claude = JSON.parse(await readFile(claudeMcp, 'utf8'));
    const claudeKeys = mcpKeys(claude);

    if (await exists(agentMcp)) {
      const agent = JSON.parse(await readFile(agentMcp, 'utf8'));
      const agentKeys = mcpKeys(agent);
      if (JSON.stringify(claudeKeys) !== JSON.stringify(agentKeys)) {
        fail(`${entry.name} MCP server keys diverge: ${claudeKeys.join(',')} vs ${agentKeys.join(',')}`);
      }
      if (agent.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') {
        fail(`${entry.name} mcp.json missing Agent Plugins $schema`);
      }
      for (const key of agentKeys) {
        if (!agent.mcpServers?.[key]?.type) {
          fail(`${entry.name} mcp.json ${key} needs an explicit type`);
        }
      }
    }

    const cursorKeys = mcpKeys(cursorManifest.mcpServers ?? {});
    if (JSON.stringify(cursorKeys) !== JSON.stringify(claudeKeys)) {
      fail(
        `${entry.name} .cursor-plugin/plugin.json must inline mcpServers ${claudeKeys.join(',')} (found ${
          cursorKeys.join(',') || 'none'
        })`
      );
    }
    if (JSON.stringify(cursorManifest.mcpServers ?? {}).includes('CLAUDE_PLUGIN_ROOT')) {
      fail(`${entry.name} .cursor-plugin/plugin.json inlines \${CLAUDE_PLUGIN_ROOT}, which Cursor does not expand`);
    }
    if (codexManifest.mcpServers !== './.mcp.json' && typeof codexManifest.mcpServers !== 'object') {
      fail(`${entry.name} .codex-plugin/plugin.json must point mcpServers at "./.mcp.json"`);
    }
  }
}

const yardDist = path.join(root, 'plugins', 'yard', 'dist', 'cli.js');
const yardUi = path.join(root, 'plugins', 'yard', 'public', 'index.html');
if (!(await exists(yardDist))) {
  fail('plugins/yard/dist/cli.js missing. Run npm run build:server');
}
if (!(await exists(yardUi))) {
  fail('plugins/yard/public/index.html missing. Run npm run build:web');
}

if (errors.length) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(`ok ${seen.size} plugins`);
