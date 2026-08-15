import { probeAll, type ProbeResult } from './probe.js';
import { estimateTokens } from './tokens.js';
import type { Client, Inventory } from './types.js';

/**
 * What a developer's agent setup costs them in context window, per turn.
 *
 * Skills, MCP tool schemas, subagent descriptions, slash commands, and always-on
 * memory files are all charged against the same window as the actual
 * conversation, and no client shows you the bill. This builds it.
 */

export type ContextKind = 'skill' | 'mcp' | 'agent' | 'command' | 'memory';

export type ContextLine = {
  id: string;
  client: Client;
  kind: ContextKind;
  label: string;
  /** Estimated tokens this costs on every turn. */
  tokens: number;
  /** False when the cost could not be measured, only guessed at. */
  measured: boolean;
  detail?: string;
  /** The command that turns this off. */
  remedy?: string;
};

export type ContextReport = {
  projectRoot: string;
  clients: Client[];
  /** Sum of `lines`. */
  total: number;
  byKind: Record<ContextKind, number>;
  byClient: Partial<Record<Client, number>>;
  lines: ContextLine[];
  /** True when MCP servers were started and asked for their real tool lists. */
  probed: boolean;
  notes: string[];
};

export type ContextOptions = {
  /**
   * Start each stdio MCP server and ask for its tool list. This is the only way
   * to price MCP honestly, and it is off by default because it executes the
   * developer's configured commands.
   */
  probe?: boolean;
  probeTimeoutMs?: number;
  /** Claude Code's `skillListingMaxDescChars`. */
  maxDescChars?: number;
};

/**
 * Claude Code truncates each skill's description in the listing it sends the
 * model. Anything past this never reaches context, so it must not be billed.
 */
const DEFAULT_MAX_DESC_CHARS = 1536;

/**
 * Rough cost of an unprobed MCP server. Derived from the observed range of
 * real servers (a handful of tools at ~150-250 tokens of JSON Schema each);
 * only ever used to say "this is not free", never reported as measured.
 */
const UNPROBED_MCP_TOKENS = 1200;

