import { execFile } from 'node:child_process';
import { mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseFrontmatter } from '../frontmatter.js';
import { codexPaths } from './client-paths.js';
import { collectSkillDirs } from './skill-dirs.js';
import { exists, isDir, isFile, listDirs, readJsonChecked, readText } from './safe-io.js';
import type {
  AgentEntry,
  CommandEntry,
  HookEntry,
  McpEntry,
  McpTransportKind,
  MemoryEntry,
  PluginEntry,
  ScanWarning,
  Scope,
  SkillEntry
} from './types.js';

/**
 * Codex keeps its settings in `~/.codex/config.toml`, a file the developer hand
 * edits. Yard reads it with the parser below and never writes it back — every
 * mutation is delegated to the `codex` CLI, which owns the formatting.
 */

const CLIENT = 'codex' as const;

/** Relative to a plugin root, not the repository root. */
const PLUGIN_MANIFEST = path.join('.codex-plugin', 'plugin.json');
const MARKETPLACE_MANIFEST = path.join('.agents', 'plugins', 'marketplace.json');
/** Codex ships its own skills inside the user skills directory, one level down. */
const SYSTEM_SKILLS = '.system';
const DEFAULT_PLUGIN_SKILLS = './skills/';
const CODEX_CLI_TIMEOUT_MS = 15_000;

export type CodexScan = {
  installed: boolean;
  skills: SkillEntry[];
  plugins: PluginEntry[];
  mcpServers: McpEntry[];
  hooks: HookEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
  memory: MemoryEntry[];
  warnings: ScanWarning[];
};

export async function scanCodex(projectRoot: string): Promise<CodexScan> {
  const paths = codexPaths(projectRoot);
  const warnings: ScanWarning[] = [];
  const warn = (file: string, message: string): void => {
    warnings.push({ client: CLIENT, file, message });
  };

  const installed = await isDir(paths.dir);
  const skills: SkillEntry[] = [];
  const mcpServers: McpEntry[] = [];
  const hooks: HookEntry[] = [];
  const memory: MemoryEntry[] = [];

  const config = await readConfig(paths.config, warn);
  mcpServers.push(...configMcpServers(config, paths.config, warn));

  hooks.push(...(await readHookFile(paths.hooks, 'user', undefined, warn)));

  skills.push(...(await readSkillTree(paths.userSkills, 'user', 'on', undefined, warn)));
  skills.push(
    ...(await readSkillTree(paths.userSkillsDisabled, 'user', 'off', paths.userSkillsDisabled, warn))
  );
  skills.push(
    ...(await readSkillTree(
      path.join(paths.userSkills, SYSTEM_SKILLS),
      'builtin',
      'on',
      undefined,
      warn
    ))
  );

  const plugins = await scanPlugins(paths.pluginCacheDir, { skills, mcpServers, hooks }, warn);

  for (const [scope, file] of [
    ['user', paths.userMemory],
    ['project', paths.projectMemory]
  ] as const) {
    const entry = await readMemory(file, scope, warn);
    if (entry) {
      memory.push(entry);
    }
  }

  return {
    installed,
    skills,
    plugins,
    mcpServers,
    hooks,
    // Codex has no user-level agent or command directories: subagents ship
    // inside plugins as skills, and prompts are not a scannable surface.
    agents: [],
    commands: [],
    memory,
    warnings
  };
}

type Warn = (file: string, message: string) => void;

/**
 * Read a file, telling "not there" apart from "there but unreadable".
 *
 * A config the developer cannot read — wrong permissions, or a directory where
 * a file belongs — must not look identical to one they never wrote, or Yard
 * reports an empty inventory for a machine that is merely misconfigured.
 */
async function readTextChecked(file: string, warn: Warn): Promise<string | undefined> {
  const raw = await readText(file);
  if (raw === undefined && (await exists(file))) {
    warn(file, 'exists but could not be read as a file (permissions, or a directory?)');
  }
  return raw;
}

