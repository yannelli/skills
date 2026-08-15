import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { backupDir, claudePaths } from './client-paths.js';
import { collectSkillDirs } from './skill-dirs.js';
import {
  isDir,
  isFile,
  listDirs,
  listFiles,
  readJson,
  readJsonChecked,
  readText,
  writeJsonSafely
} from './safe-io.js';
import type { WriteResult } from './safe-io.js';
import { SKILL_VISIBILITIES } from './types.js';
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
  SkillEntry,
  SkillVisibility
} from './types.js';

/**
 * Claude Code's hook events, PascalCase exactly as they must appear in
 * `settings.hooks`. Verified against a live 2026 install, not documentation.
 */
export const CLAUDE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged'
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

const HOOK_EVENTS = new Set<string>(CLAUDE_HOOK_EVENTS);

/** Settings layers, lowest precedence first. */
export const CLAUDE_SETTINGS_LEVELS = [
  'managed',
  'user',
  'project',
  'userLocal',
  'projectLocal'
] as const;

export type ClaudeSettingsLevel = (typeof CLAUDE_SETTINGS_LEVELS)[number];

/** A scope a caller may write settings to. `local` is the project-local override. */
export type ClaudeWriteScope = 'user' | 'project' | 'local';

export type ClaudeSettingsFile = {
  level: ClaudeSettingsLevel;
  scope: Scope;
  file: string;
};

export const SKILL_LISTING_MAX_DESC_CHARS_DEFAULT = 1536;
export const SKILL_LISTING_BUDGET_FRACTION_DEFAULT = 0.01;

/** Every settings file Claude Code consults, in increasing precedence. */
export function claudeSettingsFiles(projectRoot: string): ClaudeSettingsFile[] {
  const paths = claudePaths(projectRoot);
  return [
    { level: 'managed', scope: 'builtin', file: paths.managedSettings },
    { level: 'user', scope: 'user', file: paths.userSettings },
    { level: 'project', scope: 'project', file: paths.projectSettings },
    { level: 'userLocal', scope: 'local', file: paths.userLocalSettings },
    { level: 'projectLocal', scope: 'local', file: paths.projectLocalSettings }
  ];
}

/** The single file a mutator writes for a given scope. */
export function claudeSettingsTarget(scope: ClaudeWriteScope, projectRoot: string): string {
  const paths = claudePaths(projectRoot);
  switch (scope) {
    case 'user':
      return paths.userSettings;
    case 'project':
      return paths.projectSettings;
    case 'local':
      return paths.projectLocalSettings;
    default: {
      const exhaustive: never = scope;
      throw new Error(`unknown settings scope: ${String(exhaustive)}`);
    }
  }
}

export type ClaudeSettingsSources = {
  skillListingMaxDescChars?: string;
  skillListingBudgetFraction?: string;
  disableAllHooks?: string;
  disableBundledSkills?: string;
  enableAllProjectMcpServers?: string;
  /** Keyed by skill id. */
  skillOverrides: Record<string, string>;
  /** Keyed by `<plugin>@<marketplace>`. */
  enabledPlugins: Record<string, string>;
  /** Keyed by `.mcp.json` server name. */
  mcpjsonServers: Record<string, string>;
  /** Keyed by marketplace id. */
  extraKnownMarketplaces: Record<string, string>;
};

export type ClaudeSettingsView = {
  /** Every candidate file, in increasing precedence. */
  files: ClaudeSettingsFile[];
  /** The subset that existed and parsed. */
  loaded: string[];
  skillOverrides: Record<string, SkillVisibility>;
  skillListingMaxDescChars: number;
  skillListingBudgetFraction: number;
  enabledPlugins: Record<string, boolean>;
  /** Approval per `.mcp.json` server. A missing key means pending approval. */
  mcpjsonServers: Record<string, boolean>;
  enabledMcpjsonServers: string[];
  disabledMcpjsonServers: string[];
  disableAllHooks: boolean;
  disableBundledSkills: boolean;
  extraKnownMarketplaces: Record<string, Record<string, unknown>>;
  /** From `~/.claude.json`, which is global state rather than a settings file. */
  enableAllProjectMcpServers: boolean;
  sources: ClaudeSettingsSources;
};

export type ClaudeScan = {
  installed: boolean;
  skills: SkillEntry[];
  plugins: PluginEntry[];
  mcpServers: McpEntry[];
  hooks: HookEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
  memory: MemoryEntry[];
  warnings: ScanWarning[];
  settings: ClaudeSettingsView;
};

type LoadedSettings = { source: ClaudeSettingsFile; value: Record<string, unknown> };

type PluginComponents = {
  skills: SkillEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
  hooks: HookEntry[];
  mcpServers: McpEntry[];
};