export async function buildContextReport(
  inventory: Inventory,
  options: ContextOptions = {}
): Promise<ContextReport> {
  const maxDescChars = options.maxDescChars ?? DEFAULT_MAX_DESC_CHARS;
  const lines: ContextLine[] = [];
  const notes: string[] = [];

  for (const skill of inventory.skills) {
    // Only the name and a truncated description reach the model until the
    // skill is actually invoked — that is the whole point of progressive
    // disclosure, and it is why a skill is cheap and an MCP server is not.
    if (skill.visibility === 'off' || skill.visibility === 'user-invocable-only') {
      continue;
    }
    const description = skill.visibility === 'name-only' ? '' : skill.description.slice(0, maxDescChars);
    const tokens = estimateTokens(`${skill.qualifiedName}: ${description}`);
    lines.push({
      id: skill.id,
      client: skill.client,
      kind: 'skill',
      label: skill.qualifiedName,
      tokens,
      measured: true,
      ...(skill.description.length > maxDescChars
        ? { detail: `description truncated at ${maxDescChars} chars` }
        : {}),
      // A plugin skill cannot be switched off individually — Claude Code's
      // skillOverrides deliberately does not apply to them — so the lever is
      // the plugin. Saying so is more useful than leaving the row blank.
      ...(skill.scope === 'plugin' && skill.plugin
        ? { remedy: `yard plugin disable ${skill.plugin}` }
        : skill.client === 'claude'
          ? { remedy: `yard skill ${skill.qualifiedName} user-invocable-only` }
          : {})
    });
  }

  const enabledServers = inventory.mcpServers.filter((server) => server.enabled);
  let probes: ProbeResult[] = [];
  if (options.probe && enabledServers.length) {
    probes = await probeAll(enabledServers, {
      ...(options.probeTimeoutMs !== undefined ? { timeoutMs: options.probeTimeoutMs } : {})
    });
  }

  for (const server of enabledServers) {
    const probe = probes.find((result) => result.server === server.id);
    if (probe?.ok) {
      lines.push({
        id: server.id,
        client: server.client,
        kind: 'mcp',
        label: server.name,
        tokens: probe.totalTokens,
        measured: true,
        detail: `${probe.tools.length} tools`,
        remedy: `yard mcp disable ${server.name}`
      });
      continue;
    }
    lines.push({
      id: server.id,
      client: server.client,
      kind: 'mcp',
      label: server.name,
      tokens: UNPROBED_MCP_TOKENS,
      measured: false,
      detail: probe?.error ?? (options.probe ? 'probe failed' : 'not probed — run with --probe for the real cost'),
      remedy: `yard mcp disable ${server.name}`
    });
  }

  if (!options.probe && enabledServers.length) {
    notes.push(
      `${enabledServers.length} MCP server(s) were estimated, not measured. Re-run with --probe to start them and read their real tool schemas.`
    );
  }

  for (const agent of inventory.agents) {
    lines.push({
      id: agent.id,
      client: agent.client,
      kind: 'agent',
      label: agent.name,
      tokens: estimateTokens(`${agent.name}: ${agent.description}`),
      measured: true
    });
  }

  for (const command of inventory.commands) {
    lines.push({
      id: command.id,
      client: command.client,
      kind: 'command',
      label: command.name,
      tokens: estimateTokens(`${command.name}: ${command.description}`),
      measured: true
    });
  }

  for (const memory of inventory.memory) {
    // Memory files are loaded whole, so they are billed whole.
    lines.push({
      id: memory.id,
      client: memory.client,
      kind: 'memory',
      label: memory.name,
      tokens: tokensFromBytes(memory.bytes),
      measured: false,
      detail: `${memory.bytes} bytes, loaded in full`
    });
  }

  lines.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));

  const byKind: Record<ContextKind, number> = { skill: 0, mcp: 0, agent: 0, command: 0, memory: 0 };
  const byClient: Partial<Record<Client, number>> = {};
  let total = 0;
  for (const line of lines) {
    byKind[line.kind] += line.tokens;
    byClient[line.client] = (byClient[line.client] ?? 0) + line.tokens;
    total += line.tokens;
  }

  return {
    projectRoot: inventory.projectRoot,
    clients: inventory.clients,
    total,
    byKind,
    byClient,
    lines,
    probed: Boolean(options.probe),
    notes
  };
}

/**
 * Memory files are sized during the scan rather than re-read here, so their
 * cost comes from byte count at markdown-prose density.
 */
function tokensFromBytes(bytes: number): number {
  return Math.round(bytes / 4.1);
}

/** The lines worth acting on first: expensive, and switchable off. */
export function topOffenders(report: ContextReport, limit = 10): ContextLine[] {
  return report.lines.filter((line) => line.remedy).slice(0, limit);
}

export type ContextLever = {
  label: string;
  client: Client;
  kind: ContextKind;
  tokens: number;
  /** How many lines were rolled up. */
  count: number;
  remedy?: string;
};

/**
 * The same total, grouped by the thing you can actually switch off.
 *
 * A ranked list of individual lines is misleading: four hundred skills at sixty
 * tokens each dwarf any single MCP server, yet every row looks trivial. Rolling
 * a plugin's skills up under the plugin puts the real levers at the top.
 */
export function biggestLevers(report: ContextReport, limit = 10): ContextLever[] {
  const groups = new Map<string, ContextLever>();

  for (const line of report.lines) {
    const key = leverKey(line);
    const existing = groups.get(key);
    if (existing) {
      existing.tokens += line.tokens;
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      label: leverLabel(line),
      client: line.client,
      kind: line.kind,
      tokens: line.tokens,
      count: 1,
      ...(line.remedy ? { remedy: line.remedy } : {})
    });
  }

  return [...groups.values()]
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function leverKey(line: ContextLine): string {
  const plugin = pluginOf(line);
  return plugin ? `${line.client}:${line.kind}:plugin:${plugin}` : `${line.client}:${line.kind}:${line.label}`;
}

function leverLabel(line: ContextLine): string {
  return pluginOf(line) ?? line.label;
}

/** Skill ids are `<client>:plugin:<plugin>:<name>`. */
function pluginOf(line: ContextLine): string | undefined {
  if (line.kind !== 'skill') {
    return undefined;
  }
  const parts = line.id.split(':');
  return parts[1] === 'plugin' ? parts[2] : undefined;
}
