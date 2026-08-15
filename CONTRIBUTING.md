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
7. `npm run validate && npm test`

Names are kebab-case. Marketplace id is `yannelli-skills`.
