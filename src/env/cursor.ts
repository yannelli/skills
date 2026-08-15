import path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { backupDir, cursorPaths } from './client-paths.js';
import type { WriteResult } from './safe-io.js';
import {
  isDir,
  isFile,
  listDirs,
  listFiles,
  readJsonChecked,
  readText,
  writeJsonSafely
} from './safe-io.js';
import type {
  AgentEntry,
  Client,
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
 * Cursor's on-disk configuration.
 *
 * Two facts drive most of this file and are not in Cursor's public docs:
 *
 *  1. Cursor has two unrelated hook formats. `~/.cursor/hooks.json` and
 *     `<root>/.cursor/hooks.json` are camelCase, versioned, and hold hook
 *     definitions directly under the event key. Plugin hooks
 *     (`<pluginRoot>/hooks/hooks.json`) are byte-identical to Claude's:
 *     PascalCase events, a `{ matcher, hooks: [...] }` wrapper, and
 *     `${CLAUDE_PLUGIN_ROOT}` in commands.
 *  2. Cursor plugins declare their MCP servers inline in the manifest, and the
 *     install cache carries an extra content-hash directory level.
 */

const CLIENT: Client = 'cursor';

/** Every event Cursor's own `create-hook` skill accepts in a user/project hooks.json. */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'beforeSubmitPrompt',
  'preCompact',
  'stop',
  'afterAgentResponse',
  'afterAgentThought',
  'beforeTabFileRead',
  'afterTabFileEdit'
] as const;

export type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number];

export type CursorHookDef = {
  command: string;
  type?: 'command' | 'prompt';
  timeout?: number;
  matcher?: string;
  failClosed?: boolean;
  loop_limit?: number;
};

export type ClaudeHookGroup = {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string; timeout?: number }>;
};

export type CursorUserHooksFile = { version: 1; hooks: Record<string, CursorHookDef[]> };

export type ClaudeHooksFile = { hooks: Record<string, ClaudeHookGroup[]> };

export type CursorScan = {
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

/** Only these events have a genuine counterpart on both sides. Anything else is dropped, never guessed. */
const CLAUDE_TO_CURSOR_EVENT: Record<string, CursorHookEvent> = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PostToolUseFailure: 'postToolUseFailure',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  UserPromptSubmit: 'beforeSubmitPrompt',
  PreCompact: 'preCompact',
  Stop: 'stop'
};

const CURSOR_TO_CLAUDE_EVENT: Record<string, string> = Object.fromEntries(
  Object.entries(CLAUDE_TO_CURSOR_EVENT).map(([claude, cursor]) => [cursor, claude])
);

export function isCursorHookEvent(event: string): event is CursorHookEvent {
  return (CURSOR_HOOK_EVENTS as readonly string[]).includes(event);
}

export async function scanCursor(projectRoot: string): Promise<CursorScan> {
  const paths = cursorPaths(projectRoot);
  const scan: CursorScan = {
    installed: await isDir(paths.dir),
    skills: [],
    plugins: [],
    mcpServers: [],
    hooks: [],
    agents: [],
    commands: [],
    memory: [],
    warnings: []
  };

  await guard(scan.warnings, paths.userMcp, async () => {
    scan.mcpServers.push(...(await readMcpFile(paths.userMcp, 'user', scan.warnings)));
  });
  await guard(scan.warnings, paths.projectMcp, async () => {
    scan.mcpServers.push(...(await readMcpFile(paths.projectMcp, 'project', scan.warnings)));
  });

  await guard(scan.warnings, paths.userHooks, async () => {
    scan.hooks.push(...(await readCursorHooksFile(paths.userHooks, 'user', scan.warnings)));
  });
  await guard(scan.warnings, paths.projectHooks, async () => {
    scan.hooks.push(...(await readCursorHooksFile(paths.projectHooks, 'project', scan.warnings)));
  });

  await guard(scan.warnings, paths.userSkills, async () => {
    scan.skills.push(...(await readSkillsDir(paths.userSkills, 'user', undefined, scan.warnings)));
  });
  await guard(scan.warnings, paths.projectSkills, async () => {
    scan.skills.push(...(await readSkillsDir(paths.projectSkills, 'project', undefined, scan.warnings)));
  });
  await guard(scan.warnings, paths.builtinSkills, async () => {
    scan.skills.push(...(await readSkillsDir(paths.builtinSkills, 'builtin', undefined, scan.warnings)));
  });

  await guard(scan.warnings, paths.userCommands, async () => {
    scan.commands.push(
      ...(await readMarkdownDir(paths.userCommands, 'user', 'command', undefined, scan.warnings))
    );
  });
  await guard(scan.warnings, paths.projectCommands, async () => {
    scan.commands.push(
      ...(await readMarkdownDir(paths.projectCommands, 'project', 'command', undefined, scan.warnings))
    );
  });

  await guard(scan.warnings, paths.userRules, async () => {
    scan.memory.push(...(await readRulesDir(paths.userRules, 'user', scan.warnings)));
  });
  await guard(scan.warnings, paths.projectRules, async () => {
    scan.memory.push(...(await readRulesDir(paths.projectRules, 'project', scan.warnings)));
  });
  await guard(scan.warnings, paths.legacyRules, async () => {
    const legacy = await readMemoryFile(paths.legacyRules, 'project');
    if (legacy) {
      scan.memory.push(legacy);
    }
  });

  await guard(scan.warnings, paths.pluginCacheDir, async () => {
    await readPlugins(paths.pluginCacheDir, scan);
  });

  return scan;
}

