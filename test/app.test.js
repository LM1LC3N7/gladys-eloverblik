// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Eloverblik API and a
// virtual clock: pace, tokens, refusal, pauses, /data, Discovery, the
// consumption published after the fact, the test button, secrets.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHandlers } from '../src/handlers.js';
import { HALF_HOUR, MAX_REQUESTS_PER_DAY, TOKEN_GAP } from '../src/constants.js';
import { keyOf } from '../src/eloverblik/model.js';
import { tagOf } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { localDate, parseLocalDate, slotsOfDay } from '../src/time.js';
import { DAY, HOUR, MINUTE, createApi, defaults, json, setup, written } from './helpers/app.js';
import * as E from './fixtures/eloverblik.js';

const statusText = (env) => env.fake.connectionStatus?.message?.en ?? '';
const KEY = keyOf(E.ID_KEY, 'mp', E.MP);
const KEY2 = keyOf(E.ID_KEY, 'mp', E.MP2);
const F = (key = KEY) => `ext:eloverblik:mp:${key}:consumption`;
const TODAY = localDate(E.NOW);

async function started(options = {}) {
  const env = await setup(options);
  registerHandlers(env.gladys, env.app, env.app.log);
  await env.start(options.config);
  return env;
}

/** The user creates every discovered device. */
async function createAll(env) {
  for (const d of structuredClone(env.fake.discoveredDevices)) await env.fake.deviceCreated(d);
}

/** Every 30-minute slot start published to a feature, in order of publication. */
const slotsOf = (env, feature = F()) =>
  env.fake.publishedEnergyConsumption
    .filter((b) => b.device_feature_external_id === feature)
    .flatMap((b) => b.intervals);

/** Started, the device created, its first read done. */
async function ready(options = {}) {
  const env = await started(options);
  await createAll(env);
  await env.wait(2 * MINUTE);
  return env;
}

test('start: a token, the list, Discovery of the consumption points; nothing secret written', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  // No device created yet: no time series asked.
  assert.deepEqual(env.api.ops(), ['token', 'list']);
  assert.equal(env.api.calls[0].auth, `Bearer ${E.TOKEN}`);
  assert.equal(env.api.calls[1].auth, `Bearer ${E.ACCESS}`);
  assert.equal(env.api.calls[0].headers['User-Agent'].startsWith('gladys-eloverblik/'), true);
  const devices = env.fake.discoveredDevices;
  // The production point (E18) is not offered.
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Eloverblik meter …1234');
  assert.equal(devices[0].external_id, `ext:eloverblik:mp:${KEY}`);
  assert.deepEqual(
    devices[0].features.map((f) => [f.external_id, f.category, f.type, f.unit, f.read_only]),
    [[F(), 'energy-sensor', 'thirty-minutes-consumption', 'kilowatt-hour', true]],
  );
  assert.match(statusText(env), /Create the metering points in Discovery/);
  assert.match(statusText(env), /valid until 30\/06\/2027/);
  const out = written(env);
  for (const secret of [E.TOKEN, E.ACCESS, E.MP, E.MP_PROD, 'SECRET', 'Testvej', '8000']) {
    assert.ok(!out.includes(secret), secret);
  }
});

test('a created device: 31 days published as half hours, each hour split in two', async (t) => {
  const env = await ready();
  t.after(() => env.app.stop());
  assert.deepEqual(env.api.ops(), ['token', 'list', 'list', 'series']);
  const series = env.api.calls.at(-1);
  assert.deepEqual(series.ids, [E.MP]);
  assert.equal(series.method, 'POST');
  assert.equal(series.from, '2026-10-11');
  assert.equal(series.to, TODAY);
  // The access token is reused (24 h valid): a single GetToken.
  assert.equal(env.api.count('token'), 1);
  const slots = slotsOf(env);
  const first = parseLocalDate('2026-10-11');
  const end = parseLocalDate(TODAY);
  // 31 days, the autumn change (25 October: 25 hours) included.
  assert.equal(slots.length, (end - first) / HALF_HOUR);
  assert.equal(slots.length, 31 * 48 + 2);
  assert.equal(slots[0].starts_at, new Date(first).toISOString());
  const hour = Date.parse(slots[0].starts_at);
  assert.equal(slots[0].kwh, E.hourly(hour) / 2);
  assert.equal(slots[1].kwh, E.hourly(hour) / 2);
  assert.equal(env.store.data.published[KEY], '2026-11-10');
  assert.match(statusText(env), /Meter …1234: complete up to 10\/11\/2026/);
  assert.equal(env.fake.connectionStatus.connected, true);
  assert.ok(!written(env).includes(E.MP));
});