export async function scanClaude(projectRoot: string): Promise<ClaudeScan> {
  const paths = claudePaths(projectRoot);
  const warnings: ScanWarning[] = [];

  const loaded = await loadSettings(projectRoot, warnings);
  const global = await readGlobalConfig(paths.globalConfig, warnings);
  const settings = mergeSettings(
    claudeSettingsFiles(projectRoot),
    loaded,
    global,
    paths.globalConfig,
    warnings
  );

  const skills: SkillEntry[] = [];
  const plugins: PluginEntry[] = [];
  const mcpServers: McpEntry[] = [];
  const hooks: HookEntry[] = [];
  const agents: AgentEntry[] = [];
  const commands: CommandEntry[] = [];
  const memory: MemoryEntry[] = [];

  const personal = new Set<string>();
  skills.push(
    ...(await scanSkillDir(paths.userSkills, { scope: 'user' }, settings, warnings, personal))
  );
  skills.push(
    ...(await scanSkillDir(
      paths.userSkillsDisabled,
      { scope: 'user', disabled: true },
      settings,
      warnings,
      personal
    ))
  );
  skills.push(
    ...(await scanSkillDir(paths.projectSkills, { scope: 'project' }, settings, warnings))
  );

  agents.push(...(await scanDocDir(paths.userAgents, 'user', warnings)));
  agents.push(...(await scanDocDir(paths.projectAgents, 'project', warnings)));
  commands.push(...(await scanDocDir(paths.userCommands, 'user', warnings)));
  commands.push(...(await scanDocDir(paths.projectCommands, 'project', warnings)));

  hooks.push(...hooksFromSettings(loaded, settings, warnings));

  mcpServers.push(...(await scanProjectMcp(paths.projectMcp, settings, paths.globalConfig, warnings)));

  memory.push(...(await scanMemory(paths, warnings)));

  const pluginScan = await scanPlugins(projectRoot, settings, warnings);
  plugins.push(...pluginScan.plugins);
  skills.push(...pluginScan.components.skills);
  agents.push(...pluginScan.components.agents);
  commands.push(...pluginScan.components.commands);
  hooks.push(...pluginScan.components.hooks);
  mcpServers.push(...pluginScan.components.mcpServers);

  return {
    installed: await isDir(paths.dir),
    skills,
    plugins,
    mcpServers,
    hooks,
    agents,
    commands,
    memory,
    warnings,
    settings
  };
}

export async function setSkillVisibility(opts: {
  skill: string;
  visibility: SkillVisibility;
  scope?: ClaudeWriteScope;
  projectRoot: string;
  dryRun?: boolean;
}): Promise<WriteResult> {
  if (!SKILL_VISIBILITIES.includes(opts.visibility)) {
    throw new Error(
      `unknown skill visibility "${String(opts.visibility)}": expected one of ${SKILL_VISIBILITIES.join(', ')}`
    );
  }
  const file = claudeSettingsTarget(opts.scope ?? 'user', opts.projectRoot);
  const settings = await readSettingsForWrite(file);
  const overrides = { ...(asRecord(settings.skillOverrides) ?? {}) };

  // `on` is the default, so recording it would only grow the file.
  if (opts.visibility === 'on') {
    delete overrides[opts.skill];
  } else {
    overrides[opts.skill] = opts.visibility;
  }

  if (Object.keys(overrides).length === 0) {
    delete settings.skillOverrides;
  } else {
    settings.skillOverrides = overrides;
  }
  return writeSettings(file, settings, opts.dryRun === true);
}

export async function setPluginEnabled(opts: {
  plugin: string;
  enabled: boolean;
  scope?: ClaudeWriteScope;
  projectRoot: string;
  dryRun?: boolean;
}): Promise<WriteResult> {
  const key = await resolvePluginKey(opts.plugin, opts.projectRoot);
  const file = claudeSettingsTarget(opts.scope ?? 'user', opts.projectRoot);
  const settings = await readSettingsForWrite(file);
  const enabledPlugins = { ...(asRecord(settings.enabledPlugins) ?? {}) };
  enabledPlugins[key] = opts.enabled;
  settings.enabledPlugins = enabledPlugins;
  return writeSettings(file, settings, opts.dryRun === true);
}

export async function setMcpEnabled(opts: {
  server: string;
  enabled: boolean;
  scope?: ClaudeWriteScope;
  projectRoot: string;
  dryRun?: boolean;
}): Promise<WriteResult> {
  const file = claudeSettingsTarget(opts.scope ?? 'user', opts.projectRoot);
  const settings = await readSettingsForWrite(file);
  const enabled = new Set(asStringArray(settings.enabledMcpjsonServers) ?? []);
  const disabled = new Set(asStringArray(settings.disabledMcpjsonServers) ?? []);

  enabled.delete(opts.server);
  disabled.delete(opts.server);
  (opts.enabled ? enabled : disabled).add(opts.server);

  applyList(settings, 'enabledMcpjsonServers', enabled);
  applyList(settings, 'disabledMcpjsonServers', disabled);
  return writeSettings(file, settings, opts.dryRun === true);
}

