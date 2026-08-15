import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { biggestLevers, buildContextReport, topOffenders } from './context.js';
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

/**
 * A skill shipped by a plugin. Claude Code names these `<plugin>:<name>`, which
 * makes the id `claude:plugin:<plugin>:<name>` — the shape `biggestLevers` reads
 * the owning plugin back out of.
 */
function pluginSkill(plugin: string, name: string, description: string): SkillEntry {
  const qualifiedName = `${plugin}:${name}`;
  return {
    id: `claude:plugin:${qualifiedName}`,
    client: 'claude',
    scope: 'plugin',
    name,
    qualifiedName,
    description,
    file: `${PROJECT}/.claude/plugins/cache/market/${plugin}/skills/${name}/SKILL.md`,
    dir: `${PROJECT}/.claude/plugins/cache/market/${plugin}/skills/${name}`,
    plugin,
    visibility: 'on',
    frontmatter: { name, description },
    bytes: Buffer.byteLength(description, 'utf8')
  };
}

function mcp(
  name: string,
  enabled: boolean,
  opts: { client?: Client; scope?: Scope; plugin?: string } = {}
): McpEntry {
  const client = opts.client ?? 'claude';
  const scope = opts.scope ?? 'user';
  const qualified = opts.plugin ? `${opts.plugin}:${name}` : name;
  return {
    id: `${client}:${scope}:${qualified}`,
    client,
    scope,
    name,
    transport: 'stdio',
    command: 'node',
    args: [`${name}.js`],
    file: `${PROJECT}/.mcp.json`,
    ...(opts.plugin ? { plugin: opts.plugin } : {}),
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

test('a plugin remedy names the lever the client actually has', async () => {
  // `yard plugin disable` writes Claude Code's settings, and actions refuses it
  // for the other two clients — so printing it for them would be printing a
  // command that fails.
  const claudeSkill = pluginSkill('toolkit', 'alpha', DESCRIPTION);
  const cursorSkill: SkillEntry = {
    ...claudeSkill,
    id: 'cursor:plugin:toolkit:beta',
    client: 'cursor',
    name: 'beta',
    qualifiedName: 'toolkit:beta'
  };

  const report = await buildContextReport(inventoryWith({ skills: [claudeSkill, cursorSkill] }));
  assert.equal(
    report.lines.find((line) => line.client === 'claude')?.remedy,
    'yard plugin disable toolkit'
  );
  assert.equal(
    report.lines.find((line) => line.client === 'cursor')?.remedy,
    'cursor plugin remove toolkit'
  );
});

test('a skill\'s remedyActionable follows skillActionBlocked, not just whether a remedy string exists', async () => {
  const claudeSkill = skill({ name: 'review', description: DESCRIPTION, visibility: 'on' });
  const claudePluginSkill = pluginSkill('toolkit', 'alpha', DESCRIPTION);
  const cursorPluginSkill: SkillEntry = {
    ...claudePluginSkill,
    id: 'cursor:plugin:toolkit:beta',
    client: 'cursor',
    name: 'beta',
    qualifiedName: 'toolkit:beta'
  };

  const report = await buildContextReport(
    inventoryWith({ skills: [claudeSkill, claudePluginSkill, cursorPluginSkill] })
  );
  const line = (id: string) => report.lines.find((entry) => entry.id === id);

  const standalone = line('claude:user:review');
  assert.equal(standalone?.remedy, 'yard skill review user-invocable-only');
  assert.equal(standalone?.remedyActionable, true);

  // Both plugin skills print the plugin's own lever as their remedy, but
  // neither is clickable: `setSkillVisibility`/`setSkillEnabled` refuse a
  // plugin skill in every client, matching `skillActionBlocked`.
  const claudePlugin = line('claude:plugin:toolkit:alpha');
  assert.equal(claudePlugin?.remedy, 'yard plugin disable toolkit');
  assert.equal(claudePlugin?.remedyActionable, undefined);

  const cursorPlugin = line('cursor:plugin:toolkit:beta');
  assert.equal(cursorPlugin?.remedy, 'cursor plugin remove toolkit');
  assert.equal(cursorPlugin?.remedyActionable, undefined);
});

test('an MCP server\'s remedyActionable follows the same client/origin matrix as the action layer', async () => {
  const claudeUser = mcp('github', true);
  const claudePlugin = mcp('yard', true, { scope: 'plugin', plugin: 'yard-tools' });
  const cursorUser = mcp('shadcn', true, { client: 'cursor' });
  const cursorPlugin = mcp('shadcn', true, { client: 'cursor', scope: 'plugin', plugin: 'shadcn-ui' });
  const codexUser = mcp('data', true, { client: 'codex' });
  const codexPlugin = mcp('data', true, { client: 'codex', scope: 'plugin', plugin: 'data-analytics' });

  const report = await buildContextReport(
    inventoryWith({
      clients: ['claude', 'cursor', 'codex'],
      mcpServers: [claudeUser, claudePlugin, cursorUser, cursorPlugin, codexUser, codexPlugin]
    })
  );
  const line = (id: string) => report.lines.find((entry) => entry.id === id);

  assert.equal(line(claudeUser.id)?.remedy, 'yard mcp disable github');
  assert.equal(line(claudeUser.id)?.remedyActionable, true);

  // Claude Code can switch a plugin's own MCP server off independently of
  // the plugin, through ~/.claude.json's disabledMcpServers.
  assert.equal(line(claudePlugin.id)?.remedy, 'yard mcp disable yard');
  assert.equal(line(claudePlugin.id)?.remedyActionable, true);

  assert.equal(line(cursorUser.id)?.remedy, 'yard mcp disable shadcn');
  assert.equal(line(cursorUser.id)?.remedyActionable, true);

  // Cursor has no lever for a plugin's own server; the remedy names the
  // plugin instead, and is never offered as a button.
  assert.equal(line(cursorPlugin.id)?.remedy, 'cursor plugin remove shadcn-ui');
  assert.equal(line(cursorPlugin.id)?.remedyActionable, undefined);

  // Codex owns config.toml outright regardless of origin, so printing a
  // remedy that only refuses is worse than printing nothing.
  assert.equal(line(codexUser.id)?.remedy, undefined);
  assert.equal(line(codexPlugin.id)?.remedy, undefined);
});

test('biggestLevers rolls a plugin’s skills up under the plugin', async () => {
  // One fat standalone skill against three lean ones from a plugin. Line by
  // line the standalone skill wins; rolled up, the plugin is the real lever.
  const long = `${DESCRIPTION} ${DESCRIPTION} ${DESCRIPTION}`;
  const report = await buildContextReport(
    inventoryWith({
      skills: [
        skill({ name: 'audit', description: long, visibility: 'on' }),
        pluginSkill('toolkit', 'alpha', DESCRIPTION),
        pluginSkill('toolkit', 'beta', DESCRIPTION),
        pluginSkill('toolkit', 'gamma', DESCRIPTION)
      ]
    })
  );

  const auditLine = report.lines.find((line) => line.id === 'claude:user:audit');
  const pluginLines = report.lines.filter((line) => line.id.startsWith('claude:plugin:toolkit:'));
  assert.equal(pluginLines.length, 3, 'the rollup must not change the underlying lines');
  for (const line of pluginLines) {
    assert.ok(
      line.tokens < (auditLine?.tokens ?? 0),
      `${line.id} must be cheaper than the standalone skill for this test to mean anything`
    );
  }

  const levers = biggestLevers(report);
  assert.deepEqual(
    levers.map((lever) => lever.label),
    ['toolkit', 'audit']
  );

  const toolkit = levers[0];
  assert.equal(toolkit?.count, 3);
  assert.equal(toolkit?.kind, 'skill');
  assert.equal(toolkit?.client, 'claude');
  assert.equal(
    toolkit?.tokens,
    pluginLines.reduce((total, line) => total + line.tokens, 0)
  );
  // The lever is the plugin, because a plugin skill cannot be switched off alone.
  assert.equal(toolkit?.remedy, 'yard plugin disable toolkit');
  assert.ok((toolkit?.tokens ?? 0) > (auditLine?.tokens ?? 0));

  // The standalone skill stays its own lever, at its own remedy.
  assert.equal(levers[1]?.count, 1);
  assert.equal(levers[1]?.remedy, 'yard skill audit user-invocable-only');
});

test('biggestLevers preserves the total, sorts by cost, and honours the limit', async () => {
  const report = await buildContextReport(mixedInventory());
  const levers = biggestLevers(report, 100);

  // Nothing is double-counted and nothing is dropped: every line lands in
  // exactly one lever.
  assert.equal(
    levers.reduce((total, lever) => total + lever.tokens, 0),
    report.total
  );
  assert.equal(
    levers.reduce((total, lever) => total + lever.count, 0),
    report.lines.length
  );

  for (let index = 1; index < levers.length; index += 1) {
    assert.ok(
      (levers[index - 1]?.tokens ?? 0) >= (levers[index]?.tokens ?? 0),
      `${levers[index - 1]?.label} must not sit below ${levers[index]?.label}`
    );
  }

  assert.ok(levers.length > 2, 'the fixture must produce more levers than the limit under test');
  assert.equal(biggestLevers(report, 2).length, 2);
  assert.deepEqual(
    biggestLevers(report, 2).map((lever) => lever.label),
    levers.slice(0, 2).map((lever) => lever.label)
  );
});

/**
 * A real probe, against a fixture server started for the test.
 *
 * Everything above prices MCP from config alone, and that gap let a defect
 * ship: probe results were correlated by server name while the ledger looked
 * them up by entry id, so every probe silently came back "failed" and `--probe`
 * reported the same flat estimate as not probing at all.
 */
const FIXTURE_SERVER = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\\n');
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n');
    }
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'search', description: 'Search the corpus.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'fetch', description: 'Fetch one document by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }
      ] } }) + '\\n');
    }
  }
});
`;

test('probing prices a server from its real tool list, not the flat estimate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-context-probe-'));
  try {
    const server = path.join(dir, 'server.mjs');
    await writeFile(server, FIXTURE_SERVER, 'utf8');

    const entry: McpEntry = {
      id: 'claude:project:fixture',
      client: 'claude',
      scope: 'project',
      name: 'fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [server],
      file: path.join(dir, '.mcp.json'),
      enabled: true
    };
    const inventory = inventoryWith({ mcpServers: [entry] });

    const probed = await buildContextReport(inventory, { probe: true, probeTimeoutMs: 15_000 });
    const line = probed.lines.find((item) => item.id === entry.id);
    assert.equal(line?.measured, true, 'a server that answered must not be reported as an estimate');
    assert.equal(line?.detail, '2 tools');
    assert.ok((line?.tokens ?? 0) > 0);
    assert.equal(probed.probed, true);
    assert.deepEqual(probed.notes, []);

    // The measured cost must actually come from the tools, not the fallback.
    const estimated = await buildContextReport(inventory, {});
    const estimatedLine = estimated.lines.find((item) => item.id === entry.id);
    assert.equal(estimatedLine?.measured, false);
    assert.notEqual(line?.tokens, estimatedLine?.tokens);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a server that cannot start is reported unmeasured rather than free', async () => {
  const entry: McpEntry = {
    id: 'claude:project:broken',
    client: 'claude',
    scope: 'project',
    name: 'broken',
    transport: 'stdio',
    command: 'this-command-does-not-exist-anywhere',
    args: [],
    file: '/repo/.mcp.json',
    enabled: true
  };
  const report = await buildContextReport(inventoryWith({ mcpServers: [entry] }), {
    probe: true,
    probeTimeoutMs: 10_000
  });
  const line = report.lines.find((item) => item.id === entry.id);
  assert.equal(line?.measured, false);
  assert.ok((line?.tokens ?? 0) > 0, 'an unmeasurable server is not free');
  assert.ok(line?.detail && line.detail !== '0 tools');
});
