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
//   node scripts/arch-check.cjs --seed-rule <ID>   seed initial baseline entries for a newly introduced rule
const fs = require('fs');
const path = require('path');
const ratchet = require('./lib/ratchet.cjs');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'arch-baseline.json');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next', 'tests', 'test', '__tests__', 'scripts', 'docs', 'supabase', '.scratch']);
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

const LEGACY_NAMESPACES = new Set([
  'lib',
  'utils',
  'db',
  'queue',
  'infrastructure',
  'platform',
  'domain',
  'container.js',
]);

function isKnownSystem(name) {
  if (LEGACY_NAMESPACES.has(name)) return false;
  return true;
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
        if (aliasSys === 'shared') {
          const isInternalDb = (f.rel.startsWith('src/systems/') && f.rel.includes('/internal/db/')) || f.rel === 'lib/supabase.js';
          const isAllowedShared = subpath === '' || subpath === 'index' || subpath === 'index.js' ||
                                  (isInternalDb && subpath === 'db/supabase.js');
          if (!isAllowedShared && fromSys !== targetSys) {
            isDeep = true;
          }
        } else {
          // Two-Gateway Rule: only /api or /tools (or /api.js, /tools.js) allowed externally
          const isPublic = subpath === 'api' || subpath === 'tools' || subpath === 'api.js' || subpath === 'tools.js' ||
                           // Backward compatibility during migration for index
                           subpath === '' || subpath === 'index' || subpath === 'index.js';
          if (!isPublic && fromSys !== targetSys) {
            isDeep = true;
          }
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
          const isPublic = subpath === 'public/api.js' || subpath === 'public/tools.js' ||
                           subpath === 'public/api' || subpath === 'public/tools' ||
                           subpath === '' || subpath === 'index' || subpath === 'index.js';
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

function checkRuleR11(f) {
  // R11: inside src/systems/<name>/internal/**, forbid imports of its own public/api.js or public/tools.js (Rule 7)
  const match = f.rel.match(/^src\/systems\/([^/]+)\/internal\//);
  if (!match) return [];
  const sys = match[1];
  const hits = [];
  for (const s of specifiers(f)) {
    if (s.spec === `#${sys}/api` || s.spec === `#${sys}/tools` ||
        s.spec.includes(`/systems/${sys}/public/`)) {
      hits.push({ line: s.line, text: s.text });
    }
  }
  return hits;
}

function checkRuleR12(f) {
  // R12: database & external storage SDK isolation across ALL code directories
  // DB clients (supabase, prisma, pg, mongoose) and cloud storage SDKs (S3, R2)
  // may only be imported inside src/systems/<name>/internal/db/, dedicated storage adapter, or src/shared/db/supabase.js
  if (f.rel === 'lib/supabase.js' || f.rel === 'src/shared/db/supabase.js') return [];
  if (f.rel.startsWith('src/systems/') && (f.rel.includes('/internal/db/') || f.rel.includes('/internal/storage/'))) return [];

  const hits = [];
  for (const s of specifiers(f)) {
    if (/@supabase\/|supabase|@prisma\/|prisma|\bpg\b|mongoose|@aws-sdk\//i.test(s.spec)) {
      hits.push({ line: s.line, text: s.text });
    }
  }
  return hits;
}

function checkRuleR13(f) {
  // R13: express and web middleware isolated to src/app.js and src/systems/<name>/public/api.js
  if (!f.rel.startsWith('src/systems/')) return [];
  if (f.rel.endsWith('/public/api.js') || f.rel.endsWith('/public/api')) return [];

  const hits = [];
  for (const s of specifiers(f)) {
    if (/^express(\/.*)?$|^multer$|^cookie-parser$/.test(s.spec)) {
      hits.push({ line: s.line, text: s.text });
    }
  }
  return hits;
}

function checkRuleR15(packageJsonPath = path.join(ROOT, 'package.json')) {
  // R15: Validate package.json #imports for src/systems/
  if (!fs.existsSync(packageJsonPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const imports = pkg.imports || {};
    const violations = [];
    for (const [key, target] of Object.entries(imports)) {
      if (typeof target === 'string' && target.includes('/systems/')) {
        if (key.includes('*') || target.includes('*')) {
          violations.push({ line: 1, text: `Wildcard system alias forbidden: ${key} -> ${target}` });
        } else if (!target.endsWith('/public/api.js') && !target.endsWith('/public/tools.js')) {
          violations.push({ line: 1, text: `System alias must point to public/api.js or public/tools.js: ${key} -> ${target}` });
        }
      }
    }
    return violations;
  } catch {
    return [];
  }
}

function checkRuleR16(f) {
  // R16: Zero outbound legacy imports from src/systems/** or src/shared/**
  // No file in src/systems/** or src/shared/** may import from legacy folders or legacy #aliases
  if (!f.rel.startsWith('src/systems/') && !f.rel.startsWith('src/shared/')) return [];

  const isInternalDb = f.rel.startsWith('src/systems/') && f.rel.includes('/internal/db/');
  const hits = [];

  for (const s of specifiers(f)) {
    // 1. Check legacy #aliases
    const aliasMatch = s.spec.match(/^#([a-zA-Z0-9_.-]+)(?:\/(.*))?$/);
    if (aliasMatch) {
      const ns = aliasMatch[1];
      if (LEGACY_NAMESPACES.has(ns)) {
        // Allow #lib/supabase.js ONLY inside src/systems/<name>/internal/db/
        if (isInternalDb && s.spec === '#lib/supabase.js') continue;
        hits.push({ line: s.line, text: s.text });
        continue;
      }
    }

    // 2. Check relative or root-relative paths escaping out of src/systems/ or src/shared/
    let resolved = null;
    if (s.spec.startsWith('.')) {
      const abs = path.resolve(ROOT, path.dirname(f.rel), s.spec);
      resolved = path.relative(ROOT, abs).split(path.sep).join('/');
    } else if (/^(controllers|routes|middleware|lib|services|utils|config|src)\//.test(s.spec)) {
      resolved = s.spec;
    }

    if (resolved) {
      if (!resolved.startsWith('src/systems/') && !resolved.startsWith('src/shared/')) {
        if (isInternalDb && resolved === 'lib/supabase.js') continue;
        hits.push({ line: s.line, text: s.text });
      }
    }
  }
  return hits;
}

const ALLOWED_SRC_ENTRIES = new Set(['api', 'shared', 'systems', 'container.js']);
const FORBIDDEN_ROOT_DIRS = [
  'controllers',
  'routes',
  'lib',
  'middleware',
  'services',
  'utils',
  'config',
  'models',
  'workers',
  'queue',
  'domain',
  'platform',
  'infrastructure',
];

function checkRuleR17(rootDir = ROOT) {
  // R17: Canonical directory boundary lock — only api, shared, systems, and container.js allowed under src/, and no legacy code folders at root
  const violations = [];
  for (const dirName of FORBIDDEN_ROOT_DIRS) {
    const p = path.join(rootDir, dirName);
    if (fs.existsSync(p)) {
      violations.push({
        key: `R17|${dirName}`,
        detail: `${dirName}:1  Forbidden legacy root directory "${dirName}/" exists outside src/{api,shared,systems}`,
      });
    }
  }

  const srcDir = path.join(rootDir, 'src');
  if (fs.existsSync(srcDir)) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!ALLOWED_SRC_ENTRIES.has(entry.name)) {
        const relPath = `src/${entry.name}`;
        violations.push({
          key: `R17|${relPath}`,
          detail: `${relPath}:1  Forbidden entry "${relPath}" inside src/ (only src/api, src/shared, src/systems, and src/container.js are allowed)`,
        });
      }
    }
  }

  return violations;
}

/**
 * Finds static import cycles across codebase files.
 */
function findImportCycles(files, packageImports = null) {
  const pkg = packageImports || (fs.existsSync(path.join(ROOT, 'package.json'))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).imports || {}
    : {});

  const known = new Set(files.map((f) => f.rel));
  const normalizedKnown = new Map();
  for (const f of files) {
    normalizedKnown.set(f.rel.toLowerCase(), f.rel);
  }

  function resolveAlias(spec) {
    for (const [k, v] of Object.entries(pkg)) {
      if (k.includes('*')) {
        const [pre, post] = k.split('*');
        if (spec.startsWith(pre) && spec.endsWith(post)) {
          const mid = spec.slice(pre.length, spec.length - post.length);
          return v.replace('*', mid).replace(/^\.\//, '');
        }
      } else if (k === spec) {
        return v.replace(/^\.\//, '');
      }
    }
    return null;
  }

  const edges = new Map();
  for (const f of files) {
    const out = new Set();
    for (const s of specifiers(f)) {
      // Exclude dynamic import() to focus on static execution load-order cycles
      if (/import\s*\(/.test(s.text)) continue;

      let r = null;
      if (s.spec.startsWith('.')) {
        r = path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), s.spec));
      } else if (s.spec.startsWith('#')) {
        r = resolveAlias(s.spec);
      }
      if (!r) continue;

      const candidates = [r, r + '.js', r + '/index.js'];
      let hit = candidates.find((c) => known.has(c));
      if (!hit) {
        // Case-insensitive fallback
        const lowerCandidate = candidates.map(c => c.toLowerCase()).find(c => normalizedKnown.has(c));
        if (lowerCandidate) {
          hit = normalizedKnown.get(lowerCandidate);
        }
      }

      if (hit && hit !== f.rel) {
        out.add(hit);
      }
    }
    edges.set(f.rel, [...out]);
  }

  // Tarjan's Strongly Connected Components
  let idx = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const cycles = [];

  function strongConnect(v) {
    indices.set(v, idx);
    lowlinks.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);

    for (const w of edges.get(v) || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);

      if (component.length > 1) {
        cycles.push(component);
      }
    }
  }

  for (const v of edges.keys()) {
    if (!indices.has(v)) {
      strongConnect(v);
    }
  }

  return cycles;
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
    desc: 'outside src/systems/<name>/, only public/api.js, public/tools.js, or index.js may be imported',
    run: (f) => checkRuleR10(f),
  },
  {
    id: 'R11',
    desc: 'inside src/systems/<name>/internal/, forbidden to import own public/api.js or public/tools.js',
    run: (f) => checkRuleR11(f),
  },
  {
    id: 'R12',
    desc: 'database and storage clients isolated strictly to internal/db/ or internal/storage/',
    run: (f) => checkRuleR12(f),
  },
  {
    id: 'R13',
    desc: 'express and web frameworks isolated strictly to public/api.js',
    run: (f) => checkRuleR13(f),
  },
  {
    id: 'R16',
    desc: 'zero outbound legacy imports from src/systems/** or src/shared/**',
    run: (f) => checkRuleR16(f),
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

  // R14: Static import cycles across codebase
  const cycles = findImportCycles(files);
  for (const cycle of cycles) {
    const sorted = [...cycle].sort();
    const cycleSummary = sorted.join(' <-> ');
    for (const fileRel of sorted) {
      violations.push({
        rule: 'R14',
        key: `R14|${fileRel}`,
        detail: `${fileRel}:1  Import cycle: ${cycleSummary.slice(0, 100)}...`,
      });
    }
  }

  // R15: package.json #imports validation
  const pkgViolations = checkRuleR15();
  for (const pv of pkgViolations) {
    violations.push({
      rule: 'R15',
      key: 'R15|package.json',
      detail: `package.json:1  ${pv.text}`,
    });
  }

  // R17: Canonical directory boundary lock
  const dirViolations = checkRuleR17();
  for (const dv of dirViolations) {
    violations.push({
      rule: 'R17',
      key: dv.key,
      detail: dv.detail,
    });
  }

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
  const allRuleIds = ['R1', 'R2', 'R3', 'R4', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17'];
  const ids = allRuleIds.sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, ''), 10);
    const numB = parseInt(b.replace(/\D/g, ''), 10);
    return numA - numB;
  });
  const desc = Object.fromEntries(RULES.map((r) => [r.id, r.desc]));
  desc.R6 = 'migrations with SECURITY DEFINER must REVOKE FROM PUBLIC, anon, authenticated';
  desc.R14 = 'zero static circular dependencies across codebase modules';
  desc.R15 = 'package.json #imports must map systems directly to public/api.js or public/tools.js';
  desc.R17 = 'canonical directory boundary lock (only src/{api,shared,systems,container.js}, no legacy root folders)';

  const now = {}; const base = {}; const neu = {};
  for (const v of violations) now[v.rule] = (now[v.rule] || 0) + 1;
  for (const [k, n] of Object.entries(baseline || {})) base[k.split('|')[0]] = (base[k.split('|')[0]] || 0) + n;
  for (const x of fresh) neu[x.key.split('|')[0]] = (neu[x.key.split('|')[0]] || 0) + (x.found - x.allowed);
  console.log('Rule  Now  Baseline  New  Description');
  for (const id of ids) {
    console.log(`${id.padEnd(5)} ${String(now[id] || 0).padStart(3)}  ${String(base[id] || 0).padStart(8)}  ${String(neu[id] || 0).padStart(3)}  ${desc[id] || ''}`);
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

  if (arg === '--seed-rule') {
    const targetRule = process.argv[3];
    if (!targetRule) { console.error('Usage: --seed-rule <RULE_ID>'); return 1; }
    const updatedBaseline = { ...baseline };
    let seededCount = 0;
    for (const [k, v] of Object.entries(counts)) {
      if (k.startsWith(`${targetRule}|`) && !updatedBaseline[k]) {
        updatedBaseline[k] = v;
        seededCount++;
      }
    }
    ratchet.writeBaseline(BASELINE, updatedBaseline);
    console.log(`Seeded ${seededCount} baseline entries for rule ${targetRule}.`);
    return 0;
  }

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
    LEGACY_NAMESPACES,
    specifiers,
    isComment,
    isKnownSystem,
    loadExceptions,
    isExempt,
    checkRuleR10,
    checkRuleR11,
    checkRuleR12,
    checkRuleR13,
    checkRuleR15,
    checkRuleR16,
    checkRuleR17,
    findImportCycles,
    collect,
  };
}
