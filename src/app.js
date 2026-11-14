// -----------------------------------------------------------------------------
// The integration itself: the consumption metering points of the user read
// through the official customer API of Eloverblik (Energinet DataHub,
// Denmark), one Gladys device per metering point, the hourly consumption
// published after the fact into the energy monitoring
// (publishEnergyConsumption, each hour in two half hours). index.js only wires
// the SDK handlers to it. Read-only: nothing is ever changed on the account.
//
// Tokens: the user creates a token in the Eloverblik portal (the "refresh
// token" of the API, valid a year); GetToken trades it for a data access
// token (24 h), kept in memory only and renewed after 20 h. GetToken is
// limited to 2 calls a minute per IP: two calls are never closer than 5
// minutes, a restart included. A refusal of the token by GetToken (401, or a
// 403 / error code of the API) is kept in /data (8 bits of a salted hash) and
// nothing is sent until the token changes or Test succeeds; a 401/403 of a
// data route is never a refusal (the access token is dropped and renewed at
// the next read).
//
// Pace: one read a day, from 09:00 (local time of Denmark, a minute proper to
// the installation), asking only for the days not yet complete; again 4 hours
// later while yesterday is incomplete, at most 4 reads a day; a new device or
// a changed config is read a minute later. Every request is counted in /data
// BEFORE it leaves, with a hard ceiling per day. A 429 or a 5xx pauses every
// request (persisted, Retry-After honoured, 15 minutes doubled up to 6 hours).
//
// Two clocks: `now` (wall clock) names the days and dates what /data keeps;
// `monotonic` paces the reads, the gaps and the pauses, so that a wall clock
// set back or forward never hurries them.
//
// A start (config saved, reconnection) opens a new generation: a late answer
// of an older one publishes nothing and sets no status (checked after every
// await).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { normalizeConfig, tokenExpiry } from './config.js';
import {
  ACCESS_TOKEN_LIFE,
  BACKFILL_DAYS,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  FIRST_DAYS,
  HALF_HOUR,
  HOLE_WAIT_DAYS,
  MAX_INTERVALS_PER_CALL,
  MAX_REQUESTS_PER_DAY,
  MAX_STATUS,
  MAX_TIMER,
  MIN_ROUND_GAP,
  MINUTE,
  PAUSE_BASE,
  PAUSE_MAX,
  PAUSE_MIN,
  REREAD_DAYS,
  RETRY_GAP,
  ROUND_HOUR,
  ROUND_SPREAD_MINUTES,
  ROUNDS_PER_DAY,
  SOON_GAP,
  STORE_RETRY,
  STORE_WAIT,
  TEST_MIN_GAP,
  TOKEN_GAP,
} from './constants.js';
import { FEATURE, buildMeterDevice, idsOf, parseDeviceId } from './devices.js';
import { both, t } from './i18n.js';
import { EloverblikError, EloverblikSession, routes } from './eloverblik/client.js';
import { keyOf, parseMeteringPoints, parseTimeSeries, parseToken } from './eloverblik/model.js';
import { FileStore } from './store.js';
import {
  dayClock,
  fromLocal,
  localDate,
  nextDate,
  parseLocalDate,
  shiftDate,
  slotsOfDay,
} from './time.js';

const TIMED_OUT = Symbol('timed out');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const KEY = /^[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID_KEY = /^[0-9a-f]{64}$/;
/** Errors that pause every request. */
const PAUSING = new Set(['rate_limited', 'server']);
/** Per metering point: asked before its registration (30018) or its authorization (30010). */
const LATER_START = new Set(['E30018', 'E30010']);
/** Requests a read may spend searching the first accepted day of new points. */
const SEARCH_BUDGET = 8;
/** Result errors that belong to one metering point (not to the aggregation asked). */
const POINT_ERRORS = new Set([
  ...Array.from({ length: 14 }, (_, i) => `E${20000 + i}`),
  'E30010',
  'E30015',
  'E30016',
  'E30018',
  'E40014',
]);
const pointError = (problem) =>
  problem === undefined || POINT_ERRORS.has(problem) || !/^E\d+$/.test(problem);

/** The local date halfway between two local dates (rounded up). */
function midDate(from, to) {
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
  return shiftDate(from, Math.ceil(days / 2));
}

/** 8 bits of a salted hash of the token: nothing to find it back from. */
export const tagOf = (salt, token) =>
  createHash('sha256').update(`${salt}\u0000${token}`, 'utf8').digest()[0];

/** A pause read back from /data, its rest capped to PAUSE_MAX; undefined when invalid. */
export function validPause(pause, now, mono) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    !PAUSING.has(pause.code)
  ) {
    return undefined;
  }
  const left = Math.min(Math.max(0, pause.until - now), PAUSE_MAX);
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 16),
    code: pause.code,
    detail: typeof pause.detail === 'string' ? pause.detail.slice(0, 24) : null,
  };
}

export function validRefused(refused) {
  return refused &&
    typeof refused.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(refused.salt) &&
    Number.isInteger(refused.tag) &&
    refused.tag >= 0 &&
    refused.tag < 256
    ? { salt: refused.salt, tag: refused.tag }
    : undefined;
}

function validPublished(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, date] of Object.entries(value).slice(0, 32)) {
    if (KEY.test(key) && typeof date === 'string' && DATE.test(date)) out[key] = date;
  }
  return out;
}

function validRequests(value) {
  if (!value || !DATE.test(value.date ?? '') || !Number.isInteger(value.count)) return null;
  return { date: value.date, count: Math.min(Math.max(0, value.count), 1000) };
}

const bound = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const codeOf = (err) => (err instanceof EloverblikError ? err.code : 'bad_response');
const dmy = (date) => date.split('-').reverse().join('/');

