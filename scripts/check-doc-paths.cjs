#!/usr/bin/env node
'use strict';
// Verifies that every file named in the hand-written agent docs really exists.
// A doc that names a missing file is how an agent starts hallucinating.
// Checks `inline code` spans that look like files (have an extension). Skips fenced blocks.
// Per-line opt-out: add <!-- no-check --> to the line.
const fs = require('fs');
const path = require('path');

function findProjectRoot(start) {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, 'AGENTS.md')) && fs.existsSync(path.join(d, 'docs', 'agents', 'rules'))) return d;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}

const PROJECT = findProjectRoot(path.resolve(__dirname, '..'));
if (!PROJECT) { console.log('doc paths: SKIPPED (project root with docs/agents/rules not found above apiOpenArt)'); process.exit(0); }

const SKIP = new Set(['node_modules', '.git', '.next', 'coverage', 'dist', 'build']);
const all = new Set();
const byBase = new Map();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    const r = path.relative(PROJECT, full).split(path.sep).join('/');
    all.add(r);
    if (!byBase.has(e.name)) byBase.set(e.name, []);
    byBase.get(e.name).push(r);
  }
})(PROJECT);

const docs = [];
for (const f of ['AGENTS.md']) if (fs.existsSync(path.join(PROJECT, f))) docs.push(f);
for (const e of fs.readdirSync(PROJECT, { withFileTypes: true })) {
  if (e.isDirectory() && !SKIP.has(e.name) && fs.existsSync(path.join(PROJECT, e.name, 'AGENTS.md'))) docs.push(e.name + '/AGENTS.md');
}
(function collect(dir) {
  const abs = path.join(PROJECT, dir);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) collect(dir + '/' + e.name);
    else if (e.name.endsWith('.md')) docs.push(dir + '/' + e.name);
  }
})('docs/agents/rules');
if (fs.existsSync(path.join(PROJECT, 'docs/agents/maps'))) collect2('docs/agents/maps');
function collect2(dir) {
  for (const e of fs.readdirSync(path.join(PROJECT, dir), { withFileTypes: true })) if (e.name.endsWith('.md')) docs.push(dir + '/' + e.name);
}

const FILE_TOKEN = /^[A-Za-z0-9_@.\-\/\[\]]+\.(?:c?js|mjs|jsx|tsx?|md|sql|json|css|mdc|sh)$/;
const problems = [];
let checked = 0;
for (const doc of docs) {
  let fenced = false;
  fs.readFileSync(path.join(PROJECT, doc), 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    if (fenced || line.includes('no-check')) return;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const t = m[1].trim().replace(/^\.\//, '');
      if (!FILE_TOKEN.test(t) || /[<*]|NN|YYYY|^https?:/.test(t)) continue;
      checked++;
      const ok = t.includes('/')
        ? [t, 'apiOpenArt/' + t, 'my-app/' + t].some((c) => all.has(c))
        : byBase.has(t);
      if (!ok) problems.push(`${doc}:${i + 1}  not found: ${t}`);
    }
  });
}
if (problems.length) {
  console.error(`doc paths: ${problems.length} missing file reference(s) (checked ${checked}):`);
  problems.forEach((p) => console.error('  ' + p));
  console.error('Fix the doc (or add <!-- no-check --> on that line if the file is intentionally future).');
  process.exit(1);
}
console.log(`doc paths: OK (${checked} references checked in ${docs.length} docs)`);
