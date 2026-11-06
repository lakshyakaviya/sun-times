/**
 * Persistence: the pinned places, the last place seen, and the URL mirror.
 *
 * Three jobs that look different and are really one — each takes a place from
 * somewhere outside the running page and has to decide whether to trust it:
 *
 *   localStorage   written by an older version of this app, or by anything
 *                  else on the origin, or corrupted half-way through a write
 *   the URL        typed, truncated by a chat client, or handed over by
 *                  someone else entirely
 *
 * So nothing here believes what it is given. Every value goes through
 * `normalisePlace`, which returns `null` rather than a half-built place, and
 * every storage call is wrapped — a browser with site data blocked throws on
 * the property access itself, not merely on write.
 */

import { isValidTimeZone, viewerTimeZone } from './time.js';
import { civilDateFromISO, toISODate } from './sun.js';

export const SAVED_KEY = 'sun-times:saved';
export const LAST_KEY = 'sun-times:last';

/**
 * How many places can be pinned. The chips are one wrapping row, and a cap
 * also bounds what a damaged store can make the page render.
 */
export const MAX_SAVED = 12;

const MAX_NAME = 80;
const MAX_REGION = 120;

/** Coordinates in the URL: 4 decimals is ~11 m, and keeps a link short. */
const URL_PRECISION = 4;

/** Identity precision: ~100 m, so a re-click near a pin is the same pin. */
const IDENTITY_PRECISION = 3;

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * A coordinate out of whatever was handed over, or `NaN`.
 *
 * `Number` cannot be used on its own here. `Number(null)`, `Number('')` and
 * `Number(' ')` are all **0**, and 0 is a perfectly good latitude — so a link
 * with no coordinates at all, or a storage row missing them, would come out
 * as a real place in the Gulf of Guinea. Absence has to be rejected before
 * the conversion, not after it.
 */
function coordinate(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  return Number(value);
}

/**
 * An untrusted place into one the app can use, or `null`.
 *
 * Accepts numbers or strings for the coordinates, because the same function
 * guards both the URL (always strings) and localStorage (usually numbers).
 *
 * @param {unknown} raw
 * @returns {{name:string, region:string, lat:number, lon:number,
 *            timeZone:string, zoneIsGuess:boolean, source:string}|null}
 */
