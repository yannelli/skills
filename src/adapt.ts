import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { AGENT_MCP_SCHEMA, type AgentMcpEntry, type AgentMcpFile, type ClaudeMcpFile } from './mcp-spec.js';
import { PLUGINS_DIR } from './paths.js';
import { addCatalogEntries } from './scaffold.js';

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const AUTHOR = {
  name: 'Ryan Yannelli',
  email: 'ryanyannelli@gmail.com',
  url: 'https://github.com/yannelli'
};

/**
 * Claude events paired with their Cursor *user-level* counterparts, for
 * `~/.cursor/hooks.json` and `<project>/.cursor/hooks.json`. Plugin hooks do
 * not go through this map — those stay PascalCase in every client.
 *
 * Only genuine counterparts are listed. Events with no equivalent on the other
 * side (Notification, PermissionRequest, beforeShellExecution, afterFileEdit,
 * the Tab events) are reported as dropped rather than guessed at, because a
 * silently invented event name is a hook that never fires.
 */
const CLAUDE_TO_CURSOR_EVENTS: Record<string, string> = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  UserPromptSubmit: 'beforeSubmitPrompt',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PostToolUseFailure: 'postToolUseFailure',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  PreCompact: 'preCompact',
  Stop: 'stop'
};

const SUPPORT_DIRS = ['scripts', 'rules', 'agents', 'commands', 'hooks'] as const;
const SUPPORT_FILES = ['.mcp.json', 'mcp.json', 'README.md', 'LICENSE'] as const;
const FORBIDDEN_AGENT_ENV = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);

export type AdaptInput = {
  source: string;
  dest?: string;
  name?: string;
  register?: boolean;
};

export type AdaptReport = {
  dest: string;
  name: string;
  wrote: string[];
  skipped: string[];
  notes: string[];
  registered: boolean;
};

type ManifestSeed = {
  name: string;
  description: string;
  version: string;
  keywords: string[];
  license: string;
  homepage?: string;
  repository?: string;
  hooks?: string;
  /** `mcpServers` block to inline into `.cursor-plugin/plugin.json`. */
  cursorMcp?: Record<string, unknown>;
};

export async function adaptPlugin(input: AdaptInput): Promise<AdaptReport> {
  const source = path.resolve(input.source);
  if (!(await exists(source))) {
    throw new Error(`adapt source not found: ${source}`);
  }

  const discovered = await discover(source, input.name);
  const dest = path.resolve(input.dest ?? path.join(PLUGINS_DIR, discovered.name));
  const destExisted = await exists(dest);
  const destIsPlugin = path.resolve(dest) === path.resolve(PLUGINS_DIR, discovered.name);
  const wrote: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];

  if (path.resolve(source) !== dest) {
    await mkdir(dest, { recursive: true });
    await copySkills(source, dest, discovered.name, wrote, skipped, notes);
    await copySupport(source, dest, wrote, skipped, notes);
  } else {
    notes.push('adapting in place');
  }

  await adaptHooks(source, dest, wrote, skipped, notes);
  await adaptMcp(source, dest, wrote, skipped, notes);

  const seed = await seedFrom(source, dest, discovered);
  for (const [rel, body] of Object.entries(manifestsFor(seed))) {
    await writeMissing(dest, rel, body, wrote, skipped);
  }

  const register = destIsPlugin && (input.register ?? !destExisted);
  let registered = false;
  if (register) {
    registered = await addCatalogEntries(seed.name, seed.description);
    notes.push(
      registered ? 'registered in the three marketplace catalogs' : 'already present in the marketplace catalogs'
    );
  } else if (input.register === true && !destIsPlugin) {
    notes.push('skipped catalog registration because dest is not plugins/<name>');
  }

  return { dest, name: seed.name, wrote, skipped, notes, registered };
}

export function kebabName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type CursorUserHooks = {
  version: 1;
  hooks: Record<string, Array<{ command: string }>>;
  /** Claude events with no Cursor counterpart. Nothing was emitted for these. */
  dropped: string[];
};

