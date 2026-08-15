#!/usr/bin/env python3
"""Validate this repo against the Claude Code marketplace schema."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parents[1]
MARKETPLACE_PATH = ROOT / ".claude-plugin" / "marketplace.json"
MARKETPLACE_SCHEMA_PATH = ROOT / "schemas" / "claude-code-marketplace.json"
PLUGIN_SCHEMA_PATH = ROOT / "schemas" / "claude-code-plugin-manifest.json"

RESERVED_MARKETPLACE_NAMES = {
    "claude-code-marketplace",
    "claude-code-plugins",
    "claude-plugins-official",
    "claude-plugins-community",
    "claude-community",
    "anthropic-marketplace",
    "anthropic-plugins",
    "agent-skills",
    "anthropic-agent-skills",
    "knowledge-work-plugins",
    "life-sciences",
    "claude-for-legal",
    "claude-for-financial-services",
    "financial-services-plugins",
    "first-party-plugins",
    "healthcare",
}

REQUIRED_AGENT_FIELDS = ("name", "description")


def load_json(path: Path) -> object:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def parse_frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---"):
        raise ValueError("missing YAML frontmatter delimited by ---")

    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError("frontmatter is not closed with ---")

    fields: dict[str, str] = {}
    for raw_line in parts[1].splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip().strip("\"'")
    return fields


def resolve_plugin_root(entry: dict, plugin_root: str | None) -> Path:
    source = entry["source"]
    if not isinstance(source, str):
        raise ValueError("only relative-path plugin sources are supported in this repo")

    relative = Path(source)
    if plugin_root and not str(relative).startswith("./") and not relative.is_absolute():
        relative = Path(plugin_root) / relative
    return (ROOT / relative).resolve()


def collect_agent_files(plugin_dir: Path, manifest: dict) -> list[Path]:
    declared = manifest.get("agents")
    if declared is None:
        agents_dir = plugin_dir / "agents"
        return sorted(agents_dir.glob("*.md")) if agents_dir.is_dir() else []

    paths: list[Path] = []
    declared_paths = declared if isinstance(declared, list) else [declared]
    for item in declared_paths:
        candidate = (plugin_dir / item).resolve()
        if candidate.is_dir():
            paths.extend(sorted(candidate.glob("*.md")))
        else:
            paths.append(candidate)
    return paths


def main() -> int:
    errors: list[str] = []
    marketplace = load_json(MARKETPLACE_PATH)
    marketplace_schema = load_json(MARKETPLACE_SCHEMA_PATH)
    plugin_schema = load_json(PLUGIN_SCHEMA_PATH)

    for error in Draft7Validator(marketplace_schema).iter_errors(marketplace):
        errors.append(f"marketplace.json: {error.message} ({'/'.join(str(p) for p in error.path) or 'root'})")

    if not isinstance(marketplace, dict):
        print("marketplace.json must be an object", file=sys.stderr)
        return 1

    name = marketplace.get("name")
    if isinstance(name, str) and name in RESERVED_MARKETPLACE_NAMES:
        errors.append(f"marketplace name {name!r} is reserved by Anthropic")

    plugin_root = None
    metadata = marketplace.get("metadata")
    if isinstance(metadata, dict):
        plugin_root = metadata.get("pluginRoot")

    plugins = marketplace.get("plugins")
    if not isinstance(plugins, list):
        print("\n".join(errors) or "marketplace.json is missing plugins[]", file=sys.stderr)
        return 1

    seen_plugin_names: set[str] = set()
    catalog: list[tuple[str, str, str]] = []

    for index, entry in enumerate(plugins):
        if not isinstance(entry, dict):
            errors.append(f"plugins[{index}]: entry must be an object")
            continue

        plugin_name = entry.get("name")
        if not isinstance(plugin_name, str):
            errors.append(f"plugins[{index}]: missing name")
            continue
        if plugin_name in seen_plugin_names:
            errors.append(f"duplicate plugin name {plugin_name!r}")
        seen_plugin_names.add(plugin_name)

        try:
            plugin_dir = resolve_plugin_root(entry, plugin_root if isinstance(plugin_root, str) else None)
        except (KeyError, ValueError) as error:
            errors.append(f"{plugin_name}: {error}")
            continue

        manifest_path = plugin_dir / ".claude-plugin" / "plugin.json"
        if not manifest_path.is_file():
            errors.append(f"{plugin_name}: missing {manifest_path.relative_to(ROOT)}")
            continue

        manifest = load_json(manifest_path)
        for error in Draft7Validator(plugin_schema).iter_errors(manifest):
            location = "/".join(str(part) for part in error.path) or "root"
            errors.append(f"{manifest_path.relative_to(ROOT)}: {error.message} ({location})")

        if isinstance(manifest, dict) and manifest.get("name") != plugin_name:
            errors.append(
                f"{plugin_name}: plugin.json name {manifest.get('name')!r} does not match marketplace entry"
            )

        agent_files = collect_agent_files(plugin_dir, manifest if isinstance(manifest, dict) else {})
        if not agent_files:
            errors.append(f"{plugin_name}: no agent markdown files found")
            continue

        agent_names: set[str] = set()
        for agent_path in agent_files:
            relative = agent_path.relative_to(ROOT)
            if not agent_path.is_file():
                errors.append(f"{plugin_name}: missing agent file {relative}")
                continue
            try:
                fields = parse_frontmatter(agent_path.read_text(encoding="utf-8"))
            except ValueError as error:
                errors.append(f"{relative}: {error}")
                continue
            for field in REQUIRED_AGENT_FIELDS:
                if not fields.get(field):
                    errors.append(f"{relative}: frontmatter is missing {field}")
            agent_name = fields.get("name")
            if agent_name:
                if agent_name in agent_names:
                    errors.append(f"{plugin_name}: duplicate agent name {agent_name!r}")
                agent_names.add(agent_name)
                catalog.append((plugin_name, agent_name, fields.get("description", "")))

    if errors:
        print("Marketplace validation failed:\n", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"Marketplace {name} is valid.")
    print(f"Plugins: {len(seen_plugin_names)}")
    print(f"Agents:  {len(catalog)}")
    print()
    print(f"{'plugin':<16} {'agent':<16} description")
    print(f"{'-' * 16} {'-' * 16} {'-' * 40}")
    for plugin_name, agent_name, description in catalog:
        print(f"{plugin_name:<16} {agent_name:<16} {description}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