async function readConfig(file: string, warn: Warn): Promise<Record<string, unknown>> {
  const raw = await readTextChecked(file, warn);
  if (raw === undefined) {
    return {};
  }
  try {
    return parseToml(raw);
  } catch (error) {
    warn(file, `could not parse TOML: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function configMcpServers(
  config: Record<string, unknown>,
  file: string,
  warn: Warn
): McpEntry[] {
  const declared = config['mcp_servers'];
  const servers = asTable(declared);
  if (!servers) {
    if (declared !== undefined) {
      warn(file, 'mcp_servers is not a table');
    }
    return [];
  }
  const entries: McpEntry[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const table = asTable(value);
    if (!table) {
      warn(file, `mcp_servers.${name} is not a table`);
      continue;
    }
    const headers = asStringRecord(table['http_headers']);
    entries.push(
      mcpEntry({
        id: `${CLIENT}:user:${name}`,
        scope: 'user',
        name,
        file,
        table,
        ...(headers ? { headers } : {})
      })
    );
  }
  return entries;
}

type McpSource = {
  id: string;
  scope: Scope;
  name: string;
  file: string;
  table: Record<string, unknown>;
  headers?: Record<string, string>;
  plugin?: string;
};

function mcpEntry(source: McpSource): McpEntry {
  const { table } = source;
  const url = asString(table['url']);
  const command = asString(table['command']);
  const args = asStringArray(table['args']);
  const env = asStringRecord(table['env']);
  const cwd = asString(table['cwd']);
  const headers = source.headers ?? asStringRecord(table['headers']);
  const enabled = asBoolean(table['enabled']);

  return {
    id: source.id,
    client: CLIENT,
    scope: source.scope,
    name: source.name,
    transport: transportOf(asString(table['type']), url),
    ...(command !== undefined ? { command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers ? { headers } : {}),
    file: source.file,
    ...(source.plugin !== undefined ? { plugin: source.plugin } : {}),
    enabled: enabled ?? true,
    ...(enabled === undefined ? {} : { enabledSource: source.file })
  };
}

function transportOf(declared: string | undefined, url: string | undefined): McpTransportKind {
  if (declared === 'stdio' || declared === 'http' || declared === 'sse' || declared === 'ws') {
    return declared;
  }
  return url === undefined ? 'stdio' : 'http';
}

type HookFile = {
  hooks?: Record<string, unknown>;
};

/**
 * Codex reuses Claude's hooks.json shape with PascalCase event names, plus an
 * optional `commandWindows` sibling of `command`. Yard never rewrites this
 * file, so that key survives on disk even though HookEntry cannot carry it.
 */
async function readHookFile(
  file: string,
  scope: Scope,
  plugin: string | undefined,
  warn: Warn,
  /** True when a manifest named this file, so its absence is worth reporting. */
  required = false
): Promise<HookEntry[]> {
  const read = await readJsonChecked<HookFile>(file);
  if (read.missing) {
    if (await exists(file)) {
      warn(file, 'exists but could not be read as a file (permissions, or a directory?)');
    } else if (required) {
      warn(file, 'referenced by the plugin manifest but missing');
    }
    return [];
  }
  if (read.error !== undefined || !read.value) {
    warn(file, `could not parse JSON: ${read.error ?? 'empty file'}`);
    return [];
  }
  const events = asTable(read.value.hooks);
  if (!events) {
    warn(file, 'no "hooks" object');
    return [];
  }
  return hookEntries(events, file, scope, plugin, warn);
}

function hookEntries(
  events: Record<string, unknown>,
  file: string,
  scope: Scope,
  plugin: string | undefined,
  warn: Warn
): HookEntry[] {
  const entries: HookEntry[] = [];
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      warn(file, `hooks.${event} is not an array`);
      continue;
    }
    let index = 0;
    for (const group of groups) {
      const groupTable = asTable(group);
      const matcher = asString(groupTable?.['matcher']);
      const list = groupTable?.['hooks'];
      if (!Array.isArray(list)) {
        warn(file, `hooks.${event} entry has no "hooks" array`);
        continue;
      }
      for (const hook of list) {
        const table = asTable(hook);
        const command = asString(table?.['command']);
        if (!table || command === undefined) {
          warn(file, `hooks.${event}[${index}] has no command`);
          index += 1;
          continue;
        }
        const type = table['type'] === 'prompt' ? 'prompt' : 'command';
        const timeout = asNumber(table['timeout']);
        entries.push({
          id: `${CLIENT}:${scope}:${plugin ? `${plugin}:` : ''}${event}:${index}`,
          client: CLIENT,
          scope,
          event,
          ...(matcher !== undefined ? { matcher } : {}),
          type,
          command,
          ...(timeout !== undefined ? { timeout } : {}),
          file,
          ...(plugin !== undefined ? { plugin } : {}),
          enabled: true,
          index
        });
        index += 1;
      }
    }
  }
  return entries;
}

type SkillOptions = {
  scope: Scope;
  visibility: SkillEntry['visibility'];
  visibilitySource?: string;
  plugin?: string;
};

async function readSkillTree(
  root: string,
  scope: Scope,
  visibility: SkillEntry['visibility'],
  visibilitySource: string | undefined,
  warn: Warn,
  plugin?: string,
  skillDirs?: string[]
): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  // Plugins may declare nested or out-of-tree skill paths, in which case the
  // caller resolves them and passes the directories in directly.
  const dirs = skillDirs ?? (await listSkillDirs(root, warn));
  for (const skillDir of dirs) {
    const name = path.basename(skillDir);
    // `.system` and friends hold Codex's own skills, scanned separately.
    if (name.startsWith('.')) {
      continue;
    }
    const entry = await readSkill(skillDir, name, warn, {
      scope,
      visibility,
      ...(visibilitySource !== undefined ? { visibilitySource } : {}),
      ...(plugin !== undefined ? { plugin } : {})
    });
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Skill directories under `root`, symlinks included.
 *
 * `readdir` reports a symlink as a link and never as a directory, yet
 * symlinking a shared skill into `~/.codex/skills` is a normal thing to do and
 * Codex loads those skills like any other. Filtering on `isDirectory()` alone
 * drops them from the inventory, and hides a link whose target has gone.
 */
async function listSkillDirs(root: string, warn: Warn): Promise<string[]> {
  let names: { name: string; link: boolean }[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, link: !entry.isDirectory() }));
  } catch {
    return [];
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const dirs: string[] = [];
  for (const entry of names) {
    // `.system` and friends hold Codex's own skills, scanned separately.
    if (entry.name.startsWith('.')) {
      continue;
    }
    const dir = path.join(root, entry.name);
    if (!entry.link) {
      dirs.push(dir);
      continue;
    }
    if (await isDir(dir)) {
      dirs.push(dir);
      continue;
    }
    warn(dir, 'skill symlink does not resolve to a directory');
  }
  return dirs;
}

async function readSkill(
  dir: string,
  name: string,
  warn: Warn,
  options: SkillOptions
): Promise<SkillEntry | undefined> {
  const file = path.join(dir, 'SKILL.md');
  const raw = await readText(file);
  if (raw === undefined) {
    warn(file, 'skill directory has no readable SKILL.md');
    return undefined;
  }
  const { data } = parseFrontmatter(raw);
  const qualifiedName = options.plugin ? `${options.plugin}:${name}` : name;
  return {
    id: `${CLIENT}:${options.scope}:${qualifiedName}`,
    client: CLIENT,
    scope: options.scope,
    name,
    qualifiedName,
    description: data['description'] ?? '',
    file,
    dir,
    ...(options.plugin !== undefined ? { plugin: options.plugin } : {}),
    visibility: options.visibility,
    ...(options.visibilitySource !== undefined
      ? { visibilitySource: options.visibilitySource }
      : {}),
    frontmatter: data,
    bytes: Buffer.byteLength(raw, 'utf8')
  };
}

async function readMemory(file: string, scope: Scope, warn: Warn): Promise<MemoryEntry | undefined> {
  const raw = await readTextChecked(file, warn);
  if (raw === undefined) {
    return undefined;
  }
  return {
    id: `${CLIENT}:${scope}:${path.basename(file)}`,
    client: CLIENT,
    scope,
    name: path.basename(file),
    file,
    bytes: Buffer.byteLength(raw, 'utf8')
  };
}

type PluginManifest = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  skills?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
};

type MarketplaceFile = {
  name?: unknown;
  plugins?: unknown;
};

type Collected = {
  skills: SkillEntry[];
  mcpServers: McpEntry[];
  hooks: HookEntry[];
};

async function scanPlugins(
  cacheDir: string,
  collected: Collected,
  warn: Warn
): Promise<PluginEntry[]> {
  const plugins: PluginEntry[] = [];
  for (const marketplace of await listDirs(cacheDir)) {
    const marketplaceDir = path.join(cacheDir, marketplace);
    const installed = new Set<string>();

    for (const dirName of await listDirs(marketplaceDir)) {
      const root = await resolvePluginRoot(path.join(marketplaceDir, dirName));
      if (!root) {
        continue;
      }
      const entry = await readPlugin(root, dirName, marketplace, collected, warn);
      // The manifest may name the plugin something other than its cache
      // directory. Both spellings count as installed, or the marketplace pass
      // below lists the same plugin a second time under a colliding id.
      installed.add(dirName);
      installed.add(entry.name);
      plugins.push(entry);
    }

    plugins.push(...(await declaredPlugins(marketplaceDir, marketplace, installed, warn)));
  }

  const seen = new Set<string>();
  return plugins.map((plugin) => {
    const id = uniquePluginId(plugin.id, plugin.marketplace ?? '', seen);
    return id === plugin.id ? plugin : { ...plugin, id };
  });
}

/**
 * Two marketplaces can offer a plugin under the same name, so `id` is
 * qualified with the marketplace when — and only when — it would otherwise
 * repeat. Anything that indexes the inventory by id would silently lose the
 * second entry.
 */
function uniquePluginId(base: string, marketplace: string, seen: Set<string>): string {
  const qualified = `${base}@${marketplace}`;
  let id = seen.has(base) ? qualified : base;
  for (let n = 2; seen.has(id); n += 1) {
    id = `${qualified}#${n}`;
  }
  seen.add(id);
  return id;
}

/**
 * Remote installs nest the payload one level deeper, under a version
 * directory, so the manifest is at either `<plugin>/` or `<plugin>/<version>/`.
 */
async function resolvePluginRoot(dir: string): Promise<string | undefined> {
  if (await isFile(path.join(dir, PLUGIN_MANIFEST))) {
    return dir;
  }
  const versions = await listDirs(dir);
  for (const version of [...versions].reverse()) {
    const candidate = path.join(dir, version);
    if (await isFile(path.join(candidate, PLUGIN_MANIFEST))) {
      return candidate;
    }
  }
  return undefined;
}

async function readPlugin(
  root: string,
  dirName: string,
  marketplace: string,
  collected: Collected,
  warn: Warn
): Promise<PluginEntry> {
  const manifestFile = path.join(root, PLUGIN_MANIFEST);
  const read = await readJsonChecked<PluginManifest>(manifestFile);
  if (read.error !== undefined) {
    warn(manifestFile, `could not parse JSON: ${read.error}`);
  }
  if (read.value !== undefined && !isTable(read.value)) {
    warn(manifestFile, 'plugin manifest is not an object');
  }
  const manifest: PluginManifest = isTable(read.value) ? read.value : {};
  const name = asString(manifest.name) ?? dirName;

  const skills = await readSkillTree(
    path.resolve(root, DEFAULT_PLUGIN_SKILLS),
    'plugin',
    'on',
    undefined,
    warn,
    name,
    await collectSkillDirs(root, containedRefs(root, manifest.skills, manifestFile, warn))
  );
  const mcpServers = await pluginMcpServers(root, manifest, name, warn);
  const hooks = await pluginHooks(root, manifest, name, warn);

  collected.skills.push(...skills);
  collected.mcpServers.push(...mcpServers);
  collected.hooks.push(...hooks);

  return {
    id: `${CLIENT}:plugin:${name}`,
    client: CLIENT,
    scope: 'plugin',
    name,
    marketplace,
    qualifiedName: name,
    description: asString(manifest.description) ?? '',
    version: asString(manifest.version) ?? path.basename(root),
    root,
    enabled: true,
    installed: true,
    skills: skills.length,
    hooks: hooks.length,
    mcpServers: mcpServers.length
  };
}

/**
 * A plugin manifest is data Yard did not write, so the paths inside it are
 * untrusted: `"skills": "/etc"` or `"../../.."` must not turn a scan of one
 * plugin into a walk of the developer's disk. Anything resolving outside the
 * plugin root is dropped with a warning.
 */
function containedPath(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return undefined;
  }
  return resolved;
}

