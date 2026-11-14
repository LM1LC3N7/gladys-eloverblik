// -----------------------------------------------------------------------------
// The answers turned into slots (pure): the hours in two halves, quarter
// hours added two by two, the unknown left unknown, hostile answers bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, tokenExpiry } from '../src/config.js';
import { HALF_HOUR, MINUTE } from '../src/constants.js';
import {
  keyOf,
  parseMeteringPoints,
  parseTimeSeries,
  parseToken,
} from '../src/eloverblik/model.js';
import { parseLocalDate } from '../src/time.js';
import * as E from './fixtures/eloverblik.js';

const at = (iso) => Date.parse(iso);

test('the token answer: the access token, a refusal by error code, unreadable otherwise', () => {
  assert.deepEqual(parseToken({ result: E.ACCESS }), { token: E.ACCESS });
  assert.deepEqual(parseToken({ errorCode: 50001, result: null }), { refused: true });
  assert.deepEqual(parseToken({ errorCode: 50000 }), { refused: true });
  assert.equal(parseToken({ errorCode: 50002 }), undefined);
  assert.equal(parseToken({ result: 'short' }), undefined);
  assert.equal(parseToken({ result: 'has a space in it' }), undefined);
  assert.equal(parseToken({ result: `abc\r\nX-Injected: 1abcdef` }), undefined);
  assert.equal(parseToken([]), undefined);
});

test('the metering points: consumption ones only, 18 digits, 10 at most, sorted', () => {
  const list = parseMeteringPoints(E.meteringPoints([E.MP2, E.MP, E.MP]));
  assert.deepEqual(list.points, [
    { id: E.MP, supplier: 'Test Energi A/S' },
    { id: E.MP2, supplier: 'Test Energi A/S' },
  ]);
  assert.equal(list.others, 1);
  const many = Array.from({ length: 12 }, (_, i) => `5713131000000${String(i).padStart(5, '0')}`);
  const bounded = parseMeteringPoints(E.meteringPoints(many, { production: [] }));
  assert.equal(bounded.points.length, 10);
  assert.equal(bounded.dropped, 2);
  const bad = parseMeteringPoints({
    result: [
      { meteringPointId: '123', typeOfMP: 'E17' },
      { meteringPointId: E.MP, typeOfMP: 'E17', hasRelation: false },
      { meteringPointId: E.MP2, typeOfMP: 'E17', balanceSupplierName: 'A\r\nB' },
      null,
    ],
  });
  assert.deepEqual(bad.points, [{ id: E.MP2, supplier: 'A  B' }]);
  assert.equal(parseMeteringPoints({ result: 'x' }), undefined);
});

test('hours in two equal halves; the spring change day has 46 slots', () => {
  const body = E.timeSeries({ from: '2026-03-29', to: '2026-03-30' });
  const { slots, problem } = parseTimeSeries(body, [E.MP]).get(E.MP);
  assert.equal(problem, undefined);
  assert.equal(slots.size, 46);
  const first = parseLocalDate('2026-03-29');
  assert.equal(slots.get(first), E.hourly(first) / 2);
  assert.equal(slots.get(first + HALF_HOUR), E.hourly(first) / 2);
});

