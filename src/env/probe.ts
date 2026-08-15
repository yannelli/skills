import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { estimateJsonTokens } from './tokens.js';
import type { McpEntry } from './types.js';

/**
 * What an MCP server actually costs.
 *
 * A server's tool definitions are re-sent to the model on every turn, so their
 * schemas are a standing charge against the context window. The only way to
 * know the real number is to start the server and ask it, which is what this
 * does: three newline-delimited JSON-RPC messages over stdio, then price the
 * tool list.
 */

export type ProbeResult = {
  server: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  tools: Array<{ name: string; description: string; tokens: number }>;
  totalTokens: number;
  serverInfo?: { name: string; version: string };
};

export type ProbeOptions = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 4;

/** How long a server gets to exit on SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 2_000;
const PROTOCOL_VERSION = '2025-06-18';
const INITIALIZE_ID = 1;
const TOOLS_LIST_ID = 2;
const STDERR_LIMIT = 4_000;
/**
 * A tools/list response is a single line and can legitimately be large, so this
 * is generous — it exists only to stop a server that streams unparsable output
 * forever from exhausting memory before the timeout fires.
 */
const STDOUT_LIMIT = 16 * 1024 * 1024;
/** Kill the process group where the OS has them: `npx`-style launchers fork. */
const KILL_GROUP = process.platform !== 'win32';

type ProbeTool = ProbeResult['tools'][number];

type Outcome = {
  ok: boolean;
  error?: string;
  tools: ProbeTool[];
  serverInfo?: { name: string; version: string };
};

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