/** Convert Claude hooks into the developer's own `.cursor/hooks.json`. */
export function claudeHooksToCursor(raw: unknown): CursorUserHooks {
  const events = hookEvents(raw);
  const hooks: Record<string, Array<{ command: string }>> = {};
  const dropped: string[] = [];

  for (const [event, entries] of Object.entries(events)) {
    const mapped = CLAUDE_TO_CURSOR_EVENTS[event];
    if (!mapped) {
      dropped.push(event);
      continue;
    }
    const commands = entries
      .flatMap(extractCommands)
      .map(toCursorCommand)
      .filter((command) => command.length > 0)
      .map((command) => ({ command }));
    if (commands.length) {
      hooks[mapped] = commands;
    }
  }

  return { version: 1, hooks, dropped };
}

export type ClaudeHooksFile = {
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  dropped: string[];
};

/** Convert a `.cursor/hooks.json` into the PascalCase shape plugins use. */
export function cursorHooksToClaude(raw: unknown): ClaudeHooksFile {
  const events = hookEvents(raw);
  const hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> = {};
  const dropped: string[] = [];

  for (const [event, entries] of Object.entries(events)) {
    const mapped = Object.entries(CLAUDE_TO_CURSOR_EVENTS).find(([, cursor]) => cursor === event)?.[0];
    if (!mapped) {
      dropped.push(event);
      continue;
    }
    const commands = entries.flatMap(extractCommands).map(toClaudeCommand).filter((command) => command.length > 0);
    if (commands.length) {
      hooks[mapped] = [{ hooks: commands.map((command) => ({ type: 'command', command })) }];
    }
  }

  return { hooks, dropped };
}

export function claudeMcpToAgent(raw: unknown): AgentMcpFile {
  const servers = serverMap(raw);
  return {
    $schema: AGENT_MCP_SCHEMA,
    mcpServers: Object.fromEntries(Object.entries(servers).map(([key, entry]) => [key, toAgentEntry(entry)]))
  };
}

export function agentMcpToClaude(raw: unknown): ClaudeMcpFile {
  const servers = serverMap(raw);
  return {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([key, entry]) => {
        const record = entry as Record<string, unknown>;
        if (typeof record.url === 'string' && record.url) {
          return [key, { url: record.url, type: String(record.type ?? 'http') }];
        }
        const args = Array.isArray(record.args) ? record.args.map((arg) => toClaudePath(String(arg))) : [];
        const env = claudeEnv(record.env);
        return [
          key,
          {
            command: typeof record.command === 'string' ? record.command : 'node',
            args,
            ...(env ? { env } : {})
          }
        ];
      })
    )
  };
}

async function discover(source: string, explicit?: string): Promise<{ name: string; description: string }> {
  const skill = await findSkillFile(source);
  const claude = await readJson(path.join(dirOf(source), '.claude-plugin', 'plugin.json'));
  const rootManifest = await readJson(path.join(dirOf(source), 'plugin.json'));
  const fromSkill = skill ? parseFrontmatter(await readFile(skill, 'utf8')).data : {};
  const rawName =
    explicit ??
    stringField(claude, 'name') ??
    stringField(rootManifest, 'name') ??
    fromSkill.name ??
    path.basename(skill ? path.dirname(skill) : dirOf(source), '.md');
  const name = kebabName(rawName);
  if (!NAME_RE.test(name)) {
    throw new Error(`could not derive a kebab-case plugin name from ${source}`);
  }
  const description =
    stringField(claude, 'description') ??
    stringField(rootManifest, 'description') ??
    fromSkill.description ??
    `${name} adapted from a Claude skill`;
  return { name, description };
}

