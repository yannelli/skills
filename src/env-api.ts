import type { ActionScope } from './env/actions.js';
import type { Client, Inventory, Scope } from './env/types.js';

/**
 * The shape the HTTP API and the MCP tools both need on top of the environment
 * layer: one vocabulary for "which part of the inventory", and one way to make
 * a 450-entry scan safe to hand to a model.
 */

export const ENV_KINDS = ['skills', 'plugins', 'mcp', 'hooks', 'agents', 'commands', 'memory'] as const;

export type EnvKind = (typeof ENV_KINDS)[number];

export function isEnvKind(value: string): value is EnvKind {
  return (ENV_KINDS as readonly string[]).includes(value);
}

/**
 * The CLI and the docs say `--kind=skill`, this module says `skills`. Rather
 * than make callers remember which surface pluralises, accept either and
 * normalise, so a request that reads correctly is never a 400.
 */
const KIND_ALIASES: Record<string, EnvKind> = {
  skill: 'skills',
  plugin: 'plugins',
  mcpServers: 'mcp',
  hook: 'hooks',
  agent: 'agents',
  command: 'commands',
  memories: 'memory'
};

export function toEnvKind(value: string): EnvKind | undefined {
  if (isEnvKind(value)) {
    return value;
  }
  return KIND_ALIASES[value];
}

export function countInventory(inventory: Inventory): Record<EnvKind, number> {
  return {
    skills: inventory.skills.length,
    plugins: inventory.plugins.length,
    mcp: inventory.mcpServers.length,
    hooks: inventory.hooks.length,
    agents: inventory.agents.length,
    commands: inventory.commands.length,
    memory: inventory.memory.length
  };
}

/** The same inventory with every other kind emptied. Keeps the response shape stable. */
export function filterInventory(inventory: Inventory, kind: EnvKind): Inventory {
  return {
    ...inventory,
    skills: kind === 'skills' ? inventory.skills : [],
    plugins: kind === 'plugins' ? inventory.plugins : [],
    mcpServers: kind === 'mcp' ? inventory.mcpServers : [],
    hooks: kind === 'hooks' ? inventory.hooks : [],
    agents: kind === 'agents' ? inventory.agents : [],
    commands: kind === 'commands' ? inventory.commands : [],
    memory: kind === 'memory' ? inventory.memory : []
  };
}

export type EnvRow = {
  kind: EnvKind;
  id: string;
  client: Client;
  scope: Scope;
  name: string;
  /** Whether it is on, and in what mode. */
  state?: string;
  description?: string;
};

export type EnvSummary = {
  projectRoot: string;
  clients: Client[];
  counts: Record<EnvKind, number>;
  kind?: EnvKind;
  rows: EnvRow[];
  shown: number;
  omitted: number;
  warnings: number;
};

/** Descriptions are for recognising an entry here, not for reading it. */
const MAX_DESC_CHARS = 140;

export const DEFAULT_ROW_LIMIT = 50;

/**
 * Counts of everything, and at most `limit` rows of it. A full inventory is
 * hundreds of entries and tens of thousands of tokens, which is the very cost
 * this tool exists to measure — dumping it would be self-defeating.
 */
export function summarizeInventory(
  inventory: Inventory,
  options: { kind?: EnvKind; limit?: number } = {}
): EnvSummary {
  const limit = options.limit ?? DEFAULT_ROW_LIMIT;
  const all = rowsFor(inventory, options.kind);
  const rows = all.slice(0, limit);
  return {
    projectRoot: inventory.projectRoot,
    clients: inventory.clients,
    counts: countInventory(inventory),
    ...(options.kind ? { kind: options.kind } : {}),
    rows,
    shown: rows.length,
    omitted: all.length - rows.length,
    warnings: inventory.warnings.length
  };
}

function rowsFor(inventory: Inventory, kind?: EnvKind): EnvRow[] {
  const rows: EnvRow[] = [];

  if (!kind || kind === 'skills') {
    for (const skill of inventory.skills) {
      rows.push({
        kind: 'skills',
        id: skill.id,
        client: skill.client,
        scope: skill.scope,
        name: skill.qualifiedName,
        state: skill.visibility,
        ...describe(skill.description)
      });
    }
  }

  if (!kind || kind === 'plugins') {
    for (const plugin of inventory.plugins) {
      rows.push({
        kind: 'plugins',
        id: plugin.id,
        client: plugin.client,
        scope: plugin.scope,
        name: plugin.qualifiedName,
        state: `${plugin.enabled ? 'enabled' : 'disabled'}${plugin.installed ? '' : ', not installed'}`,
        ...describe(plugin.description)
      });
    }
  }

  if (!kind || kind === 'mcp') {
    for (const server of inventory.mcpServers) {
      rows.push({
        kind: 'mcp',
        id: server.id,
        client: server.client,
        scope: server.scope,
        name: server.name,
        state: `${server.transport}, ${server.enabled ? 'enabled' : 'disabled'}`,
        ...describe(server.command ?? server.url ?? '')
      });
    }
  }

  if (!kind || kind === 'hooks') {
    for (const hook of inventory.hooks) {
      rows.push({
        kind: 'hooks',
        id: hook.id,
        client: hook.client,
        scope: hook.scope,
        name: hook.event,
        state: hook.enabled ? 'enabled' : 'disabled',
        ...describe(hook.command)
      });
    }
  }

  if (!kind || kind === 'agents') {
    for (const agent of inventory.agents) {
      rows.push({
        kind: 'agents',
        id: agent.id,
        client: agent.client,
        scope: agent.scope,
        name: agent.name,
        ...describe(agent.description)
      });
    }
  }

  if (!kind || kind === 'commands') {
    for (const command of inventory.commands) {
      rows.push({
        kind: 'commands',
        id: command.id,
        client: command.client,
        scope: command.scope,
        name: command.name,
        ...describe(command.description)
      });
    }
  }

  if (!kind || kind === 'memory') {
    for (const memory of inventory.memory) {
      rows.push({
        kind: 'memory',
        id: memory.id,
        client: memory.client,
        scope: memory.scope,
        name: memory.name,
        state: `${memory.bytes} bytes, always loaded`
      });
    }
  }

  return rows;
}

function describe(text: string): { description?: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  return {
    description: trimmed.length > MAX_DESC_CHARS ? `${trimmed.slice(0, MAX_DESC_CHARS)}…` : trimmed
  };
}

export type ActionTarget = {
  projectRoot: string;
  client?: Client;
  scope?: ActionScope;
  dryRun?: boolean;
};

/** Where an action writes. The project root is always the server's cwd. */
export function actionTarget(opts: { client?: Client; scope?: ActionScope; dryRun?: boolean }): ActionTarget {
  return {
    projectRoot: process.cwd(),
    ...(opts.client ? { client: opts.client } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
  };
}
