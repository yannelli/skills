---
name: yard-control-plane
description: Audit and change the user's agent setup across Claude Code, Codex, and Cursor. Use when asked what is loaded, what is eating the context window, why a hook or MCP server is not working, or to enable/disable a skill, plugin, or MCP server.
---

# Yard

Yard reads the user's real configuration for all three clients and can change it. It is not limited
to this repository.

## When to reach for it

- "why is my context window so full" → `env_context`
- "what skills/plugins/MCP servers do I have" → `env_inventory`
- "my hook isn't firing" / "this MCP server won't start" → `env_doctor`
- "turn off X" → `env_set_skill`, `env_set_plugin`, `env_set_mcp`

## Reading

`env_inventory` returns counts plus a bounded list. Filter with `client` and `kind` rather than
pulling everything — there are often several hundred skills.

`env_context` prices what enters the context window every turn: skill listing lines, MCP tool
schemas, subagent descriptions, slash commands, and memory files. Numbers are estimates and are
labelled as such.

`env_doctor` finds hooks pointing at deleted scripts, MCP servers that fail to start, skills with
missing or truncated frontmatter, plugins enabled but not installed, and duplicate skill names.

`probe: true` on either one starts the user's configured stdio MCP servers to read their real tool
lists. That executes their commands, so only pass it when the user asked for real numbers, and say
that is what you are doing.

## Changing

Every mutating tool takes `dryRun`. Use it first when the change is not trivially reversible, show
the user what would change, then apply.

Writes are atomic and backed up to `~/.yard/backups`, and each result names the file that changed.

Skill visibility is the main lever for context, and only Claude Code has all four values:

- `on` — name and description in the listing
- `name-only` — name only, description dropped
- `user-invocable-only` — invisible to the model, still available from `/`
- `off` — gone

`user-invocable-only` is usually the right suggestion for a skill the user triggers by hand: it
costs nothing per turn and stays one keystroke away. Prefer it over `off` unless they want it gone.

If a name exists in more than one client the call fails and names the candidates. Pass `client`.

Codex owns `~/.codex/config.toml`, so MCP changes there are refused with the `codex mcp` command to
run instead — rewriting that file would destroy the user's comments and ordering.

## Authoring

`catalog_search` and `catalog_get` browse this marketplace's own plugins. `plugin_adapt` fills in
the files a Claude-only skill or plugin is missing for Codex and Cursor; it only writes what is
absent.

One thing worth knowing when editing plugins: plugin hooks are a single PascalCase `hooks/hooks.json`
that all three clients read. The camelCase `version: 1` form belongs to the user's own
`.cursor/hooks.json` and is not a plugin file. Cursor also reads plugin MCP servers from
`.cursor-plugin/plugin.json`, not from `.mcp.json`.
