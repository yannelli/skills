#!/usr/bin/env node
/**
 * Benchmarks for the numbers the README publishes.
 *
 * Builds a synthetic three-client setup under a tmpdir (YARD_HOME points the
 * whole scan layer at it), then times the built CLI against it. Nothing here
 * touches your real ~/.claude, ~/.codex, or ~/.cursor.
 *
 *   node scripts/bench.mjs             # README scale: ~457 skills, 71 plugins
 *   node scripts/bench.mjs --scale=10  # ten times that
 *   node scripts/bench.mjs --json
 *
 * Requires a built bundle: `bun run build:server` first. Runs every command
 * under node, and under bun too when bun is on the PATH.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repo, 'plugins', 'yard', 'dist', 'cli.js');

const args = new Set(process.argv.slice(2));
const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? Number(scaleArg.split('=')[1]) : 1;
const JSON_OUT = args.has('--json');

const SAVINGS = args.has('--savings');
// Build the synthetic setup, print where it is, and keep it. For pointing a
// live `yard` at a big believable install: YARD_HOME=<home> yard scan --project=<project>
const FIXTURE_ONLY = args.has('--fixture');

const WARMUP = 2;
const RUNS = 7;

// ---------------------------------------------------------------------------
// Fixture generation. Shapes mirror src/env/*.test.ts fixtures — the same
// frontmatter, settings, and manifest forms the scanners were tested against.
// ---------------------------------------------------------------------------

const WORDS =
  'context window budget skill plugin server hook memory agent command scan doctor probe token estimate turn client setup cost disable enable'.split(
    ' '
  );

function prose(seed, sentences) {
  const out = [];
  for (let i = 0; i < sentences; i += 1) {
    const n = 8 + ((seed + i) % 7);
    const words = [];
    for (let j = 0; j < n; j += 1) {
      words.push(WORDS[(seed * 31 + i * 7 + j) % WORDS.length]);
    }
    out.push(words.join(' ') + '.');
  }
  return out.join(' ');
}

// Four sentences of description ≈ 55-60 tokens per skill in the listing, which
// is what the real setup in the README averaged (27.1k over 457 skills).
function skillMd(name, seed) {
  return `---\nname: ${name}\ndescription: ${prose(seed, 4)}\n---\n\n# ${name}\n\n${prose(seed, 12)}\n\n## Usage\n\n${prose(seed + 1, 10)}\n`;
}

function write(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}

function buildFixture(scale) {
  const root = mkdtempSync(path.join(tmpdir(), 'yard-bench-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });

  const counts = {
    claudeSkills: 150 * scale,
    codexSkills: 120 * scale,
    cursorSkills: 116 * scale,
    plugins: 71 * scale,
    claudeMcp: 4 * scale,
    codexMcp: 3 * scale,
    cursorMcp: 3 * scale,
    claudeHooks: 10 * scale,
    codexHooks: 9 * scale,
    cursorHooks: 8 * scale,
    agents: 12 * scale,
    commands: 20 * scale
  };

  // A real script for every hook and MCP command, so doctor's existence checks
  // pass and its timing reflects a healthy setup rather than error paths.
  const hookScript = path.join(home, 'bin', 'hook.js');
  write(hookScript, 'process.exit(0);\n');
  const mcpScript = path.join(home, 'bin', 'mcp-server.js');
  write(mcpScript, 'process.exit(0);\n');

  for (let i = 0; i < counts.claudeSkills; i += 1) {
    write(path.join(home, '.claude', 'skills', `claude-skill-${i}`, 'SKILL.md'), skillMd(`claude-skill-${i}`, i));
  }
  for (let i = 0; i < counts.codexSkills; i += 1) {
    write(path.join(home, '.codex', 'skills', `codex-skill-${i}`, 'SKILL.md'), skillMd(`codex-skill-${i}`, i + 1000));
  }
  for (let i = 0; i < counts.cursorSkills; i += 1) {
    write(path.join(home, '.cursor', 'skills', `cursor-skill-${i}`, 'SKILL.md'), skillMd(`cursor-skill-${i}`, i + 2000));
  }
  for (let i = 0; i < counts.agents; i += 1) {
    write(
      path.join(home, '.claude', 'agents', `agent-${i}.md`),
      `---\nname: agent-${i}\ndescription: ${prose(i + 3000, 1)}\n---\n\n${prose(i + 3000, 8)}\n`
    );
  }
  for (let i = 0; i < counts.commands; i += 1) {
    write(path.join(home, '.claude', 'commands', `command-${i}.md`), `${prose(i + 4000, 4)}\n`);
  }

  const installed = { plugins: {} };
  const enabledPlugins = {};
  for (let i = 0; i < counts.plugins; i += 1) {
    const name = `plugin-${i}`;
    const key = `${name}@bench-marketplace`;
    const pluginRoot = path.join(home, '.claude', 'plugins', 'cache', 'bench-marketplace', name);
    write(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, description: prose(i + 5000, 1), version: '1.0.0' }, null, 2)
    );
    write(path.join(pluginRoot, 'skills', name, 'SKILL.md'), skillMd(name, i + 5000));
    installed.plugins[key] = [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }];
    enabledPlugins[key] = true;
  }
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(installed, null, 2));

  const claudeHooks = { PreToolUse: [], PostToolUse: [] };
  for (let i = 0; i < counts.claudeHooks; i += 1) {
    const event = i % 2 === 0 ? 'PreToolUse' : 'PostToolUse';
    claudeHooks[event].push({ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${hookScript}` }] });
  }
  const writeClaudeSettings = (overrides = {}) =>
    write(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins, hooks: claudeHooks, ...overrides }, null, 2)
    );
  writeClaudeSettings();

  const codexMcp = [];
  for (let i = 0; i < counts.codexMcp; i += 1) {
    codexMcp.push(`[mcp_servers.codex-mcp-${i}]\ncommand = "node"\nargs = ["${mcpScript}"]\n`);
  }
  write(path.join(home, '.codex', 'config.toml'), codexMcp.join('\n'));
  const codexHooks = { PreToolUse: [] };
  for (let i = 0; i < counts.codexHooks; i += 1) {
    codexHooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: `node ${hookScript}` }] });
  }
  write(path.join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: codexHooks }, null, 2));
  write(path.join(home, '.codex', 'AGENTS.md'), prose(6000, 20) + '\n');

  const cursorMcp = { mcpServers: {} };
  for (let i = 0; i < counts.cursorMcp; i += 1) {
    cursorMcp.mcpServers[`cursor-mcp-${i}`] = { command: 'node', args: [mcpScript] };
  }
  write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify(cursorMcp, null, 2));
  const cursorHooks = { version: 1, hooks: {} };
  cursorHooks.hooks.beforeShellExecution = [];
  for (let i = 0; i < counts.cursorHooks; i += 1) {
    cursorHooks.hooks.beforeShellExecution.push({ command: `node ${hookScript}` });
  }
  write(path.join(home, '.cursor', 'hooks.json'), JSON.stringify(cursorHooks, null, 2));

  write(path.join(home, '.claude', 'CLAUDE.md'), prose(7000, 25) + '\n');
  write(path.join(project, 'CLAUDE.md'), prose(7100, 15) + '\n');
  write(path.join(project, 'AGENTS.md'), prose(7200, 15) + '\n');
  write(path.join(project, '.cursorrules'), prose(7300, 10) + '\n');
  write(
    path.join(project, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: Object.fromEntries(
          Array.from({ length: counts.claudeMcp }, (_, i) => [`claude-mcp-${i}`, { command: 'node', args: [mcpScript] }])
        )
      },
      null,
      2
    )
  );

  return {
    root,
    home,
    project,
    writeClaudeSettings,
    personalClaudeSkills: Array.from({ length: counts.claudeSkills }, (_, i) => `claude-skill-${i}`),
    // Plugin skills are addressed by their plugin-qualified name.
    pluginSkills: Array.from({ length: counts.plugins }, (_, i) => `plugin-${i}:plugin-${i}`),
    pluginCount: counts.plugins
  };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timeCommand(runtime, cliArgs, env, allowedExits = new Set([0])) {
  const samples = [];
  for (let i = 0; i < WARMUP + RUNS; i += 1) {
    const start = performance.now();
    // stdout goes to /dev/null: the CLI still pays for serializing it, but the
    // bench process never buffers it (spawnSync's default maxBuffer kills
    // large-scale scans otherwise).
    const result = spawnSync(runtime, [cli, ...cliArgs], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8'
    });
    const elapsed = performance.now() - start;
    if (!allowedExits.has(result.status)) {
      throw new Error(`${runtime} ${cliArgs.join(' ')} exited ${result.status}\n${result.stderr}`);
    }
    if (i >= WARMUP) {
      samples.push(elapsed);
    }
  }
  return { median: median(samples), min: Math.min(...samples), max: Math.max(...samples) };
}

function cpuModel() {
  const model = cpus()[0]?.model?.trim();
  if (model && model !== 'unknown') {
    return model;
  }
  // ARM Linux reports "unknown" through os.cpus(); lscpu knows better.
  const probe = spawnSync('sh', ['-c', "lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p'"], {
    encoding: 'utf8'
  });
  return probe.stdout?.trim() || 'unknown';
}

function hasBun() {
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

function contextReport(env, projectFlag) {
  return JSON.parse(
    execFileSync('node', [cli, 'context', '--json', projectFlag], {
      env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
  );
}

/**
 * What each mode gives back, measured by pricing the same setup again after
 * writing the mode into the fixture's settings — the identical read path
 * `yard context` uses on a real machine, priced by Yard's own estimator.
 */
