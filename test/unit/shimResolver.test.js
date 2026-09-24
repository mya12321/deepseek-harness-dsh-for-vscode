'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  extractShimEntrypoints,
  expandShimToken,
  packageRootFromEntrypoint,
  packageRootsFromShim,
  executableSettingPackageRoots,
  shimDiscoveredPackageRoots,
  pnpmGlobalPackageRoots,
  windowsPathPackageCandidates,
  windowsGlobalLayoutCandidates,
} = require('../../src/shimResolver');

const BS = String.fromCharCode(92);
// Windows paths are assembled at runtime so this file contains NO backslash
// literals (immune to any transport-layer escape mangling).
const w = (...parts) => parts.join(BS);
const PKG_TAIL = ['node_modules', '@deepseek-ai', 'dsh'].join(BS);

const NPM_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  ':start',
  'endLocal & "%_prog%"  "%dp0%' + BS + PKG_TAIL + BS + 'lib' + BS + 'bin.js" %*',
].join(String.fromCharCode(13, 10));

const PNPM_ROOT = w('C:', 'Users', 'dev', 'AppData', 'Local', 'pnpm', 'global', '5',
  '.pnpm', '@deepseek-ai+dsh@0.1.1-rc.1', 'node_modules', '@deepseek-ai', 'dsh');
const PNPM_CMD_SHIM = 'node "' + PNPM_ROOT + BS + 'lib' + BS + 'bin.js" %*';

const PS1_SHIM = '& "C:' + BS + 'Users' + BS + 'dev' + BS + 'AppData' + BS + 'Roaming' + BS
  + 'npm' + BS + PKG_TAIL + BS + 'lib' + BS + 'bin.js" $args';

// pnpm >= 6 writes its Windows shims -- and an extensionless POSIX `sh` shim
// that `where.exe dsh` returns FIRST -- against `%~dp0\..` (NO closing `%`)
// and `$basedir/..` with forward slashes, reaching into its content-addressed
// global store. Captured verbatim from a real pnpm 11 install.
const PNPM_STORE_TAIL = ['global', '5', '.pnpm', '@deepseek-ai+dsh@0.1.7-rc.1_4a0342b4', ...PKG_TAIL.split(BS)];
const PNPM_STORE_ROOT = w('C:', 'Users', 'dev', 'AppData', 'Local', 'pnpm', ...PNPM_STORE_TAIL);
const PNPM_SHIM_DIR = w('C:', 'Users', 'dev', 'AppData', 'Local', 'pnpm', 'bin');
const PNPM_STORE_REL = '..' + BS + PNPM_STORE_TAIL.join(BS) + BS + 'lib' + BS + 'bin.js';

// "%~dp0\..\global\..." -- the closing % after dp0 is absent.
const PNPM_CMD_SHIM_DP0 = 'node  "%~dp0' + BS + PNPM_STORE_REL + '" %*';
// pnpm's .ps1 and extensionless `sh` shims use $basedir with forward slashes.
const PNPM_BASEDIR_SHIM =
  'exec node  "$basedir/../' + PNPM_STORE_TAIL.join('/') + '/lib/bin.js" "$@"';
// cmd-shim appends the resolved target as a trailing comment marker.
const PNPM_MARKER_SHIM =
  '#!/bin/sh\nexec node "$basedir/../x.js" "$@"\n# cmd-shim-target='
  + PNPM_STORE_ROOT.replace(/\\/g, '/') + '/lib/bin.js';

test('extractShimEntrypoints finds npm %~dp0% and pnpm absolute entrypoints', () => {
  const npmTokens = extractShimEntrypoints(NPM_CMD_SHIM);
  assert.ok(npmTokens.length >= 1, 'npm shim yields at least one token');
  // npm writes `SET dp0=%~dp0` then quotes the target with %dp0%; pnpm
  // uses %~dp0% directly — either spelling must be accepted.
  assert.ok(npmTokens.some((token) => /%[~]?dp0%/.test(token) && token.endsWith('bin.js')));

  const pnpmTokens = extractShimEntrypoints(PNPM_CMD_SHIM);
  assert.ok(pnpmTokens.some((token) => token.includes('@deepseek-ai') && token.endsWith('bin.js')));

  const psTokens = extractShimEntrypoints(PS1_SHIM);
  assert.ok(psTokens.some((token) => token.includes('bin.js')));
});