test('an A02 hour stays unknown (never 0), the day is asked again; given up after 10 days', async (t) => {
  // 10 November 05:00 local is missing (A02), every other hour is there.
  const hole = parseLocalDate('2026-11-10') + 5 * HOUR;
  const api = createApi({
    series: ({ ids, from, to }) =>
      E.timeSeries({ ids, from, to, value: (at) => (at === hole ? null : E.hourly(at)) }),
  });
  const env = await ready({ api });
  t.after(() => env.app.stop());
  const slots = slotsOf(env);
  assert.ok(!slots.some((s) => Date.parse(s.starts_at) === hole));
  assert.ok(!slots.some((s) => Date.parse(s.starts_at) === hole + HALF_HOUR));
  assert.ok(slots.every((s) => s.kwh > 0));
  assert.equal(env.store.data.published[KEY], '2026-11-09');
  // Asked again 4 hours later (yesterday incomplete), from 3 days before the mark.
  await env.wait(4 * HOUR);
  const again = env.api.calls.filter((c) => c.op === 'series');
  assert.equal(again.length, 2);
  assert.equal(again[1].from, '2026-11-07');
});

test('pace: at most 4 reads a day while yesterday is missing, then the next morning', async (t) => {
  const api = createApi({
    series: ({ ids, from, to }) =>
      E.timeSeries({ ids, from, to: to > '2026-11-10' ? '2026-11-10' : to }),
  });
  const env = await ready({ api });
  t.after(() => env.app.stop());
  assert.equal(env.store.data.published[KEY], '2026-11-09');
  const at = () => env.api.calls.filter((c) => c.op === 'series').map((c) => c.at);
  await env.wait(9 * HOUR);
  const today = at().filter((ms) => localDate(ms) === TODAY);
  assert.ok(today.length <= 4, `${today.length} reads today`);
  for (let i = 1; i < today.length; i += 1) assert.ok(today[i] - today[i - 1] >= 4 * HOUR - 1);
  await env.wait(DAY);
  const tomorrow = at().filter((ms) => localDate(ms) === '2026-11-12');
  assert.ok(tomorrow.length >= 1);
  const [first] = tomorrow;
  const local = new Date(first).toLocaleString('en-GB', { timeZone: 'Europe/Copenhagen' });
  assert.match(local, /, (09|10|11):\d\d:/);
  assert.ok(env.api.calls.length <= MAX_REQUESTS_PER_DAY * 2);
});

test('nothing more once yesterday is complete: the next read is tomorrow morning', async (t) => {
  const env = await ready();
  t.after(() => env.app.stop());
  const n = env.api.calls.length;
  await env.wait(12 * HOUR);
  assert.equal(env.api.calls.length, n);
  await env.wait(DAY);
  assert.ok(env.api.calls.length > n);
  // A new access token after 20 hours.
  assert.equal(env.api.count('token'), 2);
});

test('refusal: a 401 of GetToken stops everything, kept across a restart; a new token is tried', async (t) => {
  const api = createApi({ token: () => json({ title: 'Unauthorized', status: 401 }, 401) });
  const store = createMemoryStore();
  const env = await started({ api, store });
  t.after(() => env.app.stop());
  assert.deepEqual(env.api.ops(), ['token']);
  assert.match(statusText(env), /refused the token/);
  assert.equal(env.fake.connectionStatus.connected, false);
  await env.wait(3 * DAY);
  assert.deepEqual(env.api.ops(), ['token']);
  await env.app.stop();
  assert.ok(!JSON.stringify(store.data).includes(E.TOKEN));
  // A restart with the same token: still refused, nothing sent.
  const again = await started({ api, store, now: env.clock.now });
  t.after(() => again.app.stop());
  await again.wait(DAY);
  assert.equal(again.api.count('token'), 1);
  // A new token: tried soon.
  api.answers.token = defaults.token;
  await again.gladys.fake.configUpdated({ refresh_token: E.TOKEN2, id_key: E.ID_KEY });
  await again.wait(10 * MINUTE);
  assert.equal(again.api.count('token'), 2);
  assert.equal(again.api.calls.at(-2).auth, `Bearer ${E.TOKEN2}`);
  assert.doesNotMatch(statusText(again), /refused/);
});

