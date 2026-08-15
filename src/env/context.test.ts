import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextReport, topOffenders } from './context.js';
import { estimateTokens } from './tokens.js';
import { emptyInventory } from './types.js';
import type {
  AgentEntry,
  Client,
  Inventory,
  McpEntry,
  MemoryEntry,
  Scope,
  SkillEntry,
  SkillVisibility
} from './types.js';

/**
 * The ledger prices an inventory, so these build inventories directly rather
 * than scanning a fixture tree. Nothing here probes: every MCP server is priced
 * from config alone.
 */
const PROJECT = '/repo';

function inventoryWith(parts: Partial<Inventory>): Inventory {
  return Object.assign(emptyInventory(PROJECT), { clients: ['claude'] as Client[] }, parts);
}

function skill(spec: {
  name: string;
  description: string;
  visibility: SkillVisibility;
  client?: Client;
  scope?: Scope;
}): SkillEntry {
  const client = spec.client ?? 'claude';
  const scope = spec.scope ?? 'user';
  return {
    id: `${client}:${scope}:${spec.name}`,
    client,
    scope,
    name: spec.name,
    qualifiedName: spec.name,
    description: spec.description,
    file: `${PROJECT}/skills/${spec.name}/SKILL.md`,
    dir: `${PROJECT}/skills/${spec.name}`,
    visibility: spec.visibility,
    frontmatter: { name: spec.name, description: spec.description },
    bytes: Buffer.byteLength(spec.description, 'utf8')
  };
}

function mcp(name: string, enabled: boolean): McpEntry {
  return {
    id: `claude:user:${name}`,
    client: 'claude',
    scope: 'user',
    name,
    transport: 'stdio',
    command: 'node',
    args: [`${name}.js`],
    file: `${PROJECT}/.mcp.json`,
    enabled
  };
}

function agent(name: string, description: string): AgentEntry {
  return {
    id: `claude:user:${name}`,
    client: 'claude',
    scope: 'user',
    name,
    description,
    file: `${PROJECT}/.claude/agents/${name}.md`,
    bytes: Buffer.byteLength(description, 'utf8')
  };
}

function memory(name: string, bytes: number): MemoryEntry {
  return {
    id: `claude:project:${name}`,
    client: 'claude',
    scope: 'project',
    name,
    file: `${PROJECT}/${name}`,
    bytes
  };
}

const DESCRIPTION = 'Use when reviewing a pull request for correctness and missing tests.';

/** Skills at every visibility, an unprobed server, and a fat memory file. */
function mixedInventory(): Inventory {
  return inventoryWith({
    clients: ['claude', 'cursor'],
    skills: [
      skill({ name: 'review', description: DESCRIPTION, visibility: 'on' }),
      skill({ name: 'quiet', description: DESCRIPTION, visibility: 'name-only' }),
      skill({ name: 'manual', description: DESCRIPTION, visibility: 'user-invocable-only' }),
      skill({ name: 'retired', description: DESCRIPTION, visibility: 'off' }),
      skill({ name: 'rules', description: DESCRIPTION, visibility: 'on', client: 'cursor' })
    ],
    mcpServers: [mcp('github', true), mcp('parked', false)],
    agents: [agent('reviewer', 'Reviews diffs and reports risk')],
    commands: [agent('ship', 'Cuts a release')],
    memory: [memory('CLAUDE.md', 20_500)]
  });
}

test('a skill costs its name and description, and hidden skills cost nothing', async () => {
  const report = await buildContextReport(
    inventoryWith({
      skills: [
        skill({ name: 'review', description: DESCRIPTION, visibility: 'on' }),
        skill({ name: 'quiet', description: DESCRIPTION, visibility: 'name-only' }),
        skill({ name: 'manual', description: DESCRIPTION, visibility: 'user-invocable-only' }),
        skill({ name: 'retired', description: DESCRIPTION, visibility: 'off' })
      ]
    })
  );

  const lines = new Map(report.lines.map((line) => [line.id, line]));
  assert.deepEqual([...lines.keys()].sort(), ['claude:user:quiet', 'claude:user:review']);

  const on = lines.get('claude:user:review');
  assert.equal(on?.kind, 'skill');
  assert.equal(on?.label, 'review');
  assert.equal(on?.measured, true);
  assert.equal(on?.detail, undefined);
  assert.equal(on?.tokens, estimateTokens(`review: ${DESCRIPTION}`));
  assert.equal(on?.remedy, 'yard skill review user-invocable-only');

  const nameOnly = lines.get('claude:user:quiet');
  assert.equal(nameOnly?.tokens, estimateTokens('quiet: '));
  assert.ok((nameOnly?.tokens ?? 0) > 0);
  assert.ok((nameOnly?.tokens ?? 0) < (on?.tokens ?? 0));

  assert.equal(report.byKind.skill, (on?.tokens ?? 0) + (nameOnly?.tokens ?? 0));
  assert.equal(report.total, report.byKind.skill);
});