/** The declared skill paths that stay inside the plugin, in manifest order. */
function containedRefs(root: string, declared: unknown, file: string, warn: Warn): string[] {
  const raw = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [];
  const kept: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue;
    }
    if (containedPath(root, entry) === undefined) {
      warn(file, `skills path "${entry}" points outside the plugin directory`);
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

/** `mcpServers` is normally a path to a sibling `.mcp.json`, but may be inline. */
async function pluginMcpServers(
  root: string,
  manifest: PluginManifest,
  plugin: string,
  warn: Warn
): Promise<McpEntry[]> {
  const resolved = await resolveManifestRef<{ mcpServers?: unknown }>(
    root,
    manifest.mcpServers,
    warn
  );
  if (!resolved) {
    return [];
  }
  const servers = asTable(resolved.value['mcpServers'] ?? resolved.value);
  if (!servers) {
    warn(resolved.file, 'no "mcpServers" object');
    return [];
  }
  const entries: McpEntry[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const table = asTable(value);
    if (!table) {
      warn(resolved.file, `mcpServers.${name} is not an object`);
      continue;
    }
    entries.push(
      mcpEntry({
        id: `${CLIENT}:plugin:${plugin}:${name}`,
        scope: 'plugin',
        name,
        file: resolved.file,
        table,
        plugin
      })
    );
  }
  return entries;
}

/**
 * A plugin declares hooks either inline (the `superpowers` plugin does, though
 * only ever as an empty object so far) or as a path, and Claude-style plugins
 * drop a hooks.json at the root. All three are accepted.
 */
async function pluginHooks(
  root: string,
  manifest: PluginManifest,
  plugin: string,
  warn: Warn
): Promise<HookEntry[]> {
  const manifestFile = path.join(root, PLUGIN_MANIFEST);
  const inline = asTable(manifest.hooks);
  if (inline) {
    const events = asTable(inline['hooks']) ?? inline;
    return hookEntries(events, manifestFile, 'plugin', plugin, warn);
  }
  const declared = asString(manifest.hooks);
  const file = containedPath(root, declared ?? 'hooks.json');
  if (file === undefined) {
    warn(manifestFile, `hooks path "${declared ?? ''}" points outside the plugin directory`);
    return [];
  }
  return readHookFile(file, 'plugin', plugin, warn, declared !== undefined);
}

type ManifestRef<T> = { file: string; value: T };

async function resolveManifestRef<T extends object>(
  root: string,
  ref: unknown,
  warn: Warn
): Promise<ManifestRef<T> | undefined> {
  if (isTable(ref)) {
    return { file: path.join(root, PLUGIN_MANIFEST), value: ref as T };
  }
  const relative = asString(ref);
  if (relative === undefined) {
    return undefined;
  }
  const file = containedPath(root, relative);
  if (file === undefined) {
    warn(path.join(root, PLUGIN_MANIFEST), `"${relative}" points outside the plugin directory`);
    return undefined;
  }
  const read = await readJsonChecked<T>(file);
  if (read.missing) {
    warn(
      file,
      (await exists(file))
        ? 'exists but could not be read as a file (permissions, or a directory?)'
        : 'referenced by the plugin manifest but missing'
    );
    return undefined;
  }
  if (read.error !== undefined || !read.value) {
    warn(file, `could not parse JSON: ${read.error ?? 'empty file'}`);
    return undefined;
  }
  return { file, value: read.value };
}

/** Plugins a marketplace offers but that are not in the cache yet. */
async function declaredPlugins(
  marketplaceDir: string,
  marketplace: string,
  installed: Set<string>,
  warn: Warn
): Promise<PluginEntry[]> {
  const file = path.join(marketplaceDir, MARKETPLACE_MANIFEST);
  const read = await readJsonChecked<MarketplaceFile>(file);
  if (read.missing) {
    return [];
  }
  if (read.error !== undefined || !read.value) {
    warn(file, `could not parse JSON: ${read.error ?? 'empty file'}`);
    return [];
  }
  const listed = read.value.plugins;
  if (!Array.isArray(listed)) {
    warn(file, 'no "plugins" array');
    return [];
  }

  const entries: PluginEntry[] = [];
  for (const item of listed) {
    const name = asString(asTable(item)?.['name']);
    if (name === undefined || installed.has(name)) {
      continue;
    }
    entries.push({
      id: `${CLIENT}:plugin:${name}`,
      client: CLIENT,
      scope: 'plugin',
      name,
      marketplace,
      qualifiedName: name,
      description: asString(asTable(item)?.['description']) ?? '',
      version: '',
      enabled: false,
      enabledSource: file,
      installed: false,
      skills: 0,
      hooks: 0,
      mcpServers: 0
    });
  }
  return entries;
}

/**
 * Codex disables a skill the same way Claude does: by moving its directory to
 * `skills.disabled`. `moved` reports an actual rename, so it is false on a dry
 * run and when the skill is already where it was asked to be. A skill that is
 * not there is an error rather than a silent success, so a typo cannot be
 * mistaken for a disabled skill.
 */
export async function setSkillDirectoryEnabled(opts: {
  skill: string;
  enabled: boolean;
  dryRun?: boolean;
}): Promise<{ from: string; to: string; moved: boolean }> {
  const paths = codexPaths(process.cwd());
  if (opts.skill.includes(':')) {
    throw new Error(
      `"${opts.skill}" is a plugin skill; it lives in the plugin cache, not under ${paths.userSkills}`
    );
  }
  // A rename is the one write this module makes, so the name it is given may
  // only ever be a single directory below the skills paths — never a path.
  if (
    opts.skill === '' ||
    opts.skill.startsWith('.') ||
    opts.skill.includes('/') ||
    opts.skill.includes('\\')
  ) {
    throw new Error(`"${opts.skill}" is not a plain skill directory name`);
  }

  const enabledDir = path.join(paths.userSkills, opts.skill);
  const disabledDir = path.join(paths.userSkillsDisabled, opts.skill);
  const inEnabled = await isDir(enabledDir);
  const inDisabled = await isDir(disabledDir);

  if (inEnabled && inDisabled) {
    throw new Error(
      `"${opts.skill}" exists in both ${paths.userSkills} and ${paths.userSkillsDisabled}; resolve that by hand first`
    );
  }
  if (!inEnabled && !inDisabled) {
    throw new Error(
      `no personal skill "${opts.skill}" under ${paths.userSkills} or ${paths.userSkillsDisabled}`
    );
  }

  const from = opts.enabled ? disabledDir : enabledDir;
  const to = opts.enabled ? enabledDir : disabledDir;
  if (opts.enabled ? inEnabled : inDisabled) {
    return { from: to, to, moved: false };
  }
  if (opts.dryRun) {
    return { from, to, moved: false };
  }

  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  return { from, to, moved: true };
}

export type CodexCliOptions = {
  dryRun?: boolean;
  timeoutMs?: number;
};

export type AddMcpServerOptions = CodexCliOptions & {
  name: string;
  /** stdio servers. Mutually exclusive with `url`. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Streamable HTTP servers. Mutually exclusive with `command`. */
  url?: string;
  bearerTokenEnvVar?: string;
};

export type CodexCliResult = {
  /** The argv handed to the `codex` binary, so a dry run can be shown. */
  argv: string[];
  ran: boolean;
  stdout: string;
  stderr: string;
};

/**
 * Verified against codex-cli 0.147.0:
 *   codex mcp add [--env K=V]... [--bearer-token-env-var VAR] <NAME> (--url <URL> | -- <CMD>...)
 */
export async function addMcpServer(options: AddMcpServerOptions): Promise<CodexCliResult> {
  const hasCommand = options.command !== undefined && options.command !== '';
  const hasUrl = options.url !== undefined && options.url !== '';
  if (hasCommand === hasUrl) {
    throw new Error(`addMcpServer(${options.name}): pass exactly one of command or url`);
  }

  const argv = ['mcp', 'add', options.name];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    argv.push('--env', `${key}=${value}`);
  }
  if (options.bearerTokenEnvVar !== undefined) {
    argv.push('--bearer-token-env-var', options.bearerTokenEnvVar);
  }
  if (hasUrl) {
    argv.push('--url', options.url as string);
  } else {
    argv.push('--', options.command as string, ...(options.args ?? []));
  }
  return runCodex(argv, options);
}

