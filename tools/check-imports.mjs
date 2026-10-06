// Static sanity check for a project without a bundler: every relative import must point at an existing file,
// and every named import must be exported by that file. It also checks what an import scan cannot see: the "./" files
// the root html pages reference, the modules the editor's registries name, and that both pages share one import map.
// Run: node tools/check-imports.mjs [file or directory ...]
// With arguments only those files are checked, so somebody else's half-written module does not fail your run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['server.js', 'src', 'tools', 'test'];
// The editor loads its tools, panels and overlays with a dynamic import() of the `path: '...'` strings in these lists.
// The strings are relative to src/editor/ - the directory of main.js, which does the importing - not to the list's own file.
const EDITOR = path.join(ROOT, 'src', 'editor');
const REGISTRIES = ['tools/index.js', 'panels/index.js', 'overlays/index.js'].map((f) => path.join(EDITOR, f));
const PAGES = ['index.html', 'editor.html'].map((f) => path.join(ROOT, f));   // three.js must come from one import map

function walk(p, out = []) {
  if (!fs.existsSync(p)) return out;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p)) if (f !== 'node_modules' && !f.startsWith('.')) walk(path.join(p, f), out);
  } else if (/\.(js|mjs)$/.test(p)) out.push(p);
  return out;
}

// strips comments and string contents that could confuse the regexes (keeps import/export specifier strings intact enough)
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const exportCache = new Map();
function exportsOf(file, seen = new Set()) {
  if (exportCache.has(file)) return exportCache.get(file);
  const names = new Set();
  if (seen.has(file) || !fs.existsSync(file)) return names;
  seen.add(file);
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export const a = 1, b = 2;  (only the simple comma form at the declaration level)
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([^;=]+=[^;]*);/g)) {
    for (const part of m[0].replace(/^export\s+(?:const|let|var)\s+/, '').split(/,\s*(?=[A-Za-z_$][\w$]*\s*=)/)) {
      const id = part.match(/^\s*([A-Za-z_$][\w$]*)\s*=/);
      if (id) names.add(id[1]);
    }
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/\s+as\s+/).pop();
      if (id) names.add(id);
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  for (const m of src.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1].startsWith('.')) for (const n of exportsOf(path.resolve(path.dirname(file), m[1]), seen)) names.add(n);
  }
  exportCache.set(file, names);
  return names;
}

const rel = (file) => path.relative(ROOT, file);
const problems = [];

// ---------------------------------------------------------------- what to check

// No arguments: the whole project. Arguments (relative to the current directory): those files and directories only.
const args = process.argv.slice(2).map((a) => path.resolve(a));
for (const a of args) if (!fs.existsSync(a)) problems.push(`${rel(a)}: no such file or directory`);
const targets = args.length ? args : ROOTS.map((r) => path.join(ROOT, r));
const files = new Set(targets.flatMap((t) => walk(t)));
// html pages count only at the root; a directory argument never pulls them in
const pages = args.length
  ? args.filter((a) => a.endsWith('.html') && fs.existsSync(a))
  : fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, f));

// ---------------------------------------------------------------- editor registries

// A registry that is not written yet is skipped, like a missing editor.html.
for (const registry of REGISTRIES) {
  if (!files.has(registry)) continue;
  const src = stripComments(fs.readFileSync(registry, 'utf8'));
  for (const m of src.matchAll(/\bpath\s*:\s*(['"`])([^'"`\n]+)\1/g)) {
    const target = path.resolve(EDITOR, m[2]);
    if (!fs.existsSync(target)) problems.push(`${rel(registry)}: path '${m[2]}' names a missing file (relative to src/editor/)`);
    else if (/\.(js|mjs)$/.test(target)) files.add(target);    // its imports are checked below with everybody else's
  }
}

// ---------------------------------------------------------------- imports

let checked = 0;
for (const file of files) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const imports = [
    ...src.matchAll(/import\s+([^'";]*?)\s+from\s*['"]([^'"]+)['"]/g),
    ...[...src.matchAll(/import\s*['"]([^'"]+)['"]/g)].map((m) => [m[0], '', m[1]]),
    ...[...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => [m[0], '', m[1]]),
  ];
  for (const [, clause, spec] of imports) {
    if (!spec.startsWith('.')) continue;   // bare specifiers (three, ws, node:*) are resolved elsewhere
    const target = path.resolve(path.dirname(file), spec);
    checked++;
    if (!fs.existsSync(target)) { problems.push(`${rel(file)}: imports missing file ${spec}`); continue; }
    const available = exportsOf(target);
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const id = part.trim().split(/\s+as\s+/)[0].trim();
        if (id && !available.has(id)) problems.push(`${rel(file)}: '${id}' is not exported by ${spec}`);
      }
    }
    const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '').replace(/,/g, '').trim();
    if (head && !available.has('default')) problems.push(`${rel(file)}: default import '${head}' but ${spec} has no default export`);
  }
}

// ---------------------------------------------------------------- html pages

// every src / href that starts with "./" is a file of this project and must exist
let refs = 0;
for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*(?:"(\.\/[^"]*)"|'(\.\/[^']*)')/g)) {
    const ref = m[1] ?? m[2];
    refs++;
    const target = path.resolve(path.dirname(page), ref.split(/[?#]/)[0]);
    if (!fs.existsSync(target)) problems.push(`${rel(page)}: references missing file ${ref}`);
  }
}

// editor.html copies the import map of index.html verbatim; two versions of three.js in one project would not mix
const importMap = (page) => {
  const m = /<script\s[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(fs.readFileSync(page, 'utf8'));
  return m ? m[1].replace(/\s+/g, '') : '';
};
const bothPages = PAGES.every((p) => fs.existsSync(p)) && (!args.length || PAGES.some((p) => pages.includes(p)));
if (bothPages && importMap(PAGES[0]) !== importMap(PAGES[1])) {
  problems.push(`${rel(PAGES[1])}: its import map differs from the one in ${rel(PAGES[0])}`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) in ${files.size} files`);
  process.exit(1);
}
console.log(`ok: ${checked} relative imports in ${files.size} files${pages.length ? `, ${refs} references in ${pages.length} html page(s)` : ''}`);
