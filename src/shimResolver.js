'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Windows shim resolution for the official @deepseek-ai/dsh CLI.
 *
 * npm/pnpm/yarn install `dsh` as `dsh.cmd` (+ `dsh.ps1`) shims whose content
 * embeds the real JavaScript entrypoint. Parsing the shim recovers the package
 * root for ANY global layout (npm %APPDATA%\\npm, pnpm %LOCALAPPDATA%\\pnpm,
 * yarn globals, scoop shims, custom prefixes) without executing anything.
 *
 * The .cmd-shim-to-bin.js conversion strategy is credited to the MIT-licensed
 * Fengze233/dsh-vscode project (src/service/process.ts, windowsDshInvocation).
 * All parsing here is defensive and read-only.
 *
 * @module shimResolver
 */

// pnpm additionally writes an extensionless POSIX `sh` shim next to the
// .cmd/.ps1 pair, and `where.exe dsh` returns that one first.
const SHIM_BASENAMES = ['dsh.cmd', 'dsh.ps1', 'dsh'];

/**
 * Extract raw entrypoint tokens from npm/pnpm/yarn shim content. Four
 * reference shapes are recovered, because the shim writers disagree:
 *
 *  - absolute drive paths (npm on some setups, cmd-shim's trailing
 *    `# cmd-shim-target=<abs>` marker)
 *  - `%~dp0%`-relative (npm: `SET dp0=%~dp0` then `"%dp0%\...\bin.js"`)
 *  - `%~dp0`-relative (pnpm: `"%~dp0\..\global\v11\<hash>\...\bin.js"` — note
 *    the MISSING closing `%`, which the original `%~dp0%` pattern rejected)
 *  - `$basedir`-relative with forward slashes (pnpm's .ps1 and `sh` shims:
 *    `"$basedir/../global/v11/<hash>/.../bin.js"`)
 *
 * @param {string} content
 * @returns {string[]} raw path tokens (may need shimDir expansion)
 */