/**
 * Move a server between `mcpServers` and `_disabledMcpServers`.
 *
 * Cursor has no per-server enabled flag, so there is nothing to toggle: the
 * only way to disable a server without losing it is to park the entry under a
 * sibling key Cursor ignores. The value is moved verbatim — command, args, env,
 * url, headers and any key Yard does not model — so re-enabling restores the
 * original entry exactly.
 */
export async function setMcpServerEnabled(opts: {
  server: string;
  enabled: boolean;
  scope: 'user' | 'project';
  projectRoot: string;
  dryRun?: boolean;
}): Promise<WriteResult> {
  const paths = cursorPaths(opts.projectRoot);
  const file = opts.scope === 'user' ? paths.userMcp : paths.projectMcp;
  const parsed = await readJsonChecked<unknown>(file);
  if (parsed.error !== undefined) {
    // Refuse rather than overwrite: rewriting an unparseable file would destroy
    // configuration Yard cannot see.
    throw new Error(`cursor mcp.json is not valid JSON (${file}): ${parsed.error}`);
  }

  const root = asRecord(parsed.value) ?? {};
  const enabledMap: Record<string, unknown> = { ...(asRecord(root.mcpServers) ?? {}) };
  const disabledMap: Record<string, unknown> = { ...(asRecord(root._disabledMcpServers) ?? {}) };
  const from = opts.enabled ? disabledMap : enabledMap;
  const to = opts.enabled ? enabledMap : disabledMap;
  const entry = from[opts.server];

  if (entry === undefined) {
    // Already in the requested state, or the server is not declared here.
    const raw = await readText(file);
    return {
      file,
      changed: false,
      created: false,
      after: raw ?? '',
      ...(raw !== undefined ? { before: raw } : {})
    };
  }

  delete from[opts.server];
  to[opts.server] = entry;

  const next: Record<string, unknown> = { ...root, mcpServers: enabledMap };
  if (Object.keys(disabledMap).length > 0) {
    next._disabledMcpServers = disabledMap;
  } else {
    delete next._disabledMcpServers;
  }

  return writeJsonSafely(file, next, { dryRun: opts.dryRun === true, backupDir: backupDir() });
}

export function claudeHooksToCursorUser(raw: unknown): CursorUserHooksFile & { dropped: string[] } {
  const events = asRecord(asRecord(raw)?.hooks) ?? {};
  const hooks: Record<string, CursorHookDef[]> = {};
  const dropped: string[] = [];

  for (const [event, value] of Object.entries(events)) {
    const target = CLAUDE_TO_CURSOR_EVENT[event];
    if (!target) {
      dropped.push(event);
      continue;
    }
    const parsed = parseClaudeEvent(value);
    dropped.push(...parsed.problems.map((problem) => `${event}: ${problem}`));
    const defs = parsed.defs.map((def) => ({
      command: def.command,
      type: def.type,
      ...(def.matcher !== undefined ? { matcher: def.matcher } : {}),
      ...(def.timeout !== undefined ? { timeout: def.timeout } : {})
    }));
    if (defs.length > 0) {
      hooks[target] = [...(hooks[target] ?? []), ...defs];
    }
  }

  return { version: 1, hooks, dropped };
}