test('expandShimToken expands %~dp0% into an absolute win32 path', () => {
  const expanded = expandShimToken(
    '%~dp0%' + BS + PKG_TAIL + BS + 'lib' + BS + 'bin.js',
    w('C:', 'Users', 'dev', 'AppData', 'Roaming', 'npm')
  );
  assert.strictEqual(
    expanded,
    w('C:', 'Users', 'dev', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  );
  assert.strictEqual(expandShimToken('relative' + BS + 'only.js', w('C:', 'x')), null);
});

test('extractShimEntrypoints accepts pnpm %~dp0 without a closing %', () => {
  const tokens = extractShimEntrypoints(PNPM_CMD_SHIM_DP0);
  assert.ok(
    tokens.some((token) => /%~dp0(?!%)/.test(token) && token.endsWith('bin.js')),
    'pnpm %~dp0\.. token recovered: ' + JSON.stringify(tokens)
  );
});

test('extractShimEntrypoints accepts $basedir-relative and marker references', () => {
  const basedirTokens = extractShimEntrypoints(PNPM_BASEDIR_SHIM);
  assert.ok(
    basedirTokens.some((token) => token.startsWith('$basedir/') && token.endsWith('bin.js')),
    '$basedir token recovered: ' + JSON.stringify(basedirTokens)
  );

  const markerTokens = extractShimEntrypoints(PNPM_MARKER_SHIM);
  assert.ok(
    markerTokens.some((token) => token === PNPM_STORE_ROOT.replace(/\\/g, '/') + '/lib/bin.js'),
    'cmd-shim-target marker recovered: ' + JSON.stringify(markerTokens)
  );
});

test('expandShimToken expands pnpm %~dp0 and $basedir into the store root', () => {
  for (const token of [
    '%~dp0' + BS + PNPM_STORE_REL,
    '$basedir/../' + PNPM_STORE_TAIL.join('/') + '/lib/bin.js',
  ]) {
    const expanded = expandShimToken(token, PNPM_SHIM_DIR);
    assert.strictEqual(expanded, path.win32.join(PNPM_STORE_ROOT, 'lib', 'bin.js'), 'from ' + token);
    assert.strictEqual(packageRootFromEntrypoint(expanded), PNPM_STORE_ROOT);
  }
});

test('shimDiscoveredPackageRoots finds pnpm extensionless sh shim', async () => {
  const fileInfo = { isDirectory: () => false, isFile: () => true };
  const shimPath = path.win32.join(PNPM_SHIM_DIR, 'dsh');
  const roots = await shimDiscoveredPackageRoots({ Path: PNPM_SHIM_DIR }, {
    stat: async (p) => (p === shimPath ? fileInfo : Promise.reject(new Error('ENOENT'))),
    readFile: async () => PNPM_BASEDIR_SHIM,
  });
  assert.ok(
    roots.includes(PNPM_STORE_ROOT),
    'extensionless pnpm shim root recovered: ' + roots.join(',')
  );
});

test('pnpmGlobalPackageRoots enumerates hash and <major>/<hash> layouts', async () => {
  const local = w('C:', 'U', 'AppData', 'Local');
  const globalDir = path.win32.join(local, 'pnpm', 'global');
  const dir = (name) => ({ name, isDirectory: () => true });
  const file = (name) => ({ name, isDirectory: () => false });
  const readdir = async (p) => {
    if (p === globalDir) return [dir('5'), dir('v11'), file('pnpm-workspace.yaml')];
    if (p === path.win32.join(globalDir, '5')) return [dir('.pnpm')];
    if (p === path.win32.join(globalDir, 'v11')) return [dir('abc123'), file('pnpm-workspace.yaml')];
    throw new Error('ENOENT');
  };

  const roots = await pnpmGlobalPackageRoots({ LOCALAPPDATA: local }, { readdir });
  const joined = roots.join('|');
  assert.ok(joined.includes(w('5', 'node_modules', '@deepseek-ai', 'dsh')), 'flat layout: ' + joined);
  assert.ok(
    joined.includes(w('v11', 'abc123', 'node_modules', '@deepseek-ai', 'dsh')),
    'nested hash layout: ' + joined
  );
  assert.ok(!joined.includes('pnpm-workspace'), 'non-directory entries skipped: ' + joined);

  const unreadable = async () => { throw new Error('EPERM'); };
  assert.deepStrictEqual(await pnpmGlobalPackageRoots({ LOCALAPPDATA: local }, { readdir: unreadable }), []);
  assert.deepStrictEqual(await pnpmGlobalPackageRoots({}), []);
});

test('packageRootFromEntrypoint strips the lib/bin.js tail', () => {
  assert.strictEqual(
    packageRootFromEntrypoint(w('C:', 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
    w('C:', 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh')
  );
  assert.strictEqual(packageRootFromEntrypoint('bin.js'), null);
});

test('packageRootsFromShim derives parsed and layout-fallback roots', async () => {
  const roots = await packageRootsFromShim(w('C:', 'prefix', 'dsh.cmd'), {
    readFile: async () => NPM_CMD_SHIM,
  });
  assert.ok(
    roots.includes(w('C:', 'prefix', 'node_modules', '@deepseek-ai', 'dsh')),
    'parsed root present: ' + roots.join(',')
  );

  const pnpmRoots = await packageRootsFromShim(w('C:', 'Users', 'dev', 'AppData', 'Local', 'pnpm', 'dsh.cmd'), {
    readFile: async () => PNPM_CMD_SHIM,
  });
  assert.ok(
    pnpmRoots.includes(PNPM_ROOT),
    'pnpm absolute root recovered: ' + pnpmRoots.join(',')
  );
});

test('windowsPathPackageCandidates probes the segment and its parent', () => {
  const candidates = windowsPathPackageCandidates({
    Path: [w('C:', 'a', 'bin'), w('C:', 'b'), '', w('C:', 'c')].join(';'),
  });
  assert.strictEqual(candidates.length, 6);
  assert.strictEqual(candidates[0], w('C:', 'a', 'bin', 'node_modules', '@deepseek-ai', 'dsh'));
  assert.strictEqual(candidates[1], w('C:', 'a', 'node_modules', '@deepseek-ai', 'dsh'));
});

test('windowsGlobalLayoutCandidates covers pnpm, yarn, scoop, volta', () => {
  const env = { LOCALAPPDATA: w('C:', 'U', 'AppData', 'Local'), USERPROFILE: w('C:', 'U') };
  const { sync, voltaRoots } = windowsGlobalLayoutCandidates(env);
  const joined = sync.join('|');
  for (const marker of [['pnpm','global','5'], ['Yarn','config','global'], ['scoop','persist','nodejs'], ['AppData','Roaming','npm']]) {
    assert.ok(joined.includes(marker.join(BS)), 'missing layout: ' + marker.join(BS));
  }
  assert.strictEqual(voltaRoots.length, 1);
  assert.ok(voltaRoots[0].includes('.volta'));
});

test('executableSettingPackageRoots accepts dir, entrypoint, and shim inputs', async () => {
  const dirStat = { isDirectory: () => true, isFile: () => false };
  const fileStat = { isDirectory: () => false, isFile: () => true };

  const asDir = await executableSettingPackageRoots(w('C:', 'pkg'), { platform: 'win32', stat: async () => dirStat });
  assert.deepStrictEqual(asDir, { packageRoots: [w('C:', 'pkg')] });

  const asJs = await executableSettingPackageRoots(w('C:', 'pkg', 'lib', 'bin.js'), { platform: 'win32', stat: async () => fileStat });
  assert.deepStrictEqual(asJs, { packageRoots: [w('C:', 'pkg')] });

  const asCmd = await executableSettingPackageRoots(w('C:', 'prefix', 'dsh.cmd'), {
    platform: 'win32',
    stat: async () => fileStat,
    readFile: async () => NPM_CMD_SHIM,
  });
  assert.ok(asCmd.packageRoots.includes(w('C:', 'prefix', 'node_modules', '@deepseek-ai', 'dsh')));

  const missing = await executableSettingPackageRoots(w('C:', 'nope', 'dsh.cmd'), {
    platform: 'win32',
    stat: async () => { throw new Error('ENOENT'); },
  });
  assert.strictEqual(missing.error, 'not-found');
});
