'use strict';

// dsh 0.1.2-rc.1 added a browser-auth layer to the web UI: the spawned
// process prints an authenticated URL (`dsh web: http://127.0.0.1:PORT/?token=…`)
// and a GET of `/?token=…` mints a session cookie that all later /api calls
// must carry. Older runtimes print a plain URL and accept unauthenticated
// requests. This module bridges both: given a token it exchanges it for the
// cookie once and transparently attaches (and re-mints on 401) the Cookie
// header on every fetch it wraps, so API clients stay auth-agnostic.

/** How long a successfully exchanged cookie is reused before re-minting. */
const COOKIE_TTL_MS = 60 * 60 * 1000;
/** How long a failed exchange is remembered before trying again. */
const FAILURE_TTL_MS = 30 * 1000;
/**
 * Per-request deadline for the unary DSH API calls this fetch wraps
 * (workspace/create, session/list, …). Node's fetch has no response timeout,
 * so a DSH whose event loop is stalled — the classic post-disconnect state —
 * used to leave workspace binding pending forever and every later Retry
 * queued behind it. With this bound the lifecycle queue always advances.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
/** Token exchange (GET /?token=…) is short; never let it block the request. */
const TOKEN_MINT_TIMEOUT_MS = 5000;

/** Raised when a DSH API request exceeded its deadline (not a caller abort). */
class DshApiTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`DSH API request timed out after ${timeoutMs}ms`);
    this.name = 'DshApiTimeoutError';
    this.code = 'DSH_API_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function abortReason(signal) {
  try {
    return signal && signal.reason !== undefined ? signal.reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compose an optional caller signal with a local deadline.
 * @param {AbortSignal|undefined} externalSignal
 * @param {number} timeoutMs
 * @returns {{signal: AbortSignal, timedOut: () => boolean, cleanup: () => void}}
 */
function createRequestDeadline(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;
  const onAbort = () => {
    try { controller.abort(abortReason(externalSignal)); } catch { controller.abort(); }
  };
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DshApiTimeoutError(timeoutMs));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    },
  };
}

const RESPONSE_BODY_METHODS = new Set(['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes']);

/**
 * Keep the request deadline armed until the body is consumed: fetch resolves
 * on headers, so clearing the timer there would leave a stalled body read
 * unbounded. Body methods report a deadline as DshApiTimeoutError.
 */
function withResponseDeadline(response, deadline, timeoutMs) {
  if (!response || typeof response !== 'object') {
    deadline.cleanup();
    return response;
  }
  return new Proxy(response, {
    get(target, property) {
      if (RESPONSE_BODY_METHODS.has(property) && typeof target[property] === 'function') {
        return async (...args) => {
          try {
            return await target[property](...args);
          } catch (error) {
            if (deadline.timedOut()) throw new DshApiTimeoutError(timeoutMs);
            throw error;
          } finally {
            deadline.cleanup();
          }
        };
      }
      return Reflect.get(target, property, target);
    },
  });
}

/**
 * One fetch attempt bounded by `timeoutMs`; a caller abort propagates
 * unchanged, a deadline becomes DshApiTimeoutError.
 */
async function fetchWithDeadline(fetchImpl, input, init, timeoutMs) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return fetchImpl(input, init);
  }
  const externalSignal = init && init.signal ? init.signal : undefined;
  const deadline = createRequestDeadline(externalSignal, timeoutMs);
  let response;
  try {
    response = await fetchImpl(input, { ...(init || {}), signal: deadline.signal });
  } catch (error) {
    deadline.cleanup();
    if (deadline.timedOut()) throw new DshApiTimeoutError(timeoutMs);
    throw error;
  }
  return withResponseDeadline(response, deadline, timeoutMs);
}

/**
 * Extract the `token` query parameter from a launch URL, or null.
 *
 * @param {string} url - URL that may carry `?token=…`.
 * @returns {string|null}
 */
function tokenFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const value = new URL(url).searchParams.get('token');
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * First `name=value` pair of a Set-Cookie header value (the session cookie
// dsh mints); other attributes are irrelevant for re-sending.
 *
 * @param {string} setCookie - Raw Set-Cookie header value.
 * @returns {string|null} Cookie request-header value.
 */
function cookiePairFromSetCookie(setCookie) {
  if (typeof setCookie !== 'string') return null;
  const pair = setCookie.split(';', 1)[0].trim();
  if (pair.length === 0 || !pair.includes('=')) return null;
  return pair;
}

/**
 * Origin of a fetch input (string, URL, or Request-like object).
 *
 * @param {*} input - fetch() first argument.
 * @returns {string|null}
 */
function originOfInput(input) {
  try {
    const url = typeof input === 'string' || input instanceof URL
      ? new URL(input)
      : new URL(input && typeof input.url === 'string' ? input.url : String(input));
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Exchange a launch token for dsh's browser-session cookie.
 *
 * dsh 0.1.2+ answers `GET /?token=<valid>` with 303 + `set-cookie`; the first
 * `name=value` pair is the Cookie request header every later request needs.
 * Extracted from `createAuthedFetch` so non-fetch consumers (the embedded-UI
 * proxy) mint the exact same credential.
 *
 * @param {object} options
 * @param {string} options.origin - Loopback origin (`http://127.0.0.1:<port>`).
 * @param {string} options.token - Launch token from the ready line.
 * @param {Function} [options.fetchImpl=globalThis.fetch] - Fetch implementation.
 * @param {AbortSignal} [options.signal] - Optional caller abort signal.
 * @param {number} [options.timeoutMs] - Bound for the exchange; a stalled
 *   exchange resolves to null instead of blocking the caller forever.
 * @returns {Promise<string|null>} Cookie request-header value, or null when the
 *   exchange failed, timed out, or the runtime has no auth fence.
 */
async function mintCookiePair({
  origin,
  token,
  fetchImpl = globalThis.fetch,
  signal = undefined,
  timeoutMs = TOKEN_MINT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  if (typeof origin !== 'string' || origin.length === 0) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  const deadline = createRequestDeadline(signal, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TOKEN_MINT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${origin}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: deadline.signal,
    });
    // Consume the body so the socket is released before any retry.
    try { await response.arrayBuffer(); } catch { /* already consumed or empty */ }
    if (!response || response.status !== 303) return null;
    const setCookie = typeof response.headers.get === 'function'
      ? response.headers.get('set-cookie')
      : null;
    return cookiePairFromSetCookie(setCookie);
  } catch {
    return null;
  } finally {
    deadline.cleanup();
  }
}

/**
 * Wrap a fetch implementation with dsh web authentication.
 *
 * The returned function forwards to `fetchImpl`, attaching the Cookie header
 * for the current token's session whenever one has been minted. A 401
 * response triggers exactly one forced re-exchange and retry, so a cookie
 * that expired server-side heals on the next request instead of failing the
 * sidebar until restart.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl=globalThis.fetch] - Fetch-compatible
 *   function to wrap (injected in tests).
 * @param {Function} [options.tokenProvider] - Synchronous () => string|null
 *   returning the CURRENT launch token (e.g. reads the running server
 *   handle); null/absent on old runtimes disables auth transparently.
 * @param {Function} [options.now=Date.now] - Clock seam for tests.
 * @param {number} [options.timeoutMs=15000] - Per-attempt deadline. Unary DSH
 *   API calls must never pend forever (a disconnected/stalled server would
 *   otherwise block the lifecycle queue and every Retry behind it). Pass 0 to
 *   disable (only for consumers that manage their own deadlines).
 * @returns {Function} Auth-aware fetch-compatible function.
 */
function createAuthedFetch({
  fetchImpl = globalThis.fetch,
  tokenProvider = null,
  now = Date.now,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createAuthedFetch requires a fetchImpl');
  if (tokenProvider !== null && typeof tokenProvider !== 'function') {
    throw new TypeError('tokenProvider must be a function when provided');
  }
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  const mintTimeout = requestTimeout > 0
    ? Math.min(requestTimeout, TOKEN_MINT_TIMEOUT_MS)
    : TOKEN_MINT_TIMEOUT_MS;
  let cache = null; // { token, origin, cookie, at, ok }

  const cookieFor = async (token, origin, force = false, signal = undefined) => {
    if (token === null || origin === null) return null;
    if (!force && cache && cache.token === token && cache.origin === origin) {
      const ttl = cache.ok ? COOKIE_TTL_MS : FAILURE_TTL_MS;
      if (now() - cache.at < ttl) return cache.ok ? cache.cookie : null;
    }
    const cookie = await mintCookiePair({
      origin,
      token,
      fetchImpl,
      signal,
      timeoutMs: mintTimeout,
    });
    cache = { token, origin, cookie, at: now(), ok: cookie !== null };
    return cookie;
  };

  const request = (input, init) => fetchWithDeadline(fetchImpl, input, init, requestTimeout);
  const callerSignal = (init) => init && init.signal ? init.signal : undefined;

  return async (input, init) => {
    const token = typeof tokenProvider === 'function' ? tokenProvider() : null;
    if (token === null || token === undefined || token === '') {
      return request(input, init); // old runtime: no auth layer to satisfy
    }
    const origin = originOfInput(input);
    const cookie = await cookieFor(token, origin, false, callerSignal(init));
    const withCookie = (base, value) => ({
      ...(base || {}),
      headers: { ...(base && base.headers ? base.headers : {}), cookie: value },
    });
    const response = cookie
      ? await request(input, withCookie(init, cookie))
      : await request(input, init);
    if (response && typeof response.status === 'number' && response.status === 401 && cookie) {
      // Only re-mint when a minted cookie was actually rejected (server-side
      // expiry); with no cookie at all the exchange already failed and its
      // failure is cached, so surface the 401 instead of amplifying traffic.
      const reminted = await cookieFor(token, origin, true, callerSignal(init));
      if (reminted && reminted !== cookie) {
        return request(input, withCookie(init, reminted));
      }
    }
    return response;
  };
}

module.exports = {
  COOKIE_TTL_MS,
  FAILURE_TTL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TOKEN_MINT_TIMEOUT_MS,
  DshApiTimeoutError,
  cookiePairFromSetCookie,
  createAuthedFetch,
  mintCookiePair,
  originOfInput,
  tokenFromUrl,
};