export async function removeMcpServer(
  name: string,
  options: CodexCliOptions = {}
): Promise<CodexCliResult> {
  return runCodex(['mcp', 'remove', name], options);
}

const execFileAsync = promisify(execFile);

async function runCodex(argv: string[], options: CodexCliOptions): Promise<CodexCliResult> {
  if (options.dryRun) {
    return { argv, ran: false, stdout: '', stderr: '' };
  }
  const bin = process.env.YARD_CODEX_BIN ?? 'codex';
  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, {
      timeout: options.timeoutMs ?? CODEX_CLI_TIMEOUT_MS,
      encoding: 'utf8'
    });
    return { argv, ran: true, stdout, stderr };
  } catch (error) {
    const config = codexPaths(process.cwd()).config;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `the \`${bin}\` CLI is not installed or not on PATH, so \`codex ${argv.join(' ')}\` could not run. Edit ${config} by hand instead.`
      );
    }
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr.trim()
      : '';
    throw new Error(
      `\`${bin} ${argv.join(' ')}\` failed${stderr ? `: ${stderr}` : ''}. ${config} was left unchanged.`
    );
  }
}

/**
 * A deliberately small TOML reader: enough for config.toml, and nothing that
 * would tempt anyone to serialise a document back out.
 *
 * Supports tables, array-of-tables, dotted and quoted keys, basic/literal
 * strings (including their multi-line forms), integers, floats, booleans,
 * arrays, inline tables, comments and blank lines. Values it does not model —
 * offset dates, for instance — come back as their raw text.
 */
