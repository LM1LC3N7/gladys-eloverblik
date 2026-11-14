// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, setTimeout) and a real
// local HTTP server playing the Eloverblik API: the first read at once, the
// read of a new device a minute later, the retry while yesterday is missing
// really 4 hours later, a single GetToken, a bounded number of timers, and
// nothing sent after stop(). The time is sped up 20000 times (4 hours last
// 0.72 s) but it is the real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EloverblikApp } from '../src/app.js';
import { RETRY_GAP, SOON_GAP } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { registerHandlers } from '../src/handlers.js';
import { defaults, routeOf } from './helpers/app.js';
import * as E from './fixtures/eloverblik.js';

const SPEED = 20000;
const HOUR = 3_600_000;
// Wide margins: the suite runs in parallel on a loaded runner.

test('real clock: reads at once, a minute after a new device, 4 hours later; timers bounded', async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const call = routeOf(new URL(req.url, 'http://x').pathname);
      requests.push({ op: call.op, at: performance.now() * SPEED });
      const ids = body ? JSON.parse(body).meteringPoints.meteringPoint : undefined;
      // Yesterday never comes: the retry is due 4 hours later.
      const answer =
        call.op === 'series'
          ? E.timeSeries({ ids, from: call.from, to: '2026-11-10' })
          : defaults[call.op]({ ...call, ids });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({
    selector: 'eloverblik',
    config: { refresh_token: E.TOKEN, id_key: E.ID_KEY },
  });
  await gladys.connect();
  const quiet = () => {};
  const t0 = performance.now();
  // The fake Gladys checks the intervals are elapsed against Date.now.
  const realNow = Date.now;
  Date.now = () => E.NOW + (performance.now() - t0) * SPEED;
  t.after(() => {
    Date.now = realNow;
  });
  const app = new EloverblikApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => E.NOW + (performance.now() - t0) * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    apiUrl: `http://127.0.0.1:${server.address().port}/customerapi`,
  });
  registerHandlers(gladys, app, app.log);
  // Stopped even when an assertion fails: no timer left behind.
  t.after(() => app.stop());
  const started = performance.now() * SPEED;
  await app.connected();
  const listed = performance.now() + 20_000;
  while (!gladys.fake.discoveredDevices.length && performance.now() < listed) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await gladys.fake.deviceCreated(structuredClone(gladys.fake.discoveredDevices[0]));
  const deadline = performance.now() + 20_000;
  while (requests.filter((r) => r.op === 'series').length < 2 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.stop();
  const sent = requests.length;
  await new Promise((resolve) => setTimeout(resolve, RETRY_GAP / SPEED));
  assert.equal(requests.length, sent, 'nothing sent after stop()');
  const at = (r) => Math.round((r.at - started) / 60_000);
  assert.deepEqual(
    requests.map((r) => r.op),
    ['token', 'list', 'list', 'series', 'list', 'series'],
    `${requests.map((r) => `${r.op}@${at(r)}min`)}`,
  );
  const [token, list, , first, , retry] = requests;
  assert.ok(token.at - started < HOUR, 'the first read at once');
  assert.ok(list.at >= token.at);
  const soon = first.at - list.at;
  assert.ok(soon >= 0.9 * SOON_GAP, `a minute later: ${soon / 1000} s`);
  assert.ok(soon < 2 * HOUR, `soon: ${soon / 60_000} min`);
  const gap = retry.at - first.at;
  assert.ok(gap >= 0.9 * RETRY_GAP, `never sooner than 4 hours: ${gap / 60_000} min`);
  assert.ok(gap < 2 * RETRY_GAP, `on time: ${gap / 60_000} min`);
  assert.ok(timersSet <= 80, `${timersSet} timers`);
  assert.ok(gladys.fake.publishedEnergyConsumption.length >= 1);
});
