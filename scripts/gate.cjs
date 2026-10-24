#!/usr/bin/env node
'use strict';
// One command before every commit:  npm run gate
// Runs: architecture ratchet, service catalog freshness, doc path check, secrets scan on the staged diff, full npm test.
// Paste the SUMMARY block it prints as evidence. `--fast` skips npm test.
const { spawnSync, execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const fast = process.argv.includes('--fast');
const results = [];

function runNode(name, script, args = []) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const skipped = /SKIPPED/.test(out);
  results.push({ name, status: r.status === 0 ? (skipped ? 'SKIP' : 'PASS') : 'FAIL', out, detail: '' });
}

function secretsScan() {
  const PATTERNS = [
    [/sk-[A-Za-z0-9_-]{20,}/, 'API key (sk-...)'],
    [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\./, 'JWT'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/Bearer\s+[A-Za-z0-9._~+\/-]{25,}/, 'bearer token'],
    [/(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'][^"'\s$<{]{12,}["']/i, 'hard-coded credential'],
  ];
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) {
    results.push({ name: 'secrets scan (staged diff)', status: 'SKIP', out: 'git not available here', detail: '' });
    return;
  }
  if (!diff.trim()) { results.push({ name: 'secrets scan (staged diff)', status: 'PASS', out: '', detail: 'nothing staged' }); return; }
  const hits = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++') || line.includes('gate:allow-secret')) continue;
    for (const [re, label] of PATTERNS) if (re.test(line)) hits.push(`${label}: ${line.slice(0, 60)}...`);
  }
  results.push({ name: 'secrets scan (staged diff)', status: hits.length ? 'FAIL' : 'PASS', out: hits.join('\n'), detail: '' });
}

function npmTest() {
  const r = spawnSync('npm', ['test'], { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout || '') + (r.stderr || '');
  const pick = (k) => (out.match(new RegExp('^\\D*' + k + '\\s+(\\d+)', 'm')) || [])[1] || '?';
  const detail = `tests=${pick('tests')} pass=${pick('pass')} fail=${pick('fail')} skipped=${pick('skipped')}`;
  results.push({ name: 'npm test (full hermetic suite)', status: r.status === 0 ? 'PASS' : 'FAIL', out: r.status === 0 ? '' : out.split('\n').slice(-80).join('\n'), detail });
}

runNode('arch-check (no new violations)', 'arch-check.cjs');
runNode('service catalog up to date', 'gen-service-catalog.cjs', ['--check']);
runNode('doc paths exist', 'check-doc-paths.cjs');
secretsScan();
if (!fast) npmTest(); else results.push({ name: 'npm test', status: 'SKIP', out: '', detail: '--fast' });

for (const r of results) if (r.status === 'FAIL' && r.out) console.log(`\n--- ${r.name} ---\n${r.out.trim()}`);
console.log('\n=== GATE SUMMARY ===');
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.name}${r.detail ? '  ' + r.detail : ''}`);
const failed = results.some((r) => r.status === 'FAIL');
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