export function parseToml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    try {
      if (line.startsWith('[')) {
        current = openTable(root, line);
        continue;
      }
      let buffer = line;
      for (;;) {
        try {
          const { keys, value } = parseAssignment(buffer);
          assign(current, keys, value);
          break;
        } catch (error) {
          const next = lines[i + 1];
          if (!(error instanceof IncompleteValue) || next === undefined) {
            throw error;
          }
          i += 1;
          buffer = `${buffer}\n${next}`;
        }
      }
    } catch (error) {
      throw new Error(`line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return root;
}

type Cursor = { text: string; pos: number };

/** Signals that a value needs the next line before it can be parsed. */
class IncompleteValue extends Error {}

function openTable(root: Record<string, unknown>, line: string): Record<string, unknown> {
  const cursor: Cursor = { text: line, pos: 1 };
  const isArrayTable = line[1] === '[';
  if (isArrayTable) {
    cursor.pos += 1;
  }
  const keys = parseKeyPath(cursor);
  skipTrivia(cursor);
  const close = isArrayTable ? ']]' : ']';
  if (!cursor.text.startsWith(close, cursor.pos)) {
    throw new Error('unterminated table header');
  }
  cursor.pos += close.length;
  skipTrivia(cursor);
  if (cursor.pos < cursor.text.length) {
    throw new Error(`unexpected text after table header: ${cursor.text.slice(cursor.pos)}`);
  }
  return isArrayTable ? appendTable(root, keys) : ensureTable(root, keys);
}

function parseAssignment(text: string): { keys: string[]; value: unknown } {
  const cursor: Cursor = { text, pos: 0 };
  const keys = parseKeyPath(cursor);
  skipTrivia(cursor);
  if (cursor.text[cursor.pos] !== '=') {
    throw new Error('expected "=" after key');
  }
  cursor.pos += 1;
  const value = parseValue(cursor);
  skipTrivia(cursor);
  if (cursor.pos < cursor.text.length) {
    throw new Error(`unexpected text after value: ${cursor.text.slice(cursor.pos)}`);
  }
  return { keys, value };
}

function skipTrivia(cursor: Cursor): void {
  while (cursor.pos < cursor.text.length) {
    const char = cursor.text[cursor.pos] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      cursor.pos += 1;
      continue;
    }
    if (char === '#') {
      while (cursor.pos < cursor.text.length && cursor.text[cursor.pos] !== '\n') {
        cursor.pos += 1;
      }
      continue;
    }
    break;
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

function parseKeyPath(cursor: Cursor): string[] {
  const keys: string[] = [];
  for (;;) {
    skipTrivia(cursor);
    const char = cursor.text[cursor.pos];
    if (char === '"' || char === "'") {
      keys.push(parseString(cursor));
    } else {
      const start = cursor.pos;
      while (cursor.pos < cursor.text.length && BARE_KEY.test(cursor.text[cursor.pos] as string)) {
        cursor.pos += 1;
      }
      if (cursor.pos === start) {
        throw new Error('expected a key');
      }
      keys.push(cursor.text.slice(start, cursor.pos));
    }
    skipTrivia(cursor);
    if (cursor.text[cursor.pos] !== '.') {
      return keys;
    }
    cursor.pos += 1;
  }
}

function parseValue(cursor: Cursor): unknown {
  skipTrivia(cursor);
  if (cursor.pos >= cursor.text.length) {
    throw new Error('expected a value');
  }
  const char = cursor.text[cursor.pos] as string;
  if (char === '"' || char === "'") {
    return parseString(cursor);
  }
  if (char === '[') {
    return parseArray(cursor);
  }
  if (char === '{') {
    return parseInlineTable(cursor);
  }
  return parseScalar(cursor);
}

function parseString(cursor: Cursor): string {
  const quote = cursor.text[cursor.pos] as string;
  const triple = cursor.text.startsWith(quote.repeat(3), cursor.pos);
  const delimiter = triple ? quote.repeat(3) : quote;
  const literal = quote === "'";
  cursor.pos += delimiter.length;
  if (triple && cursor.text[cursor.pos] === '\n') {
    cursor.pos += 1;
  }

  let out = '';
  for (;;) {
    if (cursor.pos >= cursor.text.length) {
      if (triple) {
        throw new IncompleteValue('unterminated multi-line string');
      }
      throw new Error('unterminated string');
    }
    if (cursor.text.startsWith(delimiter, cursor.pos)) {
      cursor.pos += delimiter.length;
      return out;
    }
    const char = cursor.text[cursor.pos] as string;
    if (!triple && (char === '\n' || char === '\r')) {
      throw new Error('unterminated string');
    }
    if (!literal && char === '\\') {
      out += readEscape(cursor, triple);
      continue;
    }
    out += char;
    cursor.pos += 1;
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\'
};

function readEscape(cursor: Cursor, triple: boolean): string {
  cursor.pos += 1;
  const char = cursor.text[cursor.pos];
  if (char === undefined) {
    throw new Error('unterminated escape');
  }
  const simple = SIMPLE_ESCAPES[char];
  if (simple !== undefined) {
    cursor.pos += 1;
    return simple;
  }
  if (char === 'u' || char === 'U') {
    const width = char === 'u' ? 4 : 8;
    const digits = cursor.text.slice(cursor.pos + 1, cursor.pos + 1 + width);
    if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
      throw new Error(`bad \\${char} escape`);
    }
    cursor.pos += 1 + width;
    return String.fromCodePoint(Number.parseInt(digits, 16));
  }
  // A backslash at the end of a line inside a multi-line string swallows the
  // newline and the indentation that follows it.
  if (triple && /\s/.test(char)) {
    while (cursor.pos < cursor.text.length && /\s/.test(cursor.text[cursor.pos] as string)) {
      cursor.pos += 1;
    }
    return '';
  }
  throw new Error(`unknown escape: \\${char}`);
}

function parseArray(cursor: Cursor): unknown[] {
  cursor.pos += 1;
  const items: unknown[] = [];
  for (;;) {
    skipTrivia(cursor);
    if (cursor.pos >= cursor.text.length) {
      throw new IncompleteValue('unterminated array');
    }
    if (cursor.text[cursor.pos] === ']') {
      cursor.pos += 1;
      return items;
    }
    items.push(parseValue(cursor));
    skipTrivia(cursor);
    if (cursor.pos >= cursor.text.length) {
      throw new IncompleteValue('unterminated array');
    }
    const char = cursor.text[cursor.pos];
    if (char === ',') {
      cursor.pos += 1;
      continue;
    }
    if (char === ']') {
      cursor.pos += 1;
      return items;
    }
    throw new Error(`expected "," or "]" in array, got ${String(char)}`);
  }
}

function parseInlineTable(cursor: Cursor): Record<string, unknown> {
  cursor.pos += 1;
  const table: Record<string, unknown> = {};
  for (;;) {
    skipTrivia(cursor);
    if (cursor.pos >= cursor.text.length) {
      throw new IncompleteValue('unterminated inline table');
    }
    if (cursor.text[cursor.pos] === '}') {
      cursor.pos += 1;
      return table;
    }
    const keys = parseKeyPath(cursor);
    skipTrivia(cursor);
    if (cursor.text[cursor.pos] !== '=') {
      throw new Error('expected "=" in inline table');
    }
    cursor.pos += 1;
    assign(table, keys, parseValue(cursor));
    skipTrivia(cursor);
    if (cursor.text[cursor.pos] === ',') {
      cursor.pos += 1;
    }
  }
}

const INTEGER = /^[+-]?[0-9](?:[0-9_]*[0-9])?$/;
const RADIX_INTEGER = /^0(x[0-9a-fA-F_]+|o[0-7_]+|b[01_]+)$/;
const FLOAT = /^[+-]?[0-9](?:[0-9_]*[0-9])?(?:\.[0-9](?:[0-9_]*[0-9])?)?(?:[eE][+-]?[0-9_]+)?$/;

function parseScalar(cursor: Cursor): unknown {
  const start = cursor.pos;
  while (cursor.pos < cursor.text.length && !',]}#\n\r'.includes(cursor.text[cursor.pos] as string)) {
    cursor.pos += 1;
  }
  const token = cursor.text.slice(start, cursor.pos).trim();
  // Put the trailing whitespace back so callers report the right position.
  cursor.pos = start + cursor.text.slice(start, cursor.pos).trimEnd().length;

  if (token === '') {
    throw new Error('expected a value');
  }
  if (token === 'true' || token === 'false') {
    return token === 'true';
  }
  const digits = token.replace(/_/g, '');
  if (RADIX_INTEGER.test(token)) {
    const radix = token[1] === 'x' ? 16 : token[1] === 'o' ? 8 : 2;
    return Number.parseInt(digits.slice(2), radix);
  }
  if (INTEGER.test(token) || FLOAT.test(token)) {
    return Number(digits);
  }
  if (/^[+-]?inf$/.test(token)) {
    return token.startsWith('-') ? -Infinity : Infinity;
  }
  if (/^[+-]?nan$/.test(token)) {
    return NaN;
  }
  return token;
}

function ensureTable(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let node = root;
  for (const key of keys) {
    const existing = node[key];
    if (existing === undefined) {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
      continue;
    }
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (!isTable(last)) {
        throw new Error(`cannot descend into ${key}`);
      }
      node = last;
      continue;
    }
    if (!isTable(existing)) {
      throw new Error(`cannot redefine ${key} as a table`);
    }
    node = existing;
  }
  return node;
}

function appendTable(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const last = keys[keys.length - 1];
  if (last === undefined) {
    throw new Error('empty table header');
  }
  const parent = ensureTable(root, keys.slice(0, -1));
  const existing = parent[last];
  const list = Array.isArray(existing) ? existing : [];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`cannot redefine ${last} as an array of tables`);
  }
  const created: Record<string, unknown> = {};
  list.push(created);
  parent[last] = list;
  return created;
}

function assign(table: Record<string, unknown>, keys: string[], value: unknown): void {
  const last = keys[keys.length - 1];
  if (last === undefined) {
    throw new Error('empty key');
  }
  ensureTable(table, keys.slice(0, -1))[last] = value;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTable(value: unknown): Record<string, unknown> | undefined {
  return isTable(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length === value.length ? out : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const table = asTable(value);
  if (!table) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(table)) {
    if (typeof item === 'string') {
      out[key] = item;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
