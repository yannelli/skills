import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServerSpec, McpTransport } from './types.js';

export const AGENT_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

export type CanonicalMcpServer = {
  key: string;
  description: string;
  command: string;
  claudeArgs: string[];
  agentArgs: string[];
  claudeEnv?: Record<string, string>;
  agentCwd?: string;
};

export const YARD_MCP_SERVERS: CanonicalMcpServer[] = [
  {
    key: 'yard',
    description: 'Yard control plane. Search, hydrate, and attach marketplace artifacts over stdio.',
    command: 'node',
    claudeArgs: ['${CLAUDE_PLUGIN_ROOT}/dist/cli.js', '--stdio'],
    agentArgs: ['./dist/cli.js', '--stdio'],
    claudeEnv: { YARD_ROOT: '${CLAUDE_PROJECT_DIR}' },
    agentCwd: './'
  }
];

export type ClaudeMcpFile = {
  mcpServers: Record<string, ClaudeMcpEntry>;
};

export type ClaudeMcpEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
};

export type AgentMcpFile = {
  $schema: typeof AGENT_MCP_SCHEMA;
  mcpServers: Record<string, AgentMcpEntry>;
};

export type AgentMcpEntry = {
  type: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
};

export function emitClaudeMcp(servers: CanonicalMcpServer[] = YARD_MCP_SERVERS): ClaudeMcpFile {
  return {
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.key,
        {
          command: server.command,
          args: server.claudeArgs,
          ...(server.claudeEnv ? { env: server.claudeEnv } : {})
        }
      ])
    )
  };
}

export function emitAgentMcp(servers: CanonicalMcpServer[] = YARD_MCP_SERVERS): AgentMcpFile {
  return {
    $schema: AGENT_MCP_SCHEMA,
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.key,
        {
          type: 'stdio' as const,
          command: server.command,
          args: server.agentArgs,
          ...(server.agentCwd ? { cwd: server.agentCwd } : {})
        }
      ])
    )
  };
}

export async function writeMcpFiles(pluginRoot: string, servers: CanonicalMcpServer[] = YARD_MCP_SERVERS): Promise<void> {
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(emitClaudeMcp(servers), null, 2)}\n`);
  await writeFile(path.join(pluginRoot, 'mcp.json'), `${JSON.stringify(emitAgentMcp(servers), null, 2)}\n`);
}

export async function parsePluginMcp(pluginName: string, pluginRoot: string): Promise<McpServerSpec[]> {
  const claudePath = path.join(pluginRoot, '.mcp.json');
  const agentPath = path.join(pluginRoot, 'mcp.json');
  const claudeRaw = await readOptionalJson(claudePath);
  const agentRaw = await readOptionalJson(agentPath);
  const claudeKeys = claudeRaw ? serverKeys(claudeRaw) : [];
  const agentKeys = agentRaw ? serverKeys(agentRaw) : [];

  if (claudeRaw && !agentRaw) {
    throw new Error(`${pluginName} has .mcp.json but no mcp.json`);
  }
  if (agentRaw && !claudeRaw) {
    throw new Error(`${pluginName} has mcp.json but no .mcp.json`);
  }
  if (!claudeRaw || !agentRaw) {
    return [];
  }
  if (JSON.stringify(claudeKeys) !== JSON.stringify(agentKeys)) {
    throw new Error(`${pluginName} MCP server keys diverge: ${claudeKeys.join(',')} vs ${agentKeys.join(',')}`);
  }

  return claudeKeys.map((key) => {
    const claude = lookupServer(claudeRaw, key);
    return {
      key,
      plugin: pluginName,
      transport: transportFromClaude(claude),
      source: 'claude'
    };
  });
}

export function mcpKeysMatch(claude: unknown, agent: unknown): boolean {
  return JSON.stringify(serverKeys(claude)) === JSON.stringify(serverKeys(agent));
}

export function serverKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const record = raw as Record<string, unknown>;
  const wrapped = record.mcpServers;
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    return Object.keys(wrapped).sort();
  }
  return Object.keys(record)
    .filter((key) => key !== '$schema')
    .sort();
}

function lookupServer(raw: unknown, key: string): ClaudeMcpEntry {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const wrapped = record.mcpServers;
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    return ((wrapped as Record<string, ClaudeMcpEntry>)[key] ?? {}) as ClaudeMcpEntry;
  }
  return (record[key] ?? {}) as ClaudeMcpEntry;
}

function transportFromClaude(entry: ClaudeMcpEntry): McpTransport {
  if (entry.url || entry.type === 'http' || entry.type === 'streamable-http' || entry.type === 'sse') {
    return { type: 'http', url: entry.url ?? '' };
  }
  return {
    type: 'stdio',
    command: entry.command ?? 'node',
    args: entry.args ?? [],
    ...(entry.env ? { env: entry.env } : {}),
    ...(entry.cwd ? { cwd: entry.cwd } : {})
  };
}

async function readOptionalJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}
