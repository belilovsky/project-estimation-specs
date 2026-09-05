import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createProject } from './new-project.mjs';
import { PROJECT_FILES, ROOT_FILES, EXTERNAL_FILES, digestProject, validateRepository, verifyExternal } from './validate.mjs';

const exec = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));
const temporary = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const totals = { positive: 0, negative: 0 };

function document(file, draft) {
  const boundary = { 'brief.md': 7, 'editorial.md': 6, 'risks.md': 4 }[file];
  const heading = draft ? '# [название проекта]\n\n' : '# Synthetic project\n\n';
  if (!boundary) return `${heading}${draft ? '[заполнить] [публичный контакт]' : 'A finite synthetic example.'}\n\n[Brief](brief.md)\n`;
  return heading + Array.from({ length: boundary - 1 }, (_, i) => `## ${i + 1}. Author section\n\n${draft ? '[заполнить]' : 'One finite result and an acceptance check.'}\n\n`).join('')
    + `## ${boundary}. Bidder response\n\n[заполнить]\n`;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-spec-test-'));
  temporary.push(root);
  for (const folder of ['projects', 'templates', 'docs', 'scripts']) await fs.mkdir(path.join(root, folder));
  for (const file of ROOT_FILES) await fs.writeFile(path.join(root, file), '# Synthetic fixture\n');
  for (const file of PROJECT_FILES) await fs.writeFile(path.join(root, 'templates', file), document(file, true));
  for (const file of ['new-project.mjs', 'validate.mjs', 'test.mjs']) await fs.copyFile(path.join(scripts, file), path.join(root, 'scripts', file));
  await createProject(root, 'sample', 'Synthetic project');
  return root;
}

const projectPath = root => path.join(root, 'projects', 'sample', 'project.json');
async function readProject(root) { return JSON.parse(await fs.readFile(projectPath(root), 'utf8')); }
async function writeProject(root, project) { await fs.writeFile(projectPath(root), `${JSON.stringify(project, null, 2)}\n`); }
async function mutate(root, action) {
  const project = await readProject(root);
  action(project);
  await writeProject(root, project);
}

async function publish(root) {
  for (const file of PROJECT_FILES) await fs.writeFile(path.join(root, 'projects', 'sample', file), document(file, false));
  const digest = await digestProject(path.join(root, 'projects', 'sample'), PROJECT_FILES);
  await mutate(root, project => Object.assign(project, {
    state: 'published-example', as_of: '2026-09-05', source_ref: 'https://github.com/example/product/tree/1234567890abcdef1234567890abcdef12345678', editorial: 'included',
    review: { by: 'Fixture reviewer', at: '2026-09-05', scope: 'Synthetic structural check only', manifest_sha256: digest },
  }));
}

function remoteFixture() {
  const bytes = new Map(EXTERNAL_FILES.map(file => [file, Buffer.from(`Synthetic remote bytes: ${file}\n`)]));
  const manifest = { version: '1.2', date: '2026-09-05', source_revision: '1'.repeat(40), files: Object.fromEntries([...bytes].map(([file, value]) => [file, sha256(value)])) };
  const project = {
    schema_version: 1, slug: 'sample', name: 'Synthetic external', state: 'published-example', version: '1.2', as_of: '2026-09-05',
    source_ref: `https://github.com/example/spec/blob/${'2'.repeat(40)}/methodology.md`, editorial: 'included', review: null, files: ['README.md'],
    external: { repository: 'https://github.com/example/spec', commit: '2'.repeat(40), entrypoint: 'README.md', manifest: 'manifest.json', manifest_sha256: '' },
  };
  const tree = { truncated: false, tree: [...EXTERNAL_FILES, 'manifest.json'].map(file => ({ path: file, type: 'blob', mode: '100644' })) };
  let calls = 0;
  const raw = `https://raw.githubusercontent.com/example/spec/${project.external.commit}/`;
  const api = `https://api.github.com/repos/example/spec/git/trees/${project.external.commit}?recursive=1`;
  const sync = () => {
    bytes.set('manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`));
    project.external.manifest_sha256 = sha256(bytes.get('manifest.json'));
  };
  sync();
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    if (url === api) return new Response(JSON.stringify(tree));
    if (url.startsWith(raw) && bytes.has(url.slice(raw.length))) return new Response(bytes.get(url.slice(raw.length)));
    throw new Error('Unexpected fixture URL; real network access is disabled.');
  };
  return { project, bytes, manifest, tree, fetchImpl, sync, calls: () => calls };
}

