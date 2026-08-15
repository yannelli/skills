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

/**
 * Fixture servers are written as plain JS, never as template literals, so that
 * `${...}` inside them means what it says instead of interpolating here.
 */
function server(body: string): string {
  return [
    "import { createInterface } from 'node:readline';",
    'const NL = String.fromCharCode(10);',
    'const send = (v) => process.stdout.write(JSON.stringify(v) + NL);',
    'const rl = createInterface({ input: process.stdin });',
    'rl.on("line", (line) => {',
    '  if (!line.trim()) return;',
    '  let msg;',
    '  try { msg = JSON.parse(line); } catch { return; }',
    body,
    '});'
  ].join('\n');
}

const GOOD_SERVER = server(`
  if (msg.method === 'initialize') {
    process.stdout.write('starting up, this is not json' + NL);
    process.stderr.write('fixture: hello' + NL);
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-server', version: '4.2.0' }
    } });
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'noise' } });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'search_issues', description: 'Search the issue tracker for matching issues.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Full text query' } }, required: ['query'] } },
      { name: 'create_issue', description: 'Create an issue.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } } },
      { notName: 'malformed entry that must be skipped' }
    ] } });
  }
`);

const SILENT_SERVER = `
process.stdin.resume();
setInterval(() => {}, 1000);
`;

const CRASHING_SERVER = `
process.stderr.write('fixture: config file is missing' + String.fromCharCode(10));
process.exit(3);
`;

/** Replies without a trailing newline, then exits. The answer still counts. */
const UNTERMINATED_SERVER = server(`
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'unterminated', version: '1' } } }); return; }
  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'last_word', description: 'Answered without a trailing newline.' }
    ] } }));
    process.exit(0);
  }
`);

/** Echoes the request id back as a string, which JSON-RPC implementations do. */
const STRING_ID_SERVER = server(`
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: String(msg.id), result: { serverInfo: { name: 'stringy', version: '2' } } }); return; }
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: String(msg.id), result: { tools: [{ name: 'echo', description: 'Echo.' }] } }); }
`);

/** Splits one reply across many writes and packs several lines into another. */
const CHUNKED_SERVER = server(`
  if (msg.method === 'initialize') {
    const text = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'chunky', version: '3' } } }) + NL;
    for (const ch of text) process.stdout.write(ch);
    return;
  }
  if (msg.method === 'tools/list') {
    const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'chunked', description: 'Reassembled from pieces.' }] } });
    process.stdout.write('banner line' + NL + '{ not json at all' + NL + reply + String.fromCharCode(13) + NL + 'trailing noise' + NL);
  }
`);

const INIT_ERROR_SERVER = server(`
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'unsupported protocol version' } }); }
`);

const LIST_ERROR_SERVER = server(`
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'grumpy', version: '9' } } }); return; }
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'tools are not enabled' } }); }
`);

/** Answers everything, then exits in the same tick. The answer must survive. */
const FAST_EXIT_SERVER = server(`
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'brief', version: '1' } } }); return; }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'quick', description: 'Gone already.' }] } });
    process.exit(0);
  }
`);

/** A well-formed reply whose tools field is not a list. */
const NO_TOOLS_SERVER = server(`
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'empty', version: '1' } } }); return; }
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: 'not a list' } }); }
`);

/** Reports the environment and working directory it was actually started with. */
const ENV_SERVER = server(`
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'env', version: '1' } } }); return; }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'mark', description: String(process.env.YARD_PROBE_MARK) },
      { name: 'ambient', description: String(process.env.YARD_PROBE_AMBIENT) },
      { name: 'cwd', description: process.cwd() }
    ] } });
  }
`);

/**
 * The `npx` shape: a launcher that forks the real server and ignores SIGTERM.
 * Signalling only the launcher would strand the fork.
 */
const WRAPPER_SERVER = `
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
process.stderr.write('canary ' + child.pid + String.fromCharCode(10));
process.stdin.resume();
setInterval(() => {}, 1000);
`;