test('a 403 page of a proxy on GetToken is not a refusal; a 403 of the API is one', async (t) => {
  const page = () =>
    new Response('<html>Forbidden</html>', {
      status: 403,
      headers: { 'content-type': 'text/html' },
    });
  const api = createApi({ token: page });
  const env = await started({ api });
  t.after(() => env.app.stop());
  assert.doesNotMatch(statusText(env), /refused/);
  assert.match(statusText(env), /did not succeed/);
  assert.match(statusText(env), /token_forbidden/);
  api.answers.token = () => json({ title: 'Forbidden', status: 403 }, 403);
  await env.wait(4 * HOUR + TOKEN_GAP);
  assert.match(statusText(env), /refused the token/);
});

test('the API error codes of a non-valid token are a refusal', async (t) => {
  const api = createApi({ token: () => ({ result: null, errorCode: 50001 }) });
  const env = await started({ api });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /refused the token/);
});

test('a 401 of a data route is never a refusal: a new access token at the next read', async (t) => {
  let deny = true;
  const api = createApi({
    list: (call) =>
      deny ? json({ title: 'Unauthorized', status: 401 }, 401) : defaults.list(call),
  });
  const env = await started({ api });
  t.after(() => env.app.stop());
  assert.deepEqual(env.api.ops(), ['token', 'list']);
  assert.doesNotMatch(statusText(env), /refused/);
  assert.match(statusText(env), /data_unauthorized/);
  deny = false;
  await env.wait(4 * HOUR + MINUTE);
  assert.deepEqual(env.api.ops(), ['token', 'list', 'token', 'list']);
  assert.equal(env.fake.discoveredDevices.length, 1);
});

test('GetToken: never two within 5 minutes, a restart included', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.app.stop();
  assert.equal(env.api.count('token'), 1);
  // A restart a minute later: the token is in memory only, a new one is needed.
  const again = await started({ store, now: env.clock.now + MINUTE, api: env.api });
  t.after(() => again.app.stop());
  assert.equal(env.api.count('token'), 1);
  const out = await again.app.testConnection();
  assert.match(out.en, /try again after/);
  assert.equal(env.api.count('token'), 1);
  await again.wait(4 * HOUR + 5 * MINUTE);
  assert.equal(env.api.count('token'), 2);
  const [a, b] = env.api.calls.filter((c) => c.op === 'token');
  assert.ok(b.at - a.at >= TOKEN_GAP);
});

test('a 429 pauses every request (Retry-After), kept across a restart', async (t) => {
  const store = createMemoryStore();
  const api = createApi({
    series: () => json({ title: 'Too many' }, 429, { 'retry-after': '7200' }),
  });
  const env = await ready({ api, store });
  assert.match(statusText(env), /asked to slow down/);
  const n = env.api.calls.length;
  await env.wait(HOUR);
  assert.equal(env.api.calls.length, n);
  await env.app.stop();
  assert.equal(store.data.pause.code, 'rate_limited');
  const again = await started({
    store,
    api,
    now: env.clock.now,
    devices: structuredClone(env.fake.devices),
  });
  t.after(() => again.app.stop());
  await again.wait(50 * MINUTE);
  assert.equal(env.api.calls.length, n);
  api.answers.series = defaults.series;
  await again.wait(20 * MINUTE);
  assert.ok(env.api.calls.length > n);
});

test('a 503 (DataHub unavailable): 15 minutes, then doubled', async (t) => {
  const api = createApi({ series: () => json({ title: 'DataHub unavailable' }, 503) });
  const env = await ready({ api });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /unavailable \(HTTP 503\)/);
  const series = () => env.api.calls.filter((c) => c.op === 'series').map((c) => c.at);
  await env.wait(15 * MINUTE + MINUTE);
  await env.wait(30 * MINUTE + MINUTE);
  const at = series();
  assert.equal(at.length, 3);
  assert.ok(at[1] - at[0] >= 15 * MINUTE - 1);
  assert.ok(at[2] - at[1] >= 30 * MINUTE - 1);
});

test('a metering point answered with an error: its days stay asked, the other one is published', async (t) => {
  const api = createApi({
    list: () => E.meteringPoints([E.MP, E.MP2]),
    series: ({ ids, from, to }) => {
      const body = E.timeSeries({ ids, from, to });
      body.result = body.result.map((r) => (r.id === E.MP2 ? E.failed(E.MP2, 20010) : r));
      return body;
    },
  });
  const env = await ready({ api });
  t.after(() => env.app.stop());
  assert.deepEqual(env.api.calls.at(-1).ids, [E.MP, E.MP2]);
  assert.equal(env.store.data.published[KEY], '2026-11-10');
  assert.equal(env.store.data.published[KEY2], undefined);
  assert.equal(slotsOf(env, F(KEY2)).length, 0);
  assert.match(statusText(env), /Meter …5678: E20010/);
});