async function installExternal(root, remote) {
  for (const file of PROJECT_FILES.filter(file => file !== 'README.md')) await fs.unlink(path.join(root, 'projects', 'sample', file));
  await fs.writeFile(path.join(root, 'projects', 'sample', 'README.md'), '# Synthetic external descriptor\n\nPinned external example; not locally reviewed.\n');
  await writeProject(root, remote.project);
}

async function positive(label, action) { await action(); totals.positive++; console.log(`PASS positive: ${label}`); }
async function negative(label, code, change, { published = false } = {}) {
  const root = await fixture();
  if (published) await publish(root);
  await change(root);
  const result = await validateRepository(root);
  assert.equal(result.ok, false, label);
  assert(result.findings.some(item => item.code === code), `${label}: expected ${code}; received ${result.findings.map(item => item.code).join(', ')}`);
  totals.negative++;
  console.log(`PASS negative: ${label}`);
}

try {
  await positive('draft creation and offline validation', async () => {
    const root = await fixture();
    const result = await validateRepository(root, { fetchImpl: async () => { throw new Error('Offline mode attempted network'); } });
    assert(result.ok, JSON.stringify(result.findings));
    assert.equal((await readProject(root)).state, 'draft');
    assert.equal(result.external_mode, 'descriptor-only-not-remote-proof');
    assert.equal(await fs.readFile(path.join(root, 'projects/sample/brief.md'), 'utf8'), await fs.readFile(path.join(root, 'templates/brief.md'), 'utf8'));
    assert((await fs.readFile(path.join(root, 'projects/sample/README.md'), 'utf8')).includes('Synthetic project'));
  });
  await positive('published local plus unfilled bidder sections', async () => {
    const root = await fixture();
    await publish(root);
    const result = await validateRepository(root);
    assert(result.ok, JSON.stringify(result.findings));
  });
  await positive('needs-update can retain a superseded review', async () => {
    const root = await fixture();
    await publish(root);
    await mutate(root, project => { project.state = 'needs-update'; });
    await fs.appendFile(path.join(root, 'projects/sample/brief.md'), '\nChanged scope awaiting review.\n');
    assert((await validateRepository(root)).ok);
  });
  await positive('read-only CLI digest and validator', async () => {
    const root = await fixture();
    const before = await fs.readFile(projectPath(root));
    const result = await exec(process.execPath, [path.join(root, 'scripts/validate.mjs'), '--digest', 'sample'], { cwd: os.tmpdir() });
    assert.equal(result.stdout.trim(), await digestProject(path.join(root, 'projects/sample'), PROJECT_FILES));
    assert.deepEqual(await fs.readFile(projectPath(root)), before);
    const validation = await exec(process.execPath, [path.join(root, 'scripts/validate.mjs')], { cwd: os.tmpdir() });
    assert.equal(JSON.parse(validation.stdout).ok, true);
  });
  await positive('CLI new-project resolves script root, not cwd', async () => {
    const root = await fixture();
    await exec(process.execPath, [path.join(root, 'scripts/new-project.mjs'), 'second-project', 'Second synthetic'], { cwd: os.tmpdir() });
    assert.equal((await validateRepository(root)).projects, 2);
  });
  await positive('external offline descriptor does not fetch', async () => {
    const root = await fixture();
    const remote = remoteFixture();
    await installExternal(root, remote);
    assert((await validateRepository(root, { fetchImpl: remote.fetchImpl })).ok);
    assert.equal(remote.calls(), 0);
  });
  await positive('external explicit remote hashes and exact tree', async () => {
    const root = await fixture();
    const remote = remoteFixture();
    await installExternal(root, remote);
    const result = await validateRepository(root, { remote: true, fetchImpl: remote.fetchImpl });
    assert(result.ok, JSON.stringify(result.findings));
    assert.equal(result.remote_checked, 1);
    assert.equal(remote.calls(), 24);
  });
  await positive('excluded editorial has a stated reason', async () => {
    const root = await fixture();
    await publish(root);
    await mutate(root, project => Object.assign(project, { editorial: 'excluded', editorial_note: 'Synthetic tool has no authored content; interface text is in the scope.' }));
    assert((await validateRepository(root)).ok);
  });

  for (const slug of ['../escape', 'Uppercase', 'bad--slug', 'a'.repeat(65), '']) {
    const root = await fixture();
    await assert.rejects(createProject(root, slug, 'Fixture'), /invalid-slug/u);
    totals.negative++;
    console.log('PASS negative: unsafe slug refused');
  }
  await positive('no overwrite preserves existing bytes', async () => {
    const root = await fixture();
    const before = await fs.readFile(projectPath(root));
    await assert.rejects(createProject(root, 'sample', 'Replacement'));
    assert.deepEqual(await fs.readFile(projectPath(root)), before);
  });
  await negative('unknown state', 'descriptor-state', root => mutate(root, project => { project.state = 'ready'; }));
  await negative('unknown schema field', 'descriptor-fields', root => mutate(root, project => { project.extra = true; }));
  await negative('null descriptor', 'descriptor-fields', root => writeProject(root, null));
  await negative('slug mismatch', 'descriptor-identity', root => mutate(root, project => { project.slug = 'different'; }));
  await negative('duplicate declared file', 'descriptor-files', root => mutate(root, project => { project.files.push('README.md'); }));
  await negative('descriptor path escape', 'descriptor-files', root => mutate(root, project => { project.files[0] = '../README.md'; }));
  await negative('missing project file', 'project-missing-file', root => fs.unlink(path.join(root, 'projects/sample/brief.md')));
  await negative('hidden extra project file', 'project-unknown-file', root => fs.writeFile(path.join(root, 'projects/sample/.notes'), 'Synthetic note'));
  await negative('extra root file', 'repository-unknown-file', root => fs.writeFile(path.join(root, 'unlisted.md'), '# Extra'));
  await negative('missing required root file', 'repository-required-file-missing', root => fs.unlink(path.join(root, 'scripts/test.mjs')));
  await negative('forbidden file', 'forbidden-file', root => fs.writeFile(path.join(root, 'projects/sample', '.env'), 'Synthetic fixture'));
  await negative('symlink cannot make a published file', 'symlink', async root => {
    await fs.unlink(path.join(root, 'projects/sample/brief.md'));
    await fs.symlink(path.join(root, 'templates/brief.md'), path.join(root, 'projects/sample/brief.md'));
  });
  await negative('private absolute path', 'private-or-secret-pattern', root => fs.appendFile(path.join(root, 'README.md'), ['', 'Users', 'synthetic', 'private.md'].join('/')));
  await negative('potential token not echoed in findings', 'private-or-secret-pattern', async root => {
    const value = ['gh', 'p_'].join('') + 'x'.repeat(30);
    await fs.appendFile(path.join(root, 'README.md'), value);
    const result = await validateRepository(root);
    assert(!JSON.stringify(result).includes(value));
  });
  await negative('missing local link in template', 'link-missing', root => fs.appendFile(path.join(root, 'templates/README.md'), '\n[Missing](absent.md)\n'));
  await negative('encoded link escape', 'link-escape', root => fs.appendFile(path.join(root, 'README.md'), '\n[Escape](%2e%2e/outside.md)\n'));
  await negative('unsupported link scheme', 'link-unsafe', root => fs.appendFile(path.join(root, 'README.md'), '\n[Unsafe](javascript:alert)\n'));
  await negative('draft incorrectly declared published', 'published-review', root => mutate(root, project => { project.state = 'published-example'; }));
  await negative('calendar-invalid date', 'descriptor-date', root => mutate(root, project => { project.as_of = '2026-02-30'; }), { published: true });
  await negative('non-public source', 'descriptor-source', root => mutate(root, project => { project.source_ref = 'https://127.0.0.1/source'; }), { published: true });
  await negative('unresolved editorial', 'published-editorial', root => mutate(root, project => { project.editorial = 'unresolved'; }), { published: true });
  await negative('excluded editorial without reason', 'published-editorial', root => mutate(root, project => { project.editorial = 'excluded'; }), { published: true });
  await negative('stale review digest', 'review-digest-mismatch', root => fs.appendFile(path.join(root, 'projects/sample/README.md'), '\nChanged bytes.\n'), { published: true });
  await negative('author placeholder', 'published-placeholder', root => fs.appendFile(path.join(root, 'projects/sample/README.md'), '\n[заполнить]\n'), { published: true });
  await negative('inherited named author field', 'published-template-field', root => fs.appendFile(path.join(root, 'projects/sample/README.md'), '\n[публичный контакт]\n'), { published: true });
  await negative('missing author section', 'published-author-section', root => fs.writeFile(path.join(root, 'projects/sample/brief.md'), '# Synthetic\n\n## 7. Bidder\n\n[заполнить]\n'), { published: true });
  await negative('missing bidder boundary', 'published-bidder-boundary', root => fs.writeFile(path.join(root, 'projects/sample/brief.md'), '# Synthetic\n\nCompleted prose only.\n'), { published: true });
  await negative('hash array is not a string', 'descriptor-review', root => mutate(root, project => { project.review.manifest_sha256 = [project.review.manifest_sha256]; }), { published: true });
  await negative('external mutable branch', 'descriptor-external', async root => {
    const remote = remoteFixture();
    remote.project.external.commit = 'main';
    await installExternal(root, remote);
  });
  await negative('external remote host restriction', 'descriptor-external', async root => {
    const remote = remoteFixture();
    remote.project.external.repository = 'https://127.0.0.1/repo';
    await installExternal(root, remote);
  });
  for (const [label, change, pattern] of [
    ['changed manifest bytes', remote => remote.bytes.set('manifest.json', Buffer.from('{}')), /remote-manifest-hash/u],
    ['changed remote file', remote => remote.bytes.set('brief.md', Buffer.from('Changed')), /remote-file-hash/u],
    ['extra remote tree file', remote => remote.tree.tree.push({ path: 'extra.md', type: 'blob', mode: '100644' }), /remote-tree/u],
    ['remote symlink', remote => { remote.tree.tree[0].mode = '120000'; }, /remote-tree/u],
    ['truncated remote tree', remote => { remote.tree.truncated = true; }, /remote-tree/u],
    ['unsafe manifest filename', remote => { remote.manifest.files['../escape'] = '0'.repeat(64); remote.sync(); }, /remote-manifest-schema/u],
    ['mismatched remote version', remote => { remote.manifest.version = '9.9'; remote.sync(); }, /remote-manifest-schema/u],
  ]) {
    const remote = remoteFixture();
    change(remote);
    await assert.rejects(verifyExternal(remote.project, remote.fetchImpl), pattern);
    totals.negative++;
    console.log(`PASS negative: ${label}`);
  }
  console.log(JSON.stringify({ status: 'PASS', ...totals, network: 'synthetic-fetch-only', real_repository_mutations: 0 }));
} finally {
  // Exact directories created by this test run only; no globs or repo cleanup.
  for (const root of temporary) await fs.rm(root, { recursive: true, force: true });
}
