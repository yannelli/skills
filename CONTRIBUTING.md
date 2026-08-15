# Contributing

## Add a plugin

1. `yard new <name> "<description>"`, or copy `templates/plugin` to `plugins/<name>`, or use the
   Author tab. To import a Claude-only skill or plugin, `npm run adapt -- <path>` — it writes the
   files that are missing and leaves existing ones alone.
2. Replace `PLUGIN_NAME` / `PLUGIN_DESCRIPTION`. Rename `skills/PLUGIN_NAME`.
3. Register the same name and `./plugins/<name>` source in all three catalogs:
   `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` (needs `policy` and
   `category`), `.cursor-plugin/marketplace.json`.
4. Keep `name` and `version` in sync across the four manifests.
5. Every `SKILL.md` needs `name` and `description` frontmatter.
6. `npm run validate && npm test`

Names are kebab-case. The marketplace id is `yannelli-skills`.

## The cross-client rules that are easy to get wrong

These were confirmed against shipping plugins from Anthropic, OpenAI, and Cursor, and each one
contradicts a reasonable reading of the published docs.

**Plugin hooks go in one file: `hooks/hooks.json`, PascalCase.** All three clients read it, with
`${CLAUDE_PLUGIN_ROOT}` in commands. Cursor's own published plugins ship exactly this. Do not add a
`hooks/claude-hooks.json`, and do not use camelCase event names — `validate` rejects both.

The camelCase form (`{"version": 1, "hooks": {"afterFileEdit": [...]}}`) belongs to a different
surface: the developer's own `~/.cursor/hooks.json` or `.cursor/hooks.json`. It is not a plugin file.
Its events are also genuinely different — `beforeShellExecution`, `afterFileEdit`, `beforeMCPExecution`
have no Claude counterpart, and Claude's `Notification` and `PermissionRequest` have no Cursor one.
The converters drop what has no counterpart and tell you what they dropped, rather than inventing a
name that would never fire.

**MCP lives in three places, from one source.**

- `.mcp.json` — Claude Code and Codex both load it.
- `.cursor-plugin/plugin.json` — Cursor reads `mcpServers` from the manifest itself and loads
  neither MCP file. A plugin that ships MCP must inline them here, without `${CLAUDE_PLUGIN_ROOT}`,
  which Cursor does not expand.
- `.codex-plugin/plugin.json` — points `mcpServers` at `"./.mcp.json"`, the way OpenAI's own plugins do.

`mcp.json` at the plugin root is Agent Plugins 1.0 compliance. No shipping client reads it today; it
is kept for forward compatibility and is optional.

Run `npm run sync-mcp` to write all four from one spec in `src/mcp-spec.ts`. `npm run validate`
fails if they drift, if Cursor is missing the inline block, or if the inline block leaks
`${CLAUDE_PLUGIN_ROOT}`.

**Skills can be nested.** A manifest's `skills` may be a directory string or an array of explicit
paths, and real plugins group them (`./skills/engineering/tdd`). Anything walking a plugin must use
`collectSkillDirs`, not a single `listDirs`.

## Working on Yard itself

```text
src/env/          the environment layer: reads and writes real client config
  client-paths.ts every on-disk location, per client
  claude.ts       codex.ts   cursor.ts
  inventory.ts    one merged view
  context.ts      what it all costs per turn
  doctor.ts       what is broken
  actions.ts      one entry point for every mutation
  probe.ts        starts stdio MCP servers to price their tool schemas
  safe-io.ts      atomic writes, backups, JSONC
src/cli/          command-line surface
src/http.ts       HTTP API      src/mcp.ts   MCP tools
web/              Vite + shadcn UI, builds to plugins/yard/public
```

Three rules hold everywhere in `src/env`:

1. **A scan never throws.** A malformed file becomes a `ScanWarning` and the scan continues. One
   broken config must not blank the inventory — that is exactly when someone needs it.
2. **Every write is atomic, backed up, and dry-runnable.** Go through `safe-io`, never `fs.writeFile`.
   Preserve the file's existing indentation so Yard's edits are not whole-file reformats.
3. **Never write a path that did not come from a `*Paths()` helper.**

Codex is a deliberate exception: Yard reads `config.toml` with its own small parser but delegates
writes to `codex mcp add|remove`, because round-tripping TOML would destroy the comments and
ordering in a file people hand-edit.

Tests use `node:test` and point the whole layer at a fixture tree with `YARD_HOME`. No test may
touch a real `~/.claude`, `~/.codex`, or `~/.cursor`, or probe a real MCP server.

```bash
npm test
npm run validate
npm run typecheck
npm run build
```

The UI lives in `web/`. `npm run build:web` writes `plugins/yard/public`, which is committed.
