import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_FILES, validSlug } from './validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function regular(target, directory = false) {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) {
    throw new Error('unsafe-template-or-directory');
  }
}

// root is explicit for isolated tests; the CLI always uses its own repository.
export async function createProject(root, slug, name) {
  if (!validSlug(slug)) throw new Error('invalid-slug');
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/u.test(name)) {
    throw new Error('invalid-name');
  }
  const base = path.resolve(root);
  await regular(base, true);
  await regular(path.join(base, 'templates'), true);
  await regular(path.join(base, 'projects'), true);
  const copies = [];
  for (const file of PROJECT_FILES) {
    const input = path.join(base, 'templates', file);
    await regular(input);
    let contents = await fs.readFile(input, 'utf8');
    if (file === 'README.md') contents = contents.replaceAll('[название проекта]', () => name.trim());
    copies.push([file, contents]);
  }
  const descriptor = {
    schema_version: 1, slug, name: name.trim(), state: 'draft', version: '0.1',
    as_of: null, source_ref: null, editorial: 'unresolved', review: null,
    files: [...PROJECT_FILES],
  };
  const target = path.join(base, 'projects', slug);
  // Exclusive directory creation is the no-overwrite boundary. On a later IO
  // failure, retain the partial draft for inspection; never remove existing data.
  await fs.mkdir(target);
  for (const [file, contents] of copies) await fs.writeFile(path.join(target, file), contents, { flag: 'wx' });
  await fs.writeFile(path.join(target, 'project.json'), `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' });
  return slug;
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: node scripts/new-project.mjs <slug> "Название"');
    await createProject(ROOT, process.argv[2], process.argv[3]);
    console.log('Created draft. Fill and review the documents before changing its state.');
  } catch (error) {
    // Do not echo arbitrary user input, file contents, or filesystem error paths.
    const safe = ['invalid-slug', 'invalid-name', 'unsafe-template-or-directory'];
    console.error(safe.includes(error.message) ? error.message : 'Creation failed: check arguments, templates, and whether the project already exists.');
    process.exitCode = 1;
  }
}