export function cursorUserHooksToClaude(raw: unknown): ClaudeHooksFile & { dropped: string[] } {
  const events = asRecord(asRecord(raw)?.hooks) ?? {};
  const hooks: Record<string, ClaudeHookGroup[]> = {};
  const dropped: string[] = [];

  for (const [event, value] of Object.entries(events)) {
    const target = CURSOR_TO_CLAUDE_EVENT[event];
    if (!target) {
      dropped.push(event);
      continue;
    }
    const parsed = parseCursorEvent(value);
    dropped.push(...parsed.problems.map((problem) => `${event}: ${problem}`));
    const groups: ClaudeHookGroup[] = [];
    for (const def of parsed.defs) {
      if (def.type === 'prompt') {
        // Claude has no prompt-type hook, and rewriting one as a shell command
        // would change what it does.
        dropped.push(`${event}: prompt hook`);
        continue;
      }
      groups.push({
        ...(def.matcher !== undefined ? { matcher: def.matcher } : {}),
        hooks: [
          {
            type: 'command',
            command: def.command,
            ...(def.timeout !== undefined ? { timeout: def.timeout } : {})
          }
        ]
      });
    }
    if (groups.length > 0) {
      hooks[target] = [...(hooks[target] ?? []), ...groups];
    }
  }

  return { hooks, dropped };
}

type ParsedHook = {
  command: string;
  type: 'command' | 'prompt';
  matcher?: string;
  timeout?: number;
};

type ParsedEvent = { defs: ParsedHook[]; problems: string[] };

/** Cursor user/project shape: the event array holds hook definitions directly. */
function parseCursorEvent(value: unknown): ParsedEvent {
  if (!Array.isArray(value)) {
    return { defs: [], problems: ['expected an array of hook definitions'] };
  }
  const defs: ParsedHook[] = [];
  const problems: string[] = [];
  for (const [index, item] of value.entries()) {
    const def = asRecord(item);
    const command = typeof def?.command === 'string' ? def.command : undefined;
    if (!def || !command) {
      problems.push(`hook ${index} has no command`);
      continue;
    }
    defs.push({
      command,
      type: def.type === 'prompt' ? 'prompt' : 'command',
      ...(typeof def.matcher === 'string' ? { matcher: def.matcher } : {}),
      ...(typeof def.timeout === 'number' ? { timeout: def.timeout } : {})
    });
  }
  return { defs, problems };
}

/** Claude/plugin shape: the event array holds `{ matcher, hooks: [...] }` groups. */
function parseClaudeEvent(value: unknown): ParsedEvent {
  if (!Array.isArray(value)) {
    return { defs: [], problems: ['expected an array of hook groups'] };
  }
  const defs: ParsedHook[] = [];
  const problems: string[] = [];

  for (const [index, item] of value.entries()) {
    const group = asRecord(item);
    if (!group) {
      problems.push(`group ${index} is not an object`);
      continue;
    }
    const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;

    if (!Array.isArray(group.hooks)) {
      // Tolerate a bare definition where the wrapper was omitted.
      if (typeof group.command === 'string' && group.command) {
        defs.push({
          command: group.command,
          type: 'command',
          ...(matcher !== undefined ? { matcher } : {}),
          ...(typeof group.timeout === 'number' ? { timeout: group.timeout } : {})
        });
        continue;
      }
      problems.push(`group ${index} has no hooks array`);
      continue;
    }

    for (const [inner, entry] of group.hooks.entries()) {
      const hook = asRecord(entry);
      const command = typeof hook?.command === 'string' ? hook.command : undefined;
      if (!hook || !command) {
        problems.push(`group ${index} hook ${inner} has no command`);
        continue;
      }
      defs.push({
        command,
        type: 'command',
        ...(matcher !== undefined ? { matcher } : {}),
        ...(typeof hook.timeout === 'number' ? { timeout: hook.timeout } : {})
      });
    }
  }

  return { defs, problems };
}

