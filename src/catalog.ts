import { existsSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { parsePluginMcp } from './mcp-spec.js';
import { CLAUDE_MARKETPLACE, PLUGINS_DIR, REPO_ROOT, SERVER_DIR } from './paths.js';
import {
  artifactId,
  type ArtifactKind,
  type ArtifactRecord,
  type PluginRecord
} from './types.js';

type MarketplacePlugin = {
  name: string;
  description?: string;
  version?: string;
  source: string | { path?: string; source?: string };
};

type MarketplaceFile = {
  plugins: MarketplacePlugin[];
};

export type CatalogSnapshot = {
  plugins: PluginRecord[];
  artifacts: ArtifactRecord[];
};

export class Catalog {
  private snapshot: CatalogSnapshot | undefined;

  constructor(private readonly root: string = REPO_ROOT) {}

  invalidate(): void {
    this.snapshot = undefined;
  }

  async load(): Promise<CatalogSnapshot> {
    if (this.snapshot) {
      return this.snapshot;
    }
    const marketplacePath = path.join(this.root, path.relative(REPO_ROOT, CLAUDE_MARKETPLACE));
    const plugins: PluginRecord[] = [];
    const artifacts: ArtifactRecord[] = [];

    if (await exists(marketplacePath)) {
      const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8')) as MarketplaceFile;
      for (const entry of marketplace.plugins) {
        const source = pluginSource(entry);
        const pluginRoot = path.resolve(this.root, source);
        const plugin: PluginRecord = {
          name: entry.name,
          description: entry.description ?? '',
          version: entry.version ?? '0.0.0',
          source,
          root: pluginRoot
        };
        plugins.push(plugin);
        artifacts.push(...(await scanPlugin(plugin)));
      }
    } else {
      const self = selfPlugin();
      if (self) {
        plugins.push(self);
        artifacts.push(...(await scanPlugin(self)));
      }
    }

    this.snapshot = { plugins, artifacts };
    return this.snapshot;
  }

  async plugin(name: string): Promise<PluginRecord> {
    const { plugins } = await this.load();
    const found = plugins.find((item) => item.name === name);
    if (!found) {
      throw new Error(`unknown plugin: ${name}`);
    }
    return found;
  }

  async artifact(id: string): Promise<ArtifactRecord> {
    const { artifacts } = await this.load();
    const found = artifacts.find((item) => item.id === id);
    if (!found) {
      throw new Error(`unknown artifact: ${id}`);
    }
    return found;
  }
}

function pluginSource(entry: MarketplacePlugin): string {
  if (typeof entry.source === 'string') {
    return entry.source;
  }
  if (entry.source.path) {
    return entry.source.path;
  }
  throw new Error(`plugin ${entry.name} has no resolvable source`);
}

async function scanPlugin(plugin: PluginRecord): Promise<ArtifactRecord[]> {
  const found: ArtifactRecord[] = [];
  found.push(...(await scanSkills(plugin)));
  found.push(...(await scanMarkdownKind(plugin, 'rule', 'rules', ['.mdc', '.md', '.markdown'])));
  found.push(...(await scanMarkdownKind(plugin, 'agent', 'agents', ['.md', '.mdc', '.markdown'])));
  found.push(...(await scanMarkdownKind(plugin, 'command', 'commands', ['.md', '.mdc', '.markdown', '.txt'])));
  found.push(...(await scanHooks(plugin)));
  found.push(...(await scanMcp(plugin)));
  return found;
}

async function scanSkills(plugin: PluginRecord): Promise<ArtifactRecord[]> {
  const dir = path.join(plugin.root, 'skills');
  if (!(await exists(dir))) {
    return [];
  }
  const records: ArtifactRecord[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!(await exists(file))) {
      continue;
    }
    records.push(await readMarkdownArtifact(plugin, 'skill', entry.name, file));
  }
  return records;
}

async function scanMarkdownKind(
  plugin: PluginRecord,
  kind: ArtifactKind,
  directory: string,
  extensions: string[]
): Promise<ArtifactRecord[]> {
  const dir = path.join(plugin.root, directory);
  if (!(await exists(dir))) {
    return [];
  }
  const records: ArtifactRecord[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name);
    if (!extensions.includes(ext)) {
      continue;
    }
    const name = path.basename(entry.name, ext);
    records.push(await readMarkdownArtifact(plugin, kind, name, path.join(dir, entry.name)));
  }
  return records;
}

async function scanHooks(plugin: PluginRecord): Promise<ArtifactRecord[]> {
  const dir = path.join(plugin.root, 'hooks');
  if (!(await exists(dir))) {
    return [];
  }
  // One file, PascalCase, read by Claude Code, Codex, and Cursor alike.
  const file = path.join(dir, 'hooks.json');
  if (!(await exists(file))) {
    return [];
  }
  const raw = await readFile(file, 'utf8');
  let description = `${plugin.name} hooks`;
  try {
    description = (JSON.parse(raw) as { description?: string }).description ?? description;
  } catch {
    // A malformed hooks file still belongs in the catalog so doctor can report
    // it; only the description is lost.
  }
  return [
    {
      id: artifactId(plugin.name, 'hook', 'hooks'),
      plugin: plugin.name,
      kind: 'hook',
      name: 'hooks',
      description,
      path: file,
      version: plugin.version,
      body: raw,
      raw
    }
  ];
}

async function scanMcp(plugin: PluginRecord): Promise<ArtifactRecord[]> {
  const specs = await parsePluginMcp(plugin.name, plugin.root);
  return specs.map((spec) => {
    const raw = JSON.stringify(spec, null, 2);
    return {
      id: artifactId(plugin.name, 'mcp', spec.key),
      plugin: plugin.name,
      kind: 'mcp' as const,
      name: spec.key,
      description:
        spec.transport.type === 'stdio'
          ? `${plugin.name} MCP ${spec.key} (${spec.transport.command})`
          : `${plugin.name} MCP ${spec.key} (${spec.transport.url})`,
      path: path.join(plugin.root, '.mcp.json'),
      version: plugin.version,
      body: raw,
      raw
    };
  });
}

function selfPlugin(): PluginRecord | undefined {
  if (!existsSync(path.join(SERVER_DIR, '.claude-plugin', 'plugin.json'))) {
    return undefined;
  }
  return {
    name: 'yard',
    description: 'Yard control plane',
    version: '0.1.0',
    source: SERVER_DIR,
    root: SERVER_DIR
  };
}

async function readMarkdownArtifact(
  plugin: PluginRecord,
  kind: ArtifactKind,
  fallbackName: string,
  file: string
): Promise<ArtifactRecord> {
  const raw = await readFile(file, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  return {
    id: artifactId(plugin.name, kind, data.name ?? fallbackName),
    plugin: plugin.name,
    kind,
    name: data.name ?? fallbackName,
    description: data.description ?? '',
    path: file,
    version: plugin.version,
    body,
    raw
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function assertInsideRoot(file: string, root: string): Promise<string> {
  const resolved = await realpath(file);
  const resolvedRoot = await realpath(root);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error('path escapes plugin root');
  }
  return resolved;
}

export function indexOf(artifact: ArtifactRecord): Omit<ArtifactRecord, 'body' | 'raw'> {
  const { body: _body, raw: _raw, ...index } = artifact;
  return index;
}

export { PLUGINS_DIR };
