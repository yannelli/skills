# yard

Control plane for your agent setup across Claude Code, Codex, and Cursor.

Three clients, three config formats, three sets of directories. Yard reads all of them, tells you
what they cost you in context, and lets you turn things off from one place.

```bash
yard context     # what your setup costs per turn, and what to switch off
yard doctor      # what is quietly broken
yard scan        # everything the three clients will actually load
```

## Why

Skills, MCP servers, subagents, slash commands, and memory files are all charged against the same
context window as your actual conversation. Nothing shows you the bill, and nothing tells you when a
hook points at a script you deleted six weeks ago.

On the machine this was built on, a fairly ordinary setup came to roughly 37k tokens per turn before
a single message was typed: 457 skills, 71 plugins, 10 MCP servers, 27 hooks. Most of it was not
being used.

```text
$ yard context

  37.4k tokens per turn (estimated)

  skill    27.1k   ████████████████████████
  mcp       7.2k   ██████
  agent     2.5k   ██
  command    482   ▌

  claude    4.3k    codex   14.0k    cursor  18.1k

  most expensive
     1.2k  mcp    context7            (estimated)  yard mcp disable context7
     559   agent  code-simplifier
     286   skill  firecrawl-monitor                yard skill firecrawl-monitor off

  6 MCP servers were estimated, not measured. Run with --probe to start them
  and read their real tool schemas.
```

## Install

```bash
git clone https://github.com/yannelli/skills && cd skills
bun install && bun install --cwd web
bun run build
bun link            # puts `yard` on your PATH
```

No bun? npm works too — the web UI ships prebuilt, so only the server bundle needs building:

```bash
npm install && npm run build:server && npm link
```

Or install the marketplace so the agent can drive it through MCP:

```text
# Claude Code
/plugin marketplace add yannelli/skills
/plugin install yard@yannelli-skills

# Codex
codex plugin marketplace add yannelli/skills

# Cursor
# Team Marketplace -> Import from Repo -> https://github.com/yannelli/skills
```

## What it reads

Everything below was verified against live installs, not documentation.

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| settings | `~/.claude/settings.json`, `settings.local.json`, `.claude/settings*.json` | `~/.codex/config.toml` | `~/.cursor/cli-config.json` |
| skills | `~/.claude/skills`, `skills.disabled`, `.claude/skills` | `~/.codex/skills`, `skills.disabled` | `~/.cursor/skills`, `.cursor/skills` |
| plugins | `~/.claude/plugins/installed_plugins.json` | `~/.codex/plugins/cache` | `~/.cursor/plugins/cache` |
| MCP | `.mcp.json` + `enabledMcpjsonServers` | `[mcp_servers.*]` in `config.toml` | `~/.cursor/mcp.json`, `.cursor/mcp.json` |
| hooks | `hooks` in settings, PascalCase | `~/.codex/hooks.json`, PascalCase | `~/.cursor/hooks.json`, camelCase, `version: 1` |
| memory | `CLAUDE.md` | `AGENTS.md` | `.cursor/rules/*.mdc`, `.cursorrules` |

Yard never writes a file it did not read first. Every write is atomic, backed up under
`~/.yard/backups`, and available as `--dry-run`.

## Commands

```bash
yard scan [--client=] [--kind=]      # everything the clients will load
yard context [--probe]               # token cost per turn, and how to cut it
yard doctor [--probe]                # broken hooks, dead MCP servers, bad frontmatter; exit 1 on error
yard skill <name> on|name-only|user-invocable-only|off
yard plugin enable|disable <name>
yard mcp enable|disable <name>
yard serve [--port=4372]             # web UI and Streamable HTTP MCP
```

`--probe` starts your configured stdio MCP servers and asks each for its tool list. It is the only
honest way to price them, and it is off by default because it executes your commands.

Everything takes `--json`, `--dry-run`, `--client=`, and `--scope=user|project|local`.

### Skill visibility

Claude Code takes four values, and Yard writes them into `skillOverrides` for you:

| | in the model's listing | in the `/` picker |
|---|---|---|
| `on` | yes | yes |
| `name-only` | name only | yes |
| `user-invocable-only` | no | yes |
| `off` | no | no |

`user-invocable-only` is usually what you want for a skill you invoke by hand: it costs nothing per
turn and is still one keystroke away.

## Authoring

The repo is also a cross-client marketplace. `plugins/<name>` installs into all three clients.

```text
plugins/<name>/
  .claude-plugin/plugin.json    Claude Code
  .codex-plugin/plugin.json     Codex        mcpServers: "./.mcp.json"
  .cursor-plugin/plugin.json    Cursor       mcpServers inlined here
  .mcp.json                     Claude Code + Codex
  skills/<name>/SKILL.md        all three
  hooks/hooks.json              all three, PascalCase
  agents/  commands/
  plugin.json  mcp.json         Agent Plugins 1.0, forward compatibility only
```

