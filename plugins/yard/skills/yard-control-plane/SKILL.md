---
name: yard-control-plane
description: Operate the Yard marketplace control plane. Use when searching skills, hydrating artifacts, toggling dynamic mode, or attaching plugin MCP and hooks.
---

# Yard

Yard is the marketplace control plane. Clients launch it over stdio when this plugin is enabled. Do not paste HTTP MCP URLs unless the user is authoring in this repo.

## Dynamic mode

Off: every enabled artifact is readable.

On: `catalog_search` still returns the index. `catalog_get` stays closed until `session_hydrate` or `session_pin`. Hydrating a skill also marks that plugin’s hooks and MCP live in the Yard session. Dehydrate drops the body and cuts hooks/MCP when the plugin has nothing left on the floor.

Yard session IDs are not client hook stores or client MCP stores.

## Tools

1. `catalog_search` with a short query. Filter `kinds` when you know the type (`skill`, `rule`, `agent`, `command`, `hook`, `mcp`).
2. `session_hydrate` with the chosen ids. Read the returned bodies.
3. `session_dehydrate` when the work is done.
4. `catalog_reload` after files change on disk.

## Roots

Catalog root is `YARD_ROOT`, then a walk from `CLAUDE_PROJECT_DIR` / cwd for `.claude-plugin/marketplace.json`. Point `YARD_ROOT` at this marketplace when the plugin is running from a client cache copy.
