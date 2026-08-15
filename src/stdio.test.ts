import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './paths.js';

test('bundled stdio initialize lists catalog_search', async () => {
  const cli = path.join(REPO_ROOT, 'plugins', 'yard', 'dist', 'cli.js');
  const child = spawn(process.execPath, [cli, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  const send = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'yard-test', version: '0' }
    }
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  const output = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`stdio timed out: ${Buffer.concat(chunks).toString('utf8')}`));
    }, 8000);
    child.stdout.on('data', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.includes('catalog_search')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve(text);
      }
    });
    child.on('error', reject);
  });

  assert.match(output, /catalog_search/);
  assert.match(output, /session_hydrate/);
});
