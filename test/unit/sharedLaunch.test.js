'use strict';

/**
 * Shared-environment launch coordination.
 *
 * Live bug this file pins down: several VS Code windows of one OS environment
 * starting at (slightly) the same time each spawned a managed `dsh web`. The
 * winner's instance became adoptable only after its listener bound and its
 * registry token landed, while the losers either raced the same port or —
 * worse — scanned forward and bound a second port successfully, leaving the
 * environment with several managed instances. The launch claim serializes the
 * decision-to-spawn across windows; every non-holder waits for and adopts the
 * holder's instance instead of starting its own.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ServerManager } = require('../../src/serverManager');

const TOKEN = 'shared-launch-test-token';

function tempRegistry(label) {
  return path.join(os.tmpdir(), `dsh-shared-launch-${label}-${process.pid}-${Date.now()}.json`);
}

function cleanupRegistry(file) {
  for (const candidate of [file, `${file}.launch`, `${file}.lock`]) {
    try { fs.rmSync(candidate, { force: true }); } catch { /* best-effort */ }
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** A DSH-shaped HTTP answer with the boot marker (tokenless/adoptable). */
function createDshServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><script>window.__DSH_BOOT__={}</script>');
  });
}

/**
 * Fenced-DSH stand-in: answers tokenless requests with 401 and a valid
 * `/?token=…` request with 303. `publishToken` writes the owning window's
 * registry entry (the adoptable moment).
 */
function createFencedDsh({ port, registryFile, tokenDelayMs = 0, bindDelayMs = 0 }) {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const firstLine = String(chunk).split('\r\n')[0] || '';
      if (firstLine.startsWith(`GET /?token=${TOKEN} `)) {
        socket.end('HTTP/1.1 303 Found\r\nLocation: /\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      } else {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    });
  });
  let bindTimer = null;
  const listenReady = new Promise((resolve) => {
    const start = () => server.listen(port, '127.0.0.1', resolve);
    if (bindDelayMs > 0) bindTimer = setTimeout(start, bindDelayMs);
    else start();
  });
  const publishToken = () => {
    fs.writeFileSync(registryFile, JSON.stringify([{
      pid: process.pid, // alive, so the entry counts as a live managed instance
      port,
      host: '127.0.0.1',
      authToken: TOKEN,
      vscodePid: process.pid,
      windowId: 'w-holder',
      at: Date.now(),
    }], null, 2) + '\n');
  };
  const tokenTimer = tokenDelayMs > 0 ? setTimeout(publishToken, tokenDelayMs) : null;
  if (tokenDelayMs <= 0) publishToken();
  return {
    async ready() { await listenReady; },
    publishToken,
    async close() {
      if (tokenTimer) clearTimeout(tokenTimer);
      if (bindTimer) clearTimeout(bindTimer);
      await closeServer(server);
    },
  };
}

/** Fake managed runtime file accepted by buildManagedLaunchSpec. */
function fakeRuntime() {
  const executable = path.join(
    os.tmpdir(),
    `dsh-shared-launch-runtime-${process.pid}-${Math.random().toString(16).slice(2)}${process.platform === 'win32' ? '.exe' : ''}`
  );
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return executable;
}

/**
 * Spawn fake `dsh web` children. `onSpawn(port)` lets a test start the HTTP
 * listener the child would have started; every spawn is recorded so tests can
 * assert the exact number of managed instances.
 */
function createFakeSpawner({ onSpawn = null } = {}) {
  const spawns = [];
  const children = [];
  const spawnFn = (command, args) => {
    const portIndex = args.lastIndexOf('--port');
    const port = Number(args[portIndex + 1]);
    spawns.push(port);
    const child = new EventEmitter();
    child.pid = 900000 + spawns.length;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    children.push(child);
    if (onSpawn) onSpawn(port, child);
    return child;
  };
  return { spawnFn, spawns, children };
}

function newManager({ windowId, spawnFn, onStatus = null }) {
  const manager = new ServerManager({
    spawnFn,
    onStatus: onStatus || undefined,
  });
  manager.setResolvedRuntime({
    executablePath: fakeRuntime(),
    dshHome: os.tmpdir(),
    profileHome: path.join(os.tmpdir(), 'profiles', 'web'),
  });
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId });
  return manager;
}

