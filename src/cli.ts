import { serve } from '@hono/node-server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { existsSync, watch } from 'node:fs';
import { adaptPlugin } from './adapt.js';
import { Catalog } from './catalog.js';
import { createYardApp } from './http.js';
import { createYardServer } from './mcp.js';
import { writeMcpFiles } from './mcp-spec.js';
import { PLUGINS_DIR, REPO_ROOT, YARD_PLUGIN_DIR } from './paths.js';
import { Session } from './session.js';

const DEFAULT_PORT = 4372;

async function main(): Promise<void> {
  if (process.argv.includes('--emit-mcp')) {
    await writeMcpFiles(YARD_PLUGIN_DIR);
    console.error(`wrote ${YARD_PLUGIN_DIR}/.mcp.json`);
    console.error(`wrote ${YARD_PLUGIN_DIR}/mcp.json`);
    return;
  }

  const adaptSource = flagValue('adapt');
  if (adaptSource !== undefined) {
    if (!adaptSource) {
      throw new Error('usage: yard --adapt <path> [--name=] [--dest=] [--register|--no-register]');
    }
    const register = process.argv.includes('--register')
      ? true
      : process.argv.includes('--no-register')
        ? false
        : undefined;
    const name = flagValue('name');
    const dest = flagValue('dest');
    const report = await adaptPlugin({
      source: adaptSource,
      ...(name ? { name } : {}),
      ...(dest ? { dest } : {}),
      ...(register !== undefined ? { register } : {})
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const stdio = process.argv.includes('--stdio');
  const portFlag = process.argv.find((arg) => arg.startsWith('--port='));
  const port = portFlag ? Number(portFlag.slice('--port='.length)) : DEFAULT_PORT;

  const catalog = new Catalog();
  const session = new Session(catalog);
  await catalog.load();

  if (stdio) {
    console.error('yard listening on stdio');
    serveStdio(() => createYardServer(catalog, session));
    return;
  }

  const { app, close } = createYardApp(catalog, session);
  if (existsSync(PLUGINS_DIR)) {
    watch(PLUGINS_DIR, { recursive: true }, () => catalog.invalidate());
  }
  if (existsSync(REPO_ROOT)) {
    watch(REPO_ROOT, { recursive: false }, () => catalog.invalidate());
  }

  serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
    console.error(`yard  http://127.0.0.1:${info.port}`);
    console.error(`mcp   http://127.0.0.1:${info.port}/mcp`);
  });

  const shutdown = async (): Promise<void> => {
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = process.argv.find((arg) => arg.startsWith(prefix));
  if (eq) {
    return eq.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) {
    return '';
  }
  return next;
}

void main();