async function seedFrom(source: string, dest: string, discovered: { name: string; description: string }): Promise<ManifestSeed> {
  const claude =
    (await readJson(path.join(dirOf(source), '.claude-plugin', 'plugin.json'))) ??
    (await readJson(path.join(dest, '.claude-plugin', 'plugin.json')));
  const keywords = arrayField(claude, 'keywords');
  // hooks/hooks.json is the auto-discovered default in every client, so the
  // manifests only need a `hooks` field when the source pointed somewhere else.
  const declaredHooks = stringField(claude, 'hooks');
  const hooksPath =
    declaredHooks && !/^\.\/hooks\/(hooks|claude-hooks)\.json$/.test(declaredHooks) ? declaredHooks : undefined;
  const homepage = stringField(claude, 'homepage');
  const repository = stringField(claude, 'repository');
  const mcp =
    (await readJson(path.join(dest, '.mcp.json'))) ??
    (await readJson(path.join(dest, 'mcp.json'))) ??
    (claude && 'mcpServers' in claude ? { mcpServers: claude.mcpServers } : undefined);
  const hasMcp = Boolean(mcp && Object.keys(serverMap(mcp)).length);
  return {
    name: discovered.name,
    description: discovered.description,
    version: stringField(claude, 'version') ?? '0.1.0',
    keywords: keywords.length ? keywords : [discovered.name],
    license: stringField(claude, 'license') ?? 'MIT',
    ...(homepage ? { homepage } : {}),
    ...(repository ? { repository } : {}),
    ...(hooksPath ? { hooks: hooksPath } : {}),
    ...(hasMcp ? { cursorMcp: toCursorInline(mcp) } : {})
  };
}

function manifestsFor(seed: ManifestSeed): Record<string, string> {
  const shared = {
    name: seed.name,
    version: seed.version,
    description: seed.description,
    author: AUTHOR,
    homepage: seed.homepage ?? 'https://github.com/yannelli/skills',
    repository: seed.repository ?? 'https://github.com/yannelli/skills',
    license: seed.license,
    keywords: seed.keywords
  };
  const claude = {
    $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
    ...shared,
    ...(seed.hooks ? { hooks: seed.hooks } : {})
  };
  const agent = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    ...shared
  };
  // Cursor reads its MCP servers from the manifest itself — it loads neither
  // .mcp.json nor mcp.json — so they have to be inlined here or the plugin
  // installs into Cursor with no servers at all.
  const cursor = {
    name: shared.name,
    description: shared.description,
    version: shared.version,
    author: { name: AUTHOR.name, email: AUTHOR.email },
    homepage: shared.homepage,
    repository: shared.repository,
    license: shared.license,
    keywords: shared.keywords,
    skills: './skills/',
    ...(seed.hooks ? { hooks: seed.hooks } : {}),
    ...(seed.cursorMcp ? { mcpServers: seed.cursorMcp } : {})
  };
  const codex = {
    ...shared,
    skills: './skills/',
    ...(seed.hooks ? { hooks: seed.hooks } : {}),
    ...(seed.cursorMcp ? { mcpServers: './.mcp.json' } : {})
  };
  return {
    'plugin.json': json(agent),
    '.claude-plugin/plugin.json': json(claude),
    '.codex-plugin/plugin.json': json(codex),
    '.cursor-plugin/plugin.json': json(cursor)
  };
}

async function copySkills(
  source: string,
  dest: string,
  name: string,
  wrote: string[],
  skipped: string[],
  notes: string[]
): Promise<void> {
  const destSkills = path.join(dest, 'skills');
  if (await isDir(destSkills)) {
    skipped.push('skills/');
    return;
  }
  const sourceDir = dirOf(source);
  const skillsDir = path.join(sourceDir, 'skills');
  if (await isDir(skillsDir)) {
    await cp(skillsDir, destSkills, { recursive: true });
    wrote.push('skills/');
    notes.push('copied skills/ from the source plugin');
    return;
  }
  const skill = await findSkillFile(source);
  if (!skill) {
    throw new Error(`no SKILL.md found under ${source}`);
  }
  const target = path.join(dest, 'skills', name, 'SKILL.md');
  await mkdir(path.dirname(target), { recursive: true });
  await cp(skill, target);
  wrote.push(`skills/${name}/SKILL.md`);
}

