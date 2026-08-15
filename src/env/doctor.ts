import path from 'node:path';
import { exists } from './safe-io.js';
import { probeAll } from './probe.js';
import { duplicateSkills } from './inventory.js';
import type { Client, Inventory } from './types.js';

/**
 * Find the things that are quietly broken.
 *
 * Agent clients fail silently by design: a hook whose script was deleted, an
 * MCP server that exits on startup, a skill the model can never see because
 * its frontmatter is malformed. None of it surfaces during a session. This
 * looks for all of it in one pass.
 */

export type Severity = 'error' | 'warning' | 'info';

export type Diagnosis = {
  severity: Severity;
  client: Client | 'repo';
  code: string;
  summary: string;
  /** The file to look at. */
  file?: string;
  /** What to do about it. */
  remedy?: string;
};

export type DoctorOptions = {
  /** Start each stdio MCP server to find out whether it actually works. */
  probe?: boolean;
  probeTimeoutMs?: number;
};

/**
 * Claude Code truncates skill descriptions in the listing. A description past
 * this length is silently cut, so the tail never influences whether the model
 * picks the skill.
 */
const DESCRIPTION_BUDGET = 1024;

export async function diagnose(inventory: Inventory, options: DoctorOptions = {}): Promise<Diagnosis[]> {
  const found: Diagnosis[] = [];

  for (const warning of inventory.warnings) {
    found.push({
      severity: 'warning',
      client: warning.client,
      code: 'unreadable-config',
      summary: warning.file ? `${warning.file}: ${warning.message}` : warning.message,
      ...(warning.file ? { file: warning.file } : {}),
      remedy: 'Fix or remove the file — the client silently ignores what it cannot parse'
    });
  }

  found.push(...(await checkHooks(inventory)));
  found.push(...checkSkills(inventory));
  found.push(...checkPlugins(inventory));
  found.push(...checkMcpApproval(inventory));

  for (const duplicate of duplicateSkills(inventory)) {
    found.push({
      severity: 'warning',
      client: duplicate.ids[0]?.split(':')[0] as Client,
      code: 'duplicate-skill',
      summary: `${duplicate.name} is defined ${duplicate.ids.length} times; the client picks one and ignores the rest`,
      remedy: `Rename or disable all but one of: ${duplicate.ids.join(', ')}`
    });
  }

  if (options.probe) {
    found.push(...(await checkMcpReachable(inventory, options)));
  }

  return found.sort(
    (a, b) => rank(a.severity) - rank(b.severity) || a.code.localeCompare(b.code) || a.summary.localeCompare(b.summary)
  );
}

async function checkHooks(inventory: Inventory): Promise<Diagnosis[]> {
  const found: Diagnosis[] = [];
  for (const hook of inventory.hooks) {
    if (hook.type !== 'command') {
      continue;
    }
    const script = scriptPathFrom(hook.command);
    if (!script) {
      continue;
    }
    // Relative commands resolve against the file that declared them, except in
    // a plugin, where they resolve against the plugin root.
    const base = hook.plugin ? pluginRootOf(hook.file) : path.dirname(hook.file);
    const resolved = path.isAbsolute(script) ? script : path.resolve(base, script);
    if (await exists(resolved)) {
      continue;
    }
    found.push({
      severity: 'error',
      client: hook.client,
      code: 'hook-script-missing',
      summary: `${hook.event} hook runs ${script}, which does not exist`,
      file: hook.file,
      remedy: `Restore ${resolved}, or remove the hook from ${hook.file}`
    });
  }
  return found;
}

function checkSkills(inventory: Inventory): Diagnosis[] {
  const found: Diagnosis[] = [];
  for (const skill of inventory.skills) {
    if (!skill.frontmatter.name) {
      found.push({
        severity: 'error',
        client: skill.client,
        code: 'skill-missing-name',
        summary: `${skill.id} has no "name" in its frontmatter`,
        file: skill.file,
        remedy: `Add "name: ${skill.name}" to the frontmatter`
      });
    }
    if (!skill.description) {
      found.push({
        severity: 'error',
        client: skill.client,
        code: 'skill-missing-description',
        summary: `${skill.id} has no description, so the model has nothing to decide on`,
        file: skill.file,
        remedy: 'Add a description saying when to use the skill'
      });
      continue;
    }
    if (skill.description.length > DESCRIPTION_BUDGET) {
      found.push({
        severity: 'warning',
        client: skill.client,
        code: 'skill-description-long',
        summary: `${skill.id} has a ${skill.description.length}-char description; the tail is truncated before the model sees it`,
        file: skill.file,
        remedy: 'Shorten it to the trigger conditions and move the detail into the body'
      });
    }
  }
  return found;
}