export async function probeMcpServer(entry: McpEntry, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const started = Date.now();
  const timeoutMs = positiveOr(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  // This function is the contract boundary: a probe reports failure, it never
  // rejects, so one hostile server cannot take down a whole scan.
  const outcome = await runProbe(entry, timeoutMs, opts.env).catch(
    (error: unknown): Outcome => ({ ok: false, error: messageOf(error), tools: [] })
  );
  const totalTokens = outcome.tools.reduce((sum, tool) => sum + tool.tokens, 0);
  return {
    server: entry.name,
    ok: outcome.ok,
    durationMs: Date.now() - started,
    tools: outcome.tools,
    totalTokens,
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ...(outcome.serverInfo ? { serverInfo: outcome.serverInfo } : {})
  };
}

export async function probeAll(
  entries: McpEntry[],
  opts: { timeoutMs?: number; concurrency?: number } = {}
): Promise<ProbeResult[]> {
  // `Math.trunc(NaN)` is NaN, and `Array.from({ length: NaN })` builds no
  // workers at all — which used to return an array of holes typed as results.
  const limit = Math.max(1, Math.trunc(positiveOr(opts.concurrency, DEFAULT_CONCURRENCY)));
  const results: ProbeResult[] = new Array<ProbeResult>(entries.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) {
        return;
      }
      const entry = entries[index];
      if (!entry) {
        // A hole in the input must not end the worker: the entries after it
        // still deserve a probe, and every slot still owes a result.
        results[index] = {
          server: `entry ${index}`,
          ok: false,
          error: 'missing entry',
          durationMs: 0,
          tools: [],
          totalTokens: 0
        };
        continue;
      }
      results[index] = await probeMcpServer(entry, {
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
      }).catch((error: unknown) => ({
        server: entry.name,
        ok: false,
        error: messageOf(error),
        durationMs: 0,
        tools: [],
        totalTokens: 0
      }));
    }
  };

  const workers = Array.from({ length: Math.min(limit, entries.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runProbe(
  entry: McpEntry,
  timeoutMs: number,
  envOverride: NodeJS.ProcessEnv | undefined
): Promise<Outcome> {
  if (entry.transport !== 'stdio') {
    // Probing http/sse/ws means a real network connection with the user's
    // credentials attached, which is a different consent question than
    // starting a local process. Report the server unmeasured rather than
    // quietly reporting zero.
    return { ok: false, error: 'remote transports are not probed', tools: [] };
  }
  if (!entry.command) {
    return { ok: false, error: 'stdio server has no command', tools: [] };
  }

  const options: SpawnOptions = {
    // Never 'inherit': a server that reads stdin would swallow the parent's.
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so the kill below reaps the whole tree. MCP
    // servers are usually launched through `npx`/`uvx`, which fork the real
    // server as a child; signalling only the launcher leaves that orphaned.
    detached: KILL_GROUP,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    env: { ...process.env, ...entry.env, ...envOverride }
  };

  let child: ChildProcess;
  try {
    child = spawn(entry.command, entry.args ?? [], options);
  } catch (error) {
    return { ok: false, error: messageOf(error), tools: [] };
  }

  return converse(child, timeoutMs);
}

async function converse(child: ChildProcess, timeoutMs: number): Promise<Outcome> {
  const waiters = new Map<number, (response: RpcResponse) => void>();
  let stderr = '';
  let spawnError: string | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  child.stdin?.on('error', () => {
    // The server may exit mid-handshake; a broken pipe is not a probe failure
    // in its own right, the missing response is what we report.
  });
  child.stderr?.on('error', () => {});
  child.stdout?.on('error', () => {});

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) {
      stderr = (stderr + chunk).slice(0, STDERR_LIMIT);
    }
  });

  let buffer = '';
  let overflowed = false;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        deliver(line, waiters);
      }
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > STDOUT_LIMIT) {
      // No newline in sight and the line is already absurd. Drop it rather
      // than let a babbling server grow the heap until the timeout.
      overflowed = true;
      buffer = '';
    }
  });

  // 'exit' means the process is gone; 'close' additionally means its pipes are
  // drained. The conversation cares about 'close' (data may still arrive),
  // teardown cares about 'exit' (a leaked pipe must not delay it).
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });

  const closed = new Promise<void>((resolve) => {
    child.once('error', (error: Error) => {
      spawnError ??= error.message;
      resolve();
    });
    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // A server that writes its last reply without a trailing newline and
      // exits has still answered; the newline is a framing detail, not consent.
      const tail = buffer.trim();
      buffer = '';
      if (tail) {
        deliver(tail, waiters);
      }
      resolve();
    });
  });

  const send = (message: unknown): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const waitFor = (id: number): Promise<RpcResponse> =>
    new Promise<RpcResponse>((resolve) => {
      waiters.set(id, resolve);
    });

  const conversation = (async (): Promise<Outcome> => {
    const initPromise = waitFor(INITIALIZE_ID);
    send({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'yard', version: '1.0.0' }
      }
    });
    const init = await initPromise;
    if (init.error) {
      return { ok: false, error: `initialize failed: ${rpcErrorText(init.error)}`, tools: [] };
    }

    const listPromise = waitFor(TOOLS_LIST_ID);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: TOOLS_LIST_ID, method: 'tools/list', params: {} });
    const listed = await listPromise;

    const serverInfo = readServerInfo(init.result);
    if (listed.error) {
      return {
        ok: false,
        error: `tools/list failed: ${rpcErrorText(listed.error)}`,
        tools: [],
        ...(serverInfo ? { serverInfo } : {})
      };
    }
    return {
      ok: true,
      tools: readTools(listed.result),
      ...(serverInfo ? { serverInfo } : {})
    };
  })();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const died = closed.then(() => 'closed' as const);

  let raced: Outcome | 'timeout' | 'closed';
  try {
    raced = await Promise.race([conversation, deadline, died]);
  } finally {
    // Whatever happened above — including a throw while pricing tools — the
    // child must not outlive this call.
    clearTimeout(timer);
    await terminate(child, exited);
    release(child);
  }

  if (raced === 'timeout') {
    return { ok: false, error: withStderr(note(`timed out after ${timeoutMs}ms`, overflowed), stderr), tools: [] };
  }
  if (raced === 'closed') {
    const reason = spawnError ?? exitDescription(exitCode, exitSignal);
    return { ok: false, error: withStderr(note(reason, overflowed), stderr), tools: [] };
  }
  if (!raced.ok && raced.error !== undefined) {
    return { ...raced, error: withStderr(raced.error, stderr) };
  }
  return raced;
}