function extractShimEntrypoints(content) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const tokens = new Set();
  // absolute-drive references: C:\...\@deepseek-ai\dsh\...\*.js (pnpm style)
  const absoluteRe = /[A-Za-z]:[\\/](?:[^\r\n"']*[\\/])?@deepseek-ai[\\/]dsh[\\/][^\r\n"']*\.js/g;
  for (const m of content.match(absoluteRe) || []) tokens.add(m);
  // %~dp0% / %~dp0 (and the `SET dp0=%~dp0` spelling), closing `%` OPTIONAL:
  // npm and cmd-shim write it, pnpm's `%~dp0\..\global\...` does not.
  const dpZeroRe = /%[~]?dp0%?[^\r\n"']*?@deepseek-ai[\\/]dsh[\\/][^\r\n"']*\.js/gi;
  for (const m of content.match(dpZeroRe) || []) tokens.add(m);
  // $basedir-relative references, forward- or back-slashed (pnpm .ps1 + sh).
  const basedirRe = /\$basedir[\\/][^\r\n"']*?@deepseek-ai[\\/]dsh[\\/][^\r\n"']*\.js/gi;
  for (const m of content.match(basedirRe) || []) tokens.add(m);
  // cmd-shim writes the resolved target as a trailing comment marker, which is
  // already absolute and needs no expansion at all — the most reliable hook.
  const markerRe = /cmd-shim-target=([^\r\n"';]+?\.js)/gi;
  for (const m of content.matchAll(markerRe)) tokens.add(m[1].trim());
  return [...tokens];
}

/** Expand $basedir / %~dp0% / %~dp0 (shim directory) inside a raw token. */
function expandShimToken(token, shimDir) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const dir = path.win32.resolve(String(shimDir));
  let expanded = token
    .replace(/\$basedir/gi, dir)
    .replace(/%~dp0%?/gi, dir + '\\')
    .replace(/%dp0%?/gi, dir + '\\');
  expanded = expanded.replace(/^"|"$/g, '').trim();
  if (!path.win32.isAbsolute(expanded)) return null;
  return path.win32.normalize(expanded);
}

/**
 * Derive the @deepseek-ai/dsh package root from an entrypoint script path.
 * The official package layout is <root>/lib/bin.js (package.json bin.dsh).
 * @param {string} entryPath absolute win32 path to the .js entrypoint
 */
function packageRootFromEntrypoint(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) return null;
  const normalized = path.win32.normalize(entryPath);
  if (!path.win32.isAbsolute(normalized)) return null;
  // <root>/lib/bin.js -> <root>; accept one extra nesting level defensively.
  const root = path.win32.dirname(path.win32.dirname(normalized));
  return root;
}

/**
 * Package-root candidates derived from one shim file's content plus the
 * classic npm layout fallback (<shimdir>/node_modules/@deepseek-ai/dsh).
 * @param {{ readFile?: Function }} [deps]
 * @returns {Promise<string[]>}
 */
async function packageRootsFromShim(shimPath, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.promises.readFile(p, 'utf8'));
  let content;
  try {
    content = await readFile(shimPath);
  } catch {
    return [];
  }
  const shimDir = path.win32.dirname(path.win32.resolve(shimPath));
  const roots = [];
  for (const token of extractShimEntrypoints(content)) {
    const entry = expandShimToken(token, shimDir);
    if (!entry) continue;
    const root = packageRootFromEntrypoint(entry);
    if (root) roots.push(root);
  }
  roots.push(path.win32.join(shimDir, 'node_modules', '@deepseek-ai', 'dsh'));
  return roots;
}

/**
 * Scan PATH segments for a dsh shim and derive package roots from each hit.
 * Windows-only discovery layer; read-only; best-effort.
 * @param {object} env
 * @param {{ readFile?: Function, stat?: Function }} [deps]
 * @returns {Promise<string[]>}
 */
async function shimDiscoveredPackageRoots(env, deps = {}) {
  const stat = deps.stat || ((p) => fs.promises.stat(p));
  const segments = String(env.Path || env.PATH || '').split(';').map((s) => s.trim()).filter(Boolean);
  const roots = [];
  for (const segment of segments) {
    for (const base of SHIM_BASENAMES) {
      const shimPath = path.win32.join(segment, base);
      try {
        const info = await stat(shimPath);
        if (!info.isFile()) continue;
      } catch {
        continue;
      }
      roots.push(...(await packageRootsFromShim(shimPath, deps)));
    }
  }
  return roots;
}

/**
 * Pure, filesystem-free package-root candidates from a Windows PATH: the npm
 * prefix can be the segment itself (shims directly in prefix) or its parent
 * (<prefix>/bin on PATH). Mirrors the POSIX PATH-scan layer.
 */
function windowsPathPackageCandidates(env) {
  const candidates = [];
  const segments = String(env.Path || env.PATH || '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    candidates.push(path.win32.join(segment, 'node_modules', '@deepseek-ai', 'dsh'));
    candidates.push(path.win32.join(segment, '..', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  return candidates;
}

/**
 * Fixed global-layout roots pnpm/yarn/scoop keep their globals in (npm and
 * the node version managers are covered by localRuntimeResolver's own layers).
 * Volta keeps per-package images under tools/image/packages/<scope>/<name>/<version>.
 */
function windowsGlobalLayoutCandidates(env, { readdir } = {}) {
  const listDir = readdir || ((p) => fs.promises.readdir(p));
  const sync = [];
  const local = env.LOCALAPPDATA;
  const home = env.HOME || env.USERPROFILE || '';
  if (local) {
    sync.push(
      path.win32.join(local, 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh'),
      path.win32.join(local, 'pnpm', 'global', 'node_modules', '@deepseek-ai', 'dsh'),
      path.win32.join(local, 'Yarn', 'config', 'global', 'node_modules', '@deepseek-ai', 'dsh'),
      path.win32.join(local, '.volta', 'tools', 'image', 'packages', '@deepseek-ai', 'dsh')
    );
  }
  if (home) {
    sync.push(
      path.win32.join(home, 'scoop', 'persist', 'nodejs', 'bin', 'node_modules', '@deepseek-ai', 'dsh'),
      path.win32.join(home, 'scoop', 'apps', 'nodejs', 'current', 'node_modules', '@deepseek-ai', 'dsh'),
      path.win32.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
    );
  }
  return { sync, voltaRoots: local ? [path.win32.join(local, '.volta', 'tools', 'image', 'packages', '@deepseek-ai', 'dsh')] : [] };
}

/**
 * Enumerate the pnpm global store. pnpm nests the real package under a
 * content-addressed directory whose name changes on EVERY install, so no
 * static path guess can be correct:
 *
 *   %LOCALAPPDATA%\pnpm\global\<hash>\node_modules\@deepseek-ai\dsh      (old)
 *   %LOCALAPPDATA%\pnpm\global\<major>\<hash>\node_modules\@deepseek-ai\dsh (v10+)
 *
 * The `global\5\...` guess in windowsGlobalLayoutCandidates only ever covered
 * pnpm's pre-v6 numbering; reading the directory listing covers every scheme.
 * Read-only and best-effort: an unreadable or absent store yields no roots.
 *
 * @param {object} env
 * @param {{ readdir?: Function }} [deps]
 * @returns {Promise<string[]>}
 */
async function pnpmGlobalPackageRoots(env, deps = {}) {
  const readdir = deps.readdir || ((p) => fs.promises.readdir(p, { withFileTypes: true }));
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  const globalDir = path.win32.join(local, 'pnpm', 'global');
  const pkgTail = ['node_modules', '@deepseek-ai', 'dsh'];
  const roots = [];
  let groups;
  try {
    groups = await readdir(globalDir);
  } catch {
    return [];
  }
  for (const group of groups) {
    if (!group || !group.isDirectory()) continue;
    const groupDir = path.win32.join(globalDir, group.name);
    roots.push(path.win32.join(groupDir, ...pkgTail));
    let nested;
    try {
      nested = await readdir(groupDir);
    } catch {
      continue;
    }
    for (const inner of nested) {
      if (!inner || !inner.isDirectory()) continue;
      roots.push(path.win32.join(groupDir, inner.name, ...pkgTail));
    }
  }
  return roots;
}

/**
 * Normalize the user-facing dsh.executablePath setting into package roots.
 * Accepted inputs: the package directory itself, the lib/bin.js entrypoint,
 * or a Windows shim (dsh.cmd / dsh.ps1 / dsh.bat) whose content embeds the
 * entrypoint. Returns { packageRoots } on success or { error } when the
 * input is neither a file we can interpret nor a directory.
 * @param {string} input absolute path from settings
 * @param {{ platform?: string, stat?: Function, readFile?: Function }} [deps]
 */
async function executableSettingPackageRoots(input, deps = {}) {
  const platform = deps.platform || process.platform;
  const stat = deps.stat || ((p) => fs.promises.stat(p));
  const isWin = platform === 'win32';
  const ext = path.posix.extname(String(input).replace(/\\/g, '/')).toLowerCase();
  let info;
  try {
    info = await stat(input);
  } catch {
    return { error: 'not-found' };
  }
  if (info.isDirectory()) {
    return { packageRoots: [input] };
  }
  if (!info.isFile()) {
    return { error: 'not-a-file' };
  }
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    const root = packageRootFromEntrypoint(input);
    return root ? { packageRoots: [root] } : { error: 'not-entrypoint-like' };
  }
  if (isWin && (ext === '.cmd' || ext === '.bat' || ext === '.ps1')) {
    const roots = await packageRootsFromShim(input, deps);
    return roots.length ? { packageRoots: roots } : { error: 'shim-parse-failed' };
  }
  return { error: 'unsupported-file-type' };
}

module.exports = {
  extractShimEntrypoints,
  expandShimToken,
  packageRootFromEntrypoint,
  packageRootsFromShim,
  executableSettingPackageRoots,
  shimDiscoveredPackageRoots,
  pnpmGlobalPackageRoots,
  windowsPathPackageCandidates,
  windowsGlobalLayoutCandidates,
};
