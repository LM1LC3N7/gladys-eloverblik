// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Eloverblik API (a fake
// fetch) and a virtual clock: nothing fires by itself, `wait(ms)` moves the
// clock and runs every timer due on the way, letting the promises they start
// settle. The monotonic clock moves by 1 µs at each read.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EloverblikApp } from '../../src/app.js';
import { createMemoryStore } from '../../src/store.js';
import * as E from '../fixtures/eloverblik.js';

export const SELECTOR = 'eloverblik';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const CONFIG = { refresh_token: E.TOKEN, id_key: E.ID_KEY };

/** A path of the API -> { op, from, to }. */
export function routeOf(path) {
  if (path === '/customerapi/api/token') return { op: 'token' };
  if (path === '/customerapi/api/meteringpoints/meteringpoints') return { op: 'list' };
  const m =
    /^\/customerapi\/api\/meterdata\/gettimeseries\/([\d-]+)\/([\d-]+)\/(Hour|Quarter)$/.exec(path);
  if (m) return { op: 'series', from: m[1], to: m[2], aggregation: m[3] };
  return { op: 'unknown' };
}

/** The default answers, by operation. */
export const defaults = {
  token: () => E.token(),
  list: () => E.meteringPoints(),
  series: ({ ids, from, to }) => E.timeSeries({ ids, from, to }),
};

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The API: `answers[op](call, now)` -> a body object | a Response | 'timeout'
 * | 'network' | a promise of one of them. `calls` records every request
 * ({ op, from, to, ids, auth, at }).
 */
export function createApi(answers = {}) {
  const api = { answers: { ...defaults, ...answers }, calls: [], clock: { now: E.NOW } };
  api.count = (op) => api.calls.filter((c) => c.op === op).length;
  api.ops = () => api.calls.map((c) => c.op);
  api.fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = {
      ...routeOf(u.pathname),
      url,
      method: init.method,
      ids: body?.meteringPoints?.meteringPoint,
      auth: init.headers.Authorization,
      headers: init.headers,
      signal: init.signal,
      at: api.clock.now,
    };
    api.calls.push(call);
    // Like fetch: an aborted request rejects at once.
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal?.aborted) fail();
      init.signal?.addEventListener('abort', fail, { once: true });
    });
    const answer = await Promise.race([api.answers[call.op]?.(call, api.clock.now), aborted]);
    if (answer === 'timeout') {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer instanceof Response) return answer;
    if (answer === undefined) return json({ title: 'Not Found', status: 404 }, 404);
    return json(answer);
  };
  return api;
}

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
  };
  async function advance(ms) {
    const target = clock.now + ms;
    await settle();
    for (let i = 0; i < 100_000; i += 1) {
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
      }
      if (!next) break;
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      next.timer.fn();
      await settle();
    }
    clock.now = Math.max(clock.now, target);
    await settle();
  }
  return { clock, timers, pending, advance, settle };
}

export async function setup({
  devices: known = [],
  store = createMemoryStore(),
  now = E.NOW,
  api = createApi(),
  config = CONFIG,
  wall = { offset: 0 },
  random,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  await gladys.connect();
  const { clock, timers, pending, advance, settle } = createFakeClock(now);
  api.clock = clock;
  // The fake Gladys checks that an interval is elapsed against Date.now: the
  // virtual clock of this test (each test file runs in its own process).
  Date.now = () => clock.now + wall.offset;
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new EloverblikApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now + wall.offset,
    // A real monotonic clock moves between two reads of it: 1 µs per call.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    fetchImpl: api.fetch,
    requestGap: 0,
    ...(random ? { random } : {}),
  });
  const wait = (ms) => advance(ms);
  const start = async (cfg = config) => {
    gladys.fake.config = cfg;
    const done = app.connected();
    await settle();
    await done;
    await advance(0);
  };
  return { app, gladys, fake: gladys.fake, clock, store, api, start, wait, settle, lines, pending };
}

/** Everything the integration ever wrote out: logs, statuses, /data, Discovery, states. */
export function written(env) {
  return JSON.stringify([
    env.lines,
    env.fake.connectionStatuses,
    env.store.data,
    env.fake.discoveredDevices,
    env.fake.states,
    env.fake.energyConsumption,
  ]);
}