test('quarter hours are added two by two, only when both are known', () => {
  const start = '2026-11-10T23:00:00Z';
  const body = {
    result: [
      {
        success: true,
        id: E.MP,
        MyEnergyData_MarketDocument: {
          TimeSeries: [
            {
              mRID: E.MP,
              businessType: 'A04',
              'measurement_Unit.name': 'KWH',
              Period: [
                {
                  resolution: 'PT15M',
                  timeInterval: { start, end: '2026-11-11T00:00:00Z' },
                  Point: [
                    {
                      position: '1',
                      'out_Quantity.quantity': '0.100',
                      'out_Quantity.quality': 'A04',
                    },
                    {
                      position: '2',
                      'out_Quantity.quantity': '0.150',
                      'out_Quantity.quality': 'A03',
                    },
                    {
                      position: '3',
                      'out_Quantity.quantity': '0.200',
                      'out_Quantity.quality': 'A04',
                    },
                    { position: '4', 'out_Quantity.quality': 'A02' },
                    { position: '9', 'out_Quantity.quantity': '9.000' },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  };
  const { slots } = parseTimeSeries(body, [E.MP]).get(E.MP);
  assert.deepEqual([...slots], [[at(start), 0.25]]);
});

test('never a reading: A02, A05, a text, a negative, a position out of range, another unit', () => {
  const series = (points, extra = {}) => ({
    result: [
      {
        success: true,
        id: E.MP,
        MyEnergyData_MarketDocument: {
          TimeSeries: [
            {
              mRID: E.MP,
              businessType: 'A04',
              'measurement_Unit.name': 'KWH',
              ...extra,
              Period: [
                {
                  resolution: 'PT1H',
                  timeInterval: { start: '2026-11-10T23:00:00Z', end: '2026-11-11T02:00:00Z' },
                  Point: points,
                },
              ],
            },
          ],
        },
      },
    ],
  });
  const slotsOf = (points, extra) => parseTimeSeries(series(points, extra), [E.MP]).get(E.MP);
  for (const point of [
    { position: '1', 'out_Quantity.quantity': '1.000', 'out_Quantity.quality': 'A05' },
    { position: '1', 'out_Quantity.quantity': '1.000', 'out_Quantity.quality': 'A02' },
    { position: '1', 'out_Quantity.quantity': '1.000', 'out_Quantity.quality': 'Z99' },
    { position: '1', 'out_Quantity.quantity': '' },
    { position: '1', 'out_Quantity.quantity': 'n/a' },
    { position: '1', 'out_Quantity.quantity': '-1.000' },
    { position: '1', 'out_Quantity.quantity': '1e3' },
    { position: '0', 'out_Quantity.quantity': '1.000' },
    { position: '4', 'out_Quantity.quantity': '1.000' },
    { position: '1.5', 'out_Quantity.quantity': '1.000' },
    { position: '1', 'out_Quantity.quantity': '99999.000' },
  ]) {
    assert.equal(slotsOf([point]).slots.size, 0, JSON.stringify(point));
  }
  const ok = { position: '1', 'out_Quantity.quantity': '1.000', 'out_Quantity.quality': 'A04' };
  assert.equal(slotsOf([ok]).slots.size, 2);
  assert.equal(slotsOf([ok], { 'measurement_Unit.name': 'MWH' }).problem, 'bad_unit');
  assert.equal(slotsOf([ok], { 'measurement_Unit.name': 'MWH' }).slots.size, 0);
  // A production series, or a series of another metering point: not read.
  assert.equal(slotsOf([ok], { businessType: 'A01' }).slots.size, 0);
  assert.equal(slotsOf([ok], { mRID: E.MP2 }).slots.size, 0);
});

test('a result with an error code, a metering point not asked, a hostile answer', () => {
  const body = E.timeSeries({ ids: [E.MP, E.MP2], from: '2026-11-09', to: '2026-11-10' });
  body.result[1] = E.failed(E.MP2, 30015);
  const out = parseTimeSeries(body, [E.MP, E.MP2]);
  assert.equal(out.get(E.MP).slots.size, 48);
  assert.equal(out.get(E.MP2).problem, 'E30015');
  assert.equal(parseTimeSeries(body, [E.MP2]).has(E.MP), false);
  assert.equal(parseTimeSeries({ result: {} }, [E.MP]), undefined);
  assert.equal(parseTimeSeries(null, [E.MP]), undefined);
  // __proto__ and friends never become keys of anything.
  const evil = JSON.parse(
    `{"result":[{"id":"${E.MP}","success":true,"__proto__":{"x":1},"MyEnergyData_MarketDocument":{"TimeSeries":[{"__proto__":{"polluted":1}}]}}]}`,
  );
  parseTimeSeries(evil, [E.MP]);
  assert.equal({}.polluted, undefined);
  // A period not aligned or absurdly long: ignored.
  const odd = E.timeSeries({ from: '2026-11-09', to: '2026-11-10' });
  odd.result[0].MyEnergyData_MarketDocument.TimeSeries[0].Period[0].timeInterval.start =
    '2026-11-08T23:07:00Z';
  assert.equal(parseTimeSeries(odd, [E.MP]).get(E.MP).slots.size, 0);
});

test('a huge answer is parsed in bounded time', () => {
  const points = Array.from({ length: 300_000 }, (_, i) => ({
    position: String((i % 24) + 1),
    'out_Quantity.quantity': '1.000',
  }));
  const body = E.timeSeries({ from: '2026-11-09', to: '2026-11-10' });
  body.result[0].MyEnergyData_MarketDocument.TimeSeries[0].Period[0].Point = points;
  const started = performance.now();
  parseTimeSeries(body, [E.MP]);
  assert.ok(performance.now() - started < 2000);
});

test('the config: a JWT only, trimmed, never a control character', () => {
  assert.deepEqual(normalizeConfig({ refresh_token: `  ${E.TOKEN}\n` }), {
    token: E.TOKEN,
    problem: undefined,
  });
  assert.equal(normalizeConfig({}).problem, 'missing');
  assert.equal(normalizeConfig({ refresh_token: 'not a token' }).problem, 'badToken');
  assert.equal(normalizeConfig({ refresh_token: `${E.TOKEN}\r\nX: y` }).problem, 'malformed');
  assert.equal(normalizeConfig({ refresh_token: 42 }).problem, 'malformed');
  assert.equal(normalizeConfig({ refresh_token: 'a'.repeat(9000) }).problem, 'malformed');
  assert.equal(normalizeConfig({ gladys_refresh_token: E.TOKEN }).problem, 'missing');
});

test('the expiry of the token, read for the status only', () => {
  assert.equal(tokenExpiry(E.TOKEN), Date.UTC(2027, 5, 30, 12));
  assert.equal(tokenExpiry(E.TOKEN2), undefined);
  assert.equal(tokenExpiry('a.!!!.b'), undefined);
  assert.equal(tokenExpiry(undefined), undefined);
});

test('the keys of the metering points: HMAC, 16 hex digits, never the id', () => {
  const key = keyOf(E.ID_KEY, 'mp', E.MP);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.notEqual(key, keyOf(E.ID_KEY, 'mp', E.MP2));
  assert.notEqual(key, keyOf('b'.repeat(64), 'mp', E.MP));
  assert.equal(MINUTE, 60_000);
});
