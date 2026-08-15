export const CLIENTS = ['claude', 'codex', 'cursor'] as const;

export type Client = (typeof CLIENTS)[number];

/**
 * Where a piece of configuration lives. `user` is the home-directory config,
 * `project` is checked into (or sits beside) the repository, `local` is the
 * gitignored per-developer override, and `plugin` came from an installed plugin.
 */
export const SCOPES = ['user', 'project', 'local', 'plugin', 'builtin'] as const;

export type Scope = (typeof SCOPES)[number];

/** How visible a skill is to the model. Mirrors Claude Code's `skillOverrides`. */
export const SKILL_VISIBILITIES = ['on', 'name-only', 'user-invocable-only', 'off'] as const;

export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number];

export type SkillEntry = {
  /** Stable identity: `<client>:<scope>:<qualifiedName>`. */
  id: string;
  client: Client;
  scope: Scope;
  /** Bare skill directory name. */
  name: string;
  /** What the client calls it — `plugin:name` for plugin skills, else `name`. */
  qualifiedName: string;
  description: string;
  /** Absolute path to SKILL.md. */
  file: string;
  /** Absolute path to the skill directory. */
  dir: string;
  plugin?: string;
  visibility: SkillVisibility;
  /**
   * Why the skill is at that visibility: the file that decides it, or
   * `undefined` when nothing overrides the default.
   */
  visibilitySource?: string;
  /** Frontmatter keys present, for lint. */
  frontmatter: Record<string, string>;
  /** Bytes of SKILL.md. */
  bytes: number;
};

export type PluginEntry = {
  id: string;
  client: Client;
  scope: Scope;
  name: string;
  marketplace?: string;
  /** `name@marketplace` for Claude, else `name`. */
  qualifiedName: string;
  description: string;
  version: string;
  /** Absolute path to the installed plugin root, when it is on disk. */
  root?: string;
  enabled: boolean;
  /** The settings file that decides `enabled`. */
  enabledSource?: string;
  /** Present on disk, or only referenced by config. */
  installed: boolean;
  skills: number;
  hooks: number;
  mcpServers: number;
  /**
   * Contributions the manifest declares that are real but that Yard does not
   * turn into their own inventory rows — Codex `apps`, Claude `lspServers` and
   * `experimental.monitors`, and the like. Counted separately from `skills` /
   * `hooks` / `mcpServers` rather than folded into them, so a plugin that ships
   * only one of these still reads as contributing something instead of as
   * `plugin-empty`.
   */
  otherContributions?: number;
};

export type McpTransportKind = 'stdio' | 'http' | 'sse' | 'ws';

export type McpEntry = {
  id: string;
  client: Client;
  scope: Scope;
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Absolute path to the file that declares it. */
  file: string;
  plugin?: string;
  /**
   * Absolute path to the owning plugin's root, when `plugin` is set. A
   * plugin's `command`/`cwd` are commonly relative or use
   * `${CLAUDE_PLUGIN_ROOT}`-style variables that only resolve against this
   * directory, not against wherever Yard happens to be running from.
   */
  pluginRoot?: string;
  enabled: boolean;
  enabledSource?: string;
};

export type HookEntry = {
  id: string;
  client: Client;
  scope: Scope;
  /** Event name exactly as written in the source file. */
  event: string;
  matcher?: string;
  type: 'command' | 'prompt';
  command: string;
  timeout?: number;
  /** Absolute path to the file that declares it. */
  file: string;
  plugin?: string;
  /**
   * Absolute path to the owning plugin's root, when `plugin` is set. `command`
   * routinely reads `"${CLAUDE_PLUGIN_ROOT}"/scripts/...` or a bare relative
   * path that is only meaningful relative to this directory.
   */
  pluginRoot?: string;
  enabled: boolean;
  enabledSource?: string;
  /**
   * Index of this hook within its event group, so it can be addressed for
   * removal without relying on the command string being unique.
   */
  index: number;
};

export type AgentEntry = {
  id: string;
  client: Client;
  scope: Scope;
  name: string;
  description: string;
  file: string;
  plugin?: string;
  bytes: number;
};

export type CommandEntry = AgentEntry;

export type MemoryEntry = {
  id: string;
  client: Client;
  scope: Scope;
  /** CLAUDE.md, AGENTS.md, .cursorrules, ... */
  name: string;
  file: string;
  bytes: number;
};

export type Inventory = {
  /** Absolute path the project-scoped scan was rooted at. */
  projectRoot: string;
  /** Clients that were found installed on this machine. */
  clients: Client[];
  skills: SkillEntry[];
  plugins: PluginEntry[];
  mcpServers: McpEntry[];
  hooks: HookEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
  memory: MemoryEntry[];
  /** Non-fatal problems hit while scanning. Never thrown — a broken file in one client must not blank the rest. */
  warnings: ScanWarning[];
};

export type ScanWarning = {
  client: Client;
  file: string;
  message: string;
};

export function emptyInventory(projectRoot: string): Inventory {
  return {
    projectRoot,
    clients: [],
    skills: [],
    plugins: [],
    mcpServers: [],
    hooks: [],
    agents: [],
    commands: [],
    memory: [],
    warnings: []
  };
}