async function readCursorHooksFile(
  file: string,
  scope: Scope,
  warnings: ScanWarning[]
): Promise<HookEntry[]> {
  const events = await readEventMap(file, warnings);
  const out: HookEntry[] = [];
  for (const [event, value] of Object.entries(events)) {
    if (!isCursorHookEvent(event)) {
      warnings.push({ client: CLIENT, file, message: `unknown hook event: ${event}` });
    }
    const parsed = parseCursorEvent(value);
    for (const problem of parsed.problems) {
      warnings.push({ client: CLIENT, file, message: `${event}: ${problem}` });
    }
    out.push(...toHookEntries(event, parsed.defs, scope, file, undefined));
  }
  return out;
}

async function readPluginHooksFile(
  file: string,
  plugin: string,
  warnings: ScanWarning[]
): Promise<HookEntry[]> {
  const events = await readEventMap(file, warnings);
  const out: HookEntry[] = [];
  for (const [event, value] of Object.entries(events)) {
    const parsed = parseClaudeEvent(value);
    for (const problem of parsed.problems) {
      warnings.push({ client: CLIENT, file, message: `${event}: ${problem}` });
    }
    out.push(...toHookEntries(event, parsed.defs, 'plugin', file, plugin));
  }
  return out;
}

async function readEventMap(file: string, warnings: ScanWarning[]): Promise<Record<string, unknown>> {
  const parsed = await readJsonChecked<unknown>(file);
  if (parsed.missing) {
    return {};
  }
  if (parsed.error !== undefined) {
    warnings.push({ client: CLIENT, file, message: `invalid JSON: ${parsed.error}` });
    return {};
  }
  const root = asRecord(parsed.value);
  const events = asRecord(root?.hooks);
  if (!events) {
    warnings.push({ client: CLIENT, file, message: 'no "hooks" object' });
    return {};
  }
  return events;
}

function toHookEntries(
  event: string,
  defs: ParsedHook[],
  scope: Scope,
  file: string,
  plugin: string | undefined
): HookEntry[] {
  return defs.map((def, index) => ({
    id: `cursor:${scope}:${plugin ? `${plugin}:` : ''}${event}:${index}`,
    client: CLIENT,
    scope,
    event,
    type: def.type,
    command: def.command,
    file,
    enabled: true,
    index,
    ...(def.matcher !== undefined ? { matcher: def.matcher } : {}),
    ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
    ...(plugin ? { plugin } : {})
  }));
}

async function readMcpFile(file: string, scope: Scope, warnings: ScanWarning[]): Promise<McpEntry[]> {
  const parsed = await readJsonChecked<unknown>(file);
  if (parsed.missing) {
    return [];
  }
  if (parsed.error !== undefined) {
    warnings.push({ client: CLIENT, file, message: `invalid JSON: ${parsed.error}` });
    return [];
  }
  const root = asRecord(parsed.value);
  if (!root) {
    warnings.push({ client: CLIENT, file, message: 'expected a JSON object' });
    return [];
  }
  const enabled = asRecord(root.mcpServers);
  const disabled = asRecord(root._disabledMcpServers);
  if (!enabled && !disabled) {
    warnings.push({ client: CLIENT, file, message: 'no "mcpServers" object' });
    return [];
  }
  return [
    ...mcpEntries(enabled ?? {}, file, scope, true, undefined, warnings),
    ...mcpEntries(disabled ?? {}, file, scope, false, undefined, warnings)
  ];
}

function mcpEntries(
  servers: Record<string, unknown>,
  file: string,
  scope: Scope,
  enabled: boolean,
  plugin: string | undefined,
  warnings: ScanWarning[]
): McpEntry[] {
  const out: McpEntry[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const record = asRecord(value);
    if (!record) {
      warnings.push({ client: CLIENT, file, message: `mcp server ${name} is not an object` });
      continue;
    }
    const args = Array.isArray(record.args) ? record.args.map((arg) => String(arg)) : undefined;
    const env = stringMap(record.env);
    const headers = stringMap(record.headers);
    out.push({
      id: `cursor:${scope}:${plugin ? `${plugin}:` : ''}${name}`,
      client: CLIENT,
      scope,
      name,
      transport: inferTransport(record),
      file,
      enabled,
      ...(typeof record.command === 'string' ? { command: record.command } : {}),
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
      ...(typeof record.url === 'string' ? { url: record.url } : {}),
      ...(headers ? { headers } : {}),
      ...(plugin ? { plugin } : {}),
      // Cursor has no enabled flag; disabled servers are the ones Yard parked
      // under `_disabledMcpServers`, so the file itself is the source.
      ...(enabled ? {} : { enabledSource: file })
    });
  }
  return out;
}

