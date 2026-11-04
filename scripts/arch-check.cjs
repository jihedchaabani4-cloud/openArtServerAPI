#!/usr/bin/env node
'use strict';
// Architecture ratchet for apiOpenArt. Mechanical rules only (regex over source files).
// It fails only on violations that are NOT in arch-baseline.json, so legacy code never blocks work,
// but nobody can add new violations.
//
//   node scripts/arch-check.cjs                    check (default)
//   node scripts/arch-check.cjs --report           list ALL current violations + cross-layer imports
//   node scripts/arch-check.cjs --init-baseline    create arch-baseline.json (once, human reviews counts)
//   node scripts/arch-check.cjs --shrink-baseline  lower the baseline after fixing violations (never raises)
const fs = require('fs');
const path = require('path');
const ratchet = require('./lib/ratchet.cjs');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'arch-baseline.json');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next', 'tests', 'test', '__tests__', 'scripts', 'docs', 'supabase']);
const CODE_DIRS = ['src', 'routes', 'controllers', 'middleware', 'lib', 'services', 'utils', 'config'];

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const isComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (/\.(c|m)?js$/.test(e.name) && !/\.(test|spec)\.(c|m)?js$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function loadFiles() {
  const seen = new Set();
  const files = [];
  for (const d of CODE_DIRS) {
    for (const f of walk(path.join(ROOT, d))) {
      if (seen.has(f)) continue;
      seen.add(f);
      const text = fs.readFileSync(f, 'utf8');
      files.push({ rel: rel(f), text, lines: text.split(/\r?\n/) });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function specifiers(file) {
  const out = [];
  const re = /(?:require\(\s*|from\s+|import\(\s*|import\s+)['"]([^'"]+)['"]/g;
  file.lines.forEach((line, i) => {
    if (isComment(line)) return;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) out.push({ spec: m[1], line: i + 1, text: line });
  });
  return out;
}

const CANONICAL_SYSTEMS = new Set([
  'identity',
  'billing',
  'models',
  'media',
  'workspace',
  'character',
  'element',
  'workflow-container',
  'execution',
]);

function isKnownSystem(name) {
  if (CANONICAL_SYSTEMS.has(name)) return true;
  return fs.existsSync(path.join(ROOT, 'src', 'systems', name));
}

function loadExceptions() {
  const excPath = path.join(ROOT, 'scripts', 'arch-exceptions.json');
  if (!fs.existsSync(excPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(excPath, 'utf8'));
    return Array.isArray(data.exceptions) ? data.exceptions : [];
  } catch (err) {
    console.error(`Warning: failed to parse ${excPath}: ${err.message}`);
    return [];
  }
}

function isExempt(exceptions, ruleId, fRel, spec, targetRel) {
  if (!exceptions || !exceptions.length) return false;
  return exceptions.some((exc) => {
    if (exc.rule && exc.rule !== ruleId) return false;
    if (exc.from) {
      if (exc.from.startsWith('/') && exc.from.endsWith('/')) {
        const re = new RegExp(exc.from.slice(1, -1));
        if (!re.test(fRel)) return false;
      } else if (exc.from !== fRel) {
        return false;
      }
    }
    if (exc.specifierPattern) {
      const re = new RegExp(exc.specifierPattern);
      if (!re.test(spec)) return false;
    }
    if (exc.targetPattern && targetRel) {
      const re = new RegExp(exc.targetPattern);
      if (!re.test(targetRel)) return false;
    }
    return true;
  });
}

function checkRuleR10(f, exceptions = loadExceptions()) {
  const fromSysMatch = f.rel.match(/^src\/systems\/([^/]+)\//);
  const fromSys = fromSysMatch ? fromSysMatch[1] : null;

  const hits = [];
  const specs = specifiers(f);

  for (const s of specs) {
    let targetSys = null;
    let isDeep = false;
    let targetRel = null;

    const aliasMatch = s.spec.match(/^#([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
    if (aliasMatch) {
      const aliasSys = aliasMatch[1];
      const subpath = aliasMatch[2] || '';
      if (isKnownSystem(aliasSys)) {
        targetSys = aliasSys;
        const isPublic = subpath === '' || subpath === 'index' || subpath === 'index.js';
        if (!isPublic && fromSys !== targetSys) {
          isDeep = true;
        }
      }
    } else {
      let resolved = null;
      if (s.spec.startsWith('.')) {
        const abs = path.resolve(ROOT, path.dirname(f.rel), s.spec);
        resolved = path.relative(ROOT, abs).split(path.sep).join('/');
      } else if (s.spec.startsWith('src/systems/')) {
        resolved = s.spec;
      }

      if (resolved && resolved.startsWith('src/systems/')) {
        targetRel = resolved;
        const sysRelMatch = resolved.match(/^src\/systems\/([^/]+)(?:\/(.*))?$/);
        if (sysRelMatch) {
          const pathSys = sysRelMatch[1];
          const subpath = sysRelMatch[2] || '';
          targetSys = pathSys;
          const isPublic = subpath === '' ||
                           subpath === 'index' ||
                           subpath === 'index.js' ||
                           subpath === 'index.cjs' ||
                           subpath === 'index.mjs';
          if (!isPublic && fromSys !== targetSys) {
            isDeep = true;
          }
        }
      }
    }

    if (isDeep && targetSys) {
      if (!isExempt(exceptions, 'R10', f.rel, s.spec, targetRel)) {
        hits.push({ line: s.line, text: s.text });
      }
    }
  }

  return hits;
}

const grep = (file, regex) => {
  const hits = [];
  file.lines.forEach((l, i) => {
    if (!isComment(l) && regex.test(l)) hits.push({ line: i + 1, text: l });
  });
  return hits;
};

const RULES = [
  {
    id: 'R1',
    desc: 'routes/ and controllers/ must not import repositories, db, supabase or StorageService',
    run(f) {
      if (!/^(src\/)?(routes|controllers)\//.test(f.rel)) return [];
      return specifiers(f).filter((s) =>
        /(^|\/)(db|repositories|repository)(\/|$)|Repository(\.c?js)?$|(^|\/)supabase(\/|$)|@supabase\/|StorageService/i.test(s.spec));
    },
  },
  {
    id: 'R2',
    desc: 'no console.* in source (use the structured logger)',
    run: (f) => grep(f, /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/),
  },
  {
    id: 'R3',
    desc: 'process.env is read only in config/env files',
    run(f) {
      if (/(^|\/)(config|env)(\/|\.)|config\.c?js$|env\.c?js$/i.test(f.rel)) return [];
      return grep(f, /\bprocess\.env\b/);
    },
  },
  {
    id: 'R4',
    desc: 'MediaUploadService stays generic: no Element/Character/Workflow/entityType',
    run(f) {
      if (!/(^|\/)MediaUploadService\.c?js$/.test(f.rel)) return [];
      return grep(f, /\b(Element|Character|Workflow|entityType)/);
    },
  },
  {
    id: 'R7',
    desc: 'no `!== false` in media/upload/storage/rollback/cleanup code (confirmations must be `=== true`)',
    run(f) {
      if (!/media|upload|storage|rollback|reaper|cleanup/i.test(f.rel)) return [];
      return grep(f, /!==\s*false\b/);
    },
  },
  {
    id: 'R8',
    desc: 'no require() inside a service method (inject dependencies instead)',
    run(f) {
      if (!/Service\.c?js$/.test(f.rel)) return [];
      return grep(f, /^\s{2,}.*\brequire\(/);
    },
  },
  {
    id: 'R9',
    desc: 'every *Service.js has an `@owns` header line',
    run(f) {
      if (!/Service\.c?js$/.test(f.rel)) return [];
      return /@owns\s+\S/.test(f.text) ? [] : [{ line: 1, text: 'missing @owns header' }];
    },
  },
  {
    id: 'R10',
    desc: 'outside src/systems/<name>/, only index.js or #<name> may be imported',
    run: (f) => checkRuleR10(f),
  },
];

function migrationViolations() {
  const dirs = [path.join(ROOT, 'supabase', 'migrations'), path.join(ROOT, '..', 'supabase', 'migrations')];
  const dir = dirs.find((d) => fs.existsSync(d));
  if (!dir) return { violations: [], note: 'R6 skipped: supabase/migrations not found' };
  const violations = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!/security\s+definer/i.test(sql)) continue;
    const revokes = sql.match(/revoke\s[^;]*;/gi) || [];
    const ok = revokes.some((r) => /\bpublic\b/i.test(r) && /\banon\b/i.test(r) && /\bauthenticated\b/i.test(r));
    if (!ok) {
      violations.push({ rule: 'R6', key: `R6|supabase/migrations/${name}`, detail: `supabase/migrations/${name}:1  SECURITY DEFINER without REVOKE ... FROM PUBLIC, anon, authenticated` });
    }
  }
  return { violations, note: null };
}

function collect() {
  const files = loadFiles();
  const violations = [];
  for (const f of files) {
    for (const r of RULES) {
      for (const h of r.run(f)) {
        violations.push({ rule: r.id, key: `${r.id}|${f.rel}`, detail: `${f.rel}:${h.line}  ${h.text.trim().slice(0, 110)}` });
      }
    }
  }
  const mig = migrationViolations();
  violations.push(...mig.violations);
  return { files, violations, note: mig.note };
}

function layerReport(files) {
  const lines = [];
  for (const [from, to] of [['src/platform/', '/domain/'], ['src/domain/', '/platform/']]) {
    const hits = [];
    for (const f of files.filter((x) => x.rel.startsWith(from))) {
      for (const s of specifiers(f)) if (s.spec.startsWith('.') && s.spec.includes(to)) hits.push(`${f.rel}:${s.line}  ${s.spec}`);
    }
    lines.push(`${from.split('/')[1]} -> ${to.replace(/\//g, '')}: ${hits.length} import(s)`);
    hits.forEach((h) => lines.push('   ' + h));
  }
  return lines;
}

function summary(violations, baseline, fresh) {
  const ids = [...new Set([...RULES.map((r) => r.id), 'R6'])].sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, ''), 10);
    const numB = parseInt(b.replace(/\D/g, ''), 10);
    return numA - numB;
  });
  const desc = Object.fromEntries(RULES.map((r) => [r.id, r.desc]));
  desc.R6 = 'migrations with SECURITY DEFINER must REVOKE FROM PUBLIC, anon, authenticated';
  const now = {}; const base = {}; const neu = {};
  for (const v of violations) now[v.rule] = (now[v.rule] || 0) + 1;
  for (const [k, n] of Object.entries(baseline || {})) base[k.split('|')[0]] = (base[k.split('|')[0]] || 0) + n;
  for (const x of fresh) neu[x.key.split('|')[0]] = (neu[x.key.split('|')[0]] || 0) + (x.found - x.allowed);
  console.log('Rule  Now  Baseline  New  Description');
  for (const id of ids) {
    console.log(`${id.padEnd(5)} ${String(now[id] || 0).padStart(3)}  ${String(base[id] || 0).padStart(8)}  ${String(neu[id] || 0).padStart(3)}  ${desc[id]}`);
  }
}

function main() {
  const arg = process.argv[2] || '--check';
  const { files, violations, note } = collect();
  if (note) console.log(note);
  const counts = ratchet.countByKey(violations);

  if (arg === '--report') {
    for (const v of violations) console.log(`${v.rule} ${v.detail}`);
    console.log('\nCross-layer imports (report only, not enforced):');
    layerReport(files).forEach((l) => console.log(l));
    console.log('');
    summary(violations, ratchet.loadBaseline(BASELINE), []);
    return 0;
  }
  if (arg === '--init-baseline') {
    if (fs.existsSync(BASELINE)) { console.error('arch-baseline.json already exists. Use --shrink-baseline. Refusing to overwrite.'); return 1; }
    ratchet.writeBaseline(BASELINE, counts);
    summary(violations, counts, []);
    console.log(`\nWrote arch-baseline.json (${Object.keys(counts).length} entries). Review the counts above before committing.`);
    return 0;
  }
  const baseline = ratchet.loadBaseline(BASELINE);
  if (!baseline) { console.error('No arch-baseline.json. A human must run: node scripts/arch-check.cjs --init-baseline'); return 1; }
  if (arg === '--shrink-baseline') {
    const next = ratchet.shrink(counts, baseline);
    ratchet.writeBaseline(BASELINE, next);
    console.log(`Baseline shrunk: ${Object.keys(baseline).length} -> ${Object.keys(next).length} entries (never raised).`);
    return 0;
  }
  const { fresh } = ratchet.compare(violations, baseline);
  summary(violations, baseline, fresh);
  if (fresh.length) {
    console.log('\nNEW VIOLATIONS (fix the code; do NOT edit arch-baseline.json):');
    for (const f of fresh) {
      console.log(`  ${f.key}  allowed ${f.allowed}, found ${f.found}`);
      f.items.forEach((i) => console.log('    ' + i.detail));
    }
    return 1;
  }
  console.log('\narch-check: OK (no new violations)');
  return 0;
}

if (require.main === module) {
  process.exit(main());
} else {
  module.exports = {
    ROOT,
    RULES,
    CANONICAL_SYSTEMS,
    specifiers,
    isComment,
    isKnownSystem,
    loadExceptions,
    isExempt,
    checkRuleR10,
    collect,
  };
}
