import path from 'node:path';
import { claudePaths, codexPaths } from './client-paths.js';
import { exists } from './safe-io.js';
import { probeAll } from './probe.js';
import { duplicateSkills } from './inventory.js';
import { expandVariables, isFullyExpanded, pathVariables, splitShellWords } from './shell-words.js';
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

  found.push(...warningDiagnoses(inventory));
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
    // Prefer the root the scanner actually resolved the plugin against; fall
    // back to the hooks.json-relative heuristic only for entries that predate
    // that field (a client scanner Yard has not updated yet, or a fixture).
    const pluginRoot = hook.plugin ? hook.pluginRoot ?? pluginRootOf(hook.file) : undefined;
    const vars = pathVariables({ ...(pluginRoot ? { pluginRoot } : {}), projectRoot: inventory.projectRoot });
    const script = scriptPathFrom(hook.command, vars);
    if (!script) {
      continue;
    }
    // Relative commands resolve against the file that declared them, except in
    // a plugin, where they resolve against the plugin root.
    const base = pluginRoot ?? path.dirname(hook.file);
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

/**
 * Directories Yard itself parks a disabled personal skill in. Neither client
 * scans them — Claude Code only reads `skills/`, Codex only reads `skills/`
 * — so a broken symlink sitting in one is stale housekeeping, not something
 * an active client trips over. One bad marketplace sync can leave dozens of
 * dead links behind, and reporting each as its own warning buries the
 * findings that describe something actually loaded and broken.
 */
function disabledSkillDirs(projectRoot: string): Array<{ client: Client; dir: string }> {
  return [
    { client: 'claude', dir: claudePaths(projectRoot).userSkillsDisabled },
    { client: 'codex', dir: codexPaths(projectRoot).userSkillsDisabled }
  ];
}

/**
 * Every scan warning becomes a finding, except the ones from a disabled-skill
 * parking directory, which are rolled up into one `info` finding per
 * directory instead of one `warning` per stale link.
 */
function warningDiagnoses(inventory: Inventory): Diagnosis[] {
  const found: Diagnosis[] = [];
  const disabledDirs = disabledSkillDirs(inventory.projectRoot);
  const parked = new Map<string, { client: Client; dir: string; count: number }>();

  for (const warning of inventory.warnings) {
    const parking = disabledDirs.find(
      (candidate) => warning.file === candidate.dir || warning.file.startsWith(candidate.dir + path.sep)
    );
    if (parking) {
      const entry = parked.get(parking.dir) ?? { client: parking.client, dir: parking.dir, count: 0 };
      entry.count += 1;
      parked.set(parking.dir, entry);
      continue;
    }
    found.push({
      severity: 'warning',
      client: warning.client,
      code: 'unreadable-config',
      summary: warning.file ? `${warning.file}: ${warning.message}` : warning.message,
      ...(warning.file ? { file: warning.file } : {}),
      remedy: 'Fix or remove the file — the client silently ignores what it cannot parse'
    });
  }

  for (const { client, dir, count } of parked.values()) {
    const plural = count === 1 ? 'entry' : 'entries';
    found.push({
      severity: 'info',
      client,
      code: 'disabled-dir-noise',
      summary: `${count} stale ${plural} under ${dir}; ${clientName(client)} does not scan its own disabled-skill directory, so none of this affects an active session`,
      file: dir,
      remedy: `Clean up ${dir} whenever convenient: remove the broken links, or restore what they point to`
    });
  }

  return found;
}

function clientName(client: Client): string {
  switch (client) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    default: {
      const exhaustive: never = client;
      throw new Error(`unknown client: ${String(exhaustive)}`);
    }
  }
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
    const counted = contributions.get(`${plugin.client}:${plugin.name}`) ?? 0;
    const total = counted + (plugin.otherContributions ?? 0);
    if (plugin.enabled && plugin.installed && total === 0) {
      found.push({
        severity: 'info',
        client: plugin.client,
        code: 'plugin-empty',
        summary: `${plugin.qualifiedName} is enabled but contributes nothing loadable`,
        ...(plugin.root ? { file: plugin.root } : {}),
        // `yard plugin disable` only works for Claude Code, which is the one
        // client that keeps plugin enablement in a settings file.
        remedy:
          plugin.client === 'claude'
            ? `yard plugin disable ${plugin.qualifiedName}`
            : `${plugin.client} plugin remove ${plugin.qualifiedName}`
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
    projectRoot: inventory.projectRoot,
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
 * to a file, since those cannot be verified without executing them, and for a
 * path that still has a variable `vars` cannot resolve.
 *
 * Tokenizing with {@link splitShellWords} before expanding is what handles
 * `"${CLAUDE_PLUGIN_ROOT}"/scripts/hello.sh`: a naive `match(/"[^"]*"|\S+/g)`
 * treats the quoted variable and the unquoted suffix as two separate tokens
 * and neither one is a real path on its own.
 */
function scriptPathFrom(command: string, vars: Record<string, string>): string | undefined {
  const trimmed = command.trim();
  // Anything with shell control flow is a script in its own right, not a path.
  if (/[;&|<>]|\$\(|\bif\b|\bfor\b|\bwhile\b/.test(trimmed)) {
    return undefined;
  }
  const tokens = splitShellWords(trimmed)
    .map((token) => expandVariables(token, vars))
    .filter((token) => !token.startsWith('-'));
  // `node ./hooks/x.mjs` — the path is the first token that looks like one.
  const script = tokens.find((token) => /[/\\]/.test(token) && /\.[a-z0-9]+$/i.test(token));
  if (!script || !isFullyExpanded(script)) {
    // A variable `vars` does not have makes the path unknowable from here.
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