function checkPlugins(inventory: Inventory): Diagnosis[] {
  const found: Diagnosis[] = [];

  // Count what each plugin actually contributed to the scan rather than
  // trusting per-plugin counters, which do not cover agents or commands and so
  // flag agent-only plugins as empty.
  const contributions = new Map<string, number>();
  const credit = (client: string, plugin: string | undefined): void => {
    if (!plugin) {
      return;
    }
    const key = `${client}:${plugin}`;
    contributions.set(key, (contributions.get(key) ?? 0) + 1);
  };
  for (const item of [
    ...inventory.skills,
    ...inventory.hooks,
    ...inventory.mcpServers,
    ...inventory.agents,
    ...inventory.commands
  ]) {
    credit(item.client, item.plugin);
  }

  for (const plugin of inventory.plugins) {
    if (plugin.enabled && !plugin.installed) {
      found.push({
        severity: 'error',
        client: plugin.client,
        code: 'plugin-not-installed',
        summary: `${plugin.qualifiedName} is enabled but is not on disk`,
        ...(plugin.enabledSource ? { file: plugin.enabledSource } : {}),
        remedy: `Install it, or remove it from ${plugin.enabledSource ?? 'settings'}`
      });
    }
    if (plugin.enabled && plugin.installed && !contributions.get(`${plugin.client}:${plugin.name}`)) {
      found.push({
        severity: 'info',
        client: plugin.client,
        code: 'plugin-empty',
        summary: `${plugin.qualifiedName} is enabled but contributes nothing loadable`,
        ...(plugin.root ? { file: plugin.root } : {}),
        remedy: `yard plugin disable ${plugin.qualifiedName}`
      });
    }
  }
  return found;
}

function checkMcpApproval(inventory: Inventory): Diagnosis[] {
  return inventory.mcpServers
    .filter((server) => server.client === 'claude' && server.scope === 'project' && !server.enabled && !server.enabledSource)
    .map((server) => ({
      severity: 'info' as const,
      client: server.client,
      code: 'mcp-pending-approval',
      summary: `${server.name} is declared in .mcp.json but has not been approved, so it is not loaded`,
      file: server.file,
      remedy: `yard mcp enable ${server.name}`
    }));
}

async function checkMcpReachable(inventory: Inventory, options: DoctorOptions): Promise<Diagnosis[]> {
  const enabled = inventory.mcpServers.filter((server) => server.enabled && server.transport === 'stdio');
  if (!enabled.length) {
    return [];
  }
  const results = await probeAll(enabled, {
    ...(options.probeTimeoutMs !== undefined ? { timeoutMs: options.probeTimeoutMs } : {})
  });
  return results
    .filter((result) => !result.ok)
    .map((result) => {
      const server = enabled.find((item) => item.id === result.id);
      return {
        severity: 'error' as const,
        client: server?.client ?? 'claude',
        code: 'mcp-unreachable',
        summary: `${server?.name ?? result.server} did not start: ${result.error ?? 'unknown error'}`,
        ...(server?.file ? { file: server.file } : {}),
        remedy: `Fix the command, or run: yard mcp disable ${server?.name ?? result.server}`
      };
    });
}

/**
 * Pull the script out of a hook command so it can be checked for existence.
 * Returns undefined for anything that is a shell one-liner rather than a call
 * to a file, since those cannot be verified without executing them.
 */
function scriptPathFrom(command: string): string | undefined {
  const trimmed = command.trim();
  // Anything with shell control flow is a script in its own right, not a path.
  if (/[;&|<>]|\$\(|\bif\b|\bfor\b|\bwhile\b/.test(trimmed)) {
    return undefined;
  }
  const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const candidates = tokens
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter((token) => !token.startsWith('-'));
  // `node ./hooks/x.mjs` — the path is the first token that looks like one.
  const script = candidates.find((token) => /[/\\]/.test(token) && /\.[a-z0-9]+$/i.test(token));
  if (!script || script.includes('${') || script.includes('$')) {
    // Unexpanded variables make the path unknowable from here.
    return undefined;
  }
  return script;
}

function pluginRootOf(hookFile: string): string {
  // <pluginRoot>/hooks/hooks.json
  return path.resolve(path.dirname(hookFile), '..');
}

function rank(severity: Severity): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}
