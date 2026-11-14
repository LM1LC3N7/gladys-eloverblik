// -----------------------------------------------------------------------------
// Local time of Denmark (Europe/Copenhagen), through the time zone database of Node
// (Intl): the changes of time are the real ones. Eloverblik dates its
// periods in UTC; the days asked and the days complete are local dates of
// Denmark. Pure functions.
// -----------------------------------------------------------------------------

import { HALF_HOUR, HOUR, TIME_ZONE } from './constants.js';

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The local date and time of Denmark at `ms`: { y, mo, d, h, mi, s }. */
export function local(ms) {
  const out = {};
  for (const { type, value } of parts.formatToParts(new Date(ms))) {
    out[type] = Number(value);
  }
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

const pad = (v) => String(v).padStart(2, '0');

/** "2026-11-11", the local date of Denmark at `ms`. */
export function localDate(ms) {
  const t = local(ms);
  return `${t.y}-${pad(t.mo)}-${pad(t.d)}`;
}

/** "11/11 14:05", local date and time of Denmark. */
export function dayClock(ms) {
  const t = local(ms);
  return `${pad(t.d)}/${pad(t.mo)} ${pad(t.h)}:${pad(t.mi)}`;
}

/**
 * Every instant showing this local time in Denmark, oldest first: one, two
 * (the hour seen twice in autumn) or none (the hour skipped in spring).
 */
export function instantsOf(y, mo, d, h = 0, mi = 0, s = 0) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const out = [];
  for (const offset of [2, 1]) {
    const candidate = asUtc - offset * HOUR;
    const t = local(candidate);
    if (t.y === y && t.mo === mo && t.d === d && t.h === h && t.mi === mi && t.s === s) {
      out.push(candidate);
    }
  }
  return out;
}

/** The instant of a local time of Denmark (the first one of an hour seen twice). */
export function fromLocal(y, mo, d, h = 0, mi = 0) {
  const [first] = instantsOf(y, mo, d, h, mi);
  // A local time skipped by the spring change (02:xx): read as winter time.
  return first ?? Date.UTC(y, mo - 1, d, h, mi) - HOUR;
}

/** A local date "YYYY-MM-DD" -> its local midnight in Denmark; undefined when malformed. */
export function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) return undefined;
  const [y, mo, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 2000 || y > 2100) return undefined;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  return fromLocal(y, mo, d);
}

/** The next local date: "2026-11-11" -> "2026-11-12". */
export function nextDate(date) {
  const [y, mo, d] = date.split('-').map(Number);
  const n = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}`;
}

/** The local date `days` days after (negative: before) a local date. */
export function shiftDate(date, days) {
  const [y, mo, d] = date.split('-').map(Number);
  const n = new Date(Date.UTC(y, mo - 1, d + days));
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}`;
}

/** The 30-minute slots (their start instants) of a local day of Denmark: 46, 48 or 50. */
export function slotsOfDay(date) {
  const from = parseLocalDate(date);
  const to = parseLocalDate(nextDate(date));
  const out = [];
  for (let at = from; at < to; at += HALF_HOUR) out.push(at);
  return out;
}