function ensureShared(manager, port, registryFile, extra = {}) {
  return manager.ensureServer({
    host: '127.0.0.1',
    port,
    autoStart: true,
    cwd: null,
    registryFile,
    shareMode: 'environment',
    discoverDshWebPorts: async () => [],
    ...extra,
  });
}

test('two windows starting at once spawn exactly one managed instance', async (t) => {
  const port = await findFreePort();
  const registryFile = tempRegistry('concurrent');
  fs.writeFileSync(registryFile, '[]\n');
  const servers = [];
  const fake = createFakeSpawner({
    onSpawn: (spawnPort) => {
      const server = createDshServer();
      servers.push(server);
      server.listen(spawnPort, '127.0.0.1');
    },
  });
  t.after(async () => {
    for (const server of servers) await closeServer(server);
    cleanupRegistry(registryFile);
  });

  const windowA = newManager({ windowId: 'w-a', spawnFn: fake.spawnFn });
  const windowB = newManager({ windowId: 'w-b', spawnFn: fake.spawnFn });

  const [handleA, handleB] = await Promise.all([
    ensureShared(windowA, port, registryFile),
    ensureShared(windowB, port, registryFile),
  ]);

  assert.equal(fake.spawns.length, 1,
    `exactly one managed instance must be spawned, saw ports ${JSON.stringify(fake.spawns)}`);
  assert.equal(fake.spawns[0], port, 'the shared instance stays on the configured port');
  assert.equal(handleA.port, port);
  assert.equal(handleB.port, port);
  assert.equal(handleA.owned !== handleB.owned, true,
    'exactly one window owns the child; the other adopts it');
  assert.equal(fs.existsSync(`${registryFile}.launch`), false,
    'the launch claim must be released once the instance is ready');
});

test('a window waits for a claimed launch and adopts it instead of spawning beside it', async (t) => {
  const port = await findFreePort();
  const registryFile = tempRegistry('wait');
  fs.writeFileSync(registryFile, '[]\n');
  const holdManager = newManager({ windowId: 'w-holder', spawnFn: () => { throw new Error('holder must not spawn'); } });
  const claim = holdManager._tryAcquireLaunchClaim(registryFile, { host: '127.0.0.1', port });
  assert.ok(claim, 'the test window must acquire the launch claim');
  holdManager._updateLaunchClaim({ port });

  // The claimed instance binds first and only becomes adoptable when its
  // owning window publishes the launch token — the exact multi-second gap
  // that used to make sibling windows spawn their own child.
  const fenced = createFencedDsh({ port, registryFile, tokenDelayMs: 600 });
  await fenced.ready();
  t.after(async () => {
    holdManager._releaseLaunchClaim();
    await fenced.close();
    cleanupRegistry(registryFile);
  });

  const waiter = newManager({ windowId: 'w-waiter', spawnFn: () => { throw new Error('waiter must not spawn'); } });
  const handle = await ensureShared(waiter, port, registryFile);

  assert.equal(handle.port, port, 'the waiter joins the claimed instance');
  assert.equal(handle.owned, false, 'the claimed instance is adopted, not owned');
  assert.equal(handle.managed, true, 'the adopted instance is extension-managed');
  assert.equal(waiter.hasOwnedChild(), false, 'the waiter never spawned a duplicate');
});

test('a discovered booting sibling is awaited, never spawned beside', async (t) => {
  const port = await findFreePort();
  const registryFile = tempRegistry('booting');
  fs.writeFileSync(registryFile, '[]\n');
  // The sibling's child exists but has not bound the port yet, so the port
  // probe says "refused". Only the process scan reveals it; treating that as
  // "nothing there" is what spawned a duplicate on port+1.
  const fenced = createFencedDsh({ port, registryFile, bindDelayMs: 150, tokenDelayMs: 600 });
  // Deliberately do not await ready(): the port must still be refused when
  // ensure starts; only the process scan can discover the booting sibling.
  const fake = createFakeSpawner();
  const manager = newManager({ windowId: 'w-late', spawnFn: fake.spawnFn });
  t.after(async () => {
    await fenced.close();
    cleanupRegistry(registryFile);
  });

  const handle = await ensureShared(manager, port, registryFile, {
    discoverDshWebPorts: async () => [port],
  });

  assert.equal(handle.port, port);
  assert.equal(handle.owned, false);
  assert.deepEqual(fake.spawns, [], 'the booting sibling must be adopted, not raced');
});

