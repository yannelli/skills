# yannelli/skills

Claude Code marketplace of **agent plugins**. Each plugin ships one or more
subagents under `agents/` and is listed in `.claude-plugin/marketplace.json`.

The catalog follows the [Claude Code marketplace schema](https://code.claude.com/docs/en/plugin-marketplaces)
and each plugin follows the [plugin manifest schema](https://code.claude.com/docs/en/plugins-reference#plugin-manifest-schema).

## Install

In Claude Code:

```text
/plugin marketplace add yannelli/skills
/plugin install code-review@yannelli-skills
```

Then invoke an agent with `@code-review:code-reviewer` (or the matching scoped
name for another plugin).

## Plugins

| Plugin | Agent | What it does |
| --- | --- | --- |
| `code-review` | `code-reviewer` | Reviews a diff for bugs, security issues, and convention drift |
| `debugger` | `debugger` | Isolates a failing test or stack trace and reports a root cause |
| `test-writer` | `test-writer` | Writes focused tests using the repo's existing runner |

## Layout

```text
.claude-plugin/marketplace.json   # marketplace catalog
plugins/
  <plugin>/
    .claude-plugin/plugin.json    # plugin manifest
    agents/<agent>.md             # subagent (YAML frontmatter + prompt)
schemas/                          # vendored SchemaStore copies
scripts/validate-marketplace.py   # schema + agent frontmatter checks
```

Relative plugin sources live in this repository so a git checkout of the
marketplace is enough. Do not point `source` at a URL unless the plugin is
published from another repo.

## Validate

```bash
python3 -m pip install --user jsonschema
python3 scripts/validate-marketplace.py
```

The script checks:

- `marketplace.json` against `schemas/claude-code-marketplace.json`
- each `plugin.json` against `schemas/claude-code-plugin-manifest.json`
- that every listed plugin exists and ships at least one agent
- that each agent file has `name` and `description` frontmatter

## Add an agent plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json` with a unique `name`.
2. Add `plugins/<name>/agents/<agent>.md` with `name` and `description` in the frontmatter.
3. Append a `plugins[]` entry in `.claude-plugin/marketplace.json` with `"source": "./plugins/<name>"`.
4. Run `python3 scripts/validate-marketplace.py`.
