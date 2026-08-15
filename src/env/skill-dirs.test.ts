import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectSkillDirs } from './skill-dirs.js';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'yard-skill-dirs-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A skill is a directory holding a SKILL.md; nothing else here cares about its contents. */
async function putSkill(root: string, ...segments: string[]): Promise<string> {
  const dir = path.join(root, ...segments);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nBody.\n', 'utf8');
  return dir;
}

function sorted(dirs: string[]): string[] {
  return [...dirs].sort();
}

test('finds skills at the default skills/<name> depth', async () => {
  await withRoot(async (root) => {
    const alpha = await putSkill(root, 'skills', 'alpha');
    const beta = await putSkill(root, 'skills', 'beta');
    assert.deepEqual(await collectSkillDirs(root), sorted([alpha, beta]));
  });
});

test('finds skills grouped into category folders', async () => {
  await withRoot(async (root) => {
    const flat = await putSkill(root, 'skills', 'flat');
    const tdd = await putSkill(root, 'skills', 'engineering', 'tdd');
    const prose = await putSkill(root, 'skills', 'writing', 'prose');
    assert.deepEqual(await collectSkillDirs(root), sorted([flat, tdd, prose]));
  });
});

test('follows a manifest that declares skills as a string path', async () => {
  await withRoot(async (root) => {
    const deploy = await putSkill(root, 'packs', 'deploy');
    assert.deepEqual(await collectSkillDirs(root, './packs'), [deploy]);
    // Without the manifest there is no skills/ directory to walk, so the same
    // tree yields nothing — the declaration is what makes it visible.
    assert.deepEqual(await collectSkillDirs(root), []);
  });
});

test('follows a manifest that declares an array of explicit nested paths', async () => {
  await withRoot(async (root) => {
    const tdd = await putSkill(root, 'library', 'engineering', 'tdd');
    const prose = await putSkill(root, 'library', 'writing', 'prose');
    await putSkill(root, 'library', 'writing', 'undeclared');

    const found = await collectSkillDirs(root, [
      './library/engineering/tdd',
      42,
      './library/writing/prose'
    ]);
    assert.deepEqual(found, sorted([tdd, prose]));
  });
});

test('a declared path that the default walk already found is not listed twice', async () => {
  await withRoot(async (root) => {
    const tdd = await putSkill(root, 'skills', 'engineering', 'tdd');
    assert.deepEqual(await collectSkillDirs(root, ['./skills/engineering/tdd']), [tdd]);
  });
});

test('an array entry may point at a directory that holds several skills', async () => {
  await withRoot(async (root) => {
    const one = await putSkill(root, 'extra', 'one');
    const two = await putSkill(root, 'extra', 'two');
    assert.deepEqual(await collectSkillDirs(root, ['./extra']), sorted([one, two]));
  });
});

test('skips node_modules, .git, and dot-directories', async () => {
  await withRoot(async (root) => {
    const real = await putSkill(root, 'skills', 'real');
    await putSkill(root, 'skills', 'node_modules', 'some-package');
    await putSkill(root, 'skills', '.git', 'objects');
    await putSkill(root, 'skills', '.hidden');
    assert.deepEqual(await collectSkillDirs(root), [real]);
  });
});

test('a skill’s own bundled subdirectories are not extra skills', async () => {
  await withRoot(async (root) => {
    const writer = await putSkill(root, 'skills', 'writer');
    await putSkill(root, 'skills', 'writer', 'references');
    await putSkill(root, 'skills', 'writer', 'examples', 'deep');
    assert.deepEqual(await collectSkillDirs(root), [writer]);
  });
});

test('stops descending four levels below skills/', async () => {
  await withRoot(async (root) => {
    const reachable = await putSkill(root, 'skills', 'a', 'b', 'c', 'd');
    await putSkill(root, 'skills', 'p', 'q', 'r', 's', 't');
    assert.deepEqual(await collectSkillDirs(root), [reachable]);
  });
});

test('a directory that does not exist yields nothing', async () => {
  await withRoot(async (root) => {
    const absent = path.join(root, 'no-such-plugin');
    assert.deepEqual(await collectSkillDirs(absent), []);
    assert.deepEqual(await collectSkillDirs(absent, './skills'), []);
    assert.deepEqual(await collectSkillDirs(absent, ['./skills/one', './skills/two']), []);
  });
});