test('a waiter probes the port published by the claim, not only the configured port', async (t) => {
  const configuredPort = await findFreePort();
  let instancePort = await findFreePort();
  while (instancePort === configuredPort) instancePort = await findFreePort();
  const registryFile = tempRegistry('claim-port');
  fs.writeFileSync(registryFile, '[]\n');
  // The configured port belongs to a non-DSH service, so the shared instance
  // legitimately lives on the next port; waiters must follow the claim's
  // published port instead of scanning/spawning themselves.
  const plain = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not dsh');
  });
  await new Promise((resolve) => plain.listen(configuredPort, '127.0.0.1', resolve));
  const dsh = createDshServer();
  await new Promise((resolve) => dsh.listen(instancePort, '127.0.0.1', resolve));
  const holder = newManager({ windowId: 'w-holder', spawnFn: () => { throw new Error('holder must not spawn'); } });
  assert.ok(holder._tryAcquireLaunchClaim(registryFile, { host: '127.0.0.1', port: configuredPort }));
  holder._updateLaunchClaim({ port: instancePort });
  t.after(async () => {
    holder._releaseLaunchClaim();
    await closeServer(plain);
    await closeServer(dsh);
    cleanupRegistry(registryFile);
  });

  const fake = createFakeSpawner();
  const waiter = newManager({ windowId: 'w-waiter', spawnFn: fake.spawnFn });
  const handle = await ensureShared(waiter, configuredPort, registryFile, { sharedLaunchWaitMs: 5000 });

  assert.equal(handle.port, instancePort, 'the waiter adopts the claimed instance on its published port');
  assert.deepEqual(fake.spawns, [], 'the waiter must not spawn beside the claimed instance');
});

test('waiting for a live claimed launch is bounded and never spawns', async (t) => {
  const port = await findFreePort();
  const registryFile = tempRegistry('bounded');
  fs.writeFileSync(registryFile, '[]\n');
  const holder = newManager({ windowId: 'w-holder', spawnFn: () => { throw new Error('holder must not spawn'); } });
  assert.ok(holder._tryAcquireLaunchClaim(registryFile, { host: '127.0.0.1', port }));
  t.after(() => {
    holder._releaseLaunchClaim();
    cleanupRegistry(registryFile);
  });

  const fake = createFakeSpawner();
  const waiter = newManager({ windowId: 'w-waiter', spawnFn: fake.spawnFn });
  await assert.rejects(
    ensureShared(waiter, port, registryFile, { sharedLaunchWaitMs: 150 }),
    (error) => error.code === 'SHARED_START_IN_PROGRESS',
    'a live holder must produce a bounded, retryable error rather than a duplicate'
  );
  assert.deepEqual(fake.spawns, [], 'the waiter must not spawn beside a live claimed launch');
});

test('a claim left by a dead window is taken over', async (t) => {
  const port = await findFreePort();
  const registryFile = tempRegistry('stale');
  fs.writeFileSync(registryFile, '[]\n');
  fs.writeFileSync(`${registryFile}.launch`, JSON.stringify({
    token: 'dead-owner',
    pid: 999999999,
    vscodePid: 999999999,
    windowId: 'w-dead',
    environment: 'linux',
    host: '127.0.0.1',
    port,
    at: Date.now() - 60000,
    heartbeat: Date.now() - 60000,
  }));
  t.after(() => cleanupRegistry(registryFile));

  const fake = createFakeSpawner();
  const manager = newManager({ windowId: 'w-alive', spawnFn: fake.spawnFn });
  const claim = manager._tryAcquireLaunchClaim(registryFile, { host: '127.0.0.1', port });
  assert.ok(claim, 'a dead owner must not block the next window forever');
  assert.notEqual(claim.token, 'dead-owner');
  manager._releaseLaunchClaim();
});

