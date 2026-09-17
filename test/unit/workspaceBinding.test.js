'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BINDING_STATES,
  createWorkspaceBinding,
} = require('../../src/context/workspaceBinding');

const BASE_URL = 'http://127.0.0.1:3080';

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

/**
 * Fetch mock speaking the 0.1.5 typert envelope.
 *
 * 0.1.5 has no workspace.list, so "already registered" is modelled by
 * `workspaces` (pre-registered paths). `workspace.create` returns
 * `created:false` for a registered path (adopt) and `created:true` otherwise
 * (fresh registration). Session negotiation is unchanged.
 *
 * @param {object} options
 * @param {Array<object>} [options.workspaces] - Pre-registered workspaces
 *   (path must match the bound cwd exactly to count as an adopt).
 * @param {Function} [options.createWorkspaceImpl] - Optional
 *   `(path) => { workspace, created }` override.
 * @param {Function} [options.deleteWorkspaceImpl] - Optional
 *   `(workspaceId) => { deleted }` override.
 * @param {Array<object>} [options.sessions] - session.list items.
 * @param {Function} [options.createSessionImpl] - Optional
 *   `(request) => request.workspaceId + '-session'` override.
 */
function createApi({
  workspaces = [],
  createWorkspaceImpl,
  deleteWorkspaceImpl,
  sessions = [],
  createSessionImpl,
} = {}) {
  const registered = workspaces.slice();
  const calls = {
    workspaceCreate: 0,
    workspaceDelete: 0,
    sessionList: 0,
    sessionCreate: 0,
  };
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'workspace/create') {
      calls.workspaceCreate += 1;
      if (createWorkspaceImpl) {
        return jsonResponse(200, {
          result: { ok: true, value: createWorkspaceImpl(request.payload.args.request.path) },
        });
      }
      const match = registered.find((w) => w.path === request.payload.args.request.path);
      if (match) {
        return jsonResponse(200, {
          result: { ok: true, value: { workspace: match, created: false } },
        });
      }
      const workspace = { workspaceId: 'w-new', path: request.payload.args.request.path, sessionIds: [] };
      registered.push(workspace);
      return jsonResponse(200, {
        result: { ok: true, value: { workspace, created: true } },
      });
    }
    if (request.method === 'workspace/delete') {
      calls.workspaceDelete += 1;
      const workspaceId = request.payload.args.request.workspaceId;
      if (deleteWorkspaceImpl) {
        return jsonResponse(200, {
          result: { ok: true, value: deleteWorkspaceImpl(workspaceId) },
        });
      }
      return jsonResponse(200, { result: { ok: true, value: { deleted: true } } });
    }
    if (request.method === 'session/list') {
      calls.sessionList += 1;
      return jsonResponse(200, { result: { ok: true, value: { items: sessions } } });
    }
    if (request.method === 'session/create') {
      calls.sessionCreate += 1;
      const args = request.payload.args.request;
      assert.deepStrictEqual(
        args,
        { workspaceId: args.workspaceId },
        'session.create must use workspaceId, never a bare cwd'
      );
      const sessionId = createSessionImpl
        ? createSessionImpl(args)
        : args.workspaceId + '-session';
      return jsonResponse(200, { result: { ok: true, value: { sessionId } } });
    }
    throw new Error('Unexpected API method: ' + request.method);
  };
  return { fetchImpl, calls };
}

function makeBinding(api, options = {}) {
  return createWorkspaceBinding({
    vscode: {},
    baseUrlProvider: () => BASE_URL,
    debounceMs: 0,
    fetchImpl: api.fetchImpl,
    ...options,
  });
}

test('owned + already registered (created:false) reuses blank root session from workspace.sessionIds', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'], title: 'Work' },
    ],
    sessions: [
      { sessionId: 's1', blank: true, cwd: 'D:\\work' },
    ],
  });
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, 'D:\\work');

  assert.strictEqual(sessionId, 's1');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().workspaceId, 'w1');
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 0,
    sessionList: 1,
    sessionCreate: 0,
  });
});

test('owned + workspace missing creates-or-adopts and creates session with workspaceId, no consent', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, 'D:\\new');

  assert.strictEqual(sessionId, 'w-new-session');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().workspaceId, 'w-new');
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 0,
    sessionList: 1,
    sessionCreate: 1,
  });
});