/**
 * Enable or disable a personal skill by moving its directory. Claude Code has
 * no settings key for this — `skillOverrides: off` still loads the skill's
 * frontmatter, whereas moving it out of `skills/` takes it off disk entirely.
 */
export async function setSkillDirectoryEnabled(opts: {
  skill: string;
  enabled: boolean;
  projectRoot: string;
  dryRun?: boolean;
}): Promise<{ from: string; to: string; moved: boolean }> {
  const paths = claudePaths(opts.projectRoot);
  if (opts.skill.includes(':')) {
    throw new Error(
      `"${opts.skill}" is a plugin skill; disable its plugin with setPluginEnabled instead of moving directories`
    );
  }
  if (opts.skill === '' || opts.skill.includes('/') || opts.skill.includes('\\') || opts.skill.startsWith('.')) {
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
    const projectDir = path.join(paths.projectSkills, opts.skill);
    if (await isDir(projectDir)) {
      throw new Error(
        `"${opts.skill}" is a project skill at ${projectDir}; only personal skills under ${paths.userSkills} can be moved`
      );
    }
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

async function loadSettings(projectRoot: string, warnings: ScanWarning[]): Promise<LoadedSettings[]> {
  const loaded: LoadedSettings[] = [];
  for (const source of claudeSettingsFiles(projectRoot)) {
    const result = await readJsonChecked<unknown>(source.file);
    if (result.missing) {
      continue;
    }
    if (result.error !== undefined) {
      warnings.push({ client: 'claude', file: source.file, message: `invalid JSON: ${result.error}` });
      continue;
    }
    const record = asRecord(result.value);
    if (!record) {
      warnings.push({ client: 'claude', file: source.file, message: 'expected a JSON object' });
      continue;
    }
    loaded.push({ source, value: record });
  }
  return loaded;
}

async function readGlobalConfig(
  file: string,
  warnings: ScanWarning[]
): Promise<Record<string, unknown> | undefined> {
  const result = await readJsonChecked<unknown>(file);
  if (result.missing) {
    return undefined;
  }
  if (result.error !== undefined) {
    warnings.push({ client: 'claude', file, message: `invalid JSON: ${result.error}` });
    return undefined;
  }
  const record = asRecord(result.value);
  if (!record) {
    warnings.push({ client: 'claude', file, message: 'expected a JSON object' });
    return undefined;
  }
  return record;
}

function mergeSettings(
  files: ClaudeSettingsFile[],
  loaded: LoadedSettings[],
  global: Record<string, unknown> | undefined,
  globalFile: string,
  warnings: ScanWarning[]
): ClaudeSettingsView {
  const sources: ClaudeSettingsSources = {
    skillOverrides: {},
    enabledPlugins: {},
    mcpjsonServers: {},
    extraKnownMarketplaces: {}
  };
  const skillOverrides: Record<string, SkillVisibility> = {};
  const enabledPlugins: Record<string, boolean> = {};
  const mcpjsonServers: Record<string, boolean> = {};
  const extraKnownMarketplaces: Record<string, Record<string, unknown>> = {};
  let skillListingMaxDescChars = SKILL_LISTING_MAX_DESC_CHARS_DEFAULT;
  let skillListingBudgetFraction = SKILL_LISTING_BUDGET_FRACTION_DEFAULT;
  let disableAllHooks = false;
  let disableBundledSkills = false;

  for (const { source, value } of loaded) {
    const file = source.file;

    for (const [skill, raw] of Object.entries(asRecord(value.skillOverrides) ?? {})) {
      if (isSkillVisibility(raw)) {
        skillOverrides[skill] = raw;
        sources.skillOverrides[skill] = file;
      } else {
        warnings.push({
          client: 'claude',
          file,
          message: `skillOverrides.${skill} is not a known visibility: ${JSON.stringify(raw)}`
        });
      }
    }

    for (const [plugin, raw] of Object.entries(asRecord(value.enabledPlugins) ?? {})) {
      if (typeof raw === 'boolean') {
        enabledPlugins[plugin] = raw;
        sources.enabledPlugins[plugin] = file;
      } else {
        warnings.push({
          client: 'claude',
          file,
          message: `enabledPlugins["${plugin}"] is not a boolean`
        });
      }
    }

    for (const [id, raw] of Object.entries(asRecord(value.extraKnownMarketplaces) ?? {})) {
      const entry = asRecord(raw);
      if (entry) {
        extraKnownMarketplaces[id] = entry;
        sources.extraKnownMarketplaces[id] = file;
      }
    }

    // Approval lists accumulate across layers; within one file a rejection wins.
    for (const name of asStringArray(value.enabledMcpjsonServers) ?? []) {
      mcpjsonServers[name] = true;
      sources.mcpjsonServers[name] = file;
    }
    for (const name of asStringArray(value.disabledMcpjsonServers) ?? []) {
      mcpjsonServers[name] = false;
      sources.mcpjsonServers[name] = file;
    }

    const maxDesc = value.skillListingMaxDescChars;
    if (typeof maxDesc === 'number' && Number.isFinite(maxDesc)) {
      skillListingMaxDescChars = maxDesc;
      sources.skillListingMaxDescChars = file;
    }
    const fraction = value.skillListingBudgetFraction;
    if (typeof fraction === 'number' && Number.isFinite(fraction)) {
      skillListingBudgetFraction = fraction;
      sources.skillListingBudgetFraction = file;
    }
    if (typeof value.disableAllHooks === 'boolean') {
      disableAllHooks = value.disableAllHooks;
      sources.disableAllHooks = file;
    }
    if (typeof value.disableBundledSkills === 'boolean') {
      disableBundledSkills = value.disableBundledSkills;
      sources.disableBundledSkills = file;
    }
  }

  let enableAllProjectMcpServers = false;
  if (typeof global?.enableAllProjectMcpServers === 'boolean') {
    enableAllProjectMcpServers = global.enableAllProjectMcpServers;
    sources.enableAllProjectMcpServers = globalFile;
  }

  return {
    files,
    loaded: loaded.map((entry) => entry.source.file),
    skillOverrides,
    skillListingMaxDescChars,
    skillListingBudgetFraction,
    enabledPlugins,
    mcpjsonServers,
    enabledMcpjsonServers: Object.keys(mcpjsonServers).filter((name) => mcpjsonServers[name]).sort(),
    disabledMcpjsonServers: Object.keys(mcpjsonServers).filter((name) => !mcpjsonServers[name]).sort(),
    disableAllHooks,
    disableBundledSkills,
    extraKnownMarketplaces,
    enableAllProjectMcpServers,
    sources
  };
}

async function scanSkillDir(
  dir: string,
  opts: { scope: Scope; disabled?: boolean; plugin?: string; skillDirs?: string[] },
  settings: ClaudeSettingsView,
  warnings: ScanWarning[],
  seen?: Set<string>
): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  // `dir` is the directory holding skills; `skillDirs` overrides that for
  // plugins, whose manifests may declare nested or out-of-tree skill paths.
  const skillDirs = opts.skillDirs ?? (await listDirs(dir)).map((name) => path.join(dir, name));
  for (const skillDir of skillDirs) {
    const name = path.basename(skillDir);
    const file = path.join(skillDir, 'SKILL.md');
    if (!(await isFile(file))) {
      continue;
    }
    if (seen?.has(name)) {
      warnings.push({
        client: 'claude',
        file,
        message: `duplicate skill "${name}"; the copy already found takes precedence`
      });
      continue;
    }
    seen?.add(name);

    const raw = await readText(file);
    if (raw === undefined) {
      warnings.push({ client: 'claude', file, message: 'could not read SKILL.md' });
      continue;
    }

    const { data } = parseFrontmatter(raw);
    const qualifiedName = opts.plugin ? `${opts.plugin}:${name}` : name;
    const resolved = resolveVisibility(qualifiedName, name, opts, settings, skillDir);

    entries.push({
      id: `claude:${opts.scope}:${qualifiedName}`,
      client: 'claude',
      scope: opts.scope,
      name,
      qualifiedName,
      description: data.description ?? '',
      file,
      dir: skillDir,
      ...(opts.plugin ? { plugin: opts.plugin } : {}),
      visibility: resolved.visibility,
      ...(resolved.source ? { visibilitySource: resolved.source } : {}),
      frontmatter: data,
      bytes: Buffer.byteLength(raw, 'utf8')
    });
  }
  return entries;
}

function resolveVisibility(
  qualifiedName: string,
  name: string,
  opts: { scope: Scope; disabled?: boolean; plugin?: string },
  settings: ClaudeSettingsView,
  skillDir: string
): { visibility: SkillVisibility; source?: string } {
  if (opts.disabled) {
    return { visibility: 'off', source: path.dirname(skillDir) };
  }
  // The settings schema is explicit that skillOverrides does not reach plugin skills.
  if (opts.plugin) {
    return { visibility: 'on' };
  }
  for (const key of [qualifiedName, name]) {
    const override = settings.skillOverrides[key];
    if (override) {
      const source = settings.sources.skillOverrides[key];
      return { visibility: override, ...(source ? { source } : {}) };
    }
  }
  return { visibility: 'on' };
}

async function scanDocDir(
  dir: string,
  scope: Scope,
  warnings: ScanWarning[],
  plugin?: string
): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = [];
  for (const found of await collectMarkdown(dir)) {
    const raw = await readText(found.file);
    if (raw === undefined) {
      warnings.push({ client: 'claude', file: found.file, message: 'could not read file' });
      continue;
    }
    const { data } = parseFrontmatter(raw);
    entries.push({
      id: `claude:${scope}:${plugin ? `${plugin}:` : ''}${found.name}`,
      client: 'claude',
      scope,
      name: found.name,
      description: data.description ?? '',
      file: found.file,
      ...(plugin ? { plugin } : {}),
      bytes: Buffer.byteLength(raw, 'utf8')
    });
  }
  return entries;
}

