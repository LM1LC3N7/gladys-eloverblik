// -----------------------------------------------------------------------------
// The answers of the Eloverblik customer API turned into what Gladys takes
// (pure functions, no network): the data access token, the consumption
// metering points of the user, and the time series as 30-minute slots
// (instants in ms -> kWh).
//
// What the Swagger (customerapi V1.0) says, and what is kept:
// - every answer is `{ result: ... }`; a result per metering point carries
//   `success`, `errorCode`, `id` and `MyEnergyData_MarketDocument`;
// - a period has `timeInterval.start/end` (UTC, ISO 8601), a `resolution`
//   (PT15M, PT1H, ...) and points `position` (1..n) with
//   `out_Quantity.quantity` (a string, at most 3 decimals) and
//   `out_Quantity.quality`: A01 adjusted, A03 estimated and A04 measured are
//   readings; A02 (not available, no quantity) and A05 (incomplete) are not:
//   the slot stays unknown, never 0;
// - `businessType` A04 / A64 is a consumption (A01 is a production: not
//   read), `measurement_Unit.name` KWH.
// Hourly points are split in two equal halves (as the SDK asks); quarter hours
// are added two by two, only when both are known.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import {
  HALF_HOUR,
  MAX_HALF_HOUR_KWH,
  MAX_METERING_POINTS,
  MAX_POINTS,
  MINUTE,
} from '../constants.js';
import { localDate, parseLocalDate } from '../time.js';

/** 16 hex digits of an HMAC-SHA-256 under the id key: names a metering point, never its id. */
export const keyOf = (idKey, kind, value) =>
  createHmac('sha256', idKey).update(`${kind}\u0000${value}`, 'utf8').digest('hex').slice(0, 16);

export const METERING_POINT = /^\d{18}$/;
const QUANTITY = /^\d{1,9}(\.\d{1,6})?$/;
const POSITION = /^\d{1,5}$/;
const READINGS = new Set(['A01', 'A03', 'A04']);
const CONSUMPTION = new Set(['A04', 'A64']);
const RESOLUTIONS = { PT15M: 15 * MINUTE, PT30M: 30 * MINUTE, PT1H: 60 * MINUTE };
/** Error codes of the token endpoint that mean "this token is not a valid one". */
const TOKEN_REFUSED = new Set([50000, 50001]);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The data access token of a GetToken answer: `{ token }`, `{ refused: true }`
 * (the API says the token is not a Customer API one, or not valid), or
 * undefined when unreadable.
 */
export function parseToken(body) {
  if (!isObject(body)) return undefined;
  if (TOKEN_REFUSED.has(body.errorCode)) return { refused: true };
  const token = body.result;
  if (typeof token !== 'string' || token.length < 10 || token.length > 16384) return undefined;
  // Printable ASCII only: it goes back into a header.
  if (!/^[\x21-\x7e]+$/.test(token)) return undefined;
  return { token };
}

/**
 * The local date (Denmark) of `consumerStartDate`, the day the user took the
 * metering point over: the oldest day worth asking. Undefined when absent or
 * unreadable (then nothing bounds the window but its own limits).
 */
function startDateOf(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text))
    return parseLocalDate(text) === undefined ? undefined : text;
  const at = instant(text);
  return at === undefined ? undefined : localDate(at);
}

/**
 * The consumption metering points (type E17) related to the user, at most
 * MAX_METERING_POINTS (sorted by id): `{ points: [{ id, supplier }],
 * others, dropped }`; undefined when unreadable.
 */
export function parseMeteringPoints(body) {
  if (!isObject(body) || !Array.isArray(body.result)) return undefined;
  const seen = new Map();
  let others = 0;
  for (const mp of body.result.slice(0, 1000)) {
    if (!isObject(mp) || typeof mp.meteringPointId !== 'string') continue;
    const id = mp.meteringPointId.trim();
    if (!METERING_POINT.test(id)) continue;
    // A relation only (includeAll=false gives only those; checked again).
    if (mp.hasRelation === false) continue;
    if (mp.typeOfMP !== 'E17') {
      others += 1;
      continue;
    }
    const supplier =
      typeof mp.balanceSupplierName === 'string'
        ? mp.balanceSupplierName
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') // eslint-disable-line no-control-regex
            .trim()
            .slice(0, 60)
        : '';
    if (!seen.has(id)) seen.set(id, { id, supplier, startDate: startDateOf(mp.consumerStartDate) });
  }
  const all = [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    points: all.slice(0, MAX_METERING_POINTS),
    others,
    dropped: Math.max(0, all.length - MAX_METERING_POINTS),
  };
}

