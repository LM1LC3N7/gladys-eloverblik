// -----------------------------------------------------------------------------
// Constants of the Eloverblik integration: the official customer API, the
// pace, the published limits, the bounds and the manifest keys (forever:
// stored in user configs and devices).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The official customer API of Eloverblik (Energinet DataHub), Swagger V1.0. */
export const API_URL = 'https://api.eloverblik.dk/customerapi';
// The version follows the release (package.json is in the image).
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const USER_AGENT = `gladys-eloverblik/${VERSION} (+https://github.com/LM1LC3N7/gladys-eloverblik)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const HALF_HOUR = 30 * MINUTE;

export const TIME_ZONE = 'Europe/Copenhagen';

// --- Requests -----------------------------------------------------------------

/** One request never takes longer (DataHub can be slow). */
export const REQUEST_TIMEOUT = 60 * SECOND;
/** A larger answer is cut before it is read whole (10 points x 92 days of hours is ~2.5 MB). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Two requests of the integration are always this far apart (one in flight at a time). */
export const REQUEST_GAP = 2 * SECOND;

// --- Pace and published limits ---------------------------------------------------

/**
 * The data of a day reaches Eloverblik one or two days later: the daily read
 * starts at ROUND_HOUR (local time of Denmark) plus a minute of the hour
 * proper to the installation (spread over ROUND_SPREAD_MINUTES), and asks only
 * for the days not yet complete.
 */
export const ROUND_HOUR = 9;
export const ROUND_SPREAD_MINUTES = 180;
/** While yesterday is incomplete: again RETRY_GAP later, at most ROUNDS_PER_DAY reads a day. */
export const RETRY_GAP = 4 * HOUR;
export const ROUNDS_PER_DAY = 4;
/** Two reads are never closer than this (a restart, a saved config included). */
export const MIN_ROUND_GAP = HOUR;
/** A new device or a changed configuration is read sooner, never sooner than this. */
export const SOON_GAP = MINUTE;
/**
 * Hard ceiling of requests per local day of Denmark, every route included,
 * counted in /data before each request (the API allows 120 a minute per IP).
 */
export const MAX_REQUESTS_PER_DAY = 30;
/**
 * The data access token: GetToken is limited to 2 calls a minute per IP, and
 * the token lasts 24 h ("should not need to be refreshed more than once a
 * day"). Kept in memory only, renewed after ACCESS_TOKEN_LIFE; two GetToken
 * are never closer than TOKEN_GAP, a restart included (time kept in /data).
 */
export const ACCESS_TOKEN_LIFE = 20 * HOUR;
export const TOKEN_GAP = 5 * MINUTE;
/** A 429 without Retry-After, or a 5xx / 503 "DataHub unavailable": 15 min doubled up to 6 h. */
export const PAUSE_BASE = 15 * MINUTE;
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The test button answers at most once a minute with new requests. */
export const TEST_MIN_GAP = MINUTE;
/** The config is read again after a failure: 5 s doubled up to 5 minutes, for ever. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** /data: waited at most STORE_WAIT; an unreadable one is read again every STORE_RETRY. */
export const STORE_WAIT = 3 * SECOND;
export const STORE_RETRY = 10 * SECOND;
/** A wait longer than this is cut in pieces: a wall clock set forward is seen within it. */
export const MAX_TIMER = HOUR;

// --- History ----------------------------------------------------------------------

/** A metering point never published yet: this many days back. */
export const FIRST_DAYS = 31;
/** After a stop, caught up this many days back at most (the API takes 730). */
export const BACKFILL_DAYS = 92;
/** The last days complete are read again (an estimate replaced by a measure). */
export const REREAD_DAYS = 3;
/** An incomplete day is asked again; incomplete this many days back, it is given up. */
export const HOLE_WAIT_DAYS = 10;
/** The core takes at most 2,000 intervals per publishEnergyConsumption. */
export const MAX_INTERVALS_PER_CALL = 2000;

// --- Bounds -----------------------------------------------------------------------

/** At most this many metering points (the API advises bundles of 10). */
export const MAX_METERING_POINTS = 10;
/** A half hour beyond this (kWh) is not a reading. */
export const MAX_HALF_HOUR_KWH = 10_000;
/** At most this many points are taken from one answer. */
export const MAX_POINTS = 200_000;
export const MAX_STATUS = 500;

// --- Manifest keys (forever) -------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection' };
