import { cp, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_MARKETPLACE,
  CODEX_MARKETPLACE,
  CURSOR_MARKETPLACE,
  PLUGINS_DIR,
  TEMPLATE_DIR
} from './paths.js';

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type NewPlugin = {
  name: string;
  description: string;
};

export async function createPlugin(input: NewPlugin): Promise<string> {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!NAME_RE.test(name)) {
    throw new Error('plugin name must be kebab-case');
  }
  if (!description) {
    throw new Error('description is required');
  }

  const dest = path.join(PLUGINS_DIR, name);
  await cp(TEMPLATE_DIR, dest, { recursive: true, errorOnExist: true });
  await replaceInTree(dest, { PLUGIN_NAME: name, PLUGIN_DESCRIPTION: description });
  await rename(path.join(dest, 'skills', 'PLUGIN_NAME'), path.join(dest, 'skills', name));
  await addCatalogEntries(name, description);
  return dest;
}

async function replaceInTree(root: string, vars: Record<string, string>): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!(await stat(full)).isFile()) {
        continue;
      }
      const raw = await readFile(full, 'utf8');
      let next = raw;
      for (const [key, value] of Object.entries(vars)) {
        next = next.split(key).join(value);
      }
      if (next !== raw) {
        await writeFile(full, next);
      }
    }
  };
  await walk(root);
}

export async function addCatalogEntries(name: string, description: string): Promise<boolean> {
  const claude = JSON.parse(await readFile(CLAUDE_MARKETPLACE, 'utf8')) as {
    plugins: Array<Record<string, unknown>>;
  };
  const codex = JSON.parse(await readFile(CODEX_MARKETPLACE, 'utf8')) as {
    plugins: Array<Record<string, unknown>>;
  };
  const cursor = JSON.parse(await readFile(CURSOR_MARKETPLACE, 'utf8')) as {
    plugins: Array<Record<string, unknown>>;
  };

  let added = false;
  if (!hasNamedPlugin(claude.plugins, name)) {
    claude.plugins.push({
      name,
      source: `./plugins/${name}`,
      description,
      version: '0.1.0',
      author: { name: 'Ryan Yannelli', email: 'ryanyannelli@gmail.com' },
      category: 'uncategorized',
      tags: [name],
      license: 'MIT'
    });
    await writeFile(CLAUDE_MARKETPLACE, `${JSON.stringify(claude, null, 2)}\n`);
    added = true;
  }

  if (!hasNamedPlugin(codex.plugins, name)) {
    codex.plugins.push({
      name,
      source: { source: 'local', path: `./plugins/${name}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity'
    });
    await writeFile(CODEX_MARKETPLACE, `${JSON.stringify(codex, null, 2)}\n`);
    added = true;
  }

  if (!hasNamedPlugin(cursor.plugins, name)) {
    cursor.plugins.push({
      name,
      source: `./plugins/${name}`,
      description,
      version: '0.1.0',
      category: 'uncategorized',
      tags: [name]
    });
    await writeFile(CURSOR_MARKETPLACE, `${JSON.stringify(cursor, null, 2)}\n`);
    added = true;
  }

  return added;
}

function hasNamedPlugin(plugins: Array<Record<string, unknown>>, name: string): boolean {
  return plugins.some((plugin) => plugin.name === name);
}
