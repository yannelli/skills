import { scanEnvironment } from '../env/inventory.js';
import type { Client, Inventory } from '../env/types.js';
import { commonOptions, flagEnum, GLOBAL_FLAGS, rejectUnknownFlags, type Args } from './args.js';
import { colorEnabled, createStyle, plural, renderJson, renderTable, shortenPath } from './format.js';

export const SCAN_KINDS = ['skill', 'plugin', 'mcp', 'hook', 'agent', 'command', 'memory'] as const;

export type ScanKind = (typeof SCAN_KINDS)[number];

const KIND_HEADINGS: Record<ScanKind, string> = {
  skill: 'skills',
  plugin: 'plugins',
  mcp: 'mcp',
  hook: 'hooks',
  agent: 'agents',
  command: 'commands',
  memory: 'memory'
};

type Row = {
  kind: ScanKind;
  id: string;
  client: Client;
  scope: string;
  name: string;
  /** on, off, enabled, disabled, or empty for things with no switch. */
  state: string;
  file: string;
};

export async function runScan(args: Args): Promise<number> {
  rejectUnknownFlags(args, [...GLOBAL_FLAGS, 'client', 'kind']);
  const options = commonOptions(args);
  const kind = flagEnum(args, 'kind', SCAN_KINDS);

  const inventory = await scanEnvironment(options.projectRoot, {
    ...(options.client ? { clients: [options.client] } : {})
  });

  const rows = collectRows(inventory).filter((row) => !kind || row.kind === kind);
  const counts = countByClient(inventory);

  if (options.json) {
    console.log(
      renderJson({
        projectRoot: inventory.projectRoot,
        clients: inventory.clients,
        counts,
        items: rows,
        warnings: inventory.warnings
      })
    );
    return 0;
  }

  const style = createStyle(colorEnabled(options.json));
  const head = (value: string): string => style.dim(value);

  if (!inventory.clients.length) {
    console.log('no agent clients found on this machine');
    return 0;
  }

  console.log(
    renderTable(
      [
        { header: 'client' },
        ...SCAN_KINDS.map((name) => ({ header: KIND_HEADINGS[name], align: 'right' as const }))
      ],
      [
        ...inventory.clients.map((client) => [
          client,
          ...SCAN_KINDS.map((name) => String(counts[client]?.[name] ?? 0))
        ]),
        ...(inventory.clients.length > 1
          ? [['total', ...SCAN_KINDS.map((name) => String(totalFor(counts, name)))]]
          : [])
      ],
      { headStyle: head }
    )
  );

  console.log('');
  if (!rows.length) {
    console.log(kind ? `nothing of kind ${kind} is loaded` : 'nothing is loaded');
    return 0;
  }

  console.log(
    renderTable(
      [
        { header: 'kind' },
        { header: 'client' },
        { header: 'scope' },
        { header: 'name', max: 44 },
        { header: 'state' },
        { header: 'source', max: 58, cut: 'start' }
      ],
      rows.map((row) => [
        row.kind,
        row.client,
        row.scope,
        row.name,
        stateLabel(row.state, style.dim, style.green),
        shortenPath(row.file, inventory.projectRoot)
      ]),
      { headStyle: head }
    )
  );

  if (inventory.warnings.length) {
    console.log('');
    console.log(
      style.dim(`${plural(inventory.warnings.length, 'config file')} could not be read — run yard doctor`)
    );
  }
  return 0;
}

function stateLabel(state: string, dim: (v: string) => string, green: (v: string) => string): string {
  if (!state) {
    return dim('—');
  }
  return state === 'off' || state === 'disabled' ? dim(state) : green(state);
}

function collectRows(inventory: Inventory): Row[] {
  const rows: Row[] = [];

  for (const skill of inventory.skills) {
    rows.push({
      kind: 'skill',
      id: skill.id,
      client: skill.client,
      scope: skill.scope,
      name: skill.qualifiedName,
      state: skill.visibility,
      file: skill.file
    });
  }
  for (const plugin of inventory.plugins) {
    rows.push({
      kind: 'plugin',
      id: plugin.id,
      client: plugin.client,
      scope: plugin.scope,
      name: plugin.qualifiedName,
      state: plugin.enabled ? (plugin.installed ? 'enabled' : 'missing') : 'disabled',
      file: plugin.root ?? plugin.enabledSource ?? ''
    });
  }
  for (const server of inventory.mcpServers) {
    rows.push({
      kind: 'mcp',
      id: server.id,
      client: server.client,
      scope: server.scope,
      name: `${server.name} (${server.transport})`,
      state: server.enabled ? 'enabled' : 'disabled',
      file: server.file
    });
  }
  for (const hook of inventory.hooks) {
    rows.push({
      kind: 'hook',
      id: hook.id,
      client: hook.client,
      scope: hook.scope,
      name: hook.matcher ? `${hook.event}:${hook.matcher}` : hook.event,
      state: hook.enabled ? 'enabled' : 'disabled',
      file: hook.file
    });
  }
  for (const agent of inventory.agents) {
    rows.push({
      kind: 'agent',
      id: agent.id,
      client: agent.client,
      scope: agent.scope,
      name: agent.name,
      state: '',
      file: agent.file
    });
  }
  for (const command of inventory.commands) {
    rows.push({
      kind: 'command',
      id: command.id,
      client: command.client,
      scope: command.scope,
      name: command.name,
      state: '',
      file: command.file
    });
  }
  for (const memory of inventory.memory) {
    rows.push({
      kind: 'memory',
      id: memory.id,
      client: memory.client,
      scope: memory.scope,
      name: memory.name,
      state: '',
      file: memory.file
    });
  }

  return rows;
}

type Counts = Partial<Record<Client, Record<ScanKind, number>>>;

function countByClient(inventory: Inventory): Counts {
  const counts: Counts = {};
  for (const client of inventory.clients) {
    counts[client] = { skill: 0, plugin: 0, mcp: 0, hook: 0, agent: 0, command: 0, memory: 0 };
  }
  for (const row of collectRows(inventory)) {
    const bucket = counts[row.client];
    if (bucket) {
      bucket[row.kind] += 1;
    }
  }
  return counts;
}

function totalFor(counts: Counts, kind: ScanKind): number {
  return Object.values(counts).reduce((sum, bucket) => sum + (bucket?.[kind] ?? 0), 0);
}