export class EloverblikApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = { setTimeout, clearTimeout },
    store = new FileStore(),
    fetchImpl = (...args) => globalThis.fetch(...args),
    random = (n) => randomBytes(n),
    requestGap,
    requestTimeout,
    apiUrl,
  }) {
    this.gladys = gladys;
    this.log = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.requestGap = requestGap;
    this.requestTimeout = requestTimeout;
    this.apiUrl = apiUrl;

    this.gen = 0;
    this.stopped = false;
    this.stopEpoch = 0;
    this.config = normalizeConfig({});
    this.session = undefined;
    this.token = undefined;
    /** The token of the form last seen ('' when missing or malformed). */
    this.enteredToken = undefined;
    /** The data access token: memory only, `{ token, at (monotonic) }`. */
    this.access = undefined;

    /** What /data keeps (never a token nor a metering point id). */
    this.data = {
      lastRound: null,
      roundsDate: null,
      rounds: 0,
      requests: null,
      lastToken: null,
      pause: null,
      refused: null,
      published: {},
      keyTag: null,
    };
    this.storeState = 'pending';
    this.loading = null;
    this.storeTimer = null;
    this.pause = undefined;
    this.refused = undefined;

    /** The metering points listed by the API: { id (memory only), key, suffix, supplier }. */
    this.meters = [];
    this.listDate = undefined;
    this.listInfo = { others: 0, dropped: 0 };
    this.created = new Set();
    this.createdDevices = new Map();
    this.lastRoundMono = undefined;
    this.lastTokenMono = undefined;
    this.soon = false;
    this.roundOk = undefined;
    this.lastReadAt = undefined;
    this.problems = new Map();
    this.roundProblem = undefined;
    /** Per metering point key, in memory: the day it ended in error, the start DataHub took. */
    this.errorDays = new Map();
    this.floors = new Map();
    /** A search of the first accepted day cut by the budget: { lo, hi } per key. */
    this.searches = new Map();
    /** `Quarter` first (the 15-minute meters); `Hour` once DataHub refuses it. */
    this.aggregation = 'Quarter';

    this.roundTimer = null;
    this.configTimer = null;
    this.configDelay = 0;
    this.running = Promise.resolve();
    this.sleeps = new Set();
    this.lastStatus = undefined;
    this.lastTest = undefined;
    this.dueMono = undefined;
    this.lastDiscovery = undefined;
    this.idKey = undefined;
    this.idKeyPending = undefined;
    this.idKeyDue = undefined;
    this.idKeyFailures = 0;
    this.idKeyTimer = null;
    this.devicesTimer = null;
    this.devicesDelay = 0;
    this.devicesUnread = false;
    this.blindMono = undefined;
  }

  gone(gen) {
    return this.stopped || gen !== this.gen;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Every (re)connection to Gladys: read the config (retried for ever), then start. */
  async connected() {
    const epoch = this.stopEpoch;
    this.stopped = false;
    this.lastStatus = undefined;
    this.lastDiscovery = undefined;
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = null;
    }
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped || epoch !== this.stopEpoch) return;
      this.configDelay = Math.min(
        CONFIG_RETRY_MAX,
        Math.max(CONFIG_RETRY_MIN, this.configDelay * 2),
      );
      this.log.warn(
        `Configuration not read (${err?.name ?? 'Error'}): again in ${this.configDelay / 1000} s`,
      );
      await this.setStatus(false, both('configUnread'));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = null;
        this.connected().catch((e) => this.log.error(`Start failed (${e?.name ?? 'Error'})`));
      }, this.configDelay);
      return;
    }
    if (this.stopped || epoch !== this.stopEpoch) return;
    this.configDelay = 0;
    await this.start(config);
  }

  async start(rawConfig) {
    this.stopped = false;
    const gen = ++this.gen;
    const config = normalizeConfig(rawConfig);
    // Another token entered by the user (after a valid one or a malformed
    // one): read soon (not at a restart), and always tried, even when its
    // 8-bit tag matches the refused one.
    const tokenChanged =
      this.enteredToken !== undefined && config.token !== '' && config.token !== this.enteredToken;
    this.enteredToken = config.token;
    if (tokenChanged) {
      this.soon = true;
      if (this.refused || this.data.refused) {
        this.refused = undefined;
        this.data.refused = null;
        // Cleared on disk at once: a restart never brings the old refusal back.
        await this.save();
        if (this.gone(gen)) return;
      }
    }
    this.takeIdKey(rawConfig);
    this.config = config;
    if (tokenChanged || !this.session || config.problem) {
      this.session?.close();
      this.access = undefined;
      this.session = config.problem
        ? undefined
        : new EloverblikSession({
            fetchImpl: this.fetchImpl,
            monotonic: this.monotonic,
            sleep: (ms) => this.sleep(ms),
            // A 429 or a 5xx: every request still in the queue is held at once.
            onError: (err) => {
              if (PAUSING.has(err?.code)) this.applyPause(err);
            },
            ...(this.apiUrl ? { url: this.apiUrl } : {}),
            ...(this.requestTimeout ? { timeout: this.requestTimeout } : {}),
            ...(this.requestGap !== undefined ? { gap: this.requestGap } : {}),
          });
      this.token = config.problem ? undefined : config.token;
      if (tokenChanged || config.problem) {
        // Another account, maybe: the list is read again before any data.
        this.meters = [];
        this.listDate = undefined;
        this.problems.clear();
        this.errorDays.clear();
        this.floors.clear();
        this.searches.clear();
        this.roundProblem = undefined;
        this.roundOk = undefined;
        this.lastDiscovery = undefined;
      }
    }
    this.clearRound();
    await this.ready();
    if (this.gone(gen)) return;
    if (!config.problem) await this.ensureIdKey(gen);
    if (this.gone(gen)) return;
    await this.refreshCreated(gen);
    if (this.gone(gen)) return;
    await this.publishDiscovery(gen, { onlyChanged: true });
    if (this.gone(gen)) return;
    this.schedule(gen);
    await this.report(gen);
  }

  /** The id key stored in the Gladys config (outside the form), when valid. */
  takeIdKey(rawConfig) {
    const key = typeof rawConfig?.id_key === 'string' ? rawConfig.id_key : '';
    if (ID_KEY.test(key)) this.adoptIdKey(key);
  }

  adoptIdKey(key) {
    if (key === this.idKey) return;
    if (this.idKey) this.lastDiscovery = undefined;
    this.idKey = key;
    // The keys of the metering points follow the id key.
    this.meters = this.meters.map((m) => ({ ...m, key: keyOf(key, 'mp', m.id) }));
    this.checkKeyTag();
  }

  /**
   * /data keeps 4 bytes of an HMAC of the id key: when the key in use is
   * another one, what /data keeps per metering point (keyed by the old one) goes.
   */
  checkKeyTag() {
    if (!this.idKey || this.storeState !== 'ok') return;
    const tag = keyOf(this.idKey, 'tag', 'eloverblik').slice(0, 8);
    if (this.data.keyTag && this.data.keyTag !== tag) this.data.published = {};
    this.data.keyTag = tag;
  }

  /**
   * The secret of the device keys (HMAC): read from the Gladys config, made
   * once and stored there (never in /data, never shown in the form). Until it
   * is stored, nothing is read nor published (the ids depend on it). One
   * attempt at a time, spaced 5 s doubled up to 5 min after a failure; the
   * key adopted is the one Gladys holds once the write is done (read back).
   */
  ensureIdKey(gen) {
    if (this.idKey) return Promise.resolve(true);
    if (this.idKeyPending) return this.idKeyPending;
    if (this.idKeyDue !== undefined && this.monotonic() < this.idKeyDue) {
      return Promise.resolve(false);
    }
    this.idKeyPending = this.storeIdKey(gen).finally(() => {
      this.idKeyPending = undefined;
    });
    return this.idKeyPending;
  }

  async storeIdKey(gen) {
    const stored = (config) => (ID_KEY.test(config?.id_key ?? '') ? config.id_key : undefined);
    try {
      let key = stored(await this.gladys.getConfig());
      if (!key) {
        await this.gladys.setConfig({ id_key: this.random(32).toString('hex') });
        key = stored(await this.gladys.getConfig());
        if (!key) throw new Error('not stored');
      }
      if (this.stopped && this.gone(gen)) return false;
      this.idKeyFailures = 0;
      this.idKeyDue = undefined;
      this.adoptIdKey(key);
      await this.save();
      return true;
    } catch (err) {
      this.idKeyFailures += 1;
      const wait = Math.min(CONFIG_RETRY_MAX, CONFIG_RETRY_MIN * 2 ** (this.idKeyFailures - 1));
      this.idKeyDue = this.monotonic() + wait;
      this.log.warn(
        `Id key not stored in Gladys (${err?.name ?? 'Error'}): again in ${wait / 1000} s`,
      );
      // Tried again by its own timer: the reads wait for it.
      if (!this.gone(gen)) {
        if (this.idKeyTimer) this.timers.clearTimeout(this.idKeyTimer);
        this.idKeyTimer = this.timers.setTimeout(() => {
          this.idKeyTimer = null;
          if (this.gone(gen) || this.idKey) return;
          this.ensureIdKey(gen)
            .then((ok) => {
              if (this.gone(gen)) return undefined;
              if (!ok) return this.report(gen);
              this.schedule(gen);
              return this.report(gen);
            })
            .catch(() => {});
        }, wait);
      }
      return false;
    }
  }

  async stop() {
    this.stopped = true;
    this.stopEpoch += 1;
    this.gen += 1;
    this.clearRound();
    for (const timer of [this.configTimer, this.storeTimer, this.idKeyTimer, this.devicesTimer]) {
      if (timer) this.timers.clearTimeout(timer);
    }
    this.configTimer = null;
    this.storeTimer = null;
    this.idKeyTimer = null;
    this.devicesTimer = null;
    this.session?.close();
    this.session = undefined;
    this.token = undefined;
    this.access = undefined;
    for (const wake of this.sleeps) wake();
    this.sleeps.clear();
    await this.bounded(
      this.running.catch(() => {}),
      STORE_WAIT,
    ).catch(() => {});
    await this.save();
    await this.bounded(Promise.resolve(this.store.flush?.()), STORE_WAIT).catch(() => {});
  }

  /** `promise`, or TIMED_OUT after `ms` (the timer is cleared either way). */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => resolve(TIMED_OUT), ms);
      promise.then(
        (value) => {
          this.timers.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Resolves after `ms` (injected timers), or at once when the app stops. */
  sleep(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        this.timers.clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve();
      };
      timer = this.timers.setTimeout(wake, Math.max(0, ms));
      this.sleeps.add(wake);
    });
  }

  // --- /data ----------------------------------------------------------------------

  /** Waits for /data at most STORE_WAIT; without it, nothing is ever saved. */
  async ready() {
    if (this.storeState === 'ok') return;
    const result = await this.bounded(this.loadStore(), STORE_WAIT);
    if (result === TIMED_OUT && this.storeState === 'pending') this.storeState = 'unreadable';
    // Readable but not writable: the count of the day would not survive a
    // restart, so the reads wait as with an unreadable /data.
    if (this.storeState === 'ok') await this.save();
  }

  /** One read of /data at a time; an unreadable one is read again every STORE_RETRY. */
  loadStore() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const raw = await this.store.load();
        const late = this.storeState === 'unreadable';
        this.merge(raw);
        this.storeState = 'ok';
        this.checkKeyTag();
        if (late) await this.afterLateLoad();
      } catch (err) {
        this.storeState = 'unreadable';
        this.log.warn(
          `/data unreadable (${err?.name ?? 'Error'}): read again in ${STORE_RETRY / 1000} s`,
        );
      } finally {
        this.loading = null;
      }
      if (this.storeState !== 'ok' && !this.stopped && !this.storeTimer) {
        this.storeTimer = this.timers.setTimeout(() => {
          this.storeTimer = null;
          this.loadStore();
        }, STORE_RETRY);
      }
    })();
    return this.loading;
  }

  async afterLateLoad() {
    if (this.storeState !== 'ok' || this.stopped) return;
    const gen = this.gen;
    await this.save();
    if (this.gone(gen)) return;
    if (this.roundTimer) this.schedule(gen);
    await this.report(gen);
  }

  /** /data read back, merged with what this process learnt meanwhile (the stricter wins). */
  merge(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const now = this.now();
    const mono = this.monotonic();
    // A time of /data in the future is invalid: ignored.
    for (const field of ['lastRound', 'lastToken']) {
      if (
        finite(data[field]) &&
        data[field] <= now &&
        !(finite(this.data[field]) && this.data[field] > data[field])
      ) {
        this.data[field] = data[field];
      }
    }
    if (DATE.test(data.roundsDate ?? '') && Number.isInteger(data.rounds) && data.rounds >= 0) {
      if (!this.data.roundsDate || this.data.roundsDate < data.roundsDate) {
        this.data.roundsDate = data.roundsDate;
        this.data.rounds = Math.min(data.rounds, 100);
      } else if (this.data.roundsDate === data.roundsDate) {
        this.data.rounds = Math.max(this.data.rounds, Math.min(data.rounds, 100));
      }
    }
    const requests = validRequests(data.requests);
    if (requests) {
      const mine = this.data.requests;
      if (!mine || mine.date < requests.date) this.data.requests = requests;
      else if (mine.date === requests.date) mine.count = Math.max(mine.count, requests.count);
    }
    const pause = validPause(data.pause, now, mono);
    if (pause && !(this.pause && this.pause.until >= pause.until)) {
      this.pause = pause;
      this.data.pause = {
        until: pause.until,
        count: pause.count,
        code: pause.code,
        detail: pause.detail,
      };
    }
    const refused = validRefused(data.refused);
    if (refused && !this.refused) {
      this.refused = refused;
      this.data.refused = refused;
    }
    // The later mark wins: a complete day is never asked again.
    for (const [key, date] of Object.entries(validPublished(data.published))) {
      const mine = this.data.published[key];
      if (!mine || mine < date) this.data.published[key] = date;
    }
    if (typeof data.keyTag === 'string' && /^[0-9a-f]{8}$/.test(data.keyTag) && !this.data.keyTag) {
      this.data.keyTag = data.keyTag;
    }
  }

  async save() {
    // An unreadable /data is never overwritten; an unwritable one is tried again.
    if (this.storeState !== 'ok' && this.storeState !== 'unwritable') return false;
    const snapshot = { version: 1, ...this.data };
    try {
      // A slow volume never holds a read: the write goes on in the background.
      // Only a write that FAILS makes /data unwritable; a slow one that lands is fine.
      const done = this.store.save(snapshot).then(
        () => {
          if (this.storeState === 'unwritable') this.storeState = 'ok';
          return true;
        },
        (err) => {
          this.log.warn(`/data not saved (${err?.name ?? 'Error'})`);
          if (this.storeState === 'ok') this.storeState = 'unwritable';
          return false;
        },
      );
      return (await this.bounded(done, STORE_WAIT)) === true;
    } catch (err) {
      this.log.warn(`/data not saved (${err?.name ?? 'Error'})`);
      this.storeState = 'unwritable';
      return false;
    }
  }

  // --- Pace ------------------------------------------------------------------------

  clearRound() {
    if (this.roundTimer) {
      this.timers.clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }
  }

  pauseActive(mono = this.monotonic()) {
    return Boolean(this.pause && this.pause.due > mono);
  }

  isRefused() {
    return Boolean(
      this.refused &&
      this.token !== undefined &&
      this.refused.tag === tagOf(this.refused.salt, this.token),
    );
  }

  /** The minute of the day of the daily read, proper to the installation. */
  roundMinute() {
    const spread = this.idKey
      ? parseInt(keyOf(this.idKey, 'minute', 'round').slice(0, 6), 16) % ROUND_SPREAD_MINUTES
      : 0;
    return ROUND_HOUR * 60 + spread;
  }

  /** The wall instant of the daily read of the local date `date`. */
  roundAt(date) {
    const [y, mo, d] = date.split('-').map(Number);
    const minute = this.roundMinute();
    return fromLocal(y, mo, d, Math.floor(minute / 60), minute % 60);
  }

  /** The keys of the metering points whose device (and feature) the user created. */
  createdKeys() {
    const keys = [];
    for (const id of this.createdDevices.keys()) {
      const parsed = parseDeviceId(id);
      if (!parsed || parsed.feature) continue;
      if (this.created.has(idsOf(this.gladys, parsed.key).feature(FEATURE.CONSUMPTION))) {
        keys.push(parsed.key);
      }
    }
    return keys;
  }

  /** Whether a created metering point still needs a day up to yesterday. */
  needs(key, today) {
    // A metering point in error today (no data, relation, ...): tomorrow.
    if (this.errorDays.get(key) === today) return false;
    const last = this.data.published[key];
    return !last || last < shiftDate(today, -1);
  }

  requestsLeft(today) {
    const r = this.data.requests;
    // A wall clock set back keeps the count of the later day.
    const used = r && r.date >= today ? r.count : 0;
    return MAX_REQUESTS_PER_DAY - used;
  }

  accessValid(mono = this.monotonic()) {
    return Boolean(this.access && mono - this.access.at < ACCESS_TOKEN_LIFE);
  }

  /** The monotonic time GetToken may be called again (never two closer than TOKEN_GAP). */
  tokenDue(mono, now) {
    if (this.lastTokenMono !== undefined) return this.lastTokenMono + TOKEN_GAP;
    // /data not read: unknown, a whole gap is waited.
    if (this.storeState !== 'ok') return (this.blindMono ??= mono) + TOKEN_GAP;
    if (finite(this.data.lastToken) && this.data.lastToken <= now) {
      return mono + Math.max(0, this.data.lastToken + TOKEN_GAP - now);
    }
    return mono;
  }

  /**
   * The monotonic time of the next read. One reading of each clock; a wall
   * target is turned into a monotonic delay at that reading.
   */
  nextDue(mono, now) {
    if (!this.session || !this.idKey || this.isRefused()) return undefined;
    const today = localDate(now);
    // The last read: this process, else /data; /data not read: unknown, a whole gap is waited.
    let last;
    if (this.lastRoundMono !== undefined) last = this.lastRoundMono;
    else if (this.storeState !== 'ok') last = this.blindMono ??= mono;
    else if (finite(this.data.lastRound) && this.data.lastRound <= now) {
      last = mono - (now - this.data.lastRound);
    }
    const gap = (ms) => (last === undefined ? mono : last + ms);
    const wall = (at) => mono + Math.max(0, at - now);
    const tomorrow = wall(this.roundAt(shiftDate(today, 1)));
    // Work: a created metering point missing a day, or the list never read
    // in this process (Discovery, the ids of the created devices).
    const work =
      this.requestsLeft(today) > 0 &&
      (this.listDate === undefined || this.createdKeys().some((k) => this.needs(k, today)));
    const rounds = this.data.roundsDate === today ? this.data.rounds : 0;
    let due;
    if (!work) due = tomorrow;
    else if (this.soon || last === undefined) due = gap(SOON_GAP);
    else if (rounds >= ROUNDS_PER_DAY) due = tomorrow;
    else if (rounds === 0) due = Math.max(wall(this.roundAt(today)), gap(MIN_ROUND_GAP));
    else due = Math.max(gap(RETRY_GAP), gap(MIN_ROUND_GAP));
    // A pause set by the last read: the read comes back at its end (the
    // doubled pause is the spacing), not after the ordinary retry gap.
    if (this.pause && work && (last === undefined || this.pause.due > last)) due = this.pause.due;
    else if (this.pause) due = Math.max(due, this.pause.due);
    // Without a valid access token: not before GetToken may be called again.
    if (!this.accessValid(mono)) due = Math.max(due, this.tokenDue(mono, now));
    return due;
  }

  /** The next round: when due, never during a pause or a refusal; long waits cut in pieces. */
  schedule(gen) {
    if (this.gone(gen)) return;
    this.clearRound();
    const mono = this.monotonic();
    const due = this.nextDue(mono, this.now());
    if (due === undefined) {
      this.dueMono = undefined;
      return;
    }
    this.dueMono = Math.max(due, mono);
    const wait = this.dueMono - mono;
    this.roundTimer = this.timers.setTimeout(
      () => {
        this.roundTimer = null;
        if (wait > MAX_TIMER) {
          // Only a piece of the wait: the due time is computed again.
          this.schedule(gen);
          return;
        }
        this.running = this.round(gen).catch((err) =>
          this.log.error(`Round failed (${err?.name ?? 'Error'})`),
        );
      },
      Math.min(wait, MAX_TIMER),
    );
  }

  // --- Requests ----------------------------------------------------------------------

  /**
   * Counts a request in /data BEFORE it leaves; refuses beyond the ceiling.
   * A GetToken also keeps its time (two are never closer than TOKEN_GAP).
   */
  async countRequest({ token = false } = {}) {
    // A pause set while this request waited in the queue: nothing sent.
    if (this.pauseActive()) throw new EloverblikError('paused');
    const now = this.now();
    const mono = this.monotonic();
    if (token && this.tokenDue(mono, now) > mono) throw new EloverblikError('token_wait');
    const today = localDate(now);
    // A new count only when the day moves FORWARD (never on a wall clock set back).
    if (!this.data.requests || this.data.requests.date < today) {
      this.data.requests = { date: today, count: 0 };
    }
    if (this.data.requests.count >= MAX_REQUESTS_PER_DAY) {
      throw new EloverblikError('daily_ceiling');
    }
    this.data.requests.count += 1;
    if (token) {
      this.lastTokenMono = mono;
      this.data.lastToken = now;
    }
    // Kept before the request leaves (an unwritable /data is said in the status).
    await this.save();
  }

  /** A data access token: the one in memory while valid, else one GetToken. */
  async ensureAccess(gen) {
    if (this.accessValid()) return this.access;
    this.access = undefined;
    const token = this.token;
    const body = await this.session.request({ ...routes.token(), bearer: () => token }, () =>
      this.countRequest({ token: true }),
    );
    if (this.gone(gen)) throw new EloverblikError('stopped');
    const parsed = parseToken(body);
    if (parsed?.refused) throw new EloverblikError('refused');
    if (!parsed) throw new EloverblikError('bad_response');
    this.access = { token: parsed.token, at: this.monotonic() };
    return this.access;
  }

  /** One request of a data route with the access token of this generation. */
  dataRequest(gen, route) {
    if (this.gone(gen) || !this.session) return Promise.reject(new EloverblikError('stopped'));
    return this.session
      .request({ ...route, bearer: () => this.access?.token }, () => this.countRequest())
      .catch((err) => {
        // A data route refusing the access token: never a refusal of the
        // user's token; the access token is renewed at the next read.
        if (err?.code === 'unauthorized') this.access = undefined;
        throw err;
      });
  }

  /** Whether a GetToken error is a refusal of the user's token. */
  static refusal(err) {
    if (err?.code === 'refused') return true;
    if (err?.code !== 'unauthorized') return false;
    // A 401 or 403 is one only when the API itself answered it (empty body,
    // JSON or a Bearer challenge), never a page of a proxy in front of it.
    return Boolean(err.fromApi);
  }

  /** The metering points of the account: the list in memory, Discovery. */
  async listMeters(gen) {
    const body = await this.dataRequest(gen, routes.meteringPoints());
    if (this.gone(gen)) throw new EloverblikError('stopped');
    const list = parseMeteringPoints(body);
    if (!list) throw new EloverblikError('bad_response');
    this.meters = list.points.map((p) => ({
      id: p.id,
      key: keyOf(this.idKey, 'mp', p.id),
      suffix: p.id.slice(-4),
      supplier: p.supplier,
      startDate: p.startDate,
    }));
    this.listInfo = { others: list.others, dropped: list.dropped };
    this.listDate = localDate(this.now());
    await this.publishDiscovery(gen, { onlyChanged: true });
  }

  async round(gen) {
    if (this.gone(gen) || !this.session || this.isRefused()) return;
    const mono = this.monotonic();
    const now = this.now();
    if (this.pauseActive(mono)) {
      this.schedule(gen);
      return;
    }
    const due = this.nextDue(mono, now);
    if (due === undefined || due > mono) {
      this.schedule(gen);
      return;
    }
    const today = localDate(now);
    // The attempt is kept BEFORE anything: a restart never reads sooner.
    this.soon = false;
    this.lastRoundMono = mono;
    this.data.lastRound = now;
    if (this.data.roundsDate !== today) {
      this.data.roundsDate = today;
      this.data.rounds = 0;
    }
    this.data.rounds += 1;
    await this.save();
    if (this.gone(gen)) return;
    let ok = false;
    this.roundProblem = undefined;
    try {
      try {
        await this.ensureAccess(gen);
      } catch (err) {
        if (EloverblikApp.refusal(err)) {
          await this.refuse();
          return;
        }
        // A 401/403 page in front of GetToken: not a refusal, not a data route either.
        if (err?.code === 'unauthorized') err.code = 'token_unauthorized_page';
        throw err;
      }
      await this.listMeters(gen);
      await this.readSeries(gen, today);
      ok = true;
    } catch (err) {
      if (this.gone(gen)) return;
      const code = codeOf(err);
      if (PAUSING.has(code)) {
        // A read cut by the API (429, 5xx) is not one of the reads of the
        // day: it comes back at the end of the pause (the requests stay counted).
        if (this.data.roundsDate === today && this.data.rounds > 0) this.data.rounds -= 1;
        await this.setPause(err);
      } else if (code !== 'stopped' && code !== 'paused') {
        // A 401/403 of a data route: never a refusal; a new access token next time.
        this.roundProblem = code === 'unauthorized' ? 'data_unauthorized' : code;
        this.log.warn(`Read stopped (${this.roundProblem})`);
      }
    } finally {
      if (!this.gone(gen)) {
        if (ok) await this.clearPause();
        this.roundOk = ok;
        this.lastReadAt = this.now();
        // The gaps count from the END of a read: a slow read never shortens them.
        this.lastRoundMono = this.monotonic();
        this.data.lastRound = this.lastReadAt;
        await this.save();
        if (!this.gone(gen)) {
          this.schedule(gen);
          await this.report(gen);
        }
      }
    }
  }

  /**
   * The window of a metering point: from the day after its mark (a few days
   * re-read) to today, never before the day it was taken over by the user
   * (`consumerStartDate`) nor before a start that DataHub accepted for it.
   */
  windowOf(meter, today) {
    const last = this.data.published[meter.key];
    let start = last ? shiftDate(last, 1 - REREAD_DAYS) : shiftDate(today, -FIRST_DAYS);
    if (start < shiftDate(today, -BACKFILL_DAYS)) start = shiftDate(today, -BACKFILL_DAYS);
    if (meter.startDate && start < meter.startDate) start = meter.startDate;
    const floor = this.floors.get(meter.key);
    if (floor && start < floor) start = floor;
    return { start, end: today };
  }

  /**
   * One gettimeseries request. Asked as `Quarter`: any 400 of the request,
   * or a result error that is not one of a metering point, means DataHub
   * does not take that aggregation: asked again as `Hour`, kept for good.
   */
  async seriesRequest(gen, meters, from, today) {
    const ids = meters.map((m) => m.id);
    for (;;) {
      const quarter = this.aggregation !== 'Hour';
      let body;
      try {
        body = await this.dataRequest(gen, routes.timeSeries(ids, from, today, this.aggregation));
      } catch (err) {
        if (quarter && codeOf(err) === 'invalid') {
          this.aggregation = 'Hour';
          continue;
        }
        if (codeOf(err) === 'invalid') {
          const code = err.apiCode ? `invalid_${err.apiCode}` : 'invalid';
          for (const m of meters) this.problems.set(m.key, [code]);
        }
        throw err;
      }
      if (this.gone(gen)) throw new EloverblikError('stopped');
      const series = parseTimeSeries(body, ids);
      if (!series) throw new EloverblikError('bad_response');
      if (quarter && [...series.values()].some((r) => !pointError(r.problem))) {
        this.aggregation = 'Hour';
        continue;
      }
      return series;
    }
  }

  /**
   * The created metering points still missing a day: one request per
   * distinct start (a recent point is never asked from an older start than
   * its own), the answers in hand published first; then, for a point asked
   * before its registration (30018) or its authorization (30010), a search
   * of its first accepted day, alone, by halves, within a budget per read.
   */
  async readSeries(gen, today) {
    const created = new Set(this.createdKeys());
    const wanted = this.meters.filter((m) => created.has(m.key) && this.needs(m.key, today));
    for (const key of created) {
      if (!this.meters.some((m) => m.key === key)) this.problems.set(key, ['not_listed']);
      else if (!this.needs(key, today) && this.errorDays.get(key) !== today) {
        this.problems.delete(key);
      }
    }
    const windows = new Map(wanted.map((m) => [m.key, this.windowOf(m, today)]));
    const asked = wanted.filter((m) => windows.get(m.key).start < today);
    if (!asked.length) return;
    const groups = new Map();
    for (const m of asked) {
      const start = windows.get(m.key).start;
      groups.set(start, [...(groups.get(start) ?? []), m]);
    }
    // Each answer is published as it comes (a later error leaves it published).
    const later = [];
    for (const [start, meters] of [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (this.gone(gen)) throw new EloverblikError('stopped');
      const series = await this.seriesRequest(gen, meters, start, today);
      for (const meter of meters) {
        const result = series.get(meter.id);
        if (LATER_START.has(result?.problem)) later.push(meter);
        else await this.publishMeter(gen, meter, result, windows.get(meter.key), today);
      }
    }
    let budget = SEARCH_BUDGET;
    for (const meter of later) {
      if (this.gone(gen)) throw new EloverblikError('stopped');
      budget = await this.searchStart(gen, meter, windows.get(meter.key), today, budget);
    }
  }

  /**
   * The first day DataHub accepts for a metering point: between the start
   * refused and today, by halves, down to the day (no day lost). Once found,
   * its answer is published from that day, kept as the point's floor; a
   * search cut by the budget publishes nothing and goes on at the next read.
   * Returns the budget left.
   */
  async searchStart(gen, meter, window, today, budget) {
    const kept = this.searches.get(meter.key);
    let lo = kept && kept.lo > window.start ? kept.lo : window.start;
    let hi = kept?.hi;
    let best;
    let problem = 'E30018';
    while (budget > 0) {
      const mid = midDate(lo, hi ?? today);
      if (mid <= lo || mid >= (hi ?? today)) break;
      budget -= 1;
      let series;
      try {
        series = await this.seriesRequest(gen, [meter], mid, today);
      } catch (err) {
        this.searches.set(meter.key, { lo, hi });
        throw err;
      }
      const result = series.get(meter.id);
      if (LATER_START.has(result?.problem)) {
        lo = mid;
        problem = result.problem;
      } else {
        hi = mid;
        best = { result, window: { start: mid, end: today } };
      }
    }
    // A search taken up from a previous read: its accepted start asked again.
    if (!best && hi !== undefined && budget > 0) {
      budget -= 1;
      const series = await this.seriesRequest(gen, [meter], hi, today);
      const result = series.get(meter.id);
      if (LATER_START.has(result?.problem)) hi = undefined;
      else best = { result, window: { start: hi, end: today } };
    }
    const done = hi !== undefined && midDate(lo, hi) >= hi;
    if (done || (!best && budget > 0)) this.searches.delete(meter.key);
    else this.searches.set(meter.key, { lo, hi });
    if (best && done) {
      this.floors.set(meter.key, hi);
      await this.publishMeter(gen, meter, best.result, best.window, today);
    } else if (!best && hi === undefined && budget > 0) {
      // Refused up to yesterday: asked again tomorrow.
      await this.publishMeter(gen, meter, { slots: new Map(), problem }, window, today);
    } else {
      // Cut by the budget: nothing published from a start that may not be
      // the first one (a day would be lost); the search goes on next read.
      this.problems.set(meter.key, ['start_search']);
    }
    return budget;
  }

  /** The half hours of one metering point published; its mark moved over the complete days. */
  async publishMeter(gen, meter, result, window, today) {
    const problems = [];
    if (!result) problems.push('no_answer');
    else if (result.problem) problems.push(result.problem);
    const slots = result?.slots ?? new Map();
    const startMs = parseLocalDate(window.start);
    const endMs = parseLocalDate(window.end);
    const nowMs = this.now();
    // Only the window asked, only elapsed half hours.
    const intervals = [...slots.entries()]
      .filter(([at]) => at >= startMs && at < endMs && at + HALF_HOUR <= nowMs)
      .sort((a, b) => a[0] - b[0])
      .map(([at, kwh]) => ({ starts_at: new Date(at).toISOString(), kwh }));
    const feature = idsOf(this.gladys, meter.key).feature(FEATURE.CONSUMPTION);
    let published = true;
    for (let i = 0; i < intervals.length; i += MAX_INTERVALS_PER_CALL) {
      try {
        await this.gladys.publishEnergyConsumption(
          feature,
          intervals.slice(i, i + MAX_INTERVALS_PER_CALL),
        );
      } catch (err) {
        published = false;
        problems.push(err?.status === 404 ? 'not_created' : 'gladys');
        this.log.warn(
          `Metering point …${meter.suffix}: consumption not taken by Gladys (${err?.status ?? err?.name ?? 'Error'})`,
        );
        break;
      }
      if (this.gone(gen)) throw new EloverblikError('stopped');
    }
    // A metering point the API answered with an error: its days stay asked.
    if (published && result && !result.problem) {
      // The mark: the continuous run of complete days from the start of the
      // window; an incomplete day stops it (asked again: the data comes one or
      // two days late), unless it is HOLE_WAIT_DAYS old: then it is given up.
      let mark;
      for (let d = window.start; d < today; d = nextDate(d)) {
        const complete = slotsOfDay(d).every((at) => slots.has(at));
        if (!complete && d >= shiftDate(today, -HOLE_WAIT_DAYS)) break;
        mark = d;
      }
      const kept = this.data.published[meter.key];
      if (mark && (!kept || kept < mark)) {
        this.data.published[meter.key] = mark;
        await this.save();
      }
    }
    if (problems.length) {
      // A metering point the API answered in error, or without data: read
      // again tomorrow only (a failure of Gladys is retried at the next read).
      if (!result || result.problem) this.errorDays.set(meter.key, today);
      else this.errorDays.delete(meter.key);
      this.problems.set(meter.key, problems.slice(0, 3));
      if (result?.problem) this.log.warn(`Metering point …${meter.suffix}: ${result.problem}`);
    } else {
      this.errorDays.delete(meter.key);
      this.problems.delete(meter.key);
    }
  }

  async refuse() {
    const salt = this.random(16).toString('hex');
    this.refused = { salt, tag: tagOf(salt, this.token) };
    this.data.refused = this.refused;
    this.access = undefined;
    this.log.warn(
      'Eloverblik refused the token: no request until the token changes or Test succeeds',
    );
    this.clearRound();
    await this.save();
  }

  async setPause(err) {
    this.applyPause(err);
    await this.save();
  }

  /**
   * The pause, set at once (no await): a 429 / 5xx is applied by the session
   * before the next request of its queue leaves. Applied once per error.
   */
  applyPause(err) {
    if (err.pauseApplied) return;
    err.pauseApplied = true;
    const now = this.now();
    const mono = this.monotonic();
    const count = Math.min((this.pause?.code === err.code ? this.pause.count : 0) + 1, 16);
    const asked = finite(err.retryAfter) && err.retryAfter > 0 ? err.retryAfter : 0;
    const ms = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, asked, PAUSE_BASE * 2 ** (count - 1)));
    const detail = err.status ? `HTTP ${err.status}` : null;
    this.pause = { until: now + ms, due: mono + ms, count, code: err.code, detail };
    this.data.pause = { until: now + ms, count, code: err.code, detail };
    this.log.warn(`Eloverblik paused until ${dayClock(now + ms)} (${detail ?? err.code})`);
  }

  /** A read answered: the pause is over and its count forgotten. */
  async clearPause() {
    if (!this.pause && !this.data.pause) return;
    this.pause = undefined;
    this.data.pause = null;
    await this.save();
  }

  // --- Gladys --------------------------------------------------------------------------

  /**
   * The devices the user created. Not read (an error, a timeout): tried again
   * 30 s later, doubled up to 5 minutes, for ever; the status says so
   * meanwhile.
   */
  async refreshCreated(gen) {
    let devices;
    try {
      devices = await this.bounded(Promise.resolve(this.gladys.getDevices()), 10_000);
    } catch (err) {
      this.log.warn(`Devices not read from Gladys (${err?.name ?? 'Error'})`);
    }
    if (this.gone(gen)) return false;
    if (devices === TIMED_OUT || !Array.isArray(devices)) {
      this.devicesUnread = true;
      if (this.devicesTimer) this.timers.clearTimeout(this.devicesTimer);
      this.devicesDelay = Math.min(5 * MINUTE, Math.max(30 * 1000, this.devicesDelay * 2));
      this.devicesTimer = this.timers.setTimeout(() => {
        this.devicesTimer = null;
        if (this.gone(gen) || !this.devicesUnread) return;
        this.refreshCreated(gen)
          .then((ok) => {
            if (!ok || this.gone(gen)) return undefined;
            this.soon = true;
            this.schedule(gen);
            return this.report(gen);
          })
          .catch(() => {});
      }, this.devicesDelay);
      return false;
    }
    this.devicesUnread = false;
    this.devicesDelay = 0;
    this.created = new Set();
    this.createdDevices = new Map();
    for (const d of devices) this.addCreated(d);
    return true;
  }

  addCreated(device) {
    const parsed = parseDeviceId(device?.external_id);
    if (!parsed || parsed.feature) return;
    this.createdDevices.set(device.external_id, device);
    this.created.add(device.external_id);
    for (const f of device.features ?? []) if (f?.external_id) this.created.add(f.external_id);
  }

  async onDeviceCreated(device) {
    const id = parseDeviceId(device?.external_id);
    if (!id || id.feature) return;
    const known = (device.features ?? []).every((f) => this.created.has(f?.external_id));
    this.addCreated(device);
    const gen = this.gen;
    // A new metering point to fill: read soon (a minute after the last read at the earliest).
    if (!known) this.soon = true;
    if (!this.gone(gen) && (this.roundTimer || this.dueMono !== undefined)) this.schedule(gen);
    await this.report(gen);
  }

  onDeviceDeleted(device) {
    const id = parseDeviceId(device?.external_id);
    if (!id || id.feature) return;
    for (const f of device.features ?? []) this.created.delete(f?.external_id);
    this.created.delete(device.external_id);
    this.createdDevices.delete(device.external_id);
    this.problems.delete(id.key);
  }

  /** The devices offered in Discovery: the metering points listed. Never a request. */
  async publishDiscovery(gen, { onlyChanged = false } = {}) {
    if (!this.meters.length && !this.lastDiscovery) return;
    const devices = this.meters.map((m) => buildMeterDevice(this.gladys, m));
    const text = JSON.stringify(devices);
    if (onlyChanged && text === this.lastDiscovery) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      if (!this.gone(gen)) this.lastDiscovery = text;
    } catch (err) {
      this.log.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  async scan() {
    await this.publishDiscovery(this.gen);
  }

  // --- Status ------------------------------------------------------------------------

  async report(gen = this.gen) {
    if (this.gone(gen)) return;
    const [connected, message] = this.statusNow();
    if (this.storeState !== 'ok' && this.storeState !== 'pending') {
      for (const lang of ['en', 'fr']) message[lang] += t('storage', lang);
    }
    for (const lang of ['en', 'fr']) message[lang] = bound(message[lang].trim(), MAX_STATUS);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    await this.setStatus(connected, message, key);
  }

  async setStatus(connected, message, key = JSON.stringify([connected, message])) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.log.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  nextTime() {
    const wait = Math.max(0, (this.dueMono ?? this.monotonic()) - this.monotonic());
    // Rounded up: never a time before the read.
    return dayClock(this.now() + wait + 999);
  }

  /** The suffix of a created device (its params), for a status line. */
  suffixOf(key) {
    const meter = this.meters.find((m) => m.key === key);
    if (meter) return meter.suffix;
    const device = this.createdDevices.get(idsOf(this.gladys, key).device);
    const param = device?.params?.find?.((p) => p?.name === 'metering_point_suffix')?.value;
    return typeof param === 'string' && /^\d{4}$/.test(param) ? param : '????';
  }

  statusNow() {
    if (this.config.problem) return [false, both(this.config.problem)];
    if (!this.idKey) {
      const mono = this.monotonic();
      const wait = Math.max(0, (this.idKeyDue ?? mono) - mono);
      return [false, both('idKeyNotStored', { time: dayClock(this.now() + wait + 999) })];
    }
    if (this.isRefused()) return [false, both('refused')];
    if (this.pauseActive()) {
      return [
        false,
        both(this.pause.code === 'rate_limited' ? 'rateLimited' : 'server', {
          time: dayClock(this.pause.until),
          code: this.pause.detail ?? this.pause.code,
        }),
      ];
    }
    const created = this.createdKeys();
    const message =
      this.lastReadAt === undefined
        ? both('starting', { time: this.nextTime() })
        : both(this.roundOk ? 'connected' : 'failing', {
            count: this.meters.length,
            time: dayClock(this.lastReadAt),
            next: this.nextTime(),
          });
    const add = (key, values) => {
      for (const lang of ['en', 'fr']) message[lang] += t(key, lang, values);
    };
    if (this.roundProblem) add('readProblem', { code: this.roundProblem });
    // The end of the token first: the status is bounded, the meters come after.
    const expiry = tokenExpiry(this.config.token);
    if (expiry !== undefined) add('tokenUntil', { date: dmy(localDate(expiry)) });
    if (this.listDate !== undefined && !this.meters.length) add('noMeteringPoint');
    if (this.listInfo.dropped) add('tooManyMeteringPoints', { count: this.listInfo.dropped });
    if (this.meters.length && !created.length) add('createDevices');
    for (const key of created) {
      const problems = this.problems.get(key);
      const last = this.data.published[key];
      add(problems?.length ? 'meterProblems' : 'meterUpTo', {
        suffix: this.suffixOf(key),
        codes: problems?.join(', ') ?? '',
        date: last ? dmy(last) : '-',
      });
    }
    if (this.devicesUnread) add('devicesUnread');
    return [
      this.lastReadAt === undefined || this.devicesUnread ? false : Boolean(this.roundOk),
      message,
    ];
  }

  // --- Test button ------------------------------------------------------------------------

  /** A data access token and the list of the metering points: lifts a refusal on success. */
  async testConnection() {
    if (this.config.problem) return both(this.config.problem);
    if (!this.idKey || !this.session) return both('testNotReady');
    const mono = this.monotonic();
    if (this.lastTest !== undefined && mono - this.lastTest < TEST_MIN_GAP) {
      return both('testTooSoon');
    }
    if (this.pauseActive(mono)) return both('testPaused', { time: dayClock(this.pause.until) });
    // A refused token is never reused: a new GetToken is needed.
    if (this.isRefused()) this.access = undefined;
    if (!this.accessValid(mono)) {
      const due = this.tokenDue(mono, this.now());
      if (due > mono) {
        return both('testTokenWait', { time: dayClock(this.now() + (due - mono) + 999) });
      }
    }
    const gen = this.gen;
    this.lastTest = mono;
    try {
      try {
        await this.ensureAccess(gen);
      } catch (err) {
        if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
        if (EloverblikApp.refusal(err)) {
          await this.refuse();
          await this.report(gen);
          return both('testRefused');
        }
        throw err;
      }
      await this.listMeters(gen);
    } catch (err) {
      if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
      const code = codeOf(err);
      if (PAUSING.has(code)) {
        await this.setPause(err);
        await this.report(gen);
        return both('testPaused', { time: dayClock(this.pause.until) });
      }
      if (code === 'paused') return both('testPaused', { time: dayClock(this.pause.until) });
      if (code === 'token_wait') return both('testFailed', { code });
      return both('testFailed', { code: code === 'unauthorized' ? 'data_unauthorized' : code });
    }
    if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
    // Accepted: the refusal and the pause are over; a read soon.
    if (this.refused) {
      this.refused = undefined;
      this.data.refused = null;
    }
    await this.clearPause();
    await this.save();
    this.soon = true;
    if (!this.gone(gen)) this.schedule(gen);
    await this.report(gen);
    const list = this.meters
      .map((m) => (m.supplier ? `…${m.suffix} (${m.supplier})` : `…${m.suffix}`))
      .join(', ');
    return both(this.meters.length ? 'testOk' : 'testNoPoint', {
      count: this.meters.length,
      list,
    });
  }
}