/** Cursor omits `type` in practice, so a `url` is what makes a server remote. */
function inferTransport(record: Record<string, unknown>): McpTransportKind {
  const declared = typeof record.type === 'string' ? record.type.toLowerCase() : undefined;
  if (declared === 'stdio' || declared === 'http' || declared === 'sse' || declared === 'ws') {
    return declared;
  }
  if (declared === 'streamable-http' || declared === 'streamablehttp') {
    return 'http';
  }
  if (declared === 'websocket') {
    return 'ws';
  }
  return typeof record.url === 'string' && record.url ? 'http' : 'stdio';
}

async function readSkillsDir(
  dir: string,
  scope: Scope,
  plugin: string | undefined,
  warnings: ScanWarning[]
): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  for (const name of await listDirs(dir)) {
    const skillDir = path.join(dir, name);
    const file = path.join(skillDir, 'SKILL.md');
    if (!(await isFile(file))) {
      warnings.push({ client: CLIENT, file, message: `skill directory ${name} has no SKILL.md` });
      continue;
    }
    const raw = await readText(file);
    if (raw === undefined) {
      warnings.push({ client: CLIENT, file, message: 'unreadable' });
      continue;
    }
    const { data } = parseFrontmatter(raw);
    const qualifiedName = plugin ? `${plugin}:${name}` : name;
    out.push({
      id: `cursor:${scope}:${qualifiedName}`,
      client: CLIENT,
      scope,
      name,
      qualifiedName,
      description: data.description ?? '',
      file,
      dir: skillDir,
      visibility: 'on',
      frontmatter: data,
      bytes: Buffer.byteLength(raw, 'utf8'),
      ...(plugin ? { plugin } : {})
    });
  }
  return out;
}

async function readMarkdownDir(
  dir: string,
  scope: Scope,
  kind: 'agent' | 'command',
  plugin: string | undefined,
  warnings: ScanWarning[]
): Promise<AgentEntry[]> {
  const out: AgentEntry[] = [];
  for (const fileName of await listFiles(dir, ['.md', '.mdc'])) {
    const file = path.join(dir, fileName);
    const raw = await readText(file);
    if (raw === undefined) {
      warnings.push({ client: CLIENT, file, message: 'unreadable' });
      continue;
    }
    const { data } = parseFrontmatter(raw);
    const name = fileName.replace(/\.mdc?$/, '');
    out.push({
      id: `cursor:${scope}:${kind}:${plugin ? `${plugin}:` : ''}${name}`,
      client: CLIENT,
      scope,
      name,
      description: data.description ?? '',
      file,
      bytes: Buffer.byteLength(raw, 'utf8'),
      ...(plugin ? { plugin } : {})
    });
  }
  return out;
}

async function readRulesDir(dir: string, scope: Scope, warnings: ScanWarning[]): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = [];
  for (const fileName of await listFiles(dir, ['.mdc', '.md'])) {
    const file = path.join(dir, fileName);
    const raw = await readText(file);
    if (raw === undefined) {
      warnings.push({ client: CLIENT, file, message: 'unreadable' });
      continue;
    }
    const { data } = parseFrontmatter(raw);
    if (data.description === undefined && data.alwaysApply === undefined && data.globs === undefined) {
      // Without one of these Cursor has no trigger for the rule, so it never applies.
      warnings.push({
        client: CLIENT,
        file,
        message: 'rule has no description, globs, or alwaysApply frontmatter'
      });
    }
    out.push(memoryEntry(file, scope, raw));
  }
  return out;
}

async function readMemoryFile(file: string, scope: Scope): Promise<MemoryEntry | undefined> {
  const raw = await readText(file);
  return raw === undefined ? undefined : memoryEntry(file, scope, raw);
}

function memoryEntry(file: string, scope: Scope, raw: string): MemoryEntry {
  const name = path.basename(file);
  return {
    id: `cursor:${scope}:memory:${name}`,
    client: CLIENT,
    scope,
    name,
    file,
    bytes: Buffer.byteLength(raw, 'utf8')
  };
}

/**
 * `~/.cursor/plugins/cache/<marketplace>/<plugin>/<sha>/`. The content-hash
 * level is Cursor-specific — Claude and Codex stop at the plugin directory.
 */