test('owned + no folder stays unbound and makes no API calls', async () => {
  const api = createApi({});
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, null);

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 0,
    workspaceDelete: 0,
    sessionList: 0,
    sessionCreate: 0,
  });
});

test('reused + no folder stays unbound and makes no API calls', async () => {
  const api = createApi({});
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, null);

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 0,
    workspaceDelete: 0,
    sessionList: 0,
    sessionCreate: 0,
  });
});

test('reused + already registered (created:false) binds silently, no consent prompt', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'] },
    ],
    sessions: [
      { sessionId: 's1', blank: true },
    ],
  });
  let consentCalls = 0;
  const binding = makeBinding(api, {
    requestConsent: async () => { consentCalls += 1; return true; },
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\work');

  assert.strictEqual(consentCalls, 0, 'adopting an existing workspace must not prompt');
  assert.strictEqual(sessionId, 's1');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().owned, false);
  assert.strictEqual(binding.state().workspaceId, 'w1');
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 0,
    sessionList: 1,
    sessionCreate: 0,
  });
});

test('reused + workspace missing creates (created:true), asks consent and proceeds when approved', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  let consentCwd = null;
  const binding = makeBinding(api, {
    requestConsent: async (cwd) => {
      consentCwd = cwd;
      return true;
    },
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\consent');

  assert.strictEqual(consentCwd, 'D:\\consent');
  assert.strictEqual(sessionId, 'w-new-session');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().workspaceId, 'w-new');
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 0,
    sessionList: 1,
    sessionCreate: 1,
  });
});

test('reused + workspace missing when consent is declined rolls the creation back and stays unbound', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  const binding = makeBinding(api, {
    requestConsent: async () => false,
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\declined');

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
  assert.strictEqual(binding.state().workspaceId, null);
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 1,
    sessionList: 0,
    sessionCreate: 0,
  });
});

test('reused + declined rollback failure still leaves the binding unbound', async () => {
  const api = createApi({
    workspaces: [],
    deleteWorkspaceImpl: () => {
      throw new Error('rollback failed');
    },
  });
  const binding = makeBinding(api, {
    requestConsent: async () => false,
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\declined');

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
});

test('API failure moves state to ERROR and returns null without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const binding = createWorkspaceBinding({
    vscode: {},
    baseUrlProvider: () => BASE_URL,
    debounceMs: 0,
    fetchImpl,
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, 'D:\\fail');

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.ERROR);
  assert.ok(binding.state().error.includes('ECONNREFUSED'), binding.state().error);
});

test('debounce 250ms coalesces rapid resolve calls into one workspace.create', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'] },
    ],
    sessions: [
      { sessionId: 's1', blank: true },
    ],
  });
  const binding = createWorkspaceBinding({
    vscode: {},
    baseUrlProvider: () => BASE_URL,
    debounceMs: 250,
    fetchImpl: api.fetchImpl,
  });
  const server = { url: BASE_URL, owned: true };
  const [first, second] = await Promise.all([
    binding.resolve(server, 'D:\\work'),
    binding.resolve(server, 'D:\\work'),
  ]);

  assert.strictEqual(first, 's1');
  assert.strictEqual(second, 's1');
  assert.strictEqual(api.calls.workspaceCreate, 1);
  assert.strictEqual(api.calls.sessionList, 1);
});

test('cache reuses bound mapping and refresh forces a new workspace.create', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'] },
    ],
    sessions: [
      { sessionId: 's1', blank: true },
    ],
  });
  const binding = makeBinding(api);
  const server = { url: BASE_URL, owned: true };

  assert.strictEqual(await binding.resolve(server, 'D:\\work'), 's1');
  assert.strictEqual(api.calls.workspaceCreate, 1);

  assert.strictEqual(await binding.resolve(server, 'D:\\work'), 's1');
  assert.strictEqual(api.calls.workspaceCreate, 1, 'cached resolve must not re-probe');

  assert.strictEqual(await binding.refresh(), 's1');
  assert.strictEqual(api.calls.workspaceCreate, 2, 'refresh must force a new workspace.create');
});