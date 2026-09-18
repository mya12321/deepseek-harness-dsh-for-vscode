'use strict';

const { execFile } = require('node:child_process');

/**
 * Process-command-line discovery of already-running `dsh web` services.
 *
 * Fallback layer for the case where the configured port stays silent but a
 * DSH web service is in fact running somewhere else on this machine (a port
 * override, a leftover instance from another window, a manually started
 * terminal session). Scans process command lines — never spawns dsh itself.
 *
 * The scan itself is deliberately broad (every process command line, filtered
 * in `parsePorts`) because the shape of a dsh listener depends on how it was
 * started: the extension's managed launch spawns the package entrypoint
 * directly (`node …/@deepseek-ai/dsh/lib/bin.js --profile vscode --host …
 * --port N --no-open` — note the absence of a `web` subcommand), while a
 * manual run uses the CLI (`dsh web --port N`). A shell-side pattern narrow
 * enough to miss the managed shape silently disables shared-instance adoption
 * (live bug 2026-09-18: two VS Code windows of one WSL environment each
 * spawned their own DSH), so the narrowing happens here, where it is testable.
 *
 * The PowerShell/ps scanning approach is credited to the MIT-licensed
 * DM010727/dsh-cline project (packages/extension/src/extension.ts,
 * discoverDshWebUrls), hardened here with a cache, injectable exec, and
 * per-platform timeouts.
 *
 * @module processDiscovery
 */

const CACHE_TTL_MS = 5000;
const WIN_TIMEOUT_MS = 8000;

/**
 * Whether one process command line is a candidate `dsh web` listener.
 *
 * The `dsh` token must be a path segment (`…/@deepseek-ai/dsh/lib/bin.js`,
 * `…/dsh/bin.js`) or the command word itself (`dsh web --port …`,
 * `dsh.cmd web`), so a line that merely mentions a path containing "dsh"
 * (this project's own `deepseek-harness-dsh-for-vscode`, for instance) is not
 * a candidate. A `--port` argument is required: it is what the port is read
 * from, and every dsh web launch (managed or CLI) passes one.
 *
 * Candidates are only ever probed, never trusted, so a generous match costs a
 * probe at worst — a wrong one cannot be adopted.
 *
 * @param {string} command - One `ps`/PowerShell command line.
 * @returns {boolean} True when the line may be a running dsh web listener.
 */
function looksLikeDshListener(command) {
  const line = String(command === undefined || command === null ? '' : command);
  if (!/--port[= ]\d+/.test(line)) return false;
  return /(?:^|[\s"'=\\/])@deepseek-ai[\\/]dsh[\\/]/i.test(line)
    || /(?:^|[\s"'=\\/])dsh[\\/](?:lib[\\/])?bin\.(?:js|cjs|mjs)/i.test(line)
    || /(?:^|[\s"'=\\/])dsh(?:\.exe|\.cmd|\.ps1)?(?=[\s"'])/i.test(line);
}

/**
 * Extract `--port` values from scan output, keeping only lines that look like
 * a dsh web listener (see looksLikeDshListener). Port 0 (dsh's own "pick a
 * free port" value) is never a usable target.
 *
 * @param {string} stdout - Raw scan output, one command line per row.
 * @returns {number[]} Unique ports in order of appearance.
 */
function parsePorts(stdout) {
  const ports = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!looksLikeDshListener(line)) continue;
    const port = /--port[= ](\d+)/.exec(line)?.[1];
    if (port !== undefined && port !== '0') ports.push(Number(port));
  }
  return [...new Set(ports)];
}

/**
 * Build the platform-specific command list for scanning dsh processes. The
 * commands dump candidate command lines only; the dsh-shape filter lives in
 * parsePorts.
 */
function scanCommands(platform) {
  if (platform === 'win32') {
    return [{
      file: 'powershell.exe',
      args: ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='dsh.exe' or Name='dsh.cmd' or Name='bun.exe'\" | ForEach-Object { $_.CommandLine }"],
    }];
  }
  return [{
    file: 'sh',
    args: ['-lc', 'ps -eo command || true'],
  }];
}

/**
 * Discover ports of running `dsh web` listeners on this machine.
 * Results are cached for CACHE_TTL_MS; failures yield [] (best-effort).
 * @param {{ platform?: string, execFn?: Function }} [deps]
 * @returns {Promise<number[]>} unique ports, order of appearance
 */
async function discoverDshWebPorts({ platform = process.platform, execFn } = {}) {
  const run = execFn || ((file, args) => new Promise((resolve) => {
    execFile(file, args,
      { windowsHide: true, timeout: platform === 'win32' ? WIN_TIMEOUT_MS : 4000 },
      (error, stdout) => resolve(error ? '' : stdout));
  }));
  if (discoverDshWebPorts._cache && Date.now() - discoverDshWebPorts._cacheAt < CACHE_TTL_MS) {
    return discoverDshWebPorts._cache;
  }
  let ports = [];
  for (const command of scanCommands(platform)) {
    try {
      const stdout = await run(command.file, command.args);
      ports = parsePorts(stdout);
    } catch {
      ports = []; // best-effort only: a missing powershell/ps never throws
    }
    if (ports.length > 0) break;
  }
  discoverDshWebPorts._cache = ports;
  discoverDshWebPorts._cacheAt = Date.now();
  return ports;
}

/** Test hook: clear the discovery cache. */
discoverDshWebPorts.resetCache = function resetCache() {
  discoverDshWebPorts._cache = null;
  discoverDshWebPorts._cacheAt = 0;
};

module.exports = { discoverDshWebPorts, looksLikeDshListener, parsePorts, scanCommands };
