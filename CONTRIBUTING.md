# Add a plugin

1. Copy `templates/plugin` to `plugins/<name>`, or use Yard → New plugin, or `POST /api/plugins`.
2. Replace `PLUGIN_NAME` / `PLUGIN_DESCRIPTION`. Rename `skills/PLUGIN_NAME`.
3. Register the same name + `./plugins/<name>` source in all three catalogs:
   - `.claude-plugin/marketplace.json`
   - `.agents/plugins/marketplace.json` (needs `policy` + `category`)
   - `.cursor-plugin/marketplace.json`
4. Keep the four manifests’ `name` and `version` in sync.
5. Every `SKILL.md` needs `name` and `description` frontmatter.
6. Cursor hooks live in `hooks/hooks.json`. Claude/Codex hooks live in `hooks/claude-hooks.json` and are pointed at from those manifests. Do not share one file.
7. If the plugin ships MCP, write both `.mcp.json` and `mcp.json` with the same server keys. Claude needs `${CLAUDE_PLUGIN_ROOT}` in args. Agent Plugins needs `$schema`, an explicit `type`, and `./` paths. Codex can inline `mcpServers` with `cwd: "."`. Run `npm run sync-mcp` for Yard.
8. `npm run validate && npm test`

Names are kebab-case. Marketplace id is `yannelli-skills`.

The UI lives in `web/` (Vite + latest shadcn). `npm run build:web` writes `plugins/yard/public`.

Embeddings search is off until `OPENROUTER_API_KEY` is set and Embeddings is enabled. Vectors live in `.yard/embeddings/` and are gitignored.