test('a description past maxDescChars is billed truncated and the line says so', async () => {
  const long = 'trigger on a long tail of prose '.repeat(20);
  const report = await buildContextReport(
    inventoryWith({
      skills: [
        skill({ name: 'long', description: long, visibility: 'on' }),
        skill({ name: 'short', description: 'Use when shipping.', visibility: 'on' })
      ]
    }),
    { maxDescChars: 100 }
  );

  const lines = new Map(report.lines.map((line) => [line.id, line]));
  const truncated = lines.get('claude:user:long');
  assert.equal(truncated?.detail, 'description truncated at 100 chars');
  assert.equal(truncated?.tokens, estimateTokens(`long: ${long.slice(0, 100)}`));
  assert.ok((truncated?.tokens ?? 0) < estimateTokens(`long: ${long}`));

  // A description inside the budget is billed whole and says nothing.
  assert.equal(lines.get('claude:user:short')?.detail, undefined);
  assert.equal(lines.get('claude:user:short')?.tokens, estimateTokens('short: Use when shipping.'));
});

test('unprobed MCP servers are marked unmeasured and the report says why', async () => {
  const report = await buildContextReport(
    inventoryWith({ mcpServers: [mcp('github', true), mcp('parked', false)] })
  );

  assert.equal(report.probed, false);
  const mcpLines = report.lines.filter((line) => line.kind === 'mcp');
  // A disabled server is never loaded, so it costs nothing.
  assert.equal(mcpLines.length, 1);

  const line = mcpLines[0];
  assert.equal(line?.label, 'github');
  assert.equal(line?.measured, false);
  assert.equal(line?.detail, 'not probed — run with --probe for the real cost');
  assert.equal(line?.remedy, 'yard mcp disable github');
  assert.ok((line?.tokens ?? 0) > 0);

  assert.ok(
    report.notes.some((note) => note.includes('1 MCP server(s)') && note.includes('estimated, not measured'))
  );
});

test('totals equal the sum of the lines, by kind and by client', async () => {
  const report = await buildContextReport(mixedInventory());

  const sum = report.lines.reduce((total, line) => total + line.tokens, 0);
  assert.ok(sum > 0);
  assert.equal(report.total, sum);

  const kinds = ['skill', 'mcp', 'agent', 'command', 'memory'] as const;
  for (const kind of kinds) {
    assert.equal(
      report.byKind[kind],
      report.lines.filter((line) => line.kind === kind).reduce((total, line) => total + line.tokens, 0),
      `byKind.${kind}`
    );
  }
  assert.equal(
    kinds.reduce((total, kind) => total + report.byKind[kind], 0),
    report.total
  );
  assert.equal(
    Object.values(report.byClient).reduce((total, value) => total + (value ?? 0), 0),
    report.total
  );
  assert.deepEqual(Object.keys(report.byClient).sort(), ['claude', 'cursor']);
});

test('lines are sorted most expensive first', async () => {
  const report = await buildContextReport(mixedInventory());

  for (let index = 1; index < report.lines.length; index += 1) {
    const previous = report.lines[index - 1];
    const current = report.lines[index];
    assert.ok(
      (previous?.tokens ?? 0) >= (current?.tokens ?? 0),
      `${previous?.id} (${previous?.tokens}) must not sit below ${current?.id} (${current?.tokens})`
    );
  }

  // The 20,500-byte memory file dwarfs everything else, so it leads.
  assert.equal(report.lines[0]?.kind, 'memory');
  assert.equal(report.lines[0]?.tokens, 5000);
  assert.equal(report.lines[0]?.measured, false);
  assert.equal(report.lines[0]?.detail, '20500 bytes, loaded in full');
});

test('topOffenders returns only the lines that carry a remedy', async () => {
  const report = await buildContextReport(mixedInventory());
  const offenders = topOffenders(report);

  assert.ok(offenders.length > 0);
  assert.ok(offenders.every((line) => Boolean(line.remedy)));
  assert.ok(offenders.length < report.lines.length);
  assert.deepEqual(
    offenders.map((line) => line.id),
    report.lines.filter((line) => line.remedy).map((line) => line.id)
  );

  // The most expensive line in the report is a memory file, which cannot be
  // switched off, so it must not lead the list of things to act on.
  assert.equal(report.lines[0]?.kind, 'memory');
  assert.ok(!offenders.some((line) => line.kind === 'memory'));
  assert.ok(!offenders.some((line) => line.kind === 'agent' || line.kind === 'command'));
  // Cursor skills have no yard command behind them yet, so they are not offered.
  assert.ok(!offenders.some((line) => line.client === 'cursor'));

  assert.equal(offenders[0]?.kind, 'mcp');
  assert.equal(topOffenders(report, 1).length, 1);
});
