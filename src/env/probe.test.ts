import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { McpEntry } from './types.js';

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'yard-probe-'));
// probe.ts spawns processes rather than reading client config, but the fixture
// tree stands in for the home directory for anything it reaches through.
process.env.YARD_HOME = fixtureRoot;

const { probeMcpServer, probeAll } = await import('./probe.js');

const GOOD_SERVER = `
import { createInterface } from 'node:readline';

const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write('starting up, this is not json\\n');
    process.stderr.write('fixture: hello\\n');
    reply({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-server', version: '4.2.0' }
    } });
    reply({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'noise' } });
    return;
  }
  if (msg.method === 'tools/list') {
    reply({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'search_issues', description: 'Search the issue tracker for matching issues.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Full text query' } }, required: ['query'] } },
      { name: 'create_issue', description: 'Create an issue.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } } },
      { notName: 'malformed entry that must be skipped' }
    ] } });
  }
});
`;

const SILENT_SERVER = `
process.stdin.resume();
setInterval(() => {}, 1000);
`;

const CRASHING_SERVER = `
process.stderr.write('fixture: config file is missing\\n');
process.exit(3);
`;

async function fixture(name: string, source: string): Promise<string> {
  const file = path.join(fixtureRoot, name);
  await writeFile(file, source, 'utf8');
  return file;
}

function stdioEntry(name: string, command: string, args: string[]): McpEntry {
  return {
    id: `claude:user:${name}`,
    client: 'claude',
    scope: 'user',
    name,
    transport: 'stdio',
    command,
    args,
    file: path.join(fixtureRoot, '.claude.json'),
    enabled: true
  };
}

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('prices the tools a stdio server reports', async () => {
  const file = await fixture('good.mjs', GOOD_SERVER);
  const result = await probeMcpServer(stdioEntry('fixture', 'node', [file]), { timeoutMs: 8000 });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['search_issues', 'create_issue']
  );
  for (const tool of result.tools) {
    assert.ok(tool.tokens > 0, `${tool.name} should cost tokens`);
  }
  assert.equal(
    result.totalTokens,
    result.tools.reduce((sum, tool) => sum + tool.tokens, 0)
  );
  assert.ok(result.totalTokens > 0);
  // The tool with the larger schema must price higher, since ranking is the point.
  assert.ok((result.tools[0]?.tokens ?? 0) > (result.tools[1]?.tokens ?? 0));
  assert.deepEqual(result.serverInfo, { name: 'fixture-server', version: '4.2.0' });
  assert.ok(result.durationMs >= 0);
});

test('a command that does not exist fails without throwing', async () => {
  const result = await probeMcpServer(
    stdioEntry('missing', 'yard-no-such-command-9f3a', []),
    { timeoutMs: 5000 }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
  assert.deepEqual(result.tools, []);
  assert.equal(result.totalTokens, 0);
});

test('a stdio entry with no command is reported, not probed', async () => {
  const entry: McpEntry = {
    id: 'claude:user:nocmd',
    client: 'claude',
    scope: 'user',
    name: 'nocmd',
    transport: 'stdio',
    file: path.join(fixtureRoot, '.claude.json'),
    enabled: true
  };
  const result = await probeMcpServer(entry);

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no command/);
});

test('a server that exits early surfaces its stderr', async () => {
  const file = await fixture('crash.mjs', CRASHING_SERVER);
  const result = await probeMcpServer(stdioEntry('crasher', 'node', [file]), { timeoutMs: 5000 });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /config file is missing/);
  assert.equal(result.tools.length, 0);
});

test('a server that never answers times out and is killed', async () => {
  const file = await fixture('silent.mjs', SILENT_SERVER);
  const started = Date.now();
  const result = await probeMcpServer(stdioEntry('silent', 'node', [file]), { timeoutMs: 400 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out after 400ms/);
  assert.ok(elapsed < 5000, `probe should return promptly, took ${elapsed}ms`);
  assert.equal(result.totalTokens, 0);
});

test('remote transports are declared unmeasured rather than guessed', async () => {
  for (const transport of ['http', 'sse', 'ws'] as const) {
    const entry: McpEntry = {
      id: `cursor:user:remote-${transport}`,
      client: 'cursor',
      scope: 'user',
      name: `remote-${transport}`,
      transport,
      url: 'https://example.invalid/mcp',
      file: path.join(fixtureRoot, '.cursor', 'mcp.json'),
      enabled: true
    };
    const result = await probeMcpServer(entry);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'remote transports are not probed');
    assert.deepEqual(result.tools, []);
  }
});

test('probeAll keeps input order and never rejects on a bad entry', async () => {
  const good = await fixture('good.mjs', GOOD_SERVER);
  const entries: McpEntry[] = [
    stdioEntry('one', 'node', [good]),
    stdioEntry('broken', 'yard-no-such-command-9f3a', []),
    stdioEntry('two', 'node', [good]),
    stdioEntry('three', 'node', [good])
  ];

  const results = await probeAll(entries, { timeoutMs: 8000, concurrency: 2 });

  assert.equal(results.length, entries.length);
  assert.deepEqual(
    results.map((result) => result.server),
    ['one', 'broken', 'two', 'three']
  );
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, false, true, true]
  );
  assert.ok((results[0]?.totalTokens ?? 0) > 0);
});

test('probeAll on an empty list returns an empty list', async () => {
  assert.deepEqual(await probeAll([]), []);
});
