'use strict';

// Regression tests for the dsh_session follow consumer in client.js: when the
// VS Code shell reloads the embedded iframe with a fresh dsh_session query
// param (workspace switch / session navigation), the client must wait for the
// target session to appear in the sessions list mirror and route it through
// sessions.open() — without it the DSH web app restores its own persisted
// current session and the sidebar keeps showing the previous workspace.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadClient(shim) {
  let source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  source = source.replace(/^﻿/, '');
  const head = 'window.__ModuleLoader__.load(';
  assert.ok(source.startsWith(head), 'client.js must start with the module loader call');
  assert.ok(source.trimEnd().endsWith('});'), 'client.js must end with the loader call');
  const objectLiteral = '(' + source.slice(head.length).trimEnd().slice(0, -2) + ')';
  // eslint-disable-next-line no-new-func
  const loaded = new Function('window', 'navigator', 'document', 'URLSearchParams', 'TextEncoder', 'return ' + objectLiteral)(shim.window, shim.navigator, shim.document, URLSearchParams, TextEncoder);
  const moduleExports = loaded.factory();
  return moduleExports;
}

function createShim({ search = '?dsh_embed=vscode' } = {}) {
  const messageListeners = [];
  const document = {
    activeElement: { selectionStart: 0, selectionEnd: 0 },
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return true; },
  };
  const window = {
    location: { search },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    removeEventListener() {},
    getSelection() { return { toString: () => '' }; },
    URLSearchParams,
    TextEncoder,
  };
  window.parent = {
    postMessage(message) {
      if (message && message.type === 'dshWebviewHello') {
        for (const listener of messageListeners) {
          listener({
            source: window.parent,
            data: { type: 'dshWebviewReady', channel: message.channel, version: message.version },
          });
        }
      }
    },
  };
  return { window, document, navigator: { platform: 'Linux x86_64' } };
}

function createSessionsService({ byId = {}, current } = {}) {
  const opened = [];
  const snapshot = { ids: Object.keys(byId), byId, current, phase: 'ready' };
  return {
    opened,
    list: { getSnapshot: () => snapshot },
    open(id) { opened.push(id); },
  };
}

function applyWithDisposer(client, ctx) {
  let disposer = () => {};
  client.apply({ ...ctx, effect: (fn) => { disposer = fn(); return disposer; } });
  return () => disposer();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('dsh_session in the URL opens the target session once the list contains it', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  const sessions = createSessionsService({ byId: { 'sess-old': { sessionId: 'sess-old' } }, current: 'sess-old' });
  applyWithDisposer(client, { sessions });
  await sleep(60);
  assert.strictEqual(sessions.opened.length, 0, 'must wait for the target to appear in the list');
  sessions.list.getSnapshot = () => ({
    ids: ['sess-old', 'sess-42'],
    byId: { 'sess-old': { sessionId: 'sess-old' }, 'sess-42': { sessionId: 'sess-42' } },
    current: 'sess-old',
    phase: 'ready',
  });
  await sleep(250);
  assert.deepStrictEqual(sessions.opened, ['sess-42'], 'the workspace session becomes current');
});

test('no dsh_session param leaves the restored selection untouched', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode' });
  const client = loadClient(shim);
  const sessions = createSessionsService({ byId: { 'sess-old': {} }, current: 'sess-old' });
  applyWithDisposer(client, { sessions });
  await sleep(250);
  assert.strictEqual(sessions.opened.length, 0);
});

test('already-current target is not re-opened', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  const sessions = createSessionsService({ byId: { 'sess-42': {} }, current: 'sess-42' });
  applyWithDisposer(client, { sessions });
  await sleep(250);
  assert.strictEqual(sessions.opened.length, 0);
});

test('dispose stops the follow loop before the target appears', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  const sessions = createSessionsService({ byId: {}, current: undefined });
  const dispose = applyWithDisposer(client, { sessions });
  dispose();
  sessions.list.getSnapshot = () => ({
    ids: ['sess-42'], byId: { 'sess-42': {} }, current: undefined, phase: 'ready',
  });
  await sleep(250);
  assert.strictEqual(sessions.opened.length, 0, 'a disposed bridge must never navigate');
});

test('missing sessions.open degrades silently (older DSH builds)', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  const sessions = { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined }) } };
  let disposed = false;
  client.apply({ sessions, effect: (fn) => { fn(); return () => { disposed = true; }; } });
  await sleep(150);
  assert.strictEqual(disposed, false);
});

test('apply without a sessions service at all never throws', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  await sleep(50);
});