Two things here are not what the ecosystem's own documentation suggests, and both were confirmed
against shipping plugins from Anthropic, OpenAI, and Cursor:

- **Plugin hooks are PascalCase in all three clients.** Cursor's own published plugins ship
  `SessionStart` and `${CLAUDE_PLUGIN_ROOT}`. The camelCase form with `version: 1` is a different
  surface — your own `.cursor/hooks.json` — and is not a plugin file.
- **Cursor reads MCP servers from `.cursor-plugin/plugin.json`,** not from `.mcp.json` or `mcp.json`.
  A plugin that ships MCP has to inline them there or Cursor installs it with no servers.

`npm run sync-mcp` writes all four MCP surfaces from one spec. `npm run validate` fails if they drift.

```bash
npm run adapt -- path/to/SKILL.md          # fill in the files a Claude-only skill is missing
npm run adapt -- path/to/claude-plugin --name=my-tool
```

The adapter only writes what is absent, so running it twice does nothing.

## As an MCP server

Yard exposes the same capabilities as tools, so the agent can audit and fix its own setup:
`env_inventory`, `env_context`, `env_doctor`, `env_set_skill`, `env_set_plugin`, `env_set_mcp`, plus
`catalog_search` and `plugin_adapt` for authoring.

```json
{ "mcpServers": { "yard": { "url": "http://127.0.0.1:4372/mcp" } } }
```

## A note on the numbers

Token counts are estimates. There is no published tokenizer for current Claude models, so Yard
approximates byte-pair segmentation rather than dividing by a constant, which would badly
under-count JSON. Expect roughly ±10% against a real tokenizer and consistent relative ordering —
enough to answer "what is eating my context", which is the question. Anything Yard did not measure
is labelled as an estimate everywhere it appears.

## Benchmarks

Both tables run against a setup generated fresh in a tmpdir, shaped like the one in "Why" — 457
skills (71 of them from plugins), 71 plugins, 10 MCP servers, 27 hooks, 34.8k estimated tokens per
turn — without touching anything you have configured.

### What each mode gives back

Measured by writing each mode into the generated settings and pricing the setup again with Yard's
own estimator — the same read path `yard context` takes on your machine. Token counts, not timings,
so they reproduce exactly. `bun run bench -- --savings`.

| | applied to | saved per turn |
|---|---|---|
| `yard skill <name> name-only` | 150 personal skills | 7.4k — 49 per skill |
| `yard skill <name> user-invocable-only` | 150 personal skills | 8.4k — 56 per skill |
| `yard skill <name> off` | 150 personal skills | 8.4k — identical |
| `yard plugin disable`, all 71 | 71 plugin skills | 4.1k — 58 per plugin |
| every live MCP server off | 6 servers | 7.2k (estimated) |

`user-invocable-only` saves exactly what `off` saves — the difference between the two is the `/`
picker, never tokens — which is why it is the right setting for anything you invoke by hand.
`name-only` keeps ~7 tokens of name per skill in the listing. The MCP row is not credited to
`yard mcp disable`: three of the six servers are Codex's, Codex owns its `config.toml`, and Yard
refuses to edit it. The unprobed flat estimates are labelled, as everywhere.

Measuring this found a bug, fixed here: disabling a plugin did not stop the ledger from billing
its skills, so `yard plugin disable` saved zero on paper until it saved 4.1k.

### How fast

Median of 7 runs after 2 warmups, full process wall time with stdout to `/dev/null`, on an 8-core
Neoverse-V3 (AWS Graviton), node v24, bun 1.3. `bun run bench` reproduces the first column,
`bun run bench -- --scale=10` the second.

| | 457 skills (node / bun) | 4,570 skills (node / bun) |
|---|---|---|
| `yard scan` | 118 / 92 ms | 393 / 228 ms |
| `yard context` | 126 / 102 ms | 446 / 296 ms |
| `yard doctor` | 119 / 92 ms | 396 / 231 ms |
| cold start (`--help`) | 68 / 59 ms | same |

The shape is a fixed floor plus a linear walk: ~90 ms of startup under node — 67 ms of it bare
runtime, the rest first reads — then ~30 ms for each further README-sized helping of config, half
that under bun. A tenfold setup costs 3.3× the wall clock because the floor amortises, not because
scanning gets cheaper per file.

Token estimation is never the slow part: the estimator runs at 30–36 MB/s single-threaded
(`bun scripts/bench-tokens.ts`), so pricing the whole 457-skill setup takes under a millisecond of
those 126 ms. `--probe` is deliberately not benchmarked: it starts your MCP servers, and its cost
is theirs.

## Development

```bash
bun install && bun install --cwd web
bun start          # http://127.0.0.1:4372
bun run test       # node:test on node via tsx — use `bun run test`, not `bun test`
bun run validate
bun run typecheck
bun run build
```

npm still works for all of it: `npm install && npm --prefix web install`, then the same scripts
through `npm run`. CI runs exactly that path, so neither runner can rot.

MIT.