async function readPlugins(cacheDir: string, scan: CursorScan): Promise<void> {
  for (const marketplace of await listDirs(cacheDir)) {
    const marketplaceDir = path.join(cacheDir, marketplace);
    for (const pluginName of await listDirs(marketplaceDir)) {
      const versionsDir = path.join(marketplaceDir, pluginName);
      const shas = await listDirs(versionsDir);
      const sha = shas[shas.length - 1];
      if (sha === undefined) {
        continue;
      }
      if (shas.length > 1) {
        scan.warnings.push({
          client: CLIENT,
          file: versionsDir,
          message: `${shas.length} cached versions; scanning ${sha}`
        });
      }
      await readPlugin(path.join(versionsDir, sha), marketplace, pluginName, scan);
    }
  }
}

async function readPlugin(
  root: string,
  marketplace: string,
  dirName: string,
  scan: CursorScan
): Promise<void> {
  const manifestFile = path.join(root, '.cursor-plugin', 'plugin.json');
  const parsed = await readJsonChecked<unknown>(manifestFile);
  if (parsed.missing) {
    scan.warnings.push({ client: CLIENT, file: manifestFile, message: 'plugin manifest missing' });
    return;
  }
  if (parsed.error !== undefined) {
    scan.warnings.push({ client: CLIENT, file: manifestFile, message: `invalid JSON: ${parsed.error}` });
    return;
  }
  const manifest = asRecord(parsed.value);
  if (!manifest) {
    scan.warnings.push({ client: CLIENT, file: manifestFile, message: 'expected a JSON object' });
    return;
  }

  const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : dirName;

  const skills: SkillEntry[] = [];
  for (const dir of manifestDirs(root, manifest.skills, 'skills', manifestFile, scan.warnings)) {
    skills.push(...(await readSkillsDir(dir, 'plugin', name, scan.warnings)));
  }
  const agents: AgentEntry[] = [];
  for (const dir of manifestDirs(root, manifest.agents, 'agents', manifestFile, scan.warnings)) {
    agents.push(...(await readMarkdownDir(dir, 'plugin', 'agent', name, scan.warnings)));
  }
  const commands: CommandEntry[] = [];
  for (const dir of manifestDirs(root, manifest.commands, 'commands', manifestFile, scan.warnings)) {
    commands.push(...(await readMarkdownDir(dir, 'plugin', 'command', name, scan.warnings)));
  }

  const hooks = await readPluginHooksFile(path.join(root, 'hooks', 'hooks.json'), name, scan.warnings);
  const inlineMcp = asRecord(manifest.mcpServers);
  const mcpServers = inlineMcp
    ? mcpEntries(inlineMcp, manifestFile, 'plugin', true, name, scan.warnings)
    : [];

  scan.skills.push(...skills);
  scan.agents.push(...agents);
  scan.commands.push(...commands);
  scan.hooks.push(...hooks);
  scan.mcpServers.push(...mcpServers);
  scan.plugins.push({
    id: `cursor:user:${name}`,
    client: CLIENT,
    scope: 'user',
    name,
    marketplace,
    qualifiedName: name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: typeof manifest.version === 'string' ? manifest.version : '',
    root,
    enabled: true,
    installed: true,
    skills: skills.length,
    hooks: hooks.length,
    mcpServers: mcpServers.length
  });
}

/**
 * Manifest values seen in the wild are `"./skills/"`, `"skills"`, `"agents"`,
 * and `"commands"`; an array of any of those is accepted too.
 */
function manifestDirs(
  root: string,
  value: unknown,
  fallback: string,
  manifestFile: string,
  warnings: ScanWarning[]
): string[] {
  const raw = value === undefined || value === null ? [fallback] : Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item) {
      warnings.push({ client: CLIENT, file: manifestFile, message: `${fallback} entry is not a path` });
      continue;
    }
    const resolved = path.resolve(root, item);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      warnings.push({
        client: CLIENT,
        file: manifestFile,
        message: `${fallback} path escapes the plugin root: ${item}`
      });
      continue;
    }
    out.push(resolved);
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = String(item);
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Last line of defence for rule 1: an unexpected throw becomes a warning. */
async function guard(warnings: ScanWarning[], file: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    warnings.push({
      client: CLIENT,
      file,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
