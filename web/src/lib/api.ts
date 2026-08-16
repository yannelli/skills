/**
 * Hand-mirrored from src/env/types.ts, src/env/context.ts, src/env/doctor.ts and
 * src/env/actions.ts. The web build has no path into src/, so these must be kept
 * in step by hand when the environment layer changes.
 */

export const CLIENTS = ['claude', 'codex', 'cursor'] as const;

export type Client = (typeof CLIENTS)[number];

export const SCOPES = ['user', 'project', 'local', 'plugin', 'builtin'] as const;

export type Scope = (typeof SCOPES)[number];

export const SKILL_VISIBILITIES = ['on', 'name-only', 'user-invocable-only', 'off'] as const;

export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number];

export type SkillEntry = {
  id: string;
  client: Client;
  scope: Scope;
  name: string;
  qualifiedName: string;
  description: string;
  file: string;
  dir: string;
  plugin?: string;
  visibility: SkillVisibility;
  visibilitySource?: string;
  frontmatter: Record<string, string>;
  bytes: number;
};

export type PluginEntry = {
  id: string;
  client: Client;
  scope: Scope;
  name: string;
  marketplace?: string;
  qualifiedName: string;
  description: string;
  version: string;
  root?: string;
  enabled: boolean;
  enabledSource?: string;
  installed: boolean;
  skills: number;
  hooks: number;
  mcpServers: number;
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
  file: string;
  plugin?: string;
  pluginRoot?: string;
  enabled: boolean;
  enabledSource?: string;
};

export type HookEntry = {
  id: string;
  client: Client;
  scope: Scope;
  event: string;
  matcher?: string;
  type: 'command' | 'prompt';
  command: string;
  timeout?: number;
  file: string;
  plugin?: string;
  pluginRoot?: string;
  enabled: boolean;
  enabledSource?: string;
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
  name: string;
  file: string;
  bytes: number;
};

export type ScanWarning = {
  client: Client;
  file: string;
  message: string;
};

export type Inventory = {
  projectRoot: string;
  clients: Client[];
  skills: SkillEntry[];
  plugins: PluginEntry[];
  mcpServers: McpEntry[];
  hooks: HookEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
  memory: MemoryEntry[];
  warnings: ScanWarning[];
};

export const CONTEXT_KINDS = ['skill', 'mcp', 'agent', 'command', 'memory'] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];

export type ContextLine = {
  id: string;
  client: Client;
  kind: ContextKind;
  label: string;
  tokens: number;
  /** False when the cost could not be measured, only guessed at. */
  measured: boolean;
  detail?: string;
  remedy?: string;
  /**
   * True when `remedy` is a `yard` command the action layer will actually
   * carry out — false for a remedy that only names the client's own lever
   * (a plugin's own enable/disable), which Yard has no API for and a button
   * here would only fail against.
   */
  remedyActionable?: boolean;
};

export type ContextReport = {
  projectRoot: string;
  clients: Client[];
  total: number;
  byKind: Record<ContextKind, number>;
  byClient: Partial<Record<Client, number>>;
  lines: ContextLine[];
  /** True when MCP servers were started and asked for their real tool lists. */
  probed: boolean;
  notes: string[];
};

export type Severity = 'error' | 'warning' | 'info';

export type Diagnosis = {
  severity: Severity;
  client: Client | 'repo';
  code: string;
  summary: string;
  file?: string;
  remedy?: string;
};

export type ActionResult = {
  changed: boolean;
  /** The file that was written, or would be on a real run. */
  file?: string;
  backup?: string;
  dryRun: boolean;
  detail: string;
};

/**
 * The canonical `kind` vocabulary of /api/env/inventory, mirroring ENV_KINDS in
 * src/env-api.ts. That endpoint also accepts the singular aliases; this sends
 * the canonical form.
 */
export const ENV_KINDS = [
  'skills',
  'plugins',
  'mcp',
  'hooks',
  'agents',
  'commands',
  'memory'
] as const;

export type EnvKind = (typeof ENV_KINDS)[number];

export const ARTIFACT_KINDS = ['skill', 'rule', 'agent', 'command', 'hook', 'mcp'] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactIndex = {
  id: string;
  plugin: string;
  kind: ArtifactKind;
  name: string;
  description: string;
  path: string;
  version: string;
};

export type ArtifactRecord = ArtifactIndex & {
  body: string;
  raw: string;
};

export type PluginRecord = {
  name: string;
  description: string;
  version: string;
  source: string;
  root: string;
};

export type CatalogResponse = {
  plugins: PluginRecord[];
  artifacts: ArtifactIndex[];
};

export type AdaptReport = {
  ok: boolean;
  dest: string;
  name: string;
  wrote: string[];
  skipped: string[];
  notes: string[];
  registered: boolean;
};

