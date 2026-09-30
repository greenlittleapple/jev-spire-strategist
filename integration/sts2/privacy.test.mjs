// Repository check: files that are or can be committed, and commit messages, must not carry the
// details .private/publish-public.sh refuses to publish (personal email, Steam ID, local user
// folder, local game drive, keys and tokens), nor drive-letter install paths. The publish script
// checks after a commit is made; this runs with the tests, before. Patterns are general, so the
// private values themselves are not written here. Ignored files (.private, .env) are never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve, dirname, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true});
const BINARY = new Set(['.dll', '.exe', '.pdb', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.zip', '.pck', '.woff', '.woff2']);
const NOREPLY = /@users\.noreply\.github\.com$|^noreply@/i;
const PATTERNS = [
 ['a local user folder', /\bUsers[\\/]+(?![<{$%*.[])[A-Za-z0-9._-]+/i],
 ['a drive-letter install path', /\b[A-Za-z]:[\\/]+(?:Program Files|Games|SteamLibrary)/i],
 ['a local game drive label', /\bGames \([A-Z]\)/],
 ['a Steam ID', /\b7656119\d{10}\b/],
 ['an email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
 ['an API key or bridge token value', /\b(?:TYPESAFE_API_KEY|GAME_BRIDGE_TOKEN)\s*[=:]\s*["']?(?!your-)[A-Za-z0-9_.-]{12,}/],
 ['a secret key', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/],
];
// Known public placeholders, each with where it comes from.
const ALLOWED = [
 // The upstream STS2MCP default game folder, overridden by STS2GameDir; not this machine's path.
 ['integration/sts2-bridge/STS2_MCP.csproj', 'a drive-letter install path'],
 // The upstream API reference's example player ID (all zeros after the Steam prefix).
 ['vendor/jev-the-spire/spire-demo/vendor/api-reference.md', 'a Steam ID', /\b76561198000000000\b/],
];

function findings(text, name) {
 const found = [];
 text.split('\n').forEach((line, i) => {
  for (const [what, pattern] of PATTERNS) {
   const hits = what === 'an email address' ? [...line.matchAll(pattern)].map(m => m[0]).filter(m => !NOREPLY.test(m)) : pattern.test(line) ? [line] : [];
   if (!hits.length) continue;
   if (ALLOWED.some(([file, kind, only]) => file === name && kind === what && (!only || line.replace(new RegExp(only.source, 'g'), '').match(pattern) === null))) continue;
   found.push(`${name}:${i + 1}: ${what}`);
  }
 });
 return found;
}

test('the patterns catch each kind of private detail and pass placeholders', () => {
 const user = ['C:', 'Users', 'someone', 'Projects'].join('\\');
 const cases = [[user, 'a local user folder'], [['E:', 'Games', 'Slay the Spire 2'].join('/'), 'a drive-letter install path'],
  ['Games ' + '(E)', 'a local game drive label'], ['7656119' + '8123456789', 'a Steam ID'],
  [['someone', 'example.org'].join('@'), 'an email address'], ['TYPESAFE_API_KEY=' + 'x'.repeat(24), 'an API key or bridge token value']];
 for (const [text, what] of cases) assert.deepEqual(findings(text, 'x.md'), [`x.md:1: ${what}`], text);
 for (const text of ['C:/Users/<name>/Projects', 'TYPESAFE_API_KEY=', 'TYPESAFE_API_KEY="your-key-here"',
  'Co-Authored-By: Claude <' + ['noreply', 'anthropic.com'].join('@') + '>', ['1+name', 'users.noreply.github.com'].join('@')])
  assert.deepEqual(findings(text, 'x.md'), [], text);
 // An allowed placeholder does not hide a real value on the same line.
 assert.equal(findings('7656119' + '8000000000 7656119' + '8123456789', 'vendor/jev-the-spire/spire-demo/vendor/api-reference.md').length, 1);
});

test('no private details in committable files', async () => {
 const found = [];
 const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
 assert.ok(files.length > 100, 'git lists the repository files');
 for (const name of files) {
  if (BINARY.has(extname(name).toLowerCase()) || name === '.env') continue;
  let bytes;
  try { bytes = await readFile(resolve(root, name)); } catch { continue; } // deleted in the working tree
  if (bytes.includes(0)) continue;
  found.push(...findings(bytes.toString('utf8'), name));
 }
 assert.deepEqual(found, []);
});

test('no private details in commit messages', () => {
 const found = [];
 for (const entry of git(['log', '--format=%H%x00%B%x01', 'HEAD']).split('\x01')) {
  const [hash, body] = entry.trim().split('\0');
  if (body) found.push(...findings(body, hash.slice(0, 7)));
 }
 assert.deepEqual(found, []);
});
