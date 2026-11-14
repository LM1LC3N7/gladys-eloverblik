// -----------------------------------------------------------------------------
// The HTTP client on a real local server: bounded bodies, timeouts, no
// redirect, errors without secrets, one request at a time, the 429 / 5xx /
// 401 / 403 answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  EloverblikError,
  EloverblikSession,
  retryAfterMs,
  routes,
  send,
} from '../src/eloverblik/client.js';
import * as E from './fixtures/eloverblik.js';

async function server(t, handler) {
  const requests = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    srv.closeAllConnections?.();
    return new Promise((resolve) => srv.close(resolve));
  });
  return { url: `http://127.0.0.1:${srv.address().port}/customerapi`, requests };
}

const call = (url, extra = {}) =>
  send({
    fetchImpl: fetch,
    url,
    ...routes.timeSeries([E.MP], '2026-11-01', '2026-11-02'),
    bearer: E.ACCESS,
    ...extra,
  });

test('a POST with the bearer, the ids in the body only, the API version and a User-Agent', async (t) => {
  const srv = await server(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: [] }));
  });
  assert.deepEqual(await call(srv.url), { result: [] });
  const [r] = srv.requests;
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/customerapi/api/meterdata/gettimeseries/2026-11-01/2026-11-02/Hour');
  assert.ok(!r.url.includes(E.MP));
  assert.deepEqual(JSON.parse(r.body), { meteringPoints: { meteringPoint: [E.MP] } });
  assert.equal(r.headers.authorization, `Bearer ${E.ACCESS}`);
  assert.equal(r.headers['api-version'], '1.0');
  assert.equal(r.headers.accept, 'application/json');
  assert.match(
    r.headers['user-agent'],
    /^gladys-eloverblik\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-eloverblik\)$/,
  );
});

test('an oversized answer is cut before it is read whole (declared or streamed)', async (t) => {
  const big = await server(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Streamed without a length: 64 KiB chunks, far beyond the bound.
    const chunk = 'x'.repeat(64 * 1024);
    let sent = 0;
    const write = () => {
      while (sent < 400 && res.write(chunk)) sent += 1;
      if (sent < 400) res.once('drain', write);
      else res.end();
    };
    write();
  });
  await assert.rejects(call(big.url, { maxBytes: 1024 * 1024 }), (err) => err.code === 'too_large');
  const declared = await server(t, (req, res) => {
    res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) });
    res.write('{');
  });
  await assert.rejects(call(declared.url), (err) => err.code === 'too_large');
});

test('a silent server times out; a redirect is never followed', async (t) => {
  const silent = await server(t, () => {});
  await assert.rejects(call(silent.url, { timeout: 200 }), (err) => err.code === 'timeout');
  const redirect = await server(t, (req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
    res.end();
  });
  await assert.rejects(call(redirect.url), (err) => err.code === 'network');
});

test('statuses: 429 with Retry-After, 503, 401, 403 of the API or of a proxy, 400 with its code', async (t) => {
  const answers = [
    [429, { 'retry-after': '120' }, '{}'],
    [503, {}, '{"title":"DataHub unavailable"}'],
    [401, {}, '{"title":"Unauthorized","status":401}'],
    [403, { 'content-type': 'text/html' }, '<html>Forbidden</html>'],
    [400, {}, '{"errorCode":30003,"errorText":"ToDateIsGreaterThanToday"}'],
    [200, {}, 'not json'],
    [200, {}, '[1,2]'],
  ];
  let i = 0;
  const srv = await server(t, (req, res) => {
    const [status, headers, body] = answers[i++];
    res.writeHead(status, headers);
    res.end(body);
  });
  const errors = [];
  for (let n = 0; n < answers.length; n += 1) errors.push(await call(srv.url).catch((e) => e));
  assert.deepEqual(
    errors.map((e) => [e.code, e.status, e.retryAfter, e.fromApi, e.apiCode]),
    [
      ['rate_limited', 429, 120_000, undefined, undefined],
      ['server', 503, undefined, undefined, undefined],
      ['unauthorized', 401, undefined, true, undefined],
      ['unauthorized', 403, undefined, false, undefined],
      ['invalid', 400, undefined, undefined, 30003],
      ['bad_response', 200, undefined, undefined, undefined],
      ['bad_response', 200, undefined, undefined, undefined],
    ],
  );
  for (const e of errors) {
    assert.ok(e instanceof EloverblikError);
    assert.ok(!e.message.includes(E.ACCESS) && !e.message.includes(E.MP));
    assert.ok(!e.message.includes('127.0.0.1'));
  }
});

test('Retry-After: seconds, or a date against the Date header only', () => {
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(
    retryAfterMs('Wed, 11 Nov 2026 12:10:00 GMT', 'Wed, 11 Nov 2026 12:00:00 GMT'),
    600_000,
  );
  assert.equal(retryAfterMs('Wed, 11 Nov 2026 12:10:00 GMT'), undefined);
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(undefined), undefined);
});

test('the session: one request at a time, the gap from the end of the previous one, closed = nothing sent', async (t) => {
  let open = 0;
  let peak = 0;
  const srv = await server(t, (req, res) => {
    open += 1;
    peak = Math.max(peak, open);
    setTimeout(() => {
      open -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"result":"x"}');
    }, 30);
  });
  const session = new EloverblikSession({
    fetchImpl: fetch,
    url: srv.url,
    gap: 50,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const started = performance.now();
  await Promise.all([1, 2, 3].map(() => session.request({ ...routes.token(), bearer: E.TOKEN })));
  assert.equal(peak, 1);
  assert.ok(performance.now() - started >= 3 * 30 + 2 * 50 - 5);
  session.close();
  await assert.rejects(
    session.request({ ...routes.token(), bearer: E.TOKEN }),
    (e) => e.code === 'stopped',
  );
  assert.equal(srv.requests.length, 3);
  // No bearer: nothing sent.
  const other = new EloverblikSession({ fetchImpl: fetch, url: srv.url, gap: 0 });
  await assert.rejects(
    other.request({ ...routes.token(), bearer: () => undefined }),
    (e) => e.code === 'no_token',
  );
  assert.equal(srv.requests.length, 3);
});