/**
 * Hand-mirrored from the client/origin action matrix in src/env/actions.ts
 * (`skillActionBlocked` / `pluginActionBlocked` / `mcpActionBlocked`) — see
 * that file for the reasoning behind each rule. Kept here so a control can be
 * disabled *before* the click, with the same reason the server would give
 * after it: the inventory table and the context table both call these
 * rather than each guessing their own subset of the rules.
 */
export function skillActionBlocked(entry: Pick<SkillEntry, 'client' | 'scope' | 'plugin'>): string | undefined {
  if (entry.scope === 'plugin') {
    return `plugin skill — enable or disable the "${entry.plugin}" plugin instead of switching it alone`;
  }
  if (entry.client === 'cursor') {
    return 'cursor has no skill visibility setting — move the directory by hand';
  }
  return undefined;
}

/** Only Claude Code stores plugin enablement in settings; Codex and Cursor treat install as enable. */
export function pluginActionBlocked(entry: Pick<PluginEntry, 'client'>): string | undefined {
  if (entry.client !== 'claude') {
    return `only Claude Code stores plugin enablement in settings — use \`${entry.client} plugin add/remove\` instead`;
  }
  return undefined;
}

export function mcpActionBlocked(entry: Pick<McpEntry, 'client' | 'scope' | 'plugin'>): string | undefined {
  if (entry.scope === 'plugin') {
    if (entry.client === 'cursor') {
      return `plugin-contributed MCP server — Cursor manages it through the "${entry.plugin}" plugin, not ~/.cursor/mcp.json`;
    }
    if (entry.client === 'codex') {
      return `plugin-contributed MCP server, not a ~/.codex/config.toml entry — enable or disable the "${entry.plugin}" plugin instead`;
    }
    return undefined;
  }
  if (entry.client === 'codex') {
    return 'codex owns config.toml — use `codex mcp add/remove` so its formatting survives';
  }
  return undefined;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data: { error?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text) as { error?: string };
    } catch {
      throw new Error(text);
    }
  }
  if (!res.ok) {
    throw new Error(data.error ?? (text || res.statusText));
  }
  return data as T;
}

export function fetchInventory(filter: { client?: Client; kind?: EnvKind } = {}): Promise<Inventory> {
  const params = new URLSearchParams();
  if (filter.client) {
    params.set('client', filter.client);
  }
  if (filter.kind) {
    params.set('kind', filter.kind);
  }
  const query = params.toString();
  return api<Inventory>(`/api/env/inventory${query ? `?${query}` : ''}`);
}

/**
 * `probe` starts the developer's configured MCP servers, so it is only ever
 * passed in response to a deliberate click.
 */
export function fetchContext(probe: boolean): Promise<ContextReport> {
  return api<ContextReport>(`/api/env/context${probe ? '?probe=1' : ''}`);
}

export function fetchDoctor(probe: boolean): Promise<{ diagnoses: Diagnosis[] }> {
  return api<{ diagnoses: Diagnosis[] }>(`/api/env/doctor${probe ? '?probe=1' : ''}`);
}

/**
 * Every action takes the `id` a scan already handed back on the row being
 * changed, alongside the name and client it was resolved from. An id is
 * unambiguous by construction and takes priority server-side; the name and
 * client stay as the fallback the API has always accepted, and as what a
 * human reads in the request body. Names are not unique across clients — the
 * same plugin installed for Codex and Cursor gives two skills of the same
 * name, and one MCP server is commonly configured in all three — so without
 * an id the API refuses a bare name it cannot resolve to one client rather
 * than guessing which config to edit.
 */
export function setSkillVisibility(opts: {
  id?: string;
  skill: string;
  visibility: SkillVisibility;
  client?: Client;
}): Promise<ActionResult> {
  return api<ActionResult>('/api/env/skill', {
    method: 'POST',
    body: JSON.stringify({
      skill: opts.skill,
      visibility: opts.visibility,
      ...(opts.client ? { client: opts.client } : {}),
      ...(opts.id ? { id: opts.id } : {})
    })
  });
}

export function setPluginEnabled(opts: {
  id?: string;
  plugin: string;
  enabled: boolean;
  client?: Client;
}): Promise<ActionResult> {
  return api<ActionResult>('/api/env/plugin', {
    method: 'POST',
    body: JSON.stringify({
      plugin: opts.plugin,
      enabled: opts.enabled,
      ...(opts.client ? { client: opts.client } : {}),
      ...(opts.id ? { id: opts.id } : {})
    })
  });
}

export function setMcpEnabled(opts: {
  id?: string;
  server: string;
  enabled: boolean;
  client?: Client;
}): Promise<ActionResult> {
  return api<ActionResult>('/api/env/mcp', {
    method: 'POST',
    body: JSON.stringify({
      server: opts.server,
      enabled: opts.enabled,
      ...(opts.client ? { client: opts.client } : {}),
      ...(opts.id ? { id: opts.id } : {})
    })
  });
}