/** Floods stdout with a single unterminated line, forever, honouring backpressure. */
const BABBLING_SERVER = `
process.stdin.resume();
const blob = 'x'.repeat(1024 * 1024);
const pump = () => { while (process.stdout.write(blob)) {} };
process.stdout.on('drain', pump);
process.stdout.on('error', () => {});
pump();
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`pid ${pid} was still running ${ms}ms after the probe returned`);
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
  assert.equal(result.tools[0]?.description, 'Search the issue tracker for matching issues.');
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

test('the schema is part of the price, not just the name', async () => {
  const file = await fixture('good.mjs', GOOD_SERVER);
  const result = await probeMcpServer(stdioEntry('fixture', 'node', [file]), { timeoutMs: 8000 });
  const bare = await import('./tokens.js');

  const [first] = result.tools;
  assert.ok(first);
  // A stub that priced only the name and description would land on this number.
  const withoutSchema = bare.estimateJsonTokens({
    name: first.name,
    description: first.description
  });
  assert.ok(
    first.tokens > withoutSchema,
    `expected the input schema to be charged: ${first.tokens} vs ${withoutSchema}`
  );
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

test('a directory where a command should be fails without throwing', async () => {
  const result = await probeMcpServer(stdioEntry('dir', fixtureRoot, []), { timeoutMs: 5000 });

  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
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

test('a launcher that forks the real server leaves no orphan behind', async () => {
  const file = await fixture('wrapper.mjs', WRAPPER_SERVER);
  const started = Date.now();
  const result = await probeMcpServer(stdioEntry('wrapper', 'node', [file]), { timeoutMs: 300 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out after 300ms/);
  // It ignores SIGTERM and its fork holds the stdout pipe open, so 'close' never
  // arrives. Teardown must still be bounded rather than hanging the scan.
  assert.ok(elapsed < 15_000, `probe must not hang on teardown, took ${elapsed}ms`);

  const pid = Number(/canary (\d+)/.exec(result.error ?? '')?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, `expected a canary pid in ${result.error}`);
  await waitForExit(pid);
});

test('a reply without a trailing newline is still an answer', async () => {
  const file = await fixture('unterminated.mjs', UNTERMINATED_SERVER);
  const result = await probeMcpServer(stdioEntry('unterminated', 'node', [file]), { timeoutMs: 5000 });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['last_word']
  );
  assert.ok(result.totalTokens > 0);
});

test('a server that echoes the request id as a string is understood', async () => {
  const file = await fixture('stringid.mjs', STRING_ID_SERVER);
  const started = Date.now();
  const result = await probeMcpServer(stdioEntry('stringy', 'node', [file]), { timeoutMs: 5000 });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['echo']
  );
  assert.deepEqual(result.serverInfo, { name: 'stringy', version: '2' });
  // Failing to correlate would burn the whole timeout instead.
  assert.ok(Date.now() - started < 4000);
});

test('replies are framed by newline regardless of how they are written', async () => {
  const file = await fixture('chunked.mjs', CHUNKED_SERVER);
  const result = await probeMcpServer(stdioEntry('chunky', 'node', [file]), { timeoutMs: 5000 });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['chunked']
  );
  assert.deepEqual(result.serverInfo, { name: 'chunky', version: '3' });
});

test('a server that answers and exits at once is not reported as dead', async () => {
  const file = await fixture('fast.mjs', FAST_EXIT_SERVER);
  const result = await probeMcpServer(stdioEntry('brief', 'node', [file]), { timeoutMs: 5000 });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['quick']
  );
});

test('an initialize error is reported as an initialize error', async () => {
  const file = await fixture('initerr.mjs', INIT_ERROR_SERVER);
  const result = await probeMcpServer(stdioEntry('initerr', 'node', [file]), { timeoutMs: 5000 });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /initialize failed/);
  assert.match(result.error ?? '', /unsupported protocol version/);
  assert.match(result.error ?? '', /-32603/);
  assert.deepEqual(result.tools, []);
});

test('a tools/list error keeps the server identity it already learned', async () => {
  const file = await fixture('listerr.mjs', LIST_ERROR_SERVER);
  const result = await probeMcpServer(stdioEntry('grumpy', 'node', [file]), { timeoutMs: 5000 });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /tools\/list failed/);
  assert.match(result.error ?? '', /tools are not enabled/);
  assert.deepEqual(result.serverInfo, { name: 'grumpy', version: '9' });
  assert.equal(result.totalTokens, 0);
});

test('a server with no usable tool list costs nothing but still succeeds', async () => {
  const file = await fixture('notools.mjs', NO_TOOLS_SERVER);
  const result = await probeMcpServer(stdioEntry('empty', 'node', [file]), { timeoutMs: 5000 });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.tools, []);
  assert.equal(result.totalTokens, 0);
  assert.equal(result.error, undefined);
});

test('the server is started with the environment and directory it was declared with', async () => {
  const file = await fixture('env.mjs', ENV_SERVER);
  process.env.YARD_PROBE_AMBIENT = 'from-ambient';
  const entry: McpEntry = {
    ...stdioEntry('env', 'node', [file]),
    env: { YARD_PROBE_MARK: 'from-entry' },
    cwd: fixtureRoot
  };

  const declared = await probeMcpServer(entry, { timeoutMs: 5000 });
  assert.equal(declared.ok, true, declared.error);
  const byName = new Map(declared.tools.map((tool) => [tool.name, tool.description]));
  assert.equal(byName.get('mark'), 'from-entry');
  // The ambient environment still reaches the server; entry.env adds to it.
  assert.equal(byName.get('ambient'), 'from-ambient');
  assert.equal(byName.get('cwd'), fixtureRoot);

  // An explicit override from the caller beats the declared value.
  const overridden = await probeMcpServer(entry, {
    timeoutMs: 5000,
    env: { YARD_PROBE_MARK: 'from-opts' }
  });
  assert.equal(overridden.ok, true, overridden.error);
  assert.equal(
    overridden.tools.find((tool) => tool.name === 'mark')?.description,
    'from-opts'
  );
  delete process.env.YARD_PROBE_AMBIENT;
});

test('a server that floods stdout is bounded, not followed into the heap', async () => {
  const file = await fixture('babble.mjs', BABBLING_SERVER);
  const started = Date.now();
  const result = await probeMcpServer(stdioEntry('babbler', 'node', [file]), { timeoutMs: 2500 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out/);
  // The note is the observable proof that the partial line was dropped instead
  // of accumulated: it is only set once the buffer passes the cap.
  assert.match(result.error ?? '', /oversized stdout/);
  assert.ok(elapsed < 20_000, `probe must stay bounded under a flood, took ${elapsed}ms`);
});

test('an absurd timeout falls back to the default rather than firing at once', async () => {
  const file = await fixture('good.mjs', GOOD_SERVER);
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = await probeMcpServer(stdioEntry('fixture', 'node', [file]), { timeoutMs });
    assert.equal(result.ok, true, `timeoutMs ${timeoutMs}: ${result.error}`);
    assert.equal(result.tools.length, 2);
  }
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

test('probeAll fills every slot whatever concurrency it is handed', async () => {
  const good = await fixture('good.mjs', GOOD_SERVER);
  const entries: McpEntry[] = [
    stdioEntry('a', 'node', [good]),
    stdioEntry('b', 'node', [good]),
    stdioEntry('c', 'node', [good])
  ];

  for (const concurrency of [Number.NaN, 0, -3, 1.5, Number.POSITIVE_INFINITY, 100]) {
    const results = await probeAll(entries, { timeoutMs: 8000, concurrency });
    assert.equal(results.length, 3, `concurrency ${concurrency}`);
    for (const [index, result] of results.entries()) {
      assert.ok(result, `concurrency ${concurrency}: slot ${index} was never filled`);
      assert.equal(result.ok, true, `concurrency ${concurrency}: ${result.error}`);
      assert.ok(result.totalTokens > 0);
    }
  }
});

test('probeAll reports a hole in its input without abandoning what follows', async () => {
  const good = await fixture('good.mjs', GOOD_SERVER);
  const entries = [
    stdioEntry('first', 'node', [good]),
    undefined as unknown as McpEntry,
    stdioEntry('last', 'node', [good])
  ];

  const results = await probeAll(entries, { timeoutMs: 8000, concurrency: 1 });

  assert.equal(results.length, 3);
  assert.equal(results[0]?.ok, true, results[0]?.error);
  assert.equal(results[1]?.ok, false);
  // The entry after the hole must still be probed, not silently dropped.
  assert.equal(results[2]?.ok, true, results[2]?.error);
  assert.ok((results[2]?.totalTokens ?? 0) > 0);
});

test('probeAll on an empty list returns an empty list', async () => {
  assert.deepEqual(await probeAll([]), []);
});

test('no fixture server survives the suite', async () => {
  // A probe that leaked a child would show up here as a live `node <fixture>`.
  const { execFile } = await import('node:child_process');
  const listed = await new Promise<string>((resolve) => {
    execFile('ps', ['-eo', 'args'], (error, stdout) => resolve(error ? '' : stdout));
  });
  const leaked = listed
    .split('\n')
    .filter((line) => line.includes(fixtureRoot) && !line.includes('ps -eo'));
  assert.deepEqual(leaked, [], `leaked fixture processes:\n${leaked.join('\n')}`);
});