/** Agents and commands may be namespaced by subdirectory, as `dir:name`. */
async function collectMarkdown(
  dir: string,
  prefix = '',
  depth = 0
): Promise<{ name: string; file: string }[]> {
  const found: { name: string; file: string }[] = [];
  for (const name of await listFiles(dir, ['.md'])) {
    found.push({ name: `${prefix}${name.slice(0, -'.md'.length)}`, file: path.join(dir, name) });
  }
  if (depth < 2) {
    for (const sub of await listDirs(dir)) {
      found.push(...(await collectMarkdown(path.join(dir, sub), `${prefix}${sub}:`, depth + 1)));
    }
  }
  return found;
}

function hooksFromSettings(
  loaded: LoadedSettings[],
  settings: ClaudeSettingsView,
  warnings: ScanWarning[]
): HookEntry[] {
  const entries: HookEntry[] = [];
  for (const { source, value } of loaded) {
    const hooks = asRecord(value.hooks);
    if (!hooks) {
      continue;
    }
    for (const [event, groups] of Object.entries(hooks)) {
      entries.push(
        ...hooksFromEvent(event, groups, {
          idPrefix: `claude:${source.level}`,
          scope: source.scope,
          file: source.file,
          settings,
          warnings
        })
      );
    }
  }
  return entries;
}