async function copySupport(
  source: string,
  dest: string,
  wrote: string[],
  skipped: string[],
  notes: string[]
): Promise<void> {
  const sourceDir = dirOf(source);
  if (!(await looksLikePlugin(sourceDir))) {
    return;
  }
  for (const dir of SUPPORT_DIRS) {
    const from = path.join(sourceDir, dir);
    const to = path.join(dest, dir);
    if (!(await isDir(from))) {
      continue;
    }
    if (await exists(to)) {
      skipped.push(`${dir}/`);
      continue;
    }
    await cp(from, to, { recursive: true });
    wrote.push(`${dir}/`);
  }
  for (const file of SUPPORT_FILES) {
    const from = path.join(sourceDir, file);
    if (await isFile(from)) {
      await writeMissing(dest, file, await readFile(from, 'utf8'), wrote, skipped);
    }
  }
  if (wrote.some((item) => SUPPORT_DIRS.includes(item.replace(/\/$/, '') as (typeof SUPPORT_DIRS)[number]))) {
    notes.push('copied scripts, hooks, and other plugin support files');
  }
}

/**
 * Plugin hooks are a single `hooks/hooks.json` in the PascalCase Claude shape.
 *
 * All three clients read that same file from a plugin — verified against
 * Cursor's own published plugins, which ship PascalCase events and
 * `${CLAUDE_PLUGIN_ROOT}` commands. The camelCase form is a different surface
 * entirely: the developer's own `.cursor/hooks.json`, which is not a plugin
 * file. So the only conversion to do here is the legacy one, for sources that
 * predate that finding and carry a camelCase `hooks/hooks.json` or a split-out
 * `hooks/claude-hooks.json`.
 */
async function adaptHooks(
  source: string,
  dest: string,
  wrote: string[],
  skipped: string[],
  notes: string[]
): Promise<void> {
  const sourceDir = dirOf(source);
  const destHooks = path.join(dest, 'hooks', 'hooks.json');
  const legacySplit = path.join(dest, 'hooks', 'claude-hooks.json');

  const claudeRaw = await firstClaudeHooks([
    path.join(sourceDir, 'hooks', 'hooks.json'),
    path.join(sourceDir, 'hooks', 'claude-hooks.json'),
    path.join(sourceDir, '.claude-plugin', 'hooks.json'),
    destHooks,
    legacySplit
  ]);

  if (claudeRaw) {
    // copySupport may already have copied a camelCase hooks.json across, so an
    // existing destination file only counts as correct if it is Claude-shaped.
    if (await isClaudeNamedHooks(destHooks)) {
      skipped.push('hooks/hooks.json');
    } else {
      await mkdir(path.dirname(destHooks), { recursive: true });
      await writeFile(destHooks, json(claudeRaw));
      wrote.push('hooks/hooks.json');
      notes.push('wrote plugin hooks in the PascalCase shape every client reads');
    }
    if (await exists(legacySplit)) {
      await rm(legacySplit);
      notes.push('removed hooks/claude-hooks.json — plugin hooks are a single hooks/hooks.json');
    }
    return;
  }

  const cursorRaw = await firstCursorHooks([path.join(sourceDir, 'hooks', 'hooks.json'), destHooks]);
  if (cursorRaw) {
    const { hooks, dropped } = cursorHooksToClaude(cursorRaw);
    await mkdir(path.dirname(destHooks), { recursive: true });
    await writeFile(destHooks, json({ hooks }));
    wrote.push('hooks/hooks.json');
    notes.push('converted camelCase hooks to the PascalCase plugin shape');
    if (dropped.length) {
      notes.push(`dropped Cursor-only hook events with no plugin equivalent: ${dropped.join(', ')}`);
    }
  }
}

