import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  adaptPlugin,
  agentMcpToClaude,
  claudeHooksToCursor,
  claudeMcpToAgent,
  cursorHooksToClaude,
  kebabName
} from './adapt.js';
import { AGENT_MCP_SCHEMA } from './mcp-spec.js';
import { Catalog } from './catalog.js';
import { createYardApp } from './http.js';
import { Session } from './session.js';

const CLAUDE_HOOKS = {
  description: 'Announce load',
  hooks: {
    SessionStart: [
      {
        hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}"/scripts/hello.sh' }]
      }
    ]
  }
};

test('kebabName collapses titles', () => {
  assert.equal(kebabName('My Claude Skill'), 'my-claude-skill');
});

test('Claude hooks become Cursor hooks', () => {
  assert.deepEqual(claudeHooksToCursor(CLAUDE_HOOKS), {
    hooks: { sessionStart: [{ command: './scripts/hello.sh' }] }
  });
});

test('Cursor hooks become Claude hooks', () => {
  const claude = cursorHooksToClaude({ hooks: { sessionStart: [{ command: './scripts/hello.sh' }] } });
  assert.deepEqual(claude.hooks.SessionStart, [
    { hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}"/scripts/hello.sh' }] }
  ]);
});

test('Claude MCP becomes Agent Plugins MCP', () => {
  const agent = claudeMcpToAgent({
    mcpServers: {
      demo: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/cli.js', '--stdio'],
        env: { YARD_ROOT: '${CLAUDE_PROJECT_DIR}', PLUGIN_ROOT: '/tmp', KEEP: 'yes' }
      }
    }
  });
  assert.equal(agent.$schema, AGENT_MCP_SCHEMA);
  assert.deepEqual(agent.mcpServers.demo, {
    type: 'stdio',
    command: 'node',
    args: ['./dist/cli.js', '--stdio'],
    cwd: './',
    env: { KEEP: 'yes' }
  });
});

test('Agent MCP becomes Claude MCP', () => {
  const claude = agentMcpToClaude({
    $schema: AGENT_MCP_SCHEMA,
    mcpServers: {
      demo: { type: 'stdio', command: 'node', args: ['./dist/cli.js'], cwd: './' }
    }
  });
  assert.deepEqual(claude.mcpServers.demo, {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/dist/cli.js']
  });
});

test('adapts a standalone SKILL.md into a four-manifest plugin', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-adapt-skill-'));
  try {
    const source = path.join(root, 'incoming', 'SKILL.md');
    const dest = path.join(root, 'out', 'summarize');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(
      source,
      `---
name: summarize
description: Summarize the current selection
---

# Summarize
`
    );
    const report = await adaptPlugin({ source, dest, register: false });
    assert.equal(report.name, 'summarize');
    assert.equal(report.registered, false);
    assert.ok(report.wrote.includes('plugin.json'));
    assert.ok(report.wrote.includes('.claude-plugin/plugin.json'));
    assert.ok(report.wrote.includes('.codex-plugin/plugin.json'));
    assert.ok(report.wrote.includes('.cursor-plugin/plugin.json'));
    assert.ok(report.wrote.includes('skills/summarize/SKILL.md'));
    const skill = await readFile(path.join(dest, 'skills', 'summarize', 'SKILL.md'), 'utf8');
    assert.match(skill, /Summarize the current selection/);
    const agent = JSON.parse(await readFile(path.join(dest, 'plugin.json'), 'utf8')) as { name: string };
    assert.equal(agent.name, 'summarize');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adapts a Claude-only plugin and is idempotent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-adapt-plugin-'));
  try {
    const source = path.join(root, 'claude-only');
    const dest = path.join(root, 'adapted');
    await mkdir(path.join(source, '.claude-plugin'), { recursive: true });
    await mkdir(path.join(source, 'skills', 'greet'), { recursive: true });
    await mkdir(path.join(source, 'hooks'), { recursive: true });
    await mkdir(path.join(source, 'scripts'), { recursive: true });
    await writeFile(
      path.join(source, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'greet',
        description: 'Say hello from a Claude-only plugin',
        version: '0.2.0',
        hooks: './hooks/hooks.json'
      })
    );
    await writeFile(
      path.join(source, 'skills', 'greet', 'SKILL.md'),
      `---
name: greet
description: Greet the user
---

# Greet
`
    );
    await writeFile(path.join(source, 'hooks', 'hooks.json'), JSON.stringify(CLAUDE_HOOKS, null, 2));
    await writeFile(path.join(source, 'scripts', 'hello.sh'), '#!/bin/sh\necho hi\n');
    await writeFile(
      path.join(source, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          greet: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] }
        }
      })
    );

    const first = await adaptPlugin({ source, dest, register: false });
    assert.equal(first.name, 'greet');
    assert.ok(first.wrote.includes('hooks/hooks.json'));
    assert.ok(first.wrote.includes('mcp.json'));
    assert.ok(first.wrote.includes('scripts/'));

    const cursorHooks = JSON.parse(await readFile(path.join(dest, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: { sessionStart: Array<{ command: string }> };
    };
    assert.equal(cursorHooks.hooks.sessionStart[0]?.command, './scripts/hello.sh');
    const claudeHooks = JSON.parse(await readFile(path.join(dest, 'hooks', 'claude-hooks.json'), 'utf8')) as {
      hooks: { SessionStart: unknown };
    };
    assert.ok(claudeHooks.hooks.SessionStart);
    const agentMcp = JSON.parse(await readFile(path.join(dest, 'mcp.json'), 'utf8')) as {
      $schema: string;
      mcpServers: { greet: { type: string; args: string[]; cwd: string } };
    };
    assert.equal(agentMcp.$schema, AGENT_MCP_SCHEMA);
    assert.equal(agentMcp.mcpServers.greet.type, 'stdio');
    assert.equal(agentMcp.mcpServers.greet.args[0], './server.js');
    assert.equal(agentMcp.mcpServers.greet.cwd, './');
    const script = await readFile(path.join(dest, 'scripts', 'hello.sh'), 'utf8');
    assert.match(script, /echo hi/);
    const claudeManifest = JSON.parse(
      await readFile(path.join(dest, '.claude-plugin', 'plugin.json'), 'utf8')
    ) as { hooks: string };
    assert.equal(claudeManifest.hooks, './hooks/claude-hooks.json');
    const codex = JSON.parse(await readFile(path.join(dest, '.codex-plugin', 'plugin.json'), 'utf8')) as {
      mcpServers: { greet: { cwd: string } };
    };
    assert.equal(codex.mcpServers.greet.cwd, '.');

    const second = await adaptPlugin({ source, dest, register: false });
    assert.equal(second.wrote.length, 0);
    assert.ok(second.skipped.includes('plugin.json'));
    assert.ok(second.skipped.includes('hooks/hooks.json'));
    assert.ok(second.skipped.includes('mcp.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/adapt writes a plugin from a SKILL.md', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-adapt-http-'));
  const catalog = new Catalog();
  const session = new Session(catalog, path.join(root, 'state.json'));
  const { app, close } = createYardApp(catalog, session);
  try {
    const source = path.join(root, 'SKILL.md');
    const dest = path.join(root, 'note-taker');
    await writeFile(
      source,
      `---
name: note-taker
description: Capture a note
---

# Notes
`
    );
    const res = await app.request('/api/adapt', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, dest, register: false })
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { name: string; wrote: string[] };
    assert.equal(body.name, 'note-taker');
    assert.ok(body.wrote.includes('plugin.json'));
    const missing = await app.request('/api/adapt', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(missing.status, 400);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
