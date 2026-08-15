import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  AGENT_MCP_SCHEMA,
  emitAgentMcp,
  emitClaudeMcp,
  parsePluginMcp,
  writeMcpFiles
} from './mcp-spec.js';
import { YARD_PLUGIN_DIR } from './paths.js';

test('emit keeps the same server keys on both files', () => {
  const claude = emitClaudeMcp();
  const agent = emitAgentMcp();
  assert.deepEqual(Object.keys(claude.mcpServers), ['yard']);
  assert.deepEqual(Object.keys(agent.mcpServers), ['yard']);
  assert.equal(agent.$schema, AGENT_MCP_SCHEMA);
  assert.equal(agent.mcpServers.yard?.type, 'stdio');
  assert.ok(claude.mcpServers.yard?.args?.[0]?.includes('CLAUDE_PLUGIN_ROOT'));
  assert.equal(agent.mcpServers.yard?.args?.[0], './dist/cli.js');
});

test('write and parse a plugin MCP pair', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-mcp-'));
  try {
    await writeMcpFiles(dir);
    const specs = await parsePluginMcp('yard', dir);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.key, 'yard');
    assert.equal(specs[0]?.transport.type, 'stdio');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parse fails when only one MCP file exists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-mcp-one-'));
  try {
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { yard: { command: 'node' } } }));
    await assert.rejects(() => parsePluginMcp('yard', dir), /no mcp.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parse fails when keys drift', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-mcp-drift-'));
  try {
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { yard: { command: 'node' } } }));
    await writeFile(
      path.join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_MCP_SCHEMA,
        mcpServers: { other: { type: 'stdio', command: 'node' } }
      })
    );
    await assert.rejects(() => parsePluginMcp('yard', dir), /keys diverge/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('committed yard MCP files match the emitter', async () => {
  const claude = `${JSON.stringify(emitClaudeMcp(), null, 2)}\n`;
  const agent = `${JSON.stringify(emitAgentMcp(), null, 2)}\n`;
  assert.equal(await readFile(path.join(YARD_PLUGIN_DIR, '.mcp.json'), 'utf8'), claude);
  assert.equal(await readFile(path.join(YARD_PLUGIN_DIR, 'mcp.json'), 'utf8'), agent);
});

test('emit is stable JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-mcp-stable-'));
  try {
    await writeMcpFiles(dir);
    const first = await readFile(path.join(dir, '.mcp.json'), 'utf8');
    await writeMcpFiles(dir);
    const second = await readFile(path.join(dir, '.mcp.json'), 'utf8');
    assert.equal(first, second);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