async function adaptMcp(
  source: string,
  dest: string,
  wrote: string[],
  skipped: string[],
  notes: string[]
): Promise<void> {
  const sourceDir = dirOf(source);
  const sourceClaude = await readJson(path.join(sourceDir, '.mcp.json'));
  const sourceAgent = await readJson(path.join(sourceDir, 'mcp.json'));
  const destClaudePath = path.join(dest, '.mcp.json');
  const destAgentPath = path.join(dest, 'mcp.json');
  const destClaude = await readJson(destClaudePath);
  const destAgent = await readJson(destAgentPath);
  const pluginMcp = await pluginInlineMcp(sourceDir);

  const claudeRaw = sourceClaude ?? destClaude ?? (isClaudeMcpShape(sourceAgent) ? sourceAgent : undefined) ?? pluginMcp;
  const agentRaw = isAgentMcpShape(sourceAgent)
    ? sourceAgent
    : isAgentMcpShape(destAgent)
      ? destAgent
      : undefined;

  if (claudeRaw && (await isClaudeNamedMcp(destAgentPath))) {
    await writeMissing(dest, '.mcp.json', json(normalizeClaudeMcp(claudeRaw)), wrote, skipped);
    await writeFile(destAgentPath, json(claudeMcpToAgent(claudeRaw)));
    wrote.push('mcp.json');
    notes.push('moved Claude-shaped mcp.json to .mcp.json and wrote Agent Plugins mcp.json');
    return;
  }

  if (claudeRaw) {
    await writeMissing(dest, 'mcp.json', json(claudeMcpToAgent(claudeRaw)), wrote, skipped);
    if (!(await exists(destClaudePath))) {
      await writeMissing(dest, '.mcp.json', json(normalizeClaudeMcp(claudeRaw)), wrote, skipped);
    }
    if (wrote.includes('mcp.json')) {
      notes.push('wrote Agent Plugins mcp.json from Claude MCP');
    }
  }
  if (agentRaw && !(await exists(destClaudePath))) {
    await writeMissing(dest, '.mcp.json', json(agentMcpToClaude(agentRaw)), wrote, skipped);
    notes.push('wrote Claude .mcp.json from mcp.json');
  }
}

async function findSkillFile(source: string): Promise<string | undefined> {
  if ((await isFile(source)) && path.basename(source) === 'SKILL.md') {
    return source;
  }
  const root = dirOf(source);
  const direct = path.join(root, 'SKILL.md');
  if (await isFile(direct)) {
    return direct;
  }
  const skills = path.join(root, 'skills');
  if (!(await isDir(skills))) {
    return undefined;
  }
  for (const entry of await readdir(skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(skills, entry.name, 'SKILL.md');
    if (await isFile(file)) {
      return file;
    }
  }
  return undefined;
}

async function writeMissing(
  dest: string,
  rel: string,
  body: string,
  wrote: string[],
  skipped: string[]
): Promise<void> {
  const file = path.join(dest, rel);
  if (await exists(file)) {
    skipped.push(rel);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  wrote.push(rel);
}

function hookEvents(raw: unknown): Record<string, unknown[]> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const hooks = record.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(hooks as Record<string, unknown>).map(([key, value]) => [key, Array.isArray(value) ? value : []])
  );
}

function isClaudeHookShape(raw: unknown): boolean {
  return Object.keys(hookEvents(raw)).some((key) => key[0] === key[0]?.toUpperCase());
}

function extractCommands(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') {
    return [];
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.command === 'string') {
    return [record.command];
  }
  const nested = record.hooks;
  if (!Array.isArray(nested)) {
    return [];
  }
  return nested.flatMap((item) => extractCommands(item));
}

function toCursorCommand(command: string): string {
  return command
    .replaceAll('"${CLAUDE_PLUGIN_ROOT}"/', './')
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/', './')
    .replaceAll('"${CLAUDE_PLUGIN_ROOT}"', '.')
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', '.');
}

function toClaudeCommand(command: string): string {
  if (command.startsWith('./')) {
    return `"\${CLAUDE_PLUGIN_ROOT}"/${command.slice(2)}`;
  }
  return command;
}

function toClaudePath(value: string): string {
  if (value.startsWith('./')) {
    return `\${CLAUDE_PLUGIN_ROOT}/${value.slice(2)}`;
  }
  return value;
}