// ---------------------------------------------------------------------------
// Live bug 2026-09-18: "switching folders does not move the sidebar". The
// follow loop used to give up after 5s AND to bail outright when the sessions
// service was not mounted at apply time — both are silent failures, so the
// sidebar kept rendering the previous workspace's conversation.
// ---------------------------------------------------------------------------

test('a sessions service mounted after apply is still followed', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  const ctx = { effect: (fn) => { fn(); return () => {}; } };
  client.apply(ctx); // no sessions at apply time: the DSH plugin context is late
  await sleep(40);
  const sessions = createSessionsService({ byId: { 'sess-42': {} }, current: 'sess-old' });
  ctx.sessions = sessions;
  await sleep(250);
  assert.deepStrictEqual(sessions.opened, ['sess-42'], 'the follow must start once sessions mount');
});

test('the follow outlives the fast window instead of expiring with it', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  // Shrink the "responsive" window rather than sleeping through the real 5s:
  // the assertion is that the loop still runs when the target arrives after it.
  client.__sessionFollowLimits.fastWindowMs = 0;
  client.__sessionFollowLimits.tickMs = 5;
  client.__sessionFollowLimits.slowTickMs = 5;
  const sessions = createSessionsService({ byId: { 'sess-old': {} }, current: 'sess-old' });
  applyWithDisposer(client, { sessions });
  await sleep(60); // well past the (shrunk) fast window
  assert.strictEqual(sessions.opened.length, 0, 'nothing to open yet');
  sessions.list.getSnapshot = () => ({
    ids: ['sess-old', 'sess-42'],
    byId: { 'sess-old': {}, 'sess-42': {} },
    current: 'sess-old',
    phase: 'ready',
  });
  await sleep(60);
  assert.deepStrictEqual(sessions.opened, ['sess-42'], 'a late target is still followed');
});

test('the follow stops at its budget instead of polling forever', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  client.__sessionFollowLimits.fastWindowMs = 0;
  client.__sessionFollowLimits.tickMs = 5;
  client.__sessionFollowLimits.slowTickMs = 5;
  client.__sessionFollowLimits.budgetMs = 30;
  const sessions = createSessionsService({ byId: {}, current: undefined });
  applyWithDisposer(client, { sessions });
  await sleep(120); // past the budget
  sessions.list.getSnapshot = () => ({
    ids: ['sess-42'], byId: { 'sess-42': {} }, current: undefined, phase: 'ready',
  });
  await sleep(60);
  assert.strictEqual(sessions.opened.length, 0, 'an expired follow must not navigate later');
});

test('a user session switch while waiting is never yanked back to the target', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  const sessions = createSessionsService({ byId: { 'sess-old': {} }, current: 'sess-old' });
  applyWithDisposer(client, { sessions });
  await sleep(60);
  // The user clicks another row while the target is still absent from the list
  // (the list is still loading its workspace sessions).
  sessions.list.getSnapshot = () => ({
    ids: ['sess-old', 'sess-user'],
    byId: { 'sess-old': {}, 'sess-user': {} },
    current: 'sess-user',
    phase: 'ready',
  });
  await sleep(120);
  // The target finally shows up: opening it now would fight the user's click.
  sessions.list.getSnapshot = () => ({
    ids: ['sess-old', 'sess-user', 'sess-42'],
    byId: { 'sess-old': {}, 'sess-user': {}, 'sess-42': {} },
    current: 'sess-user',
    phase: 'ready',
  });
  await sleep(250);
  assert.deepStrictEqual(sessions.opened, [], 'the user click wins over the pending follow');
});

test('a restore that lands after the first snapshot is not mistaken for a click', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  // Boot: the list is up but nothing is selected yet.
  const sessions = createSessionsService({ byId: {}, current: undefined });
  applyWithDisposer(client, { sessions });
  await sleep(60);
  // The app then restores its persisted session, and the target arrives with it.
  sessions.list.getSnapshot = () => ({
    ids: ['sess-old', 'sess-42'],
    byId: { 'sess-old': {}, 'sess-42': {} },
    current: 'sess-old',
    phase: 'ready',
  });
  await sleep(250);
  assert.deepStrictEqual(sessions.opened, ['sess-42'], 'a late restore is still followed');
});

test('a list refresh that resets the selection is re-opened', async () => {
  const shim = createShim({ search: '?dsh_embed=vscode&dsh_session=sess-42' });
  const client = loadClient(shim);
  client.__sessionFollowLimits.openIntervalMs = 0;
  const sessions = createSessionsService({ byId: { 'sess-42': {} }, current: 'sess-old' });
  applyWithDisposer(client, { sessions });
  await sleep(300);
  assert.ok(sessions.opened.length >= 2, 'the open is retried while the selection keeps resetting');
  assert.ok(sessions.opened.every((id) => id === 'sess-42'));
});
