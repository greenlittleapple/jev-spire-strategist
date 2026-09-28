// Builds a standalone jev-the-spire tree with the strategist layer, for a fork.
//   node integration/sts2/export-fork.mjs [outDir]   (default .private/fork/jev-the-spire)
// Copies the git-tracked files of vendor/jev-the-spire and integration/sts2 (as sts2/),
// rewrites the imports between them, and adds the sts2 scripts to package.json.
// It never touches git remotes or publishes anything.
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {dirname, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2] ?? resolve(root, '.private/fork/jev-the-spire'));
if (!relative(root, out).startsWith('.private')) throw Error('Export only under .private/ so it stays out of this repo.');
const tracked = execFileSync('git', ['ls-files', 'vendor/jev-the-spire', 'integration/sts2'], {cwd: root, encoding: 'utf8'}).split('\n').filter(Boolean);

const rewrites = [
 // spire-demo -> strategist layer
 [/(['"])\.\.\/\.\.\/\.\.\/integration\/sts2\//g, '$1../sts2/'],
 // strategist layer -> spire-demo
 [/(['"])\.\.\/\.\.\/vendor\/jev-the-spire\/spire-demo\//g, '$1../spire-demo/'],
 // the strategist layer's repo root is one level up in the fork
 [/(fileURLToPath\(import\.meta\.url\)\)\s*,\s*)'\.\.\/\.\.'/g, "$1'..'"],
];

await rm(out, {recursive: true, force: true});
let rewritten = 0;
for (const file of tracked) {
 const target = file.startsWith('vendor/jev-the-spire/') ? file.slice('vendor/jev-the-spire/'.length) : 'sts2/' + file.slice('integration/sts2/'.length);
 if (file.endsWith('export-fork.mjs')) continue;
 let body = await readFile(resolve(root, file));
 if (/\.(mjs|js|json|md)$/.test(file)) {
  let text = body.toString('utf8');
  const before = text;
  for (const [from, to] of rewrites) text = text.replace(from, to);
  if (text !== before) rewritten++;
  body = text;
 }
 await mkdir(dirname(resolve(out, target)), {recursive: true});
 await writeFile(resolve(out, target), body);
}

const pkgPath = resolve(out, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
pkg.scripts = {...pkg.scripts,
 test: 'node --test spire-demo/*.test.mjs spire-demo/experiment/*.test.mjs sts2/*.test.mjs',
 sts2: 'node sts2/launch.mjs',
 'sts2:strategy': 'node sts2/strategy-cli.mjs',
 'sts2:start': 'node sts2/start-run.mjs',
 'sts2:scorecard': 'node sts2/scorecard.mjs',
};
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Code paths that still point at the old layout (comments are fine; imports are not).
let leftovers = [];
try {
 leftovers = execFileSync('git', ['grep', '--no-index', '-l', '-E', "(from|import\\()\\s*'[^']*(integration/sts2|vendor/jev-the-spire)", '--', '*.mjs'], {cwd: out, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim().split('\n').filter(Boolean);
} catch {}
console.log(JSON.stringify({out, files: tracked.length - 1, rewritten, leftovers}));