function hooksFromEvent(
  event: string,
  groups: unknown,
  ctx: {
    idPrefix: string;
    scope: Scope;
    file: string;
    settings: ClaudeSettingsView;
    plugin?: string;
    pluginEnabled?: boolean;
    pluginEnabledSource?: string;
    warnings: ScanWarning[];
  }
): HookEntry[] {
  if (!HOOK_EVENTS.has(event)) {
    ctx.warnings.push({
      client: 'claude',
      file: ctx.file,
      message: `unknown hook event "${event}"; Claude Code event names are PascalCase`
    });
  }
  if (!Array.isArray(groups)) {
    ctx.warnings.push({
      client: 'claude',
      file: ctx.file,
      message: `hooks.${event} is not an array`
    });
    return [];
  }

  const disabled = ctx.settings.disableAllHooks;
  const disabledSource = ctx.settings.sources.disableAllHooks;
  const entries: HookEntry[] = [];
  let index = 0;

  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) {
      continue;
    }
    const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;
    const inner = Array.isArray(group.hooks) ? group.hooks : [];
    for (const rawHook of inner) {
      const hook = asRecord(rawHook);
      if (!hook) {
        continue;
      }
      const command = typeof hook.command === 'string' ? hook.command : undefined;
      if (command === undefined) {
        ctx.warnings.push({
          client: 'claude',
          file: ctx.file,
          message: `hooks.${event}[${index}] has no command`
        });
        continue;
      }
      const enabled = !disabled && ctx.pluginEnabled !== false;
      // `disableAllHooks` outranks the owning plugin's own switch.
      const enabledSource = disabled ? disabledSource : ctx.pluginEnabledSource;
      entries.push({
        id: `${ctx.idPrefix}:${event}:${index}`,
        client: 'claude',
        scope: ctx.scope,
        event,
        ...(matcher !== undefined ? { matcher } : {}),
        type: hook.type === 'prompt' ? 'prompt' : 'command',
        command,
        ...(typeof hook.timeout === 'number' ? { timeout: hook.timeout } : {}),
        file: ctx.file,
        ...(ctx.plugin ? { plugin: ctx.plugin } : {}),
        enabled,
        ...(enabledSource ? { enabledSource } : {}),
        index
      });
      index += 1;
    }
  }
  return entries;
}

