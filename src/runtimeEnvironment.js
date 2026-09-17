'use strict';

/**
 * runtimeEnvironment.js — identifies the OS environment this extension host
 * runs in (Windows vs WSL) and resolves the shared-instance endpoint port.
 *
 * `dsh.share.mode = "environment"` (extension default) converges every VS
 * Code window of one OS environment onto ONE DSH instance: Windows windows
 * use the Windows instance, WSL windows the WSL instance. Detection is
 * extension-host based — a Remote-WSL window runs this code inside WSL, a
 * local Windows window runs it on Windows, and a Windows window that opened
 * a \\wsl$ folder still counts as Windows (its extension host is local),
 * which is exactly the "whose DSH do I talk to" split the user asked for.
 *
 * Why WSL gets its own default port: WSL2 localhost forwarding (Windows→WSL)
 * makes a WSL-side listener reachable from Windows via 127.0.0.1. If both
 * environments probed the same default port, a Windows window that starts
 * before any Windows instance exists could adopt the WSL instance and drive
 * WSL paths from Windows UI. Shifting the WSL default to its own port when
 * the user has not pinned `dsh.port` keeps the two namespaces apart. An
 * explicitly configured port is always honored verbatim (the user owns the
 * topology then), and user-managed mode (autoStart=false) is never shifted
 * for backward compatibility.
 *
 * Zero external dependencies: only Node built-ins are used.
 */

const fs = require('node:fs');

const OS_RELEASE_PATH = '/proc/sys/kernel/osrelease';

/** Allowed values of the `dsh.share.mode` setting. */
const SHARE_MODES = Object.freeze({
  /** Legacy: every VS Code window probes and spawns its own DSH child. */
  WINDOW: 'window',
  /** All windows of one OS environment (Windows vs WSL) share one instance. */
  ENVIRONMENT: 'environment',
});

/** Default DSH web port for WSL extension hosts in environment-shared mode. */
const WSL_SHARED_DEFAULT_PORT = 3081;

/**
 * Normalize a raw `dsh.share.mode` setting to a known value. Unknown values
 * fall back to `fallback` (the API-level default is WINDOW so direct
 * ServerManager callers keep the legacy semantics; the extension passes
 * ENVIRONMENT as its own default).
 * @param {*} raw - the value read from the config (may be undefined).
 * @param {string} [fallback] - value returned for undefined/unknown input.
 * @returns {string} one of SHARE_MODES.
 */
function normalizeShareMode(raw, fallback = SHARE_MODES.WINDOW) {
  const resolved = raw === SHARE_MODES.WINDOW || raw === SHARE_MODES.ENVIRONMENT
    ? raw
    : fallback;
  return resolved === SHARE_MODES.ENVIRONMENT ? SHARE_MODES.ENVIRONMENT : SHARE_MODES.WINDOW;
}

/** Memoized osrelease read so repeated detections never touch /proc twice. */
const osReleaseCache = new Map();
/** Memoized detection results, keyed by the inputs that can change them. */
const environmentCache = new Map();

/**
 * Read the kernel release file (Linux only in practice). Returns '' when the
 * file is missing or unreadable (non-Linux platforms, hardened containers).
 * Results are memoized per path; `fresh` bypasses the cache for tests.
 * @param {string} osReleasePath - Absolute path of the osrelease file.
 * @param {(path: string) => string} readFile - Sync reader (injectable).
 * @param {boolean} [fresh] - True to bypass the memoization cache.
 * @returns {string}
 */
function readOsRelease(osReleasePath, readFile, fresh = false) {
  if (!fresh && osReleaseCache.has(osReleasePath)) return osReleaseCache.get(osReleasePath);
  let content = '';
  try {
    content = String(readFile(osReleasePath) || '');
  } catch {
    content = '';
  }
  osReleaseCache.set(osReleasePath, content);
  return content;
}

/**
 * Detect the OS environment of this extension host.
 *
 *  - `windows` — the extension host runs on Windows (local folder windows,
 *    including windows that browse WSL files over \\wsl$).
 *  - `wsl`     — the extension host runs inside WSL (Remote-WSL windows):
 *    `WSL_DISTRO_NAME` is set, or the kernel release carries the Microsoft
 *    WSL marker (covers WSL1 where the env var may be absent).
 *  - `linux`   — any other Linux (Remote-SSH, containers, native Linux).
 *  - `other`   — macOS and everything else.
 *
 * The result is frozen and memoized; pass `fresh: true` to recompute.
 *
 * @param {object} [options]
 * @param {string} [options.platform] - Override process.platform.
 * @param {object} [options.env] - Override process.env.
 * @param {string} [options.osReleasePath] - Override the osrelease path.
 * @param {(path: string) => string} [options.readFile] - Sync reader (injectable).
 * @param {boolean} [options.fresh] - Bypass the memoization cache.
 * @returns {{id: string, isWsl: boolean, platform: string}} Frozen environment.
 */
function detectRuntimeEnvironment({
  platform = process.platform,
  env = process.env,
  osReleasePath = OS_RELEASE_PATH,
  readFile = (candidate) => fs.readFileSync(candidate, 'utf8'),
  fresh = false,
} = {}) {
  const distro = String((env && env.WSL_DISTRO_NAME) || '').trim();
  const cacheKey = `${platform}\u0000${distro}\u0000${osReleasePath}`;
  if (!fresh && environmentCache.has(cacheKey)) return environmentCache.get(cacheKey);

  let environment;
  if (platform === 'win32') {
    environment = Object.freeze({ id: 'windows', isWsl: false, platform });
  } else if (platform === 'linux') {
    const release = readOsRelease(osReleasePath, readFile, fresh);
    const isWsl = distro.length > 0 || /microsoft/i.test(release);
    environment = Object.freeze({ id: isWsl ? 'wsl' : 'linux', isWsl, platform });
  } else {
    environment = Object.freeze({ id: 'other', isWsl: false, platform });
  }
  environmentCache.set(cacheKey, environment);
  return environment;
}

/**
 * Resolve the effective DSH endpoint port for one connect pass.
 *
 * The WSL default-port shift applies ONLY when all of these hold:
 *   - share mode is `environment` (shared-instance semantics are active),
 *   - the extension may start/adopt broadly (autoStart true — user-managed
 *     mode keeps the configured port verbatim for backward compatibility),
 *   - the environment is WSL,
 *   - the user did not explicitly set `dsh.port` at any configuration scope.
 * Every other combination returns the configured port unchanged.
 *
 * @param {object} options
 * @param {number} options.port - Configured `dsh.port` value.
 * @param {boolean} [options.portExplicit] - True when dsh.port is set at any scope.
 * @param {string} [options.shareMode] - Normalized share mode.
 * @param {boolean} [options.autoStart] - The dsh.autoStart setting.
 * @param {{isWsl?: boolean}|null} [options.environment] - detectRuntimeEnvironment() output.
 * @returns {number} The effective endpoint port.
 */
function resolveSharedEndpointPort({
  port,
  portExplicit = false,
  shareMode = SHARE_MODES.WINDOW,
  autoStart = true,
  environment = null,
} = {}) {
  if (!Number.isInteger(port)) return port;
  const shift = shareMode === SHARE_MODES.ENVIRONMENT
    && autoStart === true
    && !portExplicit
    && Boolean(environment && environment.isWsl);
  return shift ? WSL_SHARED_DEFAULT_PORT : port;
}

module.exports = {
  SHARE_MODES,
  WSL_SHARED_DEFAULT_PORT,
  normalizeShareMode,
  detectRuntimeEnvironment,
  resolveSharedEndpointPort,
};
