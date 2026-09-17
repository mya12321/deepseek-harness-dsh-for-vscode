'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SHARE_MODES,
  WSL_SHARED_DEFAULT_PORT,
  normalizeShareMode,
  detectRuntimeEnvironment,
  resolveSharedEndpointPort,
} = require('../src/runtimeEnvironment');

const OS_RELEASE_PATH = '/proc/sys/kernel/osrelease';

function readerFor(content) {
  return (path) => {
    if (path === OS_RELEASE_PATH) {
      if (content === null) throw new Error('ENOENT');
      return content;
    }
    throw new Error('unexpected read: ' + path);
  };
}

test('detectRuntimeEnvironment classifies Windows extension hosts', () => {
  const environment = detectRuntimeEnvironment({
    platform: 'win32',
    env: {},
    readFile: readerFor(null),
    fresh: true,
  });
  assert.deepStrictEqual(
    { id: environment.id, isWsl: environment.isWsl, platform: environment.platform },
    { id: 'windows', isWsl: false, platform: 'win32' }
  );
});

test('detectRuntimeEnvironment classifies WSL via WSL_DISTRO_NAME', () => {
  const environment = detectRuntimeEnvironment({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    readFile: readerFor(null), // no /proc access needed when the env var is set
    fresh: true,
  });
  assert.strictEqual(environment.id, 'wsl');
  assert.strictEqual(environment.isWsl, true);
});

test('detectRuntimeEnvironment classifies WSL via the Microsoft kernel marker', () => {
  for (const release of [
    '5.15.153.1-microsoft-standard-WSL2\n',
    '4.4.0-19041-Microsoft\n',
  ]) {
    const environment = detectRuntimeEnvironment({
      platform: 'linux',
      env: {},
      readFile: readerFor(release),
      fresh: true,
    });
    assert.strictEqual(environment.id, 'wsl');
    assert.strictEqual(environment.isWsl, true);
  }
});

test('detectRuntimeEnvironment classifies plain Linux and other platforms', () => {
  const linux = detectRuntimeEnvironment({
    platform: 'linux',
    env: {},
    readFile: readerFor('5.15.0-generic\n'),
    fresh: true,
  });
  assert.deepStrictEqual({ id: linux.id, isWsl: linux.isWsl }, { id: 'linux', isWsl: false });

  const mac = detectRuntimeEnvironment({
    platform: 'darwin',
    env: {},
    readFile: readerFor(null),
    fresh: true,
  });
  assert.deepStrictEqual({ id: mac.id, isWsl: mac.isWsl }, { id: 'other', isWsl: false });
});

test('detectRuntimeEnvironment results are frozen and memoized', () => {
  let reads = 0;
  const options = {
    platform: 'linux',
    env: {},
    readFile: () => {
      reads += 1;
      return '5.15.153.1-microsoft-standard-WSL2\n';
    },
  };
  const first = detectRuntimeEnvironment({ ...options, fresh: true });
  const second = detectRuntimeEnvironment(options);
  assert.strictEqual(first, second);
  assert.strictEqual(reads, 1);
  assert.ok(Object.isFrozen(first));
});

test('normalizeShareMode falls back to the given default for unknown values', () => {
  assert.strictEqual(normalizeShareMode('environment'), SHARE_MODES.ENVIRONMENT);
  assert.strictEqual(normalizeShareMode('window'), SHARE_MODES.WINDOW);
  assert.strictEqual(normalizeShareMode(undefined), SHARE_MODES.WINDOW);
  assert.strictEqual(normalizeShareMode(undefined, SHARE_MODES.ENVIRONMENT), SHARE_MODES.ENVIRONMENT);
  assert.strictEqual(normalizeShareMode('Environment'), SHARE_MODES.WINDOW, 'matching is exact');
});

test('resolveSharedEndpointPort shifts only an unpinned default port on WSL', () => {
  const wsl = { id: 'wsl', isWsl: true, platform: 'linux' };
  const windows = { id: 'windows', isWsl: false, platform: 'win32' };
  const linux = { id: 'linux', isWsl: false, platform: 'linux' };

  // The core case: WSL, shared mode, autoStart, port left at its default.
  assert.strictEqual(resolveSharedEndpointPort({
    port: 3080, portExplicit: false, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: true, environment: wsl,
  }), WSL_SHARED_DEFAULT_PORT);
  assert.strictEqual(WSL_SHARED_DEFAULT_PORT, 3081);

  // An explicitly pinned port is always honored verbatim — the user owns the topology.
  assert.strictEqual(resolveSharedEndpointPort({
    port: 3080, portExplicit: true, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: true, environment: wsl,
  }), 3080);
  assert.strictEqual(resolveSharedEndpointPort({
    port: 4100, portExplicit: true, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: true, environment: wsl,
  }), 4100);

  // User-managed mode keeps the configured port for backward compatibility.
  assert.strictEqual(resolveSharedEndpointPort({
    port: 3080, portExplicit: false, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: false, environment: wsl,
  }), 3080);

  // Legacy window mode never shifts.
  assert.strictEqual(resolveSharedEndpointPort({
    port: 3080, portExplicit: false, shareMode: SHARE_MODES.WINDOW, autoStart: true, environment: wsl,
  }), 3080);

  // Non-WSL environments never shift.
  for (const environment of [windows, linux, null]) {
    assert.strictEqual(resolveSharedEndpointPort({
      port: 3080, portExplicit: false, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: true, environment,
    }), 3080);
  }
});