test('the daily ceiling of requests is never passed', async (t) => {
  const api = createApi({ series: () => 'network' });
  const env = await ready({ api });
  t.after(() => env.app.stop());
  // Saved configs and new devices make reads "soon".
  for (let i = 0; i < 40; i += 1) {
    env.app.soon = true;
    env.app.schedule(env.app.gen);
    await env.wait(MINUTE);
  }
  const today = env.api.calls.filter((c) => localDate(c.at) === TODAY);
  assert.ok(today.length <= MAX_REQUESTS_PER_DAY, `${today.length}`);
});

test('/data unreadable: never overwritten, reads wait an hour; read again later', async (t) => {
  const store = createMemoryStore({ published: { [KEY]: '2026-11-01' } });
  store.unreadable = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(env.api.calls.length, 0);
  assert.match(statusText(env), /\/data cannot be read/);
  assert.deepEqual(store.data, { published: { [KEY]: '2026-11-01' } });
  store.unreadable = false;
  await env.wait(15 * 1000);
  assert.equal(store.data.published[KEY], '2026-11-01');
});

test('getConfig failing in connected: retried with a status, then the integration starts', async (t) => {
  const env = await setup();
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  const real = env.gladys.getConfig.bind(env.gladys);
  let fail = 1;
  env.gladys.getConfig = async () => {
    if (fail-- > 0) throw new Error('down');
    return real();
  };
  await env.start();
  assert.match(statusText(env), /configuration could not be read/);
  assert.equal(env.api.calls.length, 0);
  await env.wait(10 * 1000);
  assert.deepEqual(env.api.ops(), ['token', 'list']);
});

test('test button: lists the points, at most once a minute, lifts a refusal', async (t) => {
  const api = createApi({ token: () => json({ status: 401 }, 401) });
  const env = await started({ api });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /refused/);
  api.answers.token = defaults.token;
  await env.wait(TOKEN_GAP);
  const out = await env.app.testConnection();
  assert.equal(out.en, 'Token accepted. 1 consumption metering point(s): …1234 (Test Energi A/S).');
  assert.doesNotMatch(statusText(env), /refused/);
  const again = await env.app.testConnection();
  assert.match(again.en, /less than a minute/);
  assert.ok(!JSON.stringify(out).includes(E.MP));
});

test('a reconnection keeps the access token, the pause and the list; no read sooner', async (t) => {
  const env = await ready();
  t.after(() => env.app.stop());
  const n = env.api.calls.length;
  await env.app.connected();
  await env.wait(MINUTE);
  assert.equal(env.api.calls.length, n);
  assert.equal(env.fake.discoveredDevices.length, 1);
});

test('the 30-minute slots of a local day: 46, 48 or 50', () => {
  assert.equal(slotsOfDay('2026-03-29').length, 46);
  assert.equal(slotsOfDay('2026-10-25').length, 50);
  assert.equal(slotsOfDay('2026-11-10').length, 48);
});

test('a wall clock set back never reads sooner nor counts a new day', async (t) => {
  const wall = { offset: 0 };
  const env = await ready({ wall });
  t.after(() => env.app.stop());
  const n = env.api.calls.length;
  wall.offset = -2 * DAY;
  await env.wait(2 * HOUR);
  assert.equal(env.api.calls.length, n);
});

test('the daily ceiling holds within a read: the 31st request is never sent', async (t) => {
  const store = createMemoryStore({ requests: { date: TODAY, count: MAX_REQUESTS_PER_DAY - 1 } });
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.deepEqual(env.api.ops(), ['token']);
  assert.equal(store.data.requests.count, MAX_REQUESTS_PER_DAY);
  assert.match(statusText(env), /daily_ceiling/);
  await env.wait(6 * HOUR);
  assert.deepEqual(env.api.ops(), ['token']);
});

test('countRequest: two GetToken never within 5 minutes; a wall clock set back keeps the count', async (t) => {
  const wall = { offset: 0 };
  const store = createMemoryStore();
  const env = await started({ store, wall });
  t.after(() => env.app.stop());
  await assert.rejects(env.app.countRequest({ token: true }), (e) => e.code === 'token_wait');
  await env.wait(TOKEN_GAP);
  await env.app.countRequest({ token: true });
  store.data.requests.count = MAX_REQUESTS_PER_DAY;
  env.app.data.requests.count = MAX_REQUESTS_PER_DAY;
  wall.offset = -DAY;
  await assert.rejects(env.app.countRequest(), (e) => e.code === 'daily_ceiling');
});

