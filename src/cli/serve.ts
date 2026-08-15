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

  serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port ?? DEFAULT_PORT }, (info) => {
    console.error(`yard  http://127.0.0.1:${info.port}`);
    console.error(`mcp   http://127.0.0.1:${info.port}/mcp`);
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
