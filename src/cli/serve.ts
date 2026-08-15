import { serve } from '@hono/node-server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { existsSync, watch } from 'node:fs';
import { Catalog } from '../catalog.js';
import { createYardApp } from '../http.js';
import { createYardServer } from '../mcp.js';
import { PLUGINS_DIR, REPO_ROOT } from '../paths.js';
import { Session } from '../session.js';
import { flagNumber, GLOBAL_FLAGS, rejectUnknownFlags, type Args } from './args.js';

export const DEFAULT_PORT = 4372;

export type ServeOptions = {
  stdio?: boolean;
  port?: number;
};

/**
 * The long-running surfaces. Both keep their startup lines on stderr, because
 * stdout belongs to the MCP protocol when serving over stdio.
 */
export async function runServe(options: ServeOptions = {}): Promise<number> {
  const catalog = new Catalog();
  const session = new Session(catalog);
  await catalog.load();

  if (options.stdio) {
    console.error('yard listening on stdio');
    serveStdio(() => createYardServer(catalog, session));
    return 0;
  }

  const { app, close } = createYardApp(catalog, session);
  if (existsSync(PLUGINS_DIR)) {
    watch(PLUGINS_DIR, { recursive: true }, () => catalog.invalidate());
  }
  if (existsSync(REPO_ROOT)) {
    watch(REPO_ROOT, { recursive: false }, () => catalog.invalidate());
  }

  const port = options.port ?? DEFAULT_PORT;
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
    console.error(`yard  http://127.0.0.1:${info.port}`);
    console.error(`mcp   http://127.0.0.1:${info.port}/mcp`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    // A taken port is someone else's yard, not a bug worth a stack trace.
    if (error.code === 'EADDRINUSE') {
      process.stderr.write(`yard: port ${port} is already in use — pass --port=<port>\n`);
      process.exit(1);
    }
    throw error;
  });

  const shutdown = async (): Promise<void> => {
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  return 0;
}

export async function runServeCommand(args: Args): Promise<number> {
  rejectUnknownFlags(args, [...GLOBAL_FLAGS, 'port', 'stdio']);
  const port = flagNumber(args, 'port');
  return runServe({
    stdio: args.flags.get('stdio') !== undefined,
    ...(port !== undefined ? { port } : {})
  });
}