test('a claim whose owner stopped heartbeating is displaced', async (t) => {
  const port = await findFreePort();
  const registryFile = tempRegistry('heartbeat');
  fs.writeFileSync(registryFile, '[]\n');
  fs.writeFileSync(`${registryFile}.launch`, JSON.stringify({
    token: 'hung-owner',
    pid: process.pid, // alive process, but its event loop stopped refreshing
    vscodePid: process.pid,
    windowId: 'w-hung',
    environment: 'linux',
    host: '127.0.0.1',
    port,
    at: Date.now() - 60000,
    heartbeat: Date.now() - 60000,
  }));
  t.after(() => cleanupRegistry(registryFile));

  const manager = newManager({ windowId: 'w-winner', spawnFn: () => { throw new Error('must not spawn'); } });
  const claim = manager._tryAcquireLaunchClaim(registryFile, { host: '127.0.0.1', port });
  assert.ok(claim, 'a hung holder must not block every other window');
  assert.notEqual(claim.token, 'hung-owner');
  manager._releaseLaunchClaim();
});

test('shared mode keeps the configured port after a restart instead of drifting', async (t) => {
  const port = await findFreePort();
  const registryFile = tempRegistry('restart');
  fs.writeFileSync(registryFile, '[]\n');
  const servers = [];
  const fake = createFakeSpawner({
    onSpawn: (spawnPort) => {
      const server = createDshServer();
      servers.push(server);
      server.listen(spawnPort, '127.0.0.1');
    },
  });
  const manager = newManager({ windowId: 'w-restart', spawnFn: fake.spawnFn });
  t.after(async () => {
    manager._clearHealthWatch();
    for (const server of servers) await closeServer(server);
    cleanupRegistry(registryFile);
  });

  await ensureShared(manager, port, registryFile);
  assert.deepEqual(fake.spawns, [port]);

  // Simulate the stop/restart boundary: the listener is gone, this manager no
  // longer owns a child, but it remembers the last port it spawned.
  manager._clearHealthWatch();
  for (const server of servers) await closeServer(server);
  manager._child = null;
  manager._ownedServer = null;
  ServerManager.removeRegistryEntries(registryFile, [900001]);

  const handle = await ensureShared(manager, port, registryFile);
  assert.equal(handle.port, port, 'a shared restart must reuse the canonical configured port');
  assert.deepEqual(fake.spawns, [port, port],
    `the fresh-origin rule must not apply in shared mode (saw ${JSON.stringify(fake.spawns)})`);
});

test('the launch claim never survives a completed ensure and is not re-created on release', async (t) => {
  const registryFile = tempRegistry('release');
  fs.writeFileSync(registryFile, '[]\n');
  t.after(() => cleanupRegistry(registryFile));
  const manager = newManager({ windowId: 'w-release', spawnFn: () => { throw new Error('must not spawn'); } });
  const claim = manager._tryAcquireLaunchClaim(registryFile, { host: '127.0.0.1', port: 40123 });
  assert.ok(claim);
  assert.equal(fs.existsSync(`${registryFile}.launch`), true);
  manager._releaseLaunchClaim();
  assert.equal(fs.existsSync(`${registryFile}.launch`), false);
  manager._releaseLaunchClaim(); // idempotent
  assert.equal(fs.existsSync(`${registryFile}.launch`), false);
});
test('the launch claim is exclusive across real processes', async (t) => {
  const registryFile = tempRegistry('cross-process');
  fs.writeFileSync(registryFile, '[]\n');
  t.after(() => cleanupRegistry(registryFile));

  // Every worker starts from the same wall-clock barrier, so all of them
  // attempt the claim while the winner still holds it.
  const startAt = Date.now() + 600;
  const script = `
    const { ServerManager } = require(${JSON.stringify(path.resolve(__dirname, '../../src/serverManager'))});
    const [registryFile, startAt, holdMs] = process.argv.slice(1);
    const manager = new ServerManager();
    manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-' + process.pid });
    while (Date.now() < Number(startAt)) { /* barrier */ }
    const claim = manager._tryAcquireLaunchClaim(registryFile, { host: '127.0.0.1', port: 40123 });
    console.log(claim ? 'acquired' : 'held');
    if (!claim) process.exit(0);
    setTimeout(() => { manager._releaseLaunchClaim(); process.exit(0); }, Number(holdMs));
  `;
  const workers = 4;
  const outputs = await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, registryFile, String(startAt), '300'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`claim worker exited ${code}: ${stderr}`));
      else resolve(stdout.trim());
    });
  })));

  assert.equal(outputs.filter((line) => line === 'acquired').length, 1,
    `exactly one process may hold the launch claim, saw ${JSON.stringify(outputs)}`);
  assert.equal(fs.existsSync(`${registryFile}.launch`), false,
    'the winner releases the claim on exit');
});
