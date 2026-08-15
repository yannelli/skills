# yannelli-skills

Cross-client marketplace for agent plugins: skills, rules, agents, commands, hooks.

Installable from Claude Code, Codex, and Cursor. Same plugin tree, three catalogs.

**Yard** is the local control plane: a Streamable HTTP MCP plus a web UI. Dynamic mode keeps skill bodies off the context window until you search and hydrate. Hydrate returns the file and activates that plugin’s hooks.

## Install the marketplace

```text
# Claude Code
/plugin marketplace add yannelli/skills
/plugin install hello@yannelli-skills

# Codex
codex plugin marketplace add yannelli/skills

# Cursor
# Team Marketplace → Import from Repo → https://github.com/yannelli/skills
# Local: ln -s "$(pwd)/plugins/hello" ~/.cursor/plugins/local/hello
```

## Run Yard

```bash
npm install
npm start
```

- UI: `http://127.0.0.1:4372`
- MCP: `http://127.0.0.1:4372/mcp`
- stdio: `npm start -- --stdio`

Point a client at the HTTP endpoint:

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

On: `catalog_search` still returns the index. `catalog_get` stays closed until `session_hydrate` or `session_pin`. Hydrating a skill also turns on that plugin’s hooks. Dehydrate drops the body and cuts hooks when the plugin has nothing left on the floor.

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
```

Do not put component dirs inside `.*-plugin/`.

## Checks

```bash
npm run validate
npm test
npm run typecheck
```