/** SIGTERM, then SIGKILL if it is still alive. Never leave the child behind. */
async function terminate(child: ChildProcess, exited: Promise<void>): Promise<void> {
  const running = child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  if (!running) {
    await settleWithin(exited, KILL_GRACE_MS);
    return;
  }
  child.stdin?.end();
  killTree(child, 'SIGTERM');
  const hardKill = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
  hardKill.unref();
  try {
    // Bounded even so. SIGKILL is reliable for the process we spawned, but a
    // server that daemonised itself into a new session is outside any group
    // we can signal, and waiting forever on it would hang the whole scan.
    await settleWithin(exited, KILL_GRACE_MS * 2);
  } finally {
    clearTimeout(hardKill);
  }
}

/**
 * Drop every handle the probe still holds on the child.
 *
 * A grandchild that inherited the server's stdout keeps those pipes open long
 * after the server is dead, and libuv counts an open pipe as a reason to keep
 * running — so without this the caller gets its answer and then hangs at exit.
 */
function release(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // Already torn down.
    }
  }
  child.unref();
}

/** Signal the child's whole process group, falling back to the child alone. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  // `process.kill(-0, ...)` signals our own process group. A spawned child is
  // never pid 0 or 1, but the blast radius of being wrong here is the whole CLI.
  if (KILL_GROUP && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No group, or it is already gone. Fall through to the direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already reaped.
  }
}

/** Await `promise`, but give up after `ms` rather than wait forever. */
async function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    // Never hold the event loop open just to observe a corpse.
    timer.unref();
  });
  try {
    await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

function note(message: string, overflowed: boolean): string {
  return overflowed ? `${message} (discarded oversized stdout)` : message;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function deliver(line: string, waiters: Map<number, (response: RpcResponse) => void>): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    // Servers legitimately print banners and log lines to stdout.
    return;
  }
  if (!isRecord(message)) {
    return;
  }
  const id = correlationId(message.id);
  if (id === undefined) {
    // A notification, or a reply we never asked for.
    return;
  }
  const waiter = waiters.get(id);
  if (!waiter) {
    return;
  }
  waiters.delete(id);
  waiter(message as RpcResponse);
}

/**
 * JSON-RPC says a reply echoes the request id unchanged, but servers that round
 * -trip ids through a string type answer `"1"` to `1`. Matching those costs
 * nothing and saves a full timeout per server.
 */
function correlationId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function readTools(result: unknown): ProbeTool[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    return [];
  }
  const tools: ProbeTool[] = [];
  for (const raw of result.tools) {
    if (!isRecord(raw) || typeof raw.name !== 'string') {
      continue;
    }
    const name = raw.name;
    const description = typeof raw.description === 'string' ? raw.description : '';
    tools.push({ name, description, tokens: priceTool(name, description, raw.inputSchema) });
  }
  return tools;
}

/**
 * Priced exactly as the fields arrive on the wire, since that is what the
 * client forwards to the model. A schema nested deeply enough to overflow the
 * stringify stack costs a degraded estimate, not a thrown probe.
 */
function priceTool(name: string, description: string, inputSchema: unknown): number {
  try {
    return estimateJsonTokens({
      name,
      description,
      ...(inputSchema !== undefined ? { inputSchema } : {})
    });
  } catch {
    try {
      return estimateJsonTokens({ name, description });
    } catch {
      return 0;
    }
  }
}

function readServerInfo(result: unknown): { name: string; version: string } | undefined {
  if (!isRecord(result) || !isRecord(result.serverInfo)) {
    return undefined;
  }
  const info = result.serverInfo;
  if (typeof info.name !== 'string') {
    return undefined;
  }
  return { name: info.name, version: typeof info.version === 'string' ? info.version : '' };
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) {
    return `server exited on ${signal} before responding`;
  }
  if (code !== null) {
    return `server exited with code ${code} before responding`;
  }
  return 'server exited before responding';
}

function withStderr(message: string, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-5).join('\n').trim();
  return tail ? `${message}: ${tail}` : message;
}

function rpcErrorText(error: { code?: unknown; message?: unknown }): string {
  const text = typeof error.message === 'string' ? error.message : JSON.stringify(error);
  return typeof error.code === 'number' ? `${text} (${error.code})` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