function measureSavings(fixture, env, projectFlag) {
  const baseline = contextReport(env, projectFlag);
  const skills = fixture.personalClaudeSkills;

  const modeTotal = (visibility) => {
    fixture.writeClaudeSettings({
      skillOverrides: Object.fromEntries(skills.map((name) => [name, visibility]))
    });
    return contextReport(env, projectFlag).total;
  };

  const modes = {};
  for (const visibility of ['name-only', 'user-invocable-only', 'off']) {
    modes[visibility] = baseline.total - modeTotal(visibility);
  }
  if (modes['user-invocable-only'] !== modes.off) {
    throw new Error('user-invocable-only and off should save identically: both leave the listing');
  }

  // The same modes work on plugin skills, keyed `<plugin>:<skill>`.
  const pluginModes = {};
  for (const visibility of ['name-only', 'off']) {
    fixture.writeClaudeSettings({
      skillOverrides: Object.fromEntries(fixture.pluginSkills.map((name) => [name, visibility]))
    });
    pluginModes[visibility] = baseline.total - contextReport(env, projectFlag).total;
  }
  fixture.writeClaudeSettings();

  // Plugins off: rewrite enabledPlugins to false wholesale.
  const enabledPlugins = Object.fromEntries(
    Array.from({ length: fixture.pluginCount }, (_, i) => [`plugin-${i}@bench-marketplace`, false])
  );
  fixture.writeClaudeSettings({ enabledPlugins });
  const pluginsSaved = baseline.total - contextReport(env, projectFlag).total;
  fixture.writeClaudeSettings();

  // In this fixture plugins ship only skills, so turning every plugin skill
  // off must reclaim exactly what disabling every plugin does.
  if (pluginModes.off !== pluginsSaved) {
    throw new Error(
      `plugin skills off saved ${pluginModes.off} but plugin disable saved ${pluginsSaved}; ` +
        'the fixture plugins ship only skills, so these must match'
    );
  }

  const mcpLines = baseline.lines.filter((line) => line.kind === 'mcp');
  const mcpSaved = mcpLines.reduce((sum, line) => sum + line.tokens, 0);

  return { baseline, modes, pluginModes, pluginsSaved, mcpCount: mcpLines.length, mcpSaved };
}