/** An ISO 8601 instant of the API (UTC); undefined when unreadable. */
function instant(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The kWh of a point; undefined when it is not a reading (never 0 for a missing value). */
function quantityOf(point) {
  if (!isObject(point)) return undefined;
  const quality = point['out_Quantity.quality'];
  if (quality !== undefined && quality !== null && !READINGS.has(quality)) return undefined;
  const raw = point['out_Quantity.quantity'];
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (typeof text !== 'string' || !QUANTITY.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return Number.isFinite(value) && value <= 2 * MAX_HALF_HOUR_KWH ? value : undefined;
}

/**
 * The time series of a gettimeseries answer, for the metering points asked:
 * a Map id -> `{ slots: Map(startMs -> kWh), problem? }`. A metering point
 * the answer does not mention is absent. Undefined when the answer is
 * unreadable as a whole.
 */
export function parseTimeSeries(body, ids) {
  if (!isObject(body) || !Array.isArray(body.result)) return undefined;
  const wanted = new Set(ids);
  const out = new Map();
  let points = 0;
  for (const entry of body.result.slice(0, 100)) {
    if (!isObject(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : undefined;
    if (!id || !wanted.has(id)) continue;
    const item = out.get(id) ?? { slots: new Map(), problem: undefined };
    out.set(id, item);
    if (entry.success === false) {
      item.problem = Number.isInteger(entry.errorCode) ? `E${entry.errorCode}` : 'refused';
      continue;
    }
    const doc = entry.MyEnergyData_MarketDocument;
    if (!isObject(doc) || !Array.isArray(doc.TimeSeries)) {
      item.problem ??= 'no_data';
      continue;
    }
    // Quarter hours waiting for their other half: slot -> [sum, count].
    const quarters = new Map();
    for (const series of doc.TimeSeries.slice(0, 20)) {
      if (!isObject(series)) continue;
      const mrid = series.mRID ?? series.MarketEvaluationPoint?.mRID?.name;
      if (typeof mrid === 'string' && mrid.trim() !== id) continue;
      if (!CONSUMPTION.has(series.businessType)) continue;
      const unit = series['measurement_Unit.name'];
      if (typeof unit !== 'string' || unit.toUpperCase() !== 'KWH') {
        item.problem = 'bad_unit';
        continue;
      }
      for (const period of (Array.isArray(series.Period) ? series.Period : []).slice(0, 2000)) {
        if (!isObject(period) || !Array.isArray(period.Point)) continue;
        const step = RESOLUTIONS[period.resolution];
        const start = instant(period.timeInterval?.start);
        const end = instant(period.timeInterval?.end);
        if (!step || start === undefined || end === undefined || end <= start) continue;
        if (start % (15 * MINUTE) !== 0 || (end - start) % step !== 0) continue;
        const count = (end - start) / step;
        if (count > 5000) continue;
        for (const point of period.Point.slice(0, count)) {
          points += 1;
          if (points > MAX_POINTS) return out;
          const position = point?.position;
          const posText = typeof position === 'number' ? String(position) : position;
          if (typeof posText !== 'string' || !POSITION.test(posText)) continue;
          const pos = Number(posText);
          if (pos < 1 || pos > count) continue;
          const kwh = quantityOf(point);
          if (kwh === undefined) continue;
          const at = start + (pos - 1) * step;
          if (step === HALF_HOUR) {
            if (at % HALF_HOUR === 0) item.slots.set(at, kwh);
          } else if (step === 2 * HALF_HOUR) {
            if (at % HALF_HOUR !== 0) continue;
            // The hour in two equal halves.
            item.slots.set(at, kwh / 2);
            item.slots.set(at + HALF_HOUR, kwh / 2);
          } else {
            const slot = at - (at % HALF_HOUR);
            const q = quarters.get(slot) ?? { sum: 0, seen: new Set() };
            if (q.seen.has(at)) continue;
            q.seen.add(at);
            q.sum += kwh;
            quarters.set(slot, q);
            if (q.seen.size === 2) item.slots.set(slot, q.sum);
          }
        }
      }
    }
  }
  // Rounded to the µWh: the halves of a 3-decimal hour stay exact enough.
  for (const item of out.values()) {
    for (const [at, kwh] of item.slots) {
      if (kwh > MAX_HALF_HOUR_KWH) item.slots.delete(at);
      else item.slots.set(at, Math.round(kwh * 1e6) / 1e6);
    }
  }
  return out;
}
