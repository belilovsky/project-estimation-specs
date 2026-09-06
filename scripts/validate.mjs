import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_FILES = Object.freeze(['README.md', 'brief.md', 'editorial.md', 'risks.md']);
export const ROOT_FILES = Object.freeze([
  'README.md', 'methodology.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CHANGELOG.md', 'LICENSE', '.gitignore',
  'docs/preparing-a-project.md', 'docs/maintaining.md',
  ...PROJECT_FILES.map(file => `templates/${file}`),
  'scripts/new-project.mjs', 'scripts/validate.mjs', 'scripts/test.mjs',
]);
export const EXTERNAL_FILES = Object.freeze([
  'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'bidder-form.md', 'brief.md',
  'contracts.md', 'corpus-volumes.md', 'corpus.csv', 'editorial-operations.md', 'editorial.md',
  'extract-demo.mjs', 'extraction-demo.json', 'fixtures.json', 'measurement-metadata.json',
  'methodology.md', 'reuse-ledger.json', 'reuse.md', 'risks.md', 'validate.mjs',
  'verify-corpus.mjs', 'work-register.md',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const validHash = value => typeof value === 'string' && hashPattern.test(value);
const validCommit = value => typeof value === 'string' && commitPattern.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = value => typeof value === 'string' && value.trim().length > 0;
const exact = (value, required, optional = []) => object(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => [...required, ...optional].includes(key));
const sameSet = (left, right) => Array.isArray(left) && left.length === right.length
  && new Set(left).size === left.length && right.every(item => left.includes(item));
export const validSlug = value => typeof value === 'string' && value.length <= 64
  && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// A normalized synthetic quotation check, not a parser of free-form bids or a
// price recommendation. Amounts are exact minor units on the same tax basis.
export function checkReplacementQuote({ baseIds, removeIds, packages, replacement, fullAlternative }) {
  const fail = code => { throw new Error(code); };
  const amount = value => {
    if (!Number.isSafeInteger(value) || value < 0) fail('unknown-or-invalid-price');
    return value;
  };
  const sum = values => {
    const total = values.reduce((a, b) => a + amount(b), 0);
    if (!Number.isSafeInteger(total)) fail('price-overflow');
    return total;
  };
  if (!Array.isArray(baseIds) || !baseIds.length || new Set(baseIds).size !== baseIds.length
    || !Array.isArray(removeIds) || !removeIds.length || new Set(removeIds).size !== removeIds.length
    || removeIds.some(id => !baseIds.includes(id))) fail('invalid-scope');
  if (!Array.isArray(packages) || packages.some(p => !Array.isArray(p.covers) || !p.covers.length)
    || !sameSet(packages.flatMap(p => p.covers), baseIds)) fail('base-coverage-or-double-count');
  if (!replacement || !Array.isArray(replacement.covers) || !replacement.covers.length
    || new Set(replacement.covers).size !== replacement.covers.length
    || replacement.covers.some(id => baseIds.includes(id))) fail('replacement-overlap');
  const base = sum(packages.map(p => p.amount));
  const expected = [...baseIds.filter(id => !removeIds.includes(id)), ...replacement.covers];
  // A full alternative is independently priced. It is not added to the base,
  // and does not require an invented split or an invented replacement price.
  if (fullAlternative !== undefined) {
    if (!fullAlternative || !sameSet(fullAlternative.covers, expected)) fail('alternative-coverage-or-double-count');
    return { base, alternative: amount(fullAlternative.amount), method: 'full' };
  }
  let removed = 0;
  for (const p of packages) {
    const ids = p.covers.filter(id => removeIds.includes(id));
    if (!ids.length) continue;
    if (ids.length === p.covers.length) { removed += p.amount; continue; }
    if (!object(p.breakdown) || !sameSet(Object.keys(p.breakdown), p.covers)) fail('mixed-package-needs-breakdown');
    if (sum(Object.values(p.breakdown)) !== p.amount) fail('breakdown-total');
    removed += sum(ids.map(id => p.breakdown[id]));
  }
  return { base, alternative: amount(base - removed + amount(replacement.amount)), method: 'replacement' };
}

function publicUrl(value) {
  if (!filled(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && !url.search && url.hostname.includes('.') && !/^[\d.]+$/u.test(url.hostname)
      && !url.hostname.includes(':') && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname);
  } catch { return false; }
}

function descriptorIssues(project, slug) {
  const out = [];
  const add = code => out.push(code);
  const required = ['schema_version', 'slug', 'name', 'state', 'version', 'as_of', 'source_ref', 'editorial', 'review', 'files'];
  if (!exact(project, required, ['editorial_note', 'external'])) return ['descriptor-fields'];
  if (project.schema_version !== 1 || !validSlug(project.slug) || project.slug !== slug) add('descriptor-identity');
  if (!filled(project.name) || project.name.length > 200 || /[\x00-\x1f\x7f]/u.test(project.name)) add('descriptor-name');
  if (!['draft', 'published-example', 'needs-update'].includes(project.state)) add('descriptor-state');
  if (typeof project.version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/u.test(project.version)) add('descriptor-version');
  if (project.as_of !== null && !validDate(project.as_of)) add('descriptor-date');
  if (project.source_ref !== null && !publicUrl(project.source_ref)) add('descriptor-source');
  if (!['included', 'excluded', 'unresolved'].includes(project.editorial)) add('descriptor-editorial');
  if (Object.hasOwn(project, 'editorial_note') && !filled(project.editorial_note)) add('descriptor-editorial-note');
  if (project.review !== null && (!exact(project.review, ['by', 'at', 'scope', 'manifest_sha256'])
    || !filled(project.review.by) || !validDate(project.review.at) || !filled(project.review.scope)
    || !validHash(project.review.manifest_sha256))) add('descriptor-review');
  if (Object.hasOwn(project, 'external')) {
    const ext = project.external;
    if (!exact(ext, ['repository', 'commit', 'entrypoint', 'manifest', 'manifest_sha256'])
      || typeof ext.repository !== 'string'
      || !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(ext.repository)
      || !validCommit(ext.commit) || ext.entrypoint !== 'README.md' || ext.manifest !== 'manifest.json'
      || !validHash(ext.manifest_sha256) || project.review !== null) add('descriptor-external');
    if (!sameSet(project.files, ['README.md'])) add('descriptor-files');
  } else if (!sameSet(project.files, PROJECT_FILES)) add('descriptor-files');
  if (project.state === 'published-example') {
    if (!validDate(project.as_of) || !publicUrl(project.source_ref)) add('published-provenance');
    if (project.editorial === 'unresolved' || (project.editorial === 'excluded' && !filled(project.editorial_note))) add('published-editorial');
    if (!project.external && project.review === null) add('published-review');
    const fields = [project.name, project.editorial_note, project.review?.by, project.review?.scope].filter(value => typeof value === 'string');
    if (fields.some(value => /\[(?:заполнить|название проекта)[^\]\n]*\]|ШАБЛОН/iu.test(value))) add('published-metadata-placeholder');
  }
  return out;
}

// Digest v1: sort declared flat ASCII filenames lexicographically. For each,
// append UTF-8 filename, NUL, UTF-8 decimal raw-byte length, NUL, raw bytes, NUL.
// SHA-256 the concatenation. project.json is not in this digest (no circularity);
// it is schema-validated separately. This is integrity binding, not a signature.
export async function digestProject(directory, files) {
  if (!Array.isArray(files) || new Set(files).size !== files.length
    || files.some(file => !PROJECT_FILES.includes(file))) throw new Error('digest-files');
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const target = path.join(directory, file);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('digest-file-type');
    const bytes = await fs.readFile(target);
    hash.update(file, 'utf8').update('\0').update(String(bytes.length), 'utf8').update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}

const forbiddenFile = name => /(?:^\.env(?:\.|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|\.(?:pem|key|p12|pfx|jks|keystore|sqlite3?|db)$)/iu.test(name);
const sensitiveText = text => /(?:\/Users\/|\/home\/|file:\/\/)/iu.test(text)
  || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(text)
  || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(text)
  || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u.test(text)
  || /\bAKIA[A-Z0-9]{16}\b/u.test(text)
  || /\bsk-[A-Za-z0-9_-]{20,}\b/u.test(text)
  || /\b(?:password|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\n]{12,}["']/iu.test(text);

function withoutFences(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const hit = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (hit) {
      if (!fence) fence = hit[1];
      else if (hit[1][0] === fence[0] && hit[1].length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}

function markdownTargets(text) {
  const body = withoutFences(text);
  return [
    ...body.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/gu),
    ...body.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gmu),
  ].map(match => match[1].replace(/^<|>$/gu, ''));
}

function authorIssues(file, text, template = '') {
  const out = [];
  const boundary = { 'brief.md': 7, 'editorial.md': 6, 'risks.md': 4 }[file];
  let authored = text;
  if (boundary) {
    const hit = new RegExp(`^##\\s*${boundary}(?:[.)]|\\s)`, 'mu').exec(text);
    if (!hit) out.push('published-bidder-boundary');
    else authored = text.slice(0, hit.index);
    for (let n = 1; n < boundary; n++) {
      const section = new RegExp(`^##\\s*${n}(?:[.)]|\\s)[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mu').exec(authored);
      if (!section || !section[1].trim()) out.push('published-author-section');
    }
  }
  if (!authored.trim() || /\[(?:заполнить|название проекта)[^\]\n]*\]|ШАБЛОН/iu.test(authored)) out.push('published-placeholder');
  // Check exact inherited fields too, e.g. the template's public-contact field.
  // Ordinary inline-link labels are not fields. This is not semantic review.
  const placeholders = [...template.matchAll(/\[[^\]\n]+\](?!\()/gu)].map(match => match[0]);
  if (placeholders.some(value => authored.includes(value))) out.push('published-template-field');
  return [...new Set(out)];
}

async function fetchBytes(url, fetchImpl, limit) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error('remote-fetch');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('remote-body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new Error('remote-size');
      chunks.push(Buffer.from(item.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

// Only this explicit mode performs network reads. The descriptor is for the
  // Constitution v1.2/1.3 flat 23-file package; future package shapes need a revision.
export async function verifyExternal(project, fetchImpl = fetch) {
  if (descriptorIssues(project, project.slug).length || !project.external) throw new Error('external-descriptor');
  const ext = project.external;
  const repository = ext.repository.slice('https://github.com/'.length);
  const raw = `https://raw.githubusercontent.com/${repository}/${ext.commit}/`;
  const manifestBytes = await fetchBytes(`${raw}${ext.manifest}`, fetchImpl, 1024 * 1024);
  if (sha256(manifestBytes) !== ext.manifest_sha256) throw new Error('remote-manifest-hash');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!exact(manifest, ['version', 'date', 'source_revision', 'files']) || manifest.version !== project.version
    || manifest.date !== project.as_of || !validCommit(manifest.source_revision)
    || !object(manifest.files) || !sameSet(Object.keys(manifest.files), EXTERNAL_FILES)
    || Object.values(manifest.files).some(hash => !validHash(hash))) throw new Error('remote-manifest-schema');
  const tree = JSON.parse((await fetchBytes(`https://api.github.com/repos/${repository}/git/trees/${ext.commit}?recursive=1`, fetchImpl, 1024 * 1024)).toString('utf8'));
  if (!object(tree) || tree.truncated !== false || !Array.isArray(tree.tree)
    || !sameSet(tree.tree.map(item => item.path), [...EXTERNAL_FILES, 'manifest.json'])
    || tree.tree.some(item => item.type !== 'blob' || !['100644', '100755'].includes(item.mode))) throw new Error('remote-tree');
  // Four requests at once, bounded by 22 files. Never run downloaded code.
  for (let start = 0; start < EXTERNAL_FILES.length; start += 4) {
    await Promise.all(EXTERNAL_FILES.slice(start, start + 4).map(async file => {
      const bytes = await fetchBytes(`${raw}${file}`, fetchImpl, 16 * 1024 * 1024);
      if (sha256(bytes) !== manifest.files[file]) throw new Error('remote-file-hash');
    }));
  }
  return { files: EXTERNAL_FILES.length + 1, commit: ext.commit, status: 'remote-bytes-verified' };
}

export async function validateRepository(root, { remote = false, fetchImpl = fetch } = {}) {
  const base = path.resolve(root);
  const findings = [];
  const files = new Map();
  const directories = new Set();
  const add = (code, relative = '.') => findings.push({ code, path: relative.replace(/[\x00-\x1f\x7f]/gu, '?') });
  async function walk(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const local = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { add('symlink', local); continue; }
      if (local === '.git' && entry.isDirectory()) continue;
      if (forbiddenFile(entry.name)) add('forbidden-file', local);
      if (entry.isDirectory()) {
        directories.add(local);
        await walk(path.join(directory, entry.name), local);
      } else if (entry.isFile()) {
        const target = path.join(directory, entry.name);
        if ((await fs.stat(target)).size > 16 * 1024 * 1024) { add('file-too-large', local); continue; }
        const bytes = await fs.readFile(target);
        files.set(local, bytes);
        if (sensitiveText(bytes.toString('utf8'))) add('private-or-secret-pattern', local);
      } else add('unsupported-file-type', local);
    }
  }
  try {
    const stat = await fs.lstat(base);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, projects: 0, remote_checked: 0, findings: [{ code: 'root-type', path: '.' }] };
    await walk(base);
  } catch { return { ok: false, projects: 0, remote_checked: 0, findings: [{ code: 'repository-read', path: '.' }] }; }
  if (!directories.has('projects')) add('projects-directory');
  if (!directories.has('templates')) add('templates-directory');
  for (const relative of ROOT_FILES) {
    if (!files.has(relative)) add('repository-required-file-missing', relative);
  }
  for (const relative of files.keys()) {
    if (!relative.startsWith('projects/') && !ROOT_FILES.includes(relative)) add('repository-unknown-file', relative);
  }
  for (const relative of directories) {
    if (!['projects', 'templates', 'docs', 'scripts'].includes(relative) && !relative.startsWith('projects/')) add('repository-unknown-directory', relative);
  }
  for (const file of PROJECT_FILES) if (!files.has(`templates/${file}`)) add('template-missing', `templates/${file}`);
  for (const [relative, bytes] of files) {
    if (!relative.endsWith('.md')) continue;
    for (const target of markdownTargets(bytes.toString('utf8'))) {
      if (/^(?:https?:|mailto:|#)/iu.test(target)) continue;
      if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(target) || target.startsWith('/') || target.includes('\\')) { add('link-unsafe', relative); continue; }
      let decoded;
      try { decoded = decodeURIComponent(target.split(/[?#]/u)[0]); } catch { add('link-encoding', relative); continue; }
      if (!decoded) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decoded));
      if (decoded.startsWith('/') || decoded.includes('\\') || resolved === '..' || resolved.startsWith('../')) add('link-escape', relative);
      else if (!files.has(resolved) && !directories.has(resolved)) add('link-missing', relative);
    }
  }
  let projects = 0;
  let remoteChecked = 0;
  const projectNames = new Set([
    ...[...directories].filter(item => item.startsWith('projects/')).map(item => item.split('/')[1]),
    ...[...files.keys()].filter(item => item.startsWith('projects/')).map(item => item.split('/')[1]),
  ]);
  for (const slug of [...projectNames].sort()) {
    const prefix = `projects/${slug}`;
    if (!validSlug(slug) || !directories.has(prefix)) { add('project-directory', 'projects'); continue; }
    projects++;
    let project;
    try { project = JSON.parse(files.get(`${prefix}/project.json`)?.toString('utf8') ?? ''); }
    catch { add('descriptor-json', prefix); continue; }
    const issues = descriptorIssues(project, slug);
    for (const code of issues) add(code, `${prefix}/project.json`);
    const allowed = new Set([...(object(project) && Object.hasOwn(project, 'external') ? ['README.md'] : PROJECT_FILES), 'project.json']);
    const allChildren = [...files.keys(), ...directories].filter(item => item.startsWith(`${prefix}/`));
    for (const child of allChildren) if (!allowed.has(child.slice(prefix.length + 1))) add('project-unknown-file', child);
    for (const file of allowed) if (!files.has(`${prefix}/${file}`)) add('project-missing-file', `${prefix}/${file}`);
    if (issues.length) continue;
    if (project.state === 'published-example') {
      for (const file of project.files) {
        const bytes = files.get(`${prefix}/${file}`);
        if (bytes) for (const code of authorIssues(file, bytes.toString('utf8'), files.get(`templates/${file}`)?.toString('utf8'))) add(code, `${prefix}/${file}`);
      }
      if (!project.external) {
        try {
          if (await digestProject(path.join(base, prefix), project.files) !== project.review.manifest_sha256) add('review-digest-mismatch', prefix);
        } catch { add('review-digest-read', prefix); }
      }
    }
    if (remote && project.external) {
      try { await verifyExternal(project, fetchImpl); remoteChecked++; }
      catch (error) {
        const safe = ['external-descriptor', 'remote-fetch', 'remote-body', 'remote-size', 'remote-manifest-hash', 'remote-manifest-schema', 'remote-tree', 'remote-file-hash'];
        add(safe.includes(error.message) ? error.message : 'remote-verification', prefix);
      }
    }
  }
  return { ok: findings.length === 0, projects, remote_checked: remoteChecked, external_mode: remote ? 'requested' : 'descriptor-only-not-remote-proof', findings };
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--digest' && validSlug(args[1])) {
    try {
      const directory = path.join(ROOT, 'projects', args[1]);
      for (const target of [ROOT, path.join(ROOT, 'projects'), directory]) {
        const stat = await fs.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('digest-directory');
      }
      const descriptorPath = path.join(directory, 'project.json');
      const stat = await fs.lstat(descriptorPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('digest-descriptor');
      const project = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
      if (descriptorIssues(project, args[1]).length || project.external) throw new Error('digest-descriptor');
      console.log(await digestProject(directory, project.files));
    } catch {
      console.error('Cannot digest: a valid local descriptor and regular project files are required.');
      process.exitCode = 1;
    }
  } else if (args.some(arg => arg !== '--remote') || args.length > 1) {
    console.error('Usage: node scripts/validate.mjs [--remote | --digest <slug>]');
    process.exitCode = 1;
  } else {
    const result = await validateRepository(ROOT, { remote: process.argv.includes('--remote') });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