function main() {
  const fixture = buildFixture(SCALE);
  const env = { ...process.env, YARD_HOME: fixture.home, NO_COLOR: '1' };
  const projectFlag = `--project=${fixture.project}`;

  if (FIXTURE_ONLY) {
    console.log(`YARD_HOME=${fixture.home}`);
    console.log(`project:  ${fixture.project}`);
    return;
  }

  try {
    // What did the fixture actually produce? Report measured counts, not goals.
    const scanJson = JSON.parse(
      execFileSync('node', [cli, 'scan', '--json', projectFlag], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    );
    const contextJson = JSON.parse(
      execFileSync('node', [cli, 'context', '--json', projectFlag], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    );
    const totals = {};
    for (const perClient of Object.values(scanJson.counts)) {
      for (const [kind, count] of Object.entries(perClient)) {
        totals[kind] = (totals[kind] ?? 0) + count;
      }
    }
    const setup = {
      scale: SCALE,
      skills: totals.skill ?? 0,
      plugins: totals.plugin ?? 0,
      mcpServers: totals.mcp ?? 0,
      hooks: totals.hook ?? 0,
      agents: totals.agent ?? 0,
      commands: totals.command ?? 0,
      memory: totals.memory ?? 0,
      estimatedTokensPerTurn: contextJson.total
    };

    if (SAVINGS) {
      const savings = measureSavings(fixture, env, projectFlag);
      const skillCount = fixture.personalClaudeSkills.length;
      const per = (saved, count) => Math.round(saved / count);
      const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

      if (JSON_OUT) {
        console.log(
          JSON.stringify(
            {
              setup,
              personalClaudeSkills: skillCount,
              savings: {
                'name-only': savings.modes['name-only'],
                'user-invocable-only': savings.modes['user-invocable-only'],
                off: savings.modes.off,
                pluginSkills: savings.pluginModes,
                pluginsDisabled: savings.pluginsSaved,
                mcpDisabled: { servers: savings.mcpCount, tokens: savings.mcpSaved, measured: false }
              }
            },
            null,
            2
          )
        );
        return;
      }

      console.log(
        `setup: ${setup.skills} skills, ${setup.plugins} plugins, ${setup.mcpServers} MCP servers ` +
          `— ${k(savings.baseline.total)} estimated tokens per turn\n`
      );
      const minus = (n) => `-${k(n)}`.padStart(7);
      console.log(`  yard skill <name> …          all ${skillCount} personal Claude skills`);
      for (const mode of ['name-only', 'user-invocable-only', 'off']) {
        const saved = savings.modes[mode];
        console.log(`    ${mode.padEnd(22)} ${minus(saved)}  (${per(saved, skillCount)} per skill)`);
      }
      console.log(`  yard skill <plugin>:<name> … all ${setup.plugins} plugin skills`);
      for (const mode of ['name-only', 'off']) {
        const saved = savings.pluginModes[mode];
        console.log(`    ${mode.padEnd(22)} ${minus(saved)}  (${per(saved, setup.plugins)} per skill)`);
      }
      console.log(
        `  yard plugin disable, all ${setup.plugins}   ${minus(savings.pluginsSaved)}  (${per(savings.pluginsSaved, setup.plugins)} per plugin)`
      );
      // Not credited to `yard mcp disable`: it refuses for codex servers,
      // which own their config.toml. The tokens come back either way.
      console.log(
        `  all ${savings.mcpCount} live MCP servers off   ${minus(savings.mcpSaved)}  (estimated: unprobed servers)`
      );
      return;
    }

    const runtimes = ['node', ...(hasBun() ? ['bun'] : [])];
    // doctor may exit 1 by design when a setup has real errors; this fixture
    // is healthy (verified: exit 0, info-level diagnoses only), but the
    // tolerance stays scoped to doctor so a scan regression cannot hide.
    const commands = [
      { label: 'scan', args: ['scan', '--json', projectFlag] },
      { label: 'context', args: ['context', '--json', projectFlag] },
      { label: 'doctor', args: ['doctor', '--json', projectFlag], allowedExits: new Set([0, 1]) },
      { label: 'cold start (--help)', args: ['--help'] }
    ];

    const results = [];
    for (const runtime of runtimes) {
      for (const command of commands) {
        results.push({
          runtime,
          command: command.label,
          ...timeCommand(runtime, command.args, env, command.allowedExits)
        });
      }
    }

    const bunVersion = spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout?.trim();
    const machine = {
      cpu: cpuModel(),
      cores: cpus().length,
      node: process.version,
      ...(bunVersion ? { bun: bunVersion } : {})
    };

    if (JSON_OUT) {
      console.log(JSON.stringify({ machine, setup, results }, null, 2));
      return;
    }

    console.log(
      `machine: ${machine.cpu} (${machine.cores} cores), node ${machine.node}` +
        (machine.bun ? `, bun ${machine.bun}` : '')
    );
    console.log(
      `setup: ${setup.skills} skills, ${setup.plugins} plugins, ${setup.mcpServers} MCP servers, ` +
        `${setup.hooks} hooks, ${setup.agents} agents, ${setup.commands} commands ` +
        `(~${Math.round(setup.estimatedTokensPerTurn / 1000)}k estimated tokens per turn)`
    );
    console.log(`${RUNS} runs after ${WARMUP} warmups, median (min…max), full process wall time\n`);
    for (const row of results) {
      console.log(
        `  ${row.runtime.padEnd(5)} ${row.command.padEnd(20)} ${Math.round(row.median).toString().padStart(5)} ms  ` +
          `(${Math.round(row.min)}…${Math.round(row.max)})`
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

main();
