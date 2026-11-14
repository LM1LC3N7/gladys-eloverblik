// -----------------------------------------------------------------------------
// The only place that talks to the network: the official customer API of
// Eloverblik (api.eloverblik.dk/customerapi, Swagger V1.0) with a bearer
// token, a timeout, a bounded body and an identifiable User-Agent.
//
// The session sends one request at a time, at least REQUEST_GAP apart, and
// never follows a redirect. No token, no metering point id is ever logged nor
// put in an error: an error carries a code and an HTTP status, never the URL,
// the body sent nor the text of the answer (it may echo the ids).
// -----------------------------------------------------------------------------

import { API_URL, MAX_BODY_BYTES, REQUEST_GAP, REQUEST_TIMEOUT, USER_AGENT } from '../constants.js';

export class EloverblikError extends Error {
  constructor(code, { status, retryAfter, apiCode } = {}) {
    super(`Eloverblik: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'EloverblikError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.apiCode = apiCode;
  }
}

/** Retry-After (seconds or an HTTP date, against the Date header) -> ms; undefined otherwise. */
export function retryAfterMs(value, dateHeader) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  const ref = Date.parse(dateHeader ?? '');
  // Without a readable Date of the server, a date cannot be measured.
  return Number.isFinite(at) && Number.isFinite(ref) ? Math.max(0, at - ref) : undefined;
}

/** The body as text, never more than `max` bytes (cut and refused beyond). */
async function boundedText(response, max) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel?.().catch(() => {});
    throw new EloverblikError('too_large');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > max) throw new EloverblikError('too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new EloverblikError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The `errorCode` of an API answer (an integer), when there is one. */
function apiCodeOf(text) {
  try {
    const body = JSON.parse(text);
    const code = body?.errorCode ?? body?.result?.[0]?.errorCode;
    return Number.isInteger(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a text is a JSON object (a ProblemDetails of the API). */
function isJson(text) {
  try {
    const body = JSON.parse(text);
    return Boolean(body) && typeof body === 'object' && !Array.isArray(body);
  } catch {
    return false;
  }
}

/** One request; resolves the parsed JSON object, throws an EloverblikError otherwise. */
export async function send({
  fetchImpl,
  url = API_URL,
  method = 'GET',
  path,
  bearer,
  body,
  signal,
  timeout = REQUEST_TIMEOUT,
  maxBytes = MAX_BODY_BYTES,
}) {
  const timer = AbortSignal.timeout(timeout);
  const both = signal ? AbortSignal.any([signal, timer]) : timer;
  let response;
  let text;
  try {
    response = await fetchImpl(`${url}${path}`, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'api-version': '1.0',
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: both,
      redirect: 'error',
    });
    text = await boundedText(response, maxBytes);
  } catch (err) {
    if (err instanceof EloverblikError) throw err;
    if (signal?.aborted) throw new EloverblikError('stopped');
    throw new EloverblikError(timer.aborted ? 'timeout' : 'network');
  }
  const status = response.status;
  if (status === 429) {
    throw new EloverblikError('rate_limited', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        response.headers?.get?.('date'),
      ),
    });
  }
  if (status >= 500) {
    throw new EloverblikError('server', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        response.headers?.get?.('date'),
      ),
    });
  }
  if (status === 401 || status === 403) {
    const err = new EloverblikError('unauthorized', { status, apiCode: apiCodeOf(text) });
    // An answer of the API itself: an empty body (a bearer middleware), a
    // JSON ProblemDetails, or a `WWW-Authenticate: Bearer` challenge. Only a
    // non-empty page that is not JSON (HTML of a proxy) is not one.
    const challenge = /^\s*Bearer\b/i.test(response.headers?.get?.('www-authenticate') ?? '');
    err.fromApi = challenge || text.trim() === '' || isJson(text);
    throw err;
  }
  if (status === 400) throw new EloverblikError('invalid', { status, apiCode: apiCodeOf(text) });
  if (status === 404) throw new EloverblikError('not_found', { status });
  if (status !== 200) throw new EloverblikError('http', { status });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EloverblikError('bad_response', { status });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EloverblikError('bad_response', { status });
  }
  return parsed;
}

/** One session of the API: one request at a time, REQUEST_GAP apart. */
export class EloverblikSession {
  constructor({
    fetchImpl = globalThis.fetch,
    url = API_URL,
    monotonic = () => performance.now(),
    sleep,
    timeout,
    gap = REQUEST_GAP,
    onError,
  }) {
    this.fetchImpl = fetchImpl;
    this.url = url;
    this.monotonic = monotonic;
    this.sleep = sleep;
    this.timeout = timeout;
    this.gap = gap;
    this.onError = onError;
    this.lane = Promise.resolve();
    this.lastSent = -Infinity;
    this.abort = new AbortController();
    this.closed = false;
    /** Requests sent (tests). */
    this.sent = 0;
  }

  /** Stops the session: the request in flight is aborted, nothing more is sent. */
  close() {
    this.closed = true;
    this.abort.abort();
  }

  /**
   * One request `{ method, path, body }` with the bearer `bearer()` gives
   * just before it leaves, after the previous one and REQUEST_GAP after its
   * end. `beforeSend()` runs just before too (the daily count); it may throw
   * to send nothing.
   */
  request({ method = 'GET', path, body, bearer }, beforeSend) {
    const run = async () => {
      if (this.closed) throw new EloverblikError('stopped');
      const wait = this.lastSent + this.gap - this.monotonic();
      if (wait > 0 && this.sleep) await this.sleep(wait);
      if (this.closed) throw new EloverblikError('stopped');
      if (beforeSend) await beforeSend();
      if (this.closed) throw new EloverblikError('stopped');
      const token = typeof bearer === 'function' ? bearer() : bearer;
      if (!token) throw new EloverblikError('no_token');
      this.lastSent = this.monotonic();
      this.sent += 1;
      try {
        return await send({
          fetchImpl: this.fetchImpl,
          url: this.url,
          method,
          path,
          body,
          bearer: token,
          signal: this.abort.signal,
          ...(this.timeout ? { timeout: this.timeout } : {}),
        });
      } catch (err) {
        // Told before the next request of the queue runs (a 429 holds them all).
        this.onError?.(err);
        throw err;
      } finally {
        // The gap counts from the end of a request: a slow answer never shortens it.
        this.lastSent = this.monotonic();
      }
    };
    const job = this.lane.then(run, run);
    this.lane = job.catch(() => {});
    return job;
  }
}

/** The routes used (read-only): the metering point ids go in the body, never the URL. */
export const routes = {
  token: () => ({ method: 'GET', path: '/api/token' }),
  meteringPoints: () => ({
    method: 'GET',
    path: '/api/meteringpoints/meteringpoints?includeAll=false',
  }),
  timeSeries: (ids, from, to, aggregation = 'Hour') => ({
    method: 'POST',
    path: `/api/meterdata/gettimeseries/${from}/${to}/${aggregation === 'Quarter' ? 'Quarter' : 'Hour'}`,
    body: { meteringPoints: { meteringPoint: ids } },
  }),
};