function toAgentEntry(entry: unknown): AgentMcpEntry {
  const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
  if (typeof record.url === 'string' && record.url) {
    const type = record.type === 'sse' ? 'sse' : 'streamable-http';
    return { type, url: record.url };
  }
  const args = Array.isArray(record.args) ? record.args.map((arg) => toCursorCommand(String(arg))) : [];
  const env = agentEnv(record.env);
  return {
    type: 'stdio',
    command: typeof record.command === 'string' ? record.command : 'node',
    args,
    cwd: './',
    ...(env ? { env } : {})
  };
}

/**
 * Cursor resolves a plugin's relative paths against the plugin root already, so
 * its inline entries carry neither `${CLAUDE_PLUGIN_ROOT}` nor an explicit cwd.
 */
function toCursorInline(raw: unknown): Record<string, unknown> {
  const servers = serverMap(raw);
  return Object.fromEntries(
    Object.entries(servers).map(([key, entry]) => {
      const agent = toAgentEntry(entry);
      if (agent.url) {
        return [key, { type: agent.type, url: agent.url }];
      }
      return [key, { command: agent.command, args: agent.args }];
    })
  );
}

function normalizeClaudeMcp(raw: unknown): ClaudeMcpFile {
  if (isAgentMcpShape(raw)) {
    return agentMcpToClaude(raw);
  }
  const servers = serverMap(raw);
  return { mcpServers: servers as ClaudeMcpFile['mcpServers'] };
}

function serverMap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const wrapped = record.mcpServers;
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    return wrapped as Record<string, unknown>;
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== '$schema'));
}

function isAgentMcpShape(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && '$schema' in (raw as object));
}

function isClaudeMcpShape(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || isAgentMcpShape(raw)) {
    return false;
  }
  return JSON.stringify(raw).includes('CLAUDE_PLUGIN_ROOT');
}

function agentEnv(value: unknown): Record<string, string> | undefined {
  if (!isStringRecord(value)) {
    return undefined;
  }
  const next = Object.fromEntries(
    Object.entries(value).filter(([key, item]) => {
      if (FORBIDDEN_AGENT_ENV.has(key)) {
        return false;
      }
      return !item.includes('CLAUDE_PLUGIN_ROOT') && !item.includes('CLAUDE_PROJECT_DIR');
    })
  );
  return Object.keys(next).length ? next : undefined;
}

function claudeEnv(value: unknown): Record<string, string> | undefined {
  return isStringRecord(value) && Object.keys(value).length ? value : undefined;
}

function stringField(raw: unknown, key: string): string | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function arrayField(raw: unknown, key: string): string[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const value = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')
  );
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function dirOf(source: string): string {
  return source.endsWith('.md') ? path.dirname(source) : source;
}

async function firstClaudeHooks(files: string[]): Promise<unknown | undefined> {
  for (const file of files) {
    const parsed = await readJson(file);
    if (parsed && isClaudeHookShape(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function firstCursorHooks(files: string[]): Promise<unknown | undefined> {
  for (const file of files) {
    const parsed = await readJson(file);
    if (parsed && !isClaudeHookShape(parsed) && Object.keys(hookEvents(parsed)).length) {
      return parsed;
    }
  }
  return undefined;
}

async function isClaudeNamedHooks(file: string): Promise<boolean> {
  const parsed = await readJson(file);
  return Boolean(parsed && isClaudeHookShape(parsed));
}

async function isClaudeNamedMcp(file: string): Promise<boolean> {
  return isClaudeMcpShape(await readJson(file));
}

async function pluginInlineMcp(dir: string): Promise<unknown | undefined> {
  const claude = await readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
  if (claude && 'mcpServers' in claude) {
    return { mcpServers: claude.mcpServers };
  }
  return undefined;
}

async function looksLikePlugin(dir: string): Promise<boolean> {
  return (
    (await isFile(path.join(dir, '.claude-plugin', 'plugin.json'))) ||
    (await isFile(path.join(dir, 'plugin.json'))) ||
    (await isDir(path.join(dir, 'skills')))
  );
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function isDir(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}