test('refused: no read is even scheduled', async (t) => {
  const api = createApi({ token: () => json({ status: 401 }, 401) });
  const env = await started({ api });
  t.after(() => env.app.stop());
  assert.equal(env.app.dueMono, undefined);
  assert.equal(env.app.roundTimer, null);
});

test('a new token is tried even when its 8-bit tag matches the refused one', async (t) => {
  // A salt that gives both tokens the same tag.
  let salt;
  for (let i = 0; ; i += 1) {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(i);
    if (tagOf(buf.toString('hex'), E.TOKEN) === tagOf(buf.toString('hex'), E.TOKEN2)) {
      salt = buf;
      break;
    }
  }
  const api = createApi({ token: () => json({ status: 401 }, 401) });
  const env = await started({ api, random: () => Buffer.from(salt) });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /refused/);
  api.answers.token = defaults.token;
  await env.gladys.fake.configUpdated({ refresh_token: E.TOKEN2, id_key: E.ID_KEY });
  await env.wait(10 * MINUTE);
  assert.equal(env.api.count('token'), 2);
  assert.doesNotMatch(statusText(env), /refused/);
});

test('only the window asked is published, even when the answer holds more', async (t) => {
  const api = createApi({
    series: ({ ids, to }) => E.timeSeries({ ids, from: '2026-09-01', to }),
  });
  const env = await ready({ api });
  t.after(() => env.app.stop());
  const first = Math.min(...slotsOf(env).map((s) => Date.parse(s.starts_at)));
  assert.equal(first, parseLocalDate('2026-10-11'));
});

test('/data unreadable all along: never written, even by the reads and the stop', async (t) => {
  const store = createMemoryStore({ published: { [KEY]: '2026-11-01' } });
  store.unreadable = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(3 * HOUR);
  assert.ok(env.api.calls.length > 0, 'reads after the blind wait');
  await env.app.stop();
  assert.equal(store.saves, 0);
  assert.deepEqual(store.data, { published: { [KEY]: '2026-11-01' } });
});

test('times of /data in the future are ignored: the reads are not held', async (t) => {
  const store = createMemoryStore({ lastRound: E.NOW + DAY, lastToken: E.NOW + DAY });
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.deepEqual(env.api.ops(), ['token', 'list']);
});

test('at most 4 reads a day while yesterday never comes', async (t) => {
  const api = createApi({
    series: ({ ids, from }) => E.timeSeries({ ids, from, to: '2026-11-10' }),
  });
  // 01:30 in Copenhagen: the whole day ahead.
  const env = await ready({ api, now: Date.UTC(2026, 10, 11, 0, 30) });
  t.after(() => env.app.stop());
  await env.wait(22 * HOUR);
  // Each read lists the points first; the first one (no device yet) only lists them.
  const reads = env.api.calls.filter((c) => c.op === 'list' && localDate(c.at) === TODAY);
  assert.equal(reads.length, 4);
  assert.equal(env.api.calls.filter((c) => c.op === 'series').length, 3);
});

test('merge: a time of /data in the future is dropped, a past one kept', async (t) => {
  const env = await setup();
  t.after(() => env.app.stop());
  env.app.merge({ lastRound: E.NOW + HOUR, lastToken: E.NOW + MINUTE });
  assert.equal(env.app.data.lastRound, null);
  assert.equal(env.app.data.lastToken, null);
  env.app.merge({ lastRound: E.NOW - HOUR, lastToken: E.NOW - MINUTE });
  assert.equal(env.app.data.lastRound, E.NOW - HOUR);
  assert.equal(env.app.data.lastToken, E.NOW - MINUTE);
});

test('a 429 holds the requests already queued behind it: none is sent', async (t) => {
  let release;
  const api = createApi({
    series: () =>
      new Promise((resolve) => {
        release = () => resolve(json({ title: 'Too many' }, 429, { 'retry-after': '600' }));
      }),
  });
  const env = await started({ api });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(env.api.ops().at(-1), 'series');
  // The test button queues a request behind the series in flight.
  const pressed = env.app.testConnection();
  await env.settle();
  release();
  const out = await pressed;
  await env.wait(0);
  assert.equal(env.api.ops().at(-1), 'series', env.api.ops().join());
  assert.match(out.en, /asked to wait/);
});