export function normalisePlace(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const lat = coordinate(raw.lat);
  const lon = coordinate(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const text = (value, limit) =>
    typeof value === 'string' ? value.trim().slice(0, limit) : '';

  // Two ways a zone fails to be usable, and they are different: a name this
  // browser's database does not know, and a place whose zone was never
  // established in the first place (`zoneIsGuess`). Either way the times are
  // on the viewer's clock, and the UI has to say so — so the flag survives
  // the round trip rather than being quietly cleared.
  const named = isValidTimeZone(raw.timeZone);
  const trusted = named && raw.zoneIsGuess !== true;

  return {
    name: text(raw.name, MAX_NAME),
    region: text(raw.region, MAX_REGION),
    lat,
    lon,
    timeZone: trusted ? raw.timeZone : viewerTimeZone(),
    zoneIsGuess: !trusted,
    source: 'saved',
  };
}

/** Just the fields worth storing — no feature codes, no populations. */
function toStored({ name, region, lat, lon, timeZone, zoneIsGuess }) {
  return { name, region, lat, lon, timeZone, zoneIsGuess };
}

const atPrecision = (value, digits) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/**
 * Whether two places are the same spot, to within about 100 m.
 *
 * Exact comparison would not do: a place that has been through the URL has
 * had its coordinates rounded, and clicking the map twice in the same spot
 * never lands on identical floats.
 */
export function samePlace(a, b) {
  if (!a || !b) return false;
  return (
    atPrecision(a.lat, IDENTITY_PRECISION) === atPrecision(b.lat, IDENTITY_PRECISION) &&
    atPrecision(a.lon, IDENTITY_PRECISION) === atPrecision(b.lon, IDENTITY_PRECISION)
  );
}

/* ------------------------------------------------------------------ *
 * The pinned list — pure operations on a list
 * ------------------------------------------------------------------ */

/**
 * `place` added to `places`, or the list unchanged with a reason why not.
 *
 * @returns {{places: Array<object>, added: boolean, reason: ''|'invalid'|'duplicate'|'full'}}
 */
export function addSavedPlace(places, place, limit = MAX_SAVED) {
  const normalised = normalisePlace(place);
  if (!normalised) return { places, added: false, reason: 'invalid' };
  if (places.some((entry) => samePlace(entry, normalised))) {
    return { places, added: false, reason: 'duplicate' };
  }
  if (places.length >= limit) return { places, added: false, reason: 'full' };
  return { places: [...places, normalised], added: true, reason: '' };
}

/** `places` without the entry at the same spot as `place`. */
export function removeSavedPlace(places, place) {
  return places.filter((entry) => !samePlace(entry, place));
}

/* ------------------------------------------------------------------ *
 * localStorage
 * ------------------------------------------------------------------ */

/**
 * A storage that can actually be used, or `null`.
 *
 * Both halves of this matter. Reading `localStorage` throws outright in a
 * Chrome window with site data blocked, so even getting hold of it needs a
 * guard. And a storage that hands itself over may still refuse to write — a
 * Safari private window has a zero quota. One probe settles both questions at
 * the only moment it is cheap to ask.
 *
 * @param {object} [candidate] a stand-in, for tests
 */
export function detectStorage(candidate) {
  let store = candidate;
  if (store === undefined) {
    try {
      store = globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }
  if (!store) return null;

  try {
    const probe = 'sun-times:probe';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

function readJson(storage, key) {
  if (!storage) return null;
  try {
    const text = storage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    // Not JSON, or not ours. Indistinguishable from absent, and treated the
    // same — the alternative is an app that will not start because of a
    // stray key.
    return null;
  }
}

function writeJson(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * The pinned places. Always an array; a row too broken to use is dropped and
 * the rest are kept, because losing one pin beats losing all of them.
 */
export function readSavedPlaces(storage, limit = MAX_SAVED) {
  const raw = readJson(storage, SAVED_KEY);
  if (!Array.isArray(raw)) return [];

  const places = [];
  for (const entry of raw) {
    const place = normalisePlace(entry);
    if (!place) continue;
    if (places.some((kept) => samePlace(kept, place))) continue;
    places.push(place);
    if (places.length >= limit) break;
  }
  return places;
}

/** @returns {boolean} whether it was actually stored. */
export function writeSavedPlaces(storage, places) {
  return writeJson(storage, SAVED_KEY, places.map(toStored));
}

/** The place last looked at, or `null`. */
export function readLastPlace(storage) {
  return normalisePlace(readJson(storage, LAST_KEY));
}

export function writeLastPlace(storage, place) {
  if (!place) return false;
  return writeJson(storage, LAST_KEY, toStored(place));
}

/* ------------------------------------------------------------------ *
 * The URL
 * ------------------------------------------------------------------ */

/**
 * A place and a date out of a query string. Either may be `null`.
 *
 * `lat` and `lon` together are what make a link mean anything; one without
 * the other is not a location and is ignored.
 *
 * @param {string} search e.g. `'?lat=35.6895&lon=139.6917&tz=Asia/Tokyo'`
 */
export function parseUrlState(search) {
  let params;
  try {
    params = new URLSearchParams(search ?? '');
  } catch {
    return { place: null, date: null };
  }

  const place = normalisePlace({
    lat: params.get('lat'),
    lon: params.get('lon'),
    name: params.get('name'),
    region: params.get('region'),
    timeZone: params.get('tz'),
  });

  let date = null;
  const iso = params.get('date');
  if (iso) {
    try {
      date = civilDateFromISO(iso);
    } catch {
      // A nonsense date falls back to today rather than blanking the page.
    }
  }

  return { place, date };
}

/**
 * The query string for a view, including the leading `?`, or `''`.
 *
 * The date is left out when it is only ever "today" — a link shared without
 * one shows the recipient *their* today, which is almost always what sharing
 * a place is for.
 *
 * @param {{place: object|null, date: object|null}} view
 */
export function buildUrlQuery({ place, date } = {}) {
  const params = new URLSearchParams();

  if (place) {
    params.set('lat', String(atPrecision(place.lat, URL_PRECISION)));
    params.set('lon', String(atPrecision(place.lon, URL_PRECISION)));
    if (place.name) params.set('name', place.name);
    if (place.region) params.set('region', place.region);
    // A zone that was never established is not worth passing on; the reader
    // at the other end would be told times are in a zone nobody checked.
    if (!place.zoneIsGuess) params.set('tz', place.timeZone);
  }

  if (date) params.set('date', toISODate(date));

  const query = params.toString();
  return query ? `?${query}` : '';
}
