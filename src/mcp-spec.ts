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

/**
 * Write every MCP surface a plugin has from one canonical spec: the `.mcp.json`
 * Claude Code and Codex load, the Agent Plugins `mcp.json`, the `mcpServers`
 * block Cursor reads out of its own manifest, and the Codex manifest's pointer
 * at `.mcp.json`. Keeping them in one function is what stops them drifting.
 */
export async function writeMcpFiles(pluginRoot: string, servers: CanonicalMcpServer[] = YARD_MCP_SERVERS): Promise<void> {
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(emitClaudeMcp(servers), null, 2)}\n`);
  await writeFile(path.join(pluginRoot, 'mcp.json'), `${JSON.stringify(emitAgentMcp(servers), null, 2)}\n`);
  await patchManifest(path.join(pluginRoot, '.cursor-plugin', 'plugin.json'), emitCursorMcp(servers));
  await patchManifest(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), './.mcp.json');
}

async function patchManifest(file: string, mcpServers: unknown): Promise<void> {
  const raw = await readOptionalJson(file);
  if (!raw || typeof raw !== 'object') {
    return;
  }
  await writeFile(file, `${JSON.stringify({ ...(raw as object), mcpServers }, null, 2)}\n`);
}

/**
 * Read a plugin's MCP servers.
 *
 * `.mcp.json` is the file Claude Code and Codex actually load, so it is the
 * source of truth. `mcp.json` is Agent Plugins spec compliance and is only
 * consulted when `.mcp.json` is absent.
 *
 * This never throws: it runs inside the catalog scan, and one malformed plugin
 * must not blank the whole catalog. Use {@link checkPluginMcp} to surface
 * problems where reporting them is the job.
 */
export async function parsePluginMcp(pluginName: string, pluginRoot: string): Promise<McpServerSpec[]> {
  const claudeRaw = await readOptionalJson(path.join(pluginRoot, '.mcp.json'));
  const agentRaw = await readOptionalJson(path.join(pluginRoot, 'mcp.json'));
  const raw = claudeRaw ?? agentRaw;
  if (!raw) {
    return [];
  }

  return serverKeys(raw).map((key) => ({
    key,
    plugin: pluginName,
    transport: transportFromClaude(lookupServer(raw, key)),
    source: claudeRaw ? 'claude' : 'agent'
  }));
}

/** Problems worth failing `npm run validate` over. Empty means the plugin is consistent. */
export async function checkPluginMcp(pluginName: string, pluginRoot: string): Promise<string[]> {
  const claudeRaw = await readOptionalJson(path.join(pluginRoot, '.mcp.json'));
  const agentRaw = await readOptionalJson(path.join(pluginRoot, 'mcp.json'));
  if (!claudeRaw && !agentRaw) {
    return [];
  }

  const problems: string[] = [];
  if (!claudeRaw) {
    problems.push(`${pluginName} ships mcp.json but no .mcp.json, so Claude Code and Codex load nothing`);
    return problems;
  }

  const claudeKeys = serverKeys(claudeRaw);
  if (agentRaw) {
    const agentKeys = serverKeys(agentRaw);
    if (JSON.stringify(claudeKeys) !== JSON.stringify(agentKeys)) {
      problems.push(
        `${pluginName} MCP server keys diverge: ${claudeKeys.join(',')} vs ${agentKeys.join(',')}`
      );
    }
    if (!isAgentShaped(agentRaw)) {
      problems.push(`${pluginName} mcp.json is missing the Agent Plugins $schema`);
    }
  }

  // Cursor does not read either file — it reads mcpServers inlined into
  // .cursor-plugin/plugin.json — so a plugin shipping MCP must inline it there
  // or Cursor silently installs a plugin with no servers.
  const cursor = await readOptionalJson(path.join(pluginRoot, '.cursor-plugin', 'plugin.json'));
  const cursorKeys = cursor ? serverKeys((cursor as { mcpServers?: unknown }).mcpServers ?? {}) : [];
  if (claudeKeys.length && JSON.stringify(cursorKeys) !== JSON.stringify(claudeKeys)) {
    problems.push(
      `${pluginName} .cursor-plugin/plugin.json must inline mcpServers ${claudeKeys.join(',')} (found ${
        cursorKeys.join(',') || 'none'
      })`
    );
  }

  return problems;
}

function isAgentShaped(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && '$schema' in (raw as object));
}

/**
 * The `mcpServers` block to inline into `.cursor-plugin/plugin.json`. Cursor
 * plugins declare servers in the manifest itself and resolve relative paths
 * against the plugin root, so no `${CLAUDE_PLUGIN_ROOT}` and no `cwd`.
 */
export function emitCursorMcp(servers: CanonicalMcpServer[] = YARD_MCP_SERVERS): Record<string, ClaudeMcpEntry> {
  return Object.fromEntries(
    servers.map((server) => [
      server.key,
      {
        command: server.command,
        args: server.agentArgs
      }
    ])
  );
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
