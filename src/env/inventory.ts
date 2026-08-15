import { scanClaude } from './claude.js';
import { scanCodex } from './codex.js';
import { scanCursor } from './cursor.js';
import { emptyInventory, type Client, type Inventory } from './types.js';

export type ScanOptions = {
  /** Restrict the scan. Defaults to every client installed on the machine. */
  clients?: Client[];
};

/**
 * Everything the developer's agent clients will actually load, in one list.
 *
 * Each client is scanned independently and its failures are contained: a
 * corrupt Cursor config must still leave the Claude Code inventory intact,
 * because a control plane that goes blank when one file is malformed is
 * useless exactly when it is needed.
 */
export async function scanEnvironment(projectRoot: string, options: ScanOptions = {}): Promise<Inventory> {
  const wanted = options.clients;
  const inventory = emptyInventory(projectRoot);

  const scans = [
    { client: 'claude' as const, run: scanClaude },
    { client: 'codex' as const, run: scanCodex },
    { client: 'cursor' as const, run: scanCursor }
  ].filter((entry) => !wanted || wanted.includes(entry.client));

  const results = await Promise.all(
    scans.map(async (entry) => {
      try {
        return { client: entry.client, result: await entry.run(projectRoot) };
      } catch (error) {
        return {
          client: entry.client,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  for (const outcome of results) {
    if ('error' in outcome && outcome.error !== undefined) {
      inventory.warnings.push({
        client: outcome.client,
        file: '',
        message: `scan failed: ${outcome.error}`
      });
      continue;
    }
    const result = 'result' in outcome ? outcome.result : undefined;
    if (!result?.installed) {
      continue;
    }
    inventory.clients.push(outcome.client);
    inventory.skills.push(...result.skills);
    inventory.plugins.push(...result.plugins);
    inventory.mcpServers.push(...result.mcpServers);
    inventory.hooks.push(...result.hooks);
    inventory.agents.push(...result.agents);
    inventory.commands.push(...result.commands);
    inventory.memory.push(...result.memory);
    inventory.warnings.push(...result.warnings);
  }

  sortInventory(inventory);
  return inventory;
}

function sortInventory(inventory: Inventory): void {
  const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);
  inventory.clients.sort();
  inventory.skills.sort(byId);
  inventory.plugins.sort(byId);
  inventory.mcpServers.sort(byId);
  inventory.hooks.sort(byId);
  inventory.agents.sort(byId);
  inventory.commands.sort(byId);
  inventory.memory.sort(byId);
}

/** Skill names claimed by more than one source, which is a real cause of surprise. */
export function duplicateSkills(inventory: Inventory): Array<{ name: string; ids: string[] }> {
  const byName = new Map<string, string[]>();
  for (const skill of inventory.skills) {
    if (skill.visibility === 'off') {
      continue;
    }
    const key = `${skill.client}:${skill.qualifiedName}`;
    byName.set(key, [...(byName.get(key) ?? []), skill.id]);
  }
  return [...byName.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, ids }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
