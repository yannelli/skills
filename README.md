# yannelli-skills

Cross-client marketplace for agent plugins: skills, rules, agents, commands, hooks, and MCP.

Installable from Claude Code, Codex, and Cursor. Same plugin tree, three catalogs.

**Yard** is the control plane. Clients launch it over stdio when `yard@yannelli-skills` is enabled. Dynamic mode keeps skill bodies off the context window until you search and hydrate. Hydrate returns the file and marks that plugin’s hooks and MCP live in the Yard session.

## Install

```text
# Claude Code
/plugin marketplace add yannelli/skills
/plugin install yard@yannelli-skills

# Codex
codex plugin marketplace add yannelli/skills

# Cursor
# Team Marketplace → Import from Repo → https://github.com/yannelli/skills
```

Claude copies the plugin into its cache and starts `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js --stdio`. Codex uses `cwd: "."` against the installed plugin root. Cursor / Agent Plugins read `mcp.json`.

Set `YARD_ROOT` to this repository when Yard is running from a cache copy and the marketplace is not a parent of cwd.

`hello` and `review` are examples. `review` is meant to be searched, not preloaded.

### Adapt a Claude skill

A Claude-only `SKILL.md` or plugin is missing Codex, Cursor, and Agent Plugins files. The adapter writes only what is absent.

```bash
npm run adapt -- path/to/SKILL.md
npm run adapt -- path/to/claude-plugin --name=my-tool --no-register
```

Or Yard → Adapt, `POST /api/adapt`, or `plugin_adapt`. Claude hooks become Cursor hooks. `.mcp.json` becomes `mcp.json`. The four manifests are filled in. Existing files stay. Catalog registration happens only for a new `plugins/<name>` directory.

## Author mode

HTTP UI and Streamable HTTP MCP are for working in this repo.

```bash
npm install
npm start
```

- UI: `http://127.0.0.1:4372`
- MCP: `http://127.0.0.1:4372/mcp`
- stdio: `npm start -- --stdio`

```json
{
  "mcpServers": {
    "yard": {
      "url": "http://127.0.0.1:4372/mcp"
    }
  }
}
```

### Dynamic mode

Off: every enabled artifact is readable.

On: `catalog_search` still returns the index. `catalog_get` stays closed until `session_hydrate` or `session_pin`. Hydrating a skill also turns on that plugin’s hooks and MCP in the Yard session. Dehydrate drops the body and cuts them when the plugin has nothing left on the floor.

Yard session IDs are not client hook stores or client MCP stores.

## Layout

```text
.claude-plugin/marketplace.json
.agents/plugins/marketplace.json
.cursor-plugin/marketplace.json
plugins/<name>/
  plugin.json                 Agent Plugins 1.0
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  .cursor-plugin/plugin.json
  skills/<name>/SKILL.md
  rules/  agents/  commands/
  hooks/hooks.json            Cursor
  hooks/claude-hooks.json     Claude / Codex
  .mcp.json                   Claude / Codex
  mcp.json                    Agent Plugins / Cursor
plugins/yard/dist/cli.js      bundled stdio server
plugins/yard/public/          built shadcn UI
```

Do not put component dirs inside `.*-plugin/`. Do not symlink `.mcp.json` to `mcp.json`. The schemas disagree. `npm run sync-mcp` writes both from one spec.

## Checks

```bash
npm run validate
npm test
npm run typecheck
npm run build
```
