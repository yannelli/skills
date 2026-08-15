import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, readlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { backupDir, claudePaths } from './client-paths.js';
import { collectSkillDirs } from './skill-dirs.js';
import { exists, isDir, isFile, parseJsonc, readText, writeJsonSafely } from './safe-io.js';
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

/**
 * Settings layers, lowest precedence first.
 *
 * Managed policy sits at the *top*, not the bottom: an enterprise
 * `managed-settings.json` is the one layer a developer cannot override, so a
 * merge that let `~/.claude/settings.json` win over it would report a policy
 * as inactive when the client is still enforcing it.
 */
export const CLAUDE_SETTINGS_LEVELS = [
  'user',
  'userLocal',
  'project',
  'projectLocal',
  'managed'
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
    { level: 'user', scope: 'user', file: paths.userSettings },
    { level: 'userLocal', scope: 'local', file: paths.userLocalSettings },
    { level: 'project', scope: 'project', file: paths.projectSettings },
    { level: 'projectLocal', scope: 'local', file: paths.projectLocalSettings },
    { level: 'managed', scope: 'builtin', file: paths.managedSettings }
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
  /** The file holding `projects[<root>].disabledMcpServers`, when any. */
  disabledMcpServers?: string;
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
  /**
   * Servers switched off for this project in `~/.claude.json`, by the name the
   * client uses there: a bare name for a user or `.mcp.json` server, and
   * `plugin:<plugin>:<server>` for one a plugin brought in.
   */
  disabledMcpServers: string[];
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

/**
 * `~/.claude.json` — global client state rather than a settings file. It holds
 * the user-scope MCP servers, and under `projects[<root>]` the per-project
 * answers to the client's own prompts (which `.mcp.json` servers were
 * approved, which servers were switched off).
 */
type ClaudeGlobalConfig = {
  file: string;
  value?: Record<string, unknown>;
  project?: Record<string, unknown>;
};

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
  const global = await readGlobalConfig(paths.globalConfig, projectRoot, warnings);
  const settings = mergeSettings(claudeSettingsFiles(projectRoot), loaded, global, warnings);

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

  mcpServers.push(...globalMcpServers(global, settings, warnings));
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
  // `<plugin>:<skill>` is how a plugin skill's qualified name always reads.
  // Claude Code's own settings reference says skillOverrides "does not apply
  // to plugin skills, which are managed through /plugin" — writing one here
  // would report success while the client keeps ignoring the key.
  if (opts.skill.includes(':')) {
    throw new Error(
      `"${opts.skill}" is a plugin skill; Claude Code does not apply skillOverrides to plugin skills — enable or disable its plugin instead`
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

/**
 * `origin` is the *item's* scope from its `McpEntry`, not the settings layer
 * to write — those are different axes, and conflating them is the reason
 * plugin and user/local servers were being written to the wrong setting.
 *
 * A `.mcp.json` project server is switched on and off through the
 * approve/reject lists in `enabledMcpjsonServers`/`disabledMcpjsonServers`,
 * which is also how Claude Code decides whether an as-yet-unseen server is
 * pending approval. Every other origin — a user/local server declared
 * directly in `~/.claude.json`, or a plugin's own `.mcp.json` — has no such
 * approval step; Claude Code's one lever for switching an already-loaded
 * server off without touching the plugin itself is the general per-project
 * `disabledMcpServers` array in `~/.claude.json`, keyed by the bare server
 * name for a user/local server and `plugin:<plugin>:<server>` for a plugin's.
 */
export async function setMcpEnabled(opts: {
  server: string;
  enabled: boolean;
  origin: Scope;
  /** Required when `origin` is `'plugin'`. */
  plugin?: string;
  scope?: ClaudeWriteScope;
  projectRoot: string;
  dryRun?: boolean;
}): Promise<WriteResult> {
  if (opts.origin === 'plugin' && !opts.plugin) {
    throw new Error(`setMcpEnabled: "${opts.server}" has origin "plugin" but no owning plugin was given`);
  }

  if (opts.origin === 'project') {
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

  const key = opts.origin === 'plugin' ? `plugin:${opts.plugin}:${opts.server}` : opts.server;
  return setDisabledMcpServers(opts.projectRoot, key, !opts.enabled, opts.dryRun === true);
}

/**
 * `~/.claude.json`'s `projects[<root>].disabledMcpServers` — the general
 * per-project off-switch `applyMcpSwitch` already reads on the scan side.
 * The file holds a great deal of other client state (trust answers, OAuth
 * tokens, history) per project, so only that one array is touched, and a
 * project Claude Code has never opened is created with nothing else in it
 * rather than refused, since disabling ahead of first use is still a
 * legitimate thing to ask for.
 */
async function setDisabledMcpServers(
  projectRoot: string,
  key: string,
  disabled: boolean,
  dryRun: boolean
): Promise<WriteResult> {
  const file = claudePaths(projectRoot).globalConfig;
  const root = await readSettingsForWrite(file);
  const projects = { ...(asRecord(root.projects) ?? {}) };
  const projectKey = path.resolve(projectRoot);
  const project = { ...(asRecord(projects[projectKey]) ?? {}) };
  const list = new Set(asStringArray(project.disabledMcpServers) ?? []);

  if (disabled) {
    list.add(key);
  } else {
    list.delete(key);
  }

  if (list.size === 0) {
    delete project.disabledMcpServers;
  } else {
    project.disabledMcpServers = [...list].sort();
  }
  projects[projectKey] = project;
  root.projects = projects;

  return writeSettings(file, root, dryRun);
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
    const record = await readRecordFile(source.file, warnings);
    if (record) {
      loaded.push({ source, value: record });
    }
  }
  return loaded;
}

async function readGlobalConfig(
  file: string,
  projectRoot: string,
  warnings: ScanWarning[]
): Promise<ClaudeGlobalConfig> {
  const value = await readRecordFile(file, warnings);
  if (!value) {
    return { file };
  }
  // Claude Code keys `projects` by the absolute path it was started in.
  const project = asRecord(asRecord(value.projects)?.[path.resolve(projectRoot)]);
  return { file, value, ...(project ? { project } : {}) };
}

/** Read a JSON object, turning every failure into a warning rather than silence. */
async function readRecordFile(
  file: string,
  warnings: ScanWarning[]
): Promise<Record<string, unknown> | undefined> {
  const result = await readJsonFile(file);
  if (result.missing) {
    return undefined;
  }
  if (result.error !== undefined) {
    warnings.push({ client: 'claude', file, message: result.error });
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
  global: ClaudeGlobalConfig,
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
  let enableAllProjectMcpServers = false;

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
    if (typeof value.enableAllProjectMcpServers === 'boolean') {
      enableAllProjectMcpServers = value.enableAllProjectMcpServers;
      sources.enableAllProjectMcpServers = file;
    }
  }

  // `~/.claude.json` is not a settings file, but it is where the running client
  // records the answers to its own prompts, so for the keys it writes there it
  // is the last word. A live install keeps `disableBundledSkills` here even
  // though the same key is documented for settings.json.
  const globalValue = global.value;
  if (typeof globalValue?.disableBundledSkills === 'boolean') {
    disableBundledSkills = globalValue.disableBundledSkills;
    sources.disableBundledSkills = global.file;
  }
  if (typeof globalValue?.enableAllProjectMcpServers === 'boolean') {
    enableAllProjectMcpServers = globalValue.enableAllProjectMcpServers;
    sources.enableAllProjectMcpServers = global.file;
  }
  for (const name of asStringArray(global.project?.enabledMcpjsonServers) ?? []) {
    mcpjsonServers[name] = true;
    sources.mcpjsonServers[name] = global.file;
  }
  for (const name of asStringArray(global.project?.disabledMcpjsonServers) ?? []) {
    mcpjsonServers[name] = false;
    sources.mcpjsonServers[name] = global.file;
  }

  const disabledMcpServers = asStringArray(global.project?.disabledMcpServers) ?? [];
  if (disabledMcpServers.length > 0) {
    sources.disabledMcpServers = global.file;
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
    disabledMcpServers,
    disableAllHooks,
    disableBundledSkills,
    extraKnownMarketplaces,
    enableAllProjectMcpServers,
    sources
  };
}

async function scanSkillDir(
  dir: string,
  opts: { scope: Scope; disabled?: boolean; disabledSource?: string; plugin?: string; skillDirs?: string[] },
  settings: ClaudeSettingsView,
  warnings: ScanWarning[],
  seen?: Set<string>
): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  // `dir` is the directory holding skills; `skillDirs` overrides that for
  // plugins, whose manifests may declare nested or out-of-tree skill paths.
  const skillDirs =
    opts.skillDirs ?? (await listChildDirs(dir, warnings)).map((name) => path.join(dir, name));
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
    const resolved = resolveVisibility(name, opts, settings, skillDir);

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
  name: string,
  opts: { scope: Scope; disabled?: boolean; disabledSource?: string; plugin?: string },
  settings: ClaudeSettingsView,
  skillDir: string
): { visibility: SkillVisibility; source?: string } {
  if (opts.disabled) {
    // A parked personal skill is off because of where it sits; a disabled
    // plugin's skill is off because a settings file said so.
    return { visibility: 'off', source: opts.disabledSource ?? path.dirname(skillDir) };
  }
  // Claude Code's own settings reference is explicit: skillOverrides "does not
  // apply to plugin skills, which are managed through /plugin". A plugin skill
  // is only ever fully on (the plugin is enabled, handled by `opts.disabled`
  // above) or fully off — there is no partial visibility to look up.
  if (opts.plugin) {
    return { visibility: 'on' };
  }
  const override = settings.skillOverrides[name];
  if (override) {
    const source = settings.sources.skillOverrides[name];
    return { visibility: override, ...(source ? { source } : {}) };
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
  for (const found of await collectMarkdown(dir, warnings)) {
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
  warnings: ScanWarning[],
  prefix = '',
  depth = 0
): Promise<{ name: string; file: string }[]> {
  const found: { name: string; file: string }[] = [];
  for (const name of await listChildFiles(dir, '.md', warnings)) {
    found.push({ name: `${prefix}${name.slice(0, -'.md'.length)}`, file: path.join(dir, name) });
  }
  if (depth < 2) {
    for (const sub of await listChildDirs(dir, warnings)) {
      found.push(
        ...(await collectMarkdown(path.join(dir, sub), warnings, `${prefix}${sub}:`, depth + 1))
      );
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
    const decided = applyMcpSwitch(name, settings, {
      enabled: approved ?? settings.enableAllProjectMcpServers,
      ...(source ? { source } : {})
    });
    const entry = toMcpEntry(name, raw, {
      id: `claude:project:${name}`,
      scope: 'project',
      file,
      enabled: decided.enabled,
      ...(decided.source ? { enabledSource: decided.source } : {}),
      warnings
    });
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

/** The user-scope and project-local servers Claude Code keeps in `~/.claude.json`. */
function globalMcpServers(
  global: ClaudeGlobalConfig,
  settings: ClaudeSettingsView,
  warnings: ScanWarning[]
): McpEntry[] {
  const entries: McpEntry[] = [];
  // Project-local first: a server added with `--scope local` shadows a user
  // server of the same name, and the more specific one is the one in force.
  const layers: { scope: Scope; servers: Record<string, unknown> | undefined }[] = [
    { scope: 'local', servers: asRecord(global.project?.mcpServers) },
    { scope: 'user', servers: asRecord(global.value?.mcpServers) }
  ];
  const claimed = new Set<string>();

  for (const layer of layers) {
    for (const [name, raw] of Object.entries(layer.servers ?? {})) {
      if (claimed.has(name)) {
        continue;
      }
      const decided = applyMcpSwitch(name, settings, { enabled: true });
      const entry = toMcpEntry(name, raw, {
        id: `claude:${layer.scope}:${name}`,
        scope: layer.scope,
        file: global.file,
        enabled: decided.enabled,
        ...(decided.source ? { enabledSource: decided.source } : {}),
        warnings
      });
      if (entry) {
        claimed.add(name);
        entries.push(entry);
      }
    }
  }
  return entries;
}

/** `projects[<root>].disabledMcpServers` overrides however a server got switched on. */
function applyMcpSwitch(
  key: string,
  settings: ClaudeSettingsView,
  fallback: { enabled: boolean; source?: string }
): { enabled: boolean; source?: string } {
  if (settings.disabledMcpServers.includes(key)) {
    const source = settings.sources.disabledMcpServers;
    return { enabled: false, ...(source ? { source } : {}) };
  }
  return fallback;
}

async function readMcpFile(
  file: string,
  warnings: ScanWarning[],
  opts: { allowBareMap?: boolean } = {}
): Promise<Record<string, unknown>> {
  const result = await readJsonFile(file);
  if (result.missing) {
    return {};
  }
  if (result.error !== undefined) {
    warnings.push({ client: 'claude', file, message: result.error });
    return {};
  }
  const record = asRecord(result.value);
  const servers = asRecord(record?.mcpServers);
  if (servers) {
    return servers;
  }
  // Plugins ship both shapes. The official playwright plugin's `.mcp.json` is a
  // bare `{ "<name>": { command } }` map with no `mcpServers` wrapper, and
  // Claude Code loads it, so rejecting that shape drops a real server.
  if (opts.allowBareMap && record && isServerMap(record)) {
    return record;
  }
  warnings.push({ client: 'claude', file, message: 'expected an object with an mcpServers key' });
  return {};
}

function isServerMap(record: Record<string, unknown>): boolean {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(([, value]) => {
    const server = asRecord(value);
    return (
      server !== undefined &&
      (typeof server.command === 'string' || typeof server.url === 'string')
    );
  });
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
  for (const name of await listChildFiles(paths.userRules, '.md', warnings)) {
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

  const installedFile = await readJsonFile(paths.installedPlugins);
  if (installedFile.error !== undefined) {
    warnings.push({
      client: 'claude',
      file: paths.installedPlugins,
      message: installedFile.error
    });
  }
  const installedRecord = asRecord(asRecord(installedFile.value)?.plugins) ?? {};

  const marketplacesFile = await readJsonFile(paths.knownMarketplaces);
  if (marketplacesFile.error !== undefined) {
    warnings.push({
      client: 'claude',
      file: paths.knownMarketplaces,
      message: marketplacesFile.error
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
      const installPath = typeof install.installPath === 'string' ? install.installPath : undefined;
      const root = installPath
        ? await resolveNestedPluginRoot(installPath, name, marketplace, marketplaces, warnings)
        : undefined;
      const manifest = root
        ? await readManifest(path.join(root, '.claude-plugin', 'plugin.json'), warnings)
        : undefined;
      const otherContributions = root ? await pluginOtherContributions(root, manifest, warnings) : 0;
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
        mcpServers: discovered.mcpServers.length,
        ...(otherContributions > 0 ? { otherContributions } : {})
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
      // A disabled plugin loads nothing, so its skills are `off` — otherwise
      // the context ledger keeps billing them after `yard plugin disable`.
      {
        scope: 'plugin',
        plugin,
        skillDirs,
        ...(enabled
          ? {}
          : { disabled: true, ...(owner.enabledSource ? { disabledSource: owner.enabledSource } : {}) })
      },
      settings,
      warnings
    ))
  );
  components.agents.push(...(await scanDocDir(path.join(root, 'agents'), 'plugin', warnings, plugin)));
  components.commands.push(
    ...(await scanDocDir(path.join(root, 'commands'), 'plugin', warnings, plugin))
  );

  const hooksFile = path.join(root, 'hooks', 'hooks.json');
  const hooksResult = await readJsonFile(hooksFile);
  if (hooksResult.error !== undefined) {
    warnings.push({ client: 'claude', file: hooksFile, message: hooksResult.error });
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
    const servers = await readMcpFile(mcpFile, warnings, { allowBareMap: true });
    for (const [name, raw] of Object.entries(servers)) {
      // `/mcp` records a plugin's server under this composite name.
      const decided = applyMcpSwitch(`plugin:${plugin}:${name}`, settings, {
        enabled,
        ...(owner.enabledSource ? { source: owner.enabledSource } : {})
      });
      const entry = toMcpEntry(name, raw, {
        id: `claude:plugin:${plugin}:${name}`,
        scope: 'plugin',
        file: mcpFile,
        plugin,
        enabled: decided.enabled,
        ...(decided.source ? { enabledSource: decided.source } : {}),
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

type ClaudePluginManifest = {
  description?: string;
  version?: string;
  skills?: unknown;
  lspServers?: unknown;
  monitors?: unknown;
  experimental?: unknown;
};

async function readManifest(
  file: string,
  warnings: ScanWarning[]
): Promise<ClaudePluginManifest | undefined> {
  const result = await readJsonFile(file);
  if (result.missing) {
    // Auto-discovery is legal: a plugin needs no manifest.
    return undefined;
  }
  if (result.error !== undefined) {
    warnings.push({ client: 'claude', file, message: result.error });
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
    ...(record.skills !== undefined ? { skills: record.skills } : {}),
    ...(record.lspServers !== undefined ? { lspServers: record.lspServers } : {}),
    ...(record.monitors !== undefined ? { monitors: record.monitors } : {}),
    ...(record.experimental !== undefined ? { experimental: record.experimental } : {})
  };
}

/**
 * A marketplace can list a plugin under a `git-subdir` source — a sparse
 * clone of one subdirectory of a larger repository. `installed_plugins.json`
 * then names the checkout root, not the plugin: the manifest, skills, and
 * every other component sit under `<checkout>/<source.path>`. Every other
 * source type (a relative path within the marketplace, `github`, `url`,
 * `npm`, `archive`, `command`) has no such nesting, so the install path is
 * already the plugin root and this is a no-op for them.
 */
async function resolveNestedPluginRoot(
  installPath: string,
  name: string,
  marketplace: string | undefined,
  marketplaces: Record<string, unknown>,
  warnings: ScanWarning[]
): Promise<string> {
  if (!marketplace) {
    return installPath;
  }
  const installLocation = asRecord(marketplaces[marketplace])?.installLocation;
  if (typeof installLocation !== 'string') {
    return installPath;
  }
  const manifestFile = path.join(installLocation, '.claude-plugin', 'marketplace.json');
  const result = await readJsonFile(manifestFile);
  if (result.missing || result.error !== undefined) {
    // A remote or otherwise-unavailable marketplace checkout is normal —
    // only the plugin's own cache needs to be readable, not the marketplace's.
    return installPath;
  }
  const listed = asRecord(result.value)?.plugins;
  if (!Array.isArray(listed)) {
    return installPath;
  }
  const entry = listed.find((item) => asRecord(item)?.name === name);
  const source = asRecord(asRecord(entry)?.source);
  if (source?.source !== 'git-subdir' || typeof source.path !== 'string') {
    return installPath;
  }
  const nested = path.resolve(installPath, source.path);
  const rel = path.relative(installPath, nested);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    warnings.push({
      client: 'claude',
      file: manifestFile,
      message: `plugin "${name}" source.path "${source.path}" escapes the checkout — scanning ${installPath} instead`
    });
    return installPath;
  }
  return (await isDir(nested)) ? nested : installPath;
}

/**
 * LSP servers and background monitors are real, loadable contributions that
 * Yard does not turn into their own inventory rows — see
 * {@link PluginEntry.otherContributions}. `monitors` is also accepted at the
 * manifest's top level: Claude Code still loads it there for backward
 * compatibility even though `claude plugin validate` now prefers
 * `experimental.monitors`.
 */
async function pluginOtherContributions(
  root: string,
  manifest: ClaudePluginManifest | undefined,
  warnings: ScanWarning[]
): Promise<number> {
  const manifestFile = path.join(root, '.claude-plugin', 'plugin.json');
  let count = 0;

  const lsp = await resolvePluginManifestValue(root, manifestFile, manifest?.lspServers, '.lsp.json', warnings);
  const lspTable = asRecord(lsp);
  if (lspTable) {
    count += Object.keys(lspTable).length;
  }

  const experimental = asRecord(manifest?.experimental);
  const monitorsRef = experimental?.monitors ?? manifest?.monitors;
  const monitors = await resolvePluginManifestValue(
    root,
    manifestFile,
    monitorsRef,
    path.join('monitors', 'monitors.json'),
    warnings
  );
  if (Array.isArray(monitors)) {
    count += monitors.length;
  }

  return count;
}

/**
 * The `lspServers`/`monitors` manifest fields follow the same shape as hooks
 * and MCP servers: either the value inline, or a path (relative to the
 * plugin root) to a file holding it. A default location is tried, silently,
 * when the manifest says nothing at all — auto-discovery is legal.
 */
async function resolvePluginManifestValue(
  root: string,
  manifestFile: string,
  ref: unknown,
  defaultRelative: string,
  warnings: ScanWarning[]
): Promise<unknown | undefined> {
  if (ref === undefined || ref === null) {
    return readOptionalPluginJson(path.join(root, defaultRelative), warnings, false);
  }
  if (typeof ref === 'string') {
    const file = containedPluginPath(root, ref);
    if (file === undefined) {
      warnings.push({ client: 'claude', file: manifestFile, message: `"${ref}" points outside the plugin directory` });
      return undefined;
    }
    return readOptionalPluginJson(file, warnings, true);
  }
  // Already inline — an object for lspServers, an array for monitors.
  return ref;
}

async function readOptionalPluginJson(
  file: string,
  warnings: ScanWarning[],
  required: boolean
): Promise<unknown | undefined> {
  const result = await readJsonFile(file);
  if (result.missing) {
    if (required) {
      warnings.push({ client: 'claude', file, message: 'referenced by the plugin manifest but missing' });
    }
    return undefined;
  }
  if (result.error !== undefined) {
    warnings.push({ client: 'claude', file, message: result.error });
    return undefined;
  }
  return result.value;
}

/**
 * A plugin manifest is data Yard did not write, so a path inside it is
 * untrusted: `"../../.."` must not turn a scan of one plugin into a walk of
 * the developer's disk. Returns the resolved path only when it stays inside
 * `root`.
 */
function containedPluginPath(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return undefined;
  }
  return resolved;
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
  const installed = await readJsonFile(paths.installedPlugins);
  for (const key of Object.keys(asRecord(asRecord(installed.value)?.plugins) ?? {})) {
    keys.add(key);
  }
  for (const source of claudeSettingsFiles(projectRoot)) {
    const settings = await readJsonFile(source.file);
    for (const key of Object.keys(asRecord(asRecord(settings.value)?.enabledPlugins) ?? {})) {
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
  const result = await readJsonFile(file);
  if (result.error !== undefined) {
    throw new Error(`refusing to edit ${file}: ${result.error}`);
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

type JsonRead = { value?: unknown; error?: string; missing: boolean };

/**
 * Read JSON, and say why when it cannot.
 *
 * `safe-io`'s reader cannot tell "no such file" from "cannot read it": both
 * come back as `undefined`, so an unreadable `settings.json` — no permission,
 * or a directory where a file belongs — would scan as an empty one and the
 * report would quietly claim the developer has no settings at all. A leading
 * BOM is stripped for the same reason: editors write it, the client copes
 * with it, and a scan that calls the file corrupt would be lying.
 */
async function readJsonFile(file: string): Promise<JsonRead> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { missing: true };
    }
    return { missing: false, error: `could not read: ${code ?? describe(error)}` };
  }
  try {
    return { missing: false, value: parseJsonc<unknown>(stripBom(raw)) };
  } catch (error) {
    return { missing: false, error: `invalid JSON: ${describe(error)}` };
  }
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Subdirectories, counting symlinks that point at one.
 *
 * `Dirent.isDirectory()` is false for a symlink, and linking a skill checked
 * out elsewhere into `~/.claude/skills` is a normal setup — on the machine
 * this was written against, every personal skill is a link, and a scan that
 * trusted the dirent alone reported none of them.
 */
async function listChildDirs(dir: string, warnings: ScanWarning[]): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readEntries(dir, warnings)) {
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const target = path.join(dir, entry.name);
    if (await isDir(target)) {
      names.push(entry.name);
    } else {
      await warnIfBrokenLink(target, warnings);
    }
  }
  return names.sort();
}

/**
 * A link whose target is gone is invisible to the client and to `ls`, and it
 * is the likeliest reason a developer's skill "disappeared" — worth saying out
 * loud rather than skipping in silence.
 */
async function warnIfBrokenLink(target: string, warnings: ScanWarning[]): Promise<void> {
  if (await exists(target)) {
    return;
  }
  // One directory is walked for both its subdirectories and its markdown, so
  // the same dead link can be met twice.
  if (warnings.some((warning) => warning.file === target && warning.message.startsWith('broken'))) {
    return;
  }
  const to = await readlink(target).catch(() => undefined);
  warnings.push({
    client: 'claude',
    file: target,
    message: `broken symlink${to ? ` to ${to}` : ''}; nothing is loaded from it`
  });
}

/** Files with the given extension, counting symlinks that point at one. */
async function listChildFiles(
  dir: string,
  extension: string,
  warnings: ScanWarning[]
): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readEntries(dir, warnings)) {
    if (path.extname(entry.name) !== extension) {
      continue;
    }
    if (entry.isFile()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const target = path.join(dir, entry.name);
    if (await isFile(target)) {
      names.push(entry.name);
    } else {
      await warnIfBrokenLink(target, warnings);
    }
  }
  return names.sort();
}

async function readEntries(dir: string, warnings: ScanWarning[]): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A directory that was never created is the normal case, not a problem.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warnings.push({
        client: 'claude',
        file: dir,
        message: `could not list directory: ${code ?? describe(error)}`
      });
    }
    return [];
  }
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