async function scanProjectMcp(
  file: string,
  settings: ClaudeSettingsView,
  globalFile: string,
  warnings: ScanWarning[]
): Promise<McpEntry[]> {
  const servers = await readMcpFile(file, warnings);
  const entries: McpEntry[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    // A server nobody has ruled on yet is pending approval, which is modelled
    // as enabled:false with no source — distinct from an explicit rejection.
    const approved = settings.mcpjsonServers[name];
    const source =
      approved !== undefined
        ? settings.sources.mcpjsonServers[name]
        : settings.enableAllProjectMcpServers
          ? globalFile
          : undefined;
    const entry = toMcpEntry(name, raw, {
      id: `claude:project:${name}`,
      scope: 'project',
      file,
      enabled: approved ?? settings.enableAllProjectMcpServers,
      ...(source ? { enabledSource: source } : {}),
      warnings
    });
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

async function readMcpFile(file: string, warnings: ScanWarning[]): Promise<Record<string, unknown>> {
  const result = await readJsonChecked<unknown>(file);
  if (result.missing) {
    return {};
  }
  if (result.error !== undefined) {
    warnings.push({ client: 'claude', file, message: `invalid JSON: ${result.error}` });
    return {};
  }
  const record = asRecord(result.value);
  const servers = asRecord(record?.mcpServers);
  if (!servers) {
    warnings.push({ client: 'claude', file, message: 'expected an object with an mcpServers key' });
    return {};
  }
  return servers;
}

function toMcpEntry(
  name: string,
  raw: unknown,
  ctx: {
    id: string;
    scope: Scope;
    file: string;
    plugin?: string;
    enabled: boolean;
    enabledSource?: string;
    warnings: ScanWarning[];
  }
): McpEntry | undefined {
  const entry = asRecord(raw);
  if (!entry) {
    ctx.warnings.push({ client: 'claude', file: ctx.file, message: `server "${name}" is not an object` });
    return undefined;
  }

  const declared = typeof entry.type === 'string' ? entry.type : undefined;
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  let transport: McpTransportKind;
  if (declared !== undefined && isTransport(declared)) {
    transport = declared;
  } else {
    if (declared !== undefined) {
      ctx.warnings.push({
        client: 'claude',
        file: ctx.file,
        message: `server "${name}" has unknown type "${declared}"`
      });
    }
    // No `type` means stdio, which is what a bare `command` entry is.
    transport = command === undefined && url !== undefined ? 'http' : 'stdio';
  }

  return {
    id: ctx.id,
    client: 'claude',
    scope: ctx.scope,
    name,
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(asStringArray(entry.args) ? { args: asStringArray(entry.args) as string[] } : {}),
    ...(asStringRecord(entry.env) ? { env: asStringRecord(entry.env) as Record<string, string> } : {}),
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(asStringRecord(entry.headers)
      ? { headers: asStringRecord(entry.headers) as Record<string, string> }
      : {}),
    file: ctx.file,
    ...(ctx.plugin ? { plugin: ctx.plugin } : {}),
    enabled: ctx.enabled,
    ...(ctx.enabledSource ? { enabledSource: ctx.enabledSource } : {})
  };
}

async function scanMemory(
  paths: ReturnType<typeof claudePaths>,
  warnings: ScanWarning[]
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  const candidates: { scope: Scope; file: string }[] = [
    { scope: 'user', file: paths.userMemory },
    { scope: 'project', file: paths.projectMemory }
  ];
  for (const name of await listFiles(paths.userRules, ['.md'])) {
    candidates.push({ scope: 'user', file: path.join(paths.userRules, name) });
  }

  for (const candidate of candidates) {
    if (!(await isFile(candidate.file))) {
      continue;
    }
    const raw = await readText(candidate.file);
    if (raw === undefined) {
      warnings.push({ client: 'claude', file: candidate.file, message: 'could not read file' });
      continue;
    }
    entries.push({
      id: `claude:${candidate.scope}:${candidate.file}`,
      client: 'claude',
      scope: candidate.scope,
      name: path.basename(candidate.file),
      file: candidate.file,
      bytes: Buffer.byteLength(raw, 'utf8')
    });
  }
  return entries;
}

async function scanPlugins(
  projectRoot: string,
  settings: ClaudeSettingsView,
  warnings: ScanWarning[]
): Promise<{ plugins: PluginEntry[]; components: PluginComponents }> {
  const paths = claudePaths(projectRoot);
  const components: PluginComponents = {
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    mcpServers: []
  };
  const plugins: PluginEntry[] = [];

  const installedFile = await readJsonChecked<unknown>(paths.installedPlugins);
  if (installedFile.error !== undefined) {
    warnings.push({
      client: 'claude',
      file: paths.installedPlugins,
      message: `invalid JSON: ${installedFile.error}`
    });
  }
  const installedRecord = asRecord(asRecord(installedFile.value)?.plugins) ?? {};

  const marketplacesFile = await readJsonChecked<unknown>(paths.knownMarketplaces);
  if (marketplacesFile.error !== undefined) {
    warnings.push({
      client: 'claude',
      file: paths.knownMarketplaces,
      message: `invalid JSON: ${marketplacesFile.error}`
    });
  }
  const marketplaces = asRecord(marketplacesFile.value) ?? {};

  const seen = new Set<string>();

  for (const [key, raw] of Object.entries(installedRecord)) {
    if (!Array.isArray(raw)) {
      warnings.push({
        client: 'claude',
        file: paths.installedPlugins,
        message: `plugins["${key}"] is not an array of installs`
      });
      continue;
    }
    seen.add(key);
    const { name, marketplace } = splitPluginKey(key);
    const enabled = settings.enabledPlugins[key] ?? false;
    const enabledSource = settings.sources.enabledPlugins[key];

    for (const rawInstall of raw) {
      const install = asRecord(rawInstall);
      if (!install) {
        continue;
      }
      const scope = toScope(install.scope);
      const root = typeof install.installPath === 'string' ? install.installPath : undefined;
      const manifest = root
        ? await readManifest(path.join(root, '.claude-plugin', 'plugin.json'), warnings)
        : undefined;
      const discovered = root
        ? await discoverPluginComponents(
            root,
            {
              plugin: name,
              enabled,
              ...(enabledSource ? { enabledSource } : {}),
              ...(manifest?.skills !== undefined ? { declaredSkills: manifest.skills } : {})
            },
            settings,
            warnings
          )
        : emptyComponents();

      components.skills.push(...discovered.skills);
      components.agents.push(...discovered.agents);
      components.commands.push(...discovered.commands);
      components.hooks.push(...discovered.hooks);
      components.mcpServers.push(...discovered.mcpServers);

      plugins.push({
        id: `claude:${scope}:${key}`,
        client: 'claude',
        scope,
        name,
        ...(marketplace ? { marketplace } : {}),
        qualifiedName: key,
        description: manifest?.description ?? '',
        version:
          manifest?.version ??
          (typeof install.version === 'string' ? install.version : 'unknown'),
        ...(root ? { root } : {}),
        enabled,
        ...(enabledSource ? { enabledSource } : {}),
        installed: root !== undefined && (await isDir(root)),
        skills: discovered.skills.length,
        hooks: discovered.hooks.length,
        mcpServers: discovered.mcpServers.length
      });
    }
  }

  // Referenced by settings but never installed: still worth reporting.
  for (const key of Object.keys(settings.enabledPlugins)) {
    if (seen.has(key)) {
      continue;
    }
    const { name, marketplace } = splitPluginKey(key);
    const enabledSource = settings.sources.enabledPlugins[key];
    plugins.push({
      id: `claude:user:${key}`,
      client: 'claude',
      scope: 'user',
      name,
      ...(marketplace ? { marketplace } : {}),
      qualifiedName: key,
      description: '',
      version: 'unknown',
      enabled: settings.enabledPlugins[key] === true,
      ...(enabledSource ? { enabledSource } : {}),
      installed: false,
      skills: 0,
      hooks: 0,
      mcpServers: 0
    });
    if (marketplace && !(marketplace in marketplaces)) {
      warnings.push({
        client: 'claude',
        file: paths.knownMarketplaces,
        message: `plugin "${key}" refers to unknown marketplace "${marketplace}"`
      });
    }
  }

  return { plugins, components };
}

async function discoverPluginComponents(
  root: string,
  owner: { plugin: string; enabled: boolean; enabledSource?: string; declaredSkills?: unknown },
  settings: ClaudeSettingsView,
  warnings: ScanWarning[]
): Promise<PluginComponents> {
  const { plugin, enabled } = owner;
  const components = emptyComponents();

  const skillDirs = await collectSkillDirs(root, owner.declaredSkills);
  components.skills.push(
    ...(await scanSkillDir(
      path.join(root, 'skills'),
      { scope: 'plugin', plugin, skillDirs },
      settings,
      warnings
    ))
  );
  components.agents.push(...(await scanDocDir(path.join(root, 'agents'), 'plugin', warnings, plugin)));
  components.commands.push(
    ...(await scanDocDir(path.join(root, 'commands'), 'plugin', warnings, plugin))
  );

  const hooksFile = path.join(root, 'hooks', 'hooks.json');
  const hooksResult = await readJsonChecked<unknown>(hooksFile);
  if (hooksResult.error !== undefined) {
    warnings.push({ client: 'claude', file: hooksFile, message: `invalid JSON: ${hooksResult.error}` });
  } else if (!hooksResult.missing) {
    const record = asRecord(hooksResult.value);
    const events = asRecord(record?.hooks) ?? record ?? {};
    for (const [event, groups] of Object.entries(events)) {
      components.hooks.push(
        ...hooksFromEvent(event, groups, {
          idPrefix: `claude:plugin:${plugin}`,
          scope: 'plugin',
          file: hooksFile,
          settings,
          plugin,
          pluginEnabled: enabled,
          ...(owner.enabledSource ? { pluginEnabledSource: owner.enabledSource } : {}),
          warnings
        })
      );
    }
  }

  const mcpFile = path.join(root, '.mcp.json');
  if (await isFile(mcpFile)) {
    for (const [name, raw] of Object.entries(await readMcpFile(mcpFile, warnings))) {
      const entry = toMcpEntry(name, raw, {
        id: `claude:plugin:${plugin}:${name}`,
        scope: 'plugin',
        file: mcpFile,
        plugin,
        enabled,
        ...(owner.enabledSource ? { enabledSource: owner.enabledSource } : {}),
        warnings
      });
      if (entry) {
        components.mcpServers.push(entry);
      }
    }
  }

  return components;
}

function emptyComponents(): PluginComponents {
  return { skills: [], agents: [], commands: [], hooks: [], mcpServers: [] };
}

async function readManifest(
  file: string,
  warnings: ScanWarning[]
): Promise<{ description?: string; version?: string; skills?: unknown } | undefined> {
  const result = await readJsonChecked<unknown>(file);
  if (result.missing) {
    // Auto-discovery is legal: a plugin needs no manifest.
    return undefined;
  }
  if (result.error !== undefined) {
    warnings.push({ client: 'claude', file, message: `invalid JSON: ${result.error}` });
    return undefined;
  }
  const record = asRecord(result.value);
  if (!record) {
    return undefined;
  }
  return {
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    // A manifest may point `skills` at another directory or list explicit
    // skill paths. Kept unnarrowed; collectSkillDirs does the validation.
    ...(record.skills !== undefined ? { skills: record.skills } : {})
  };
}

function splitPluginKey(key: string): { name: string; marketplace?: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) {
    return { name: key };
  }
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

function toScope(value: unknown): Scope {
  if (value === 'project' || value === 'local' || value === 'plugin' || value === 'builtin') {
    return value;
  }
  return 'user';
}

async function resolvePluginKey(plugin: string, projectRoot: string): Promise<string> {
  if (plugin.includes('@')) {
    return plugin;
  }
  const paths = claudePaths(projectRoot);
  const keys = new Set<string>();
  const installed = await readJson<unknown>(paths.installedPlugins);
  for (const key of Object.keys(asRecord(asRecord(installed)?.plugins) ?? {})) {
    keys.add(key);
  }
  for (const source of claudeSettingsFiles(projectRoot)) {
    const settings = await readJson<unknown>(source.file);
    for (const key of Object.keys(asRecord(asRecord(settings)?.enabledPlugins) ?? {})) {
      keys.add(key);
    }
  }

  const candidates = [...keys].filter((key) => splitPluginKey(key).name === plugin).sort();
  const first = candidates[0];
  if (candidates.length === 1 && first !== undefined) {
    return first;
  }
  if (candidates.length === 0) {
    throw new Error(
      `unknown plugin "${plugin}": no installed plugin matches, so qualify it as <plugin>@<marketplace>`
    );
  }
  throw new Error(
    `plugin "${plugin}" is ambiguous across marketplaces (${candidates.join(', ')}): qualify it as <plugin>@<marketplace>`
  );
}

async function readSettingsForWrite(file: string): Promise<Record<string, unknown>> {
  const result = await readJsonChecked<unknown>(file);
  if (result.error !== undefined) {
    throw new Error(`refusing to edit ${file}: it is not valid JSON (${result.error})`);
  }
  if (result.missing) {
    return {};
  }
  const record = asRecord(result.value);
  if (!record) {
    throw new Error(`refusing to edit ${file}: expected a JSON object`);
  }
  return record;
}

function writeSettings(
  file: string,
  settings: Record<string, unknown>,
  dryRun: boolean
): Promise<WriteResult> {
  return writeJsonSafely(file, settings, { dryRun, backupDir: backupDir() });
}

function applyList(settings: Record<string, unknown>, key: string, values: Set<string>): void {
  if (values.size === 0) {
    delete settings[key];
    return;
  }
  settings[key] = [...values].sort();
}

function isSkillVisibility(value: unknown): value is SkillVisibility {
  return typeof value === 'string' && (SKILL_VISIBILITIES as readonly string[]).includes(value);
}

function isTransport(value: string): value is McpTransportKind {
  return value === 'stdio' || value === 'http' || value === 'sse' || value === 'ws';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') {
      out[key] = item;
    }
  }
  return out;
}
