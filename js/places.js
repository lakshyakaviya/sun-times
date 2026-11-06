/**
 * Finding places: city search, the browser's own location, and the time zone
 * that belongs to a pair of coordinates.
 *
 * Two keyless, CORS-open endpoints from Open-Meteo. Neither needs an account,
 * which is what makes this deployable as a static page.
 *
 * Fetching and parsing are kept apart on purpose: every network call is a thin
 * wrapper around a pure parser, and the parsers are what the tests exercise
 * against recorded payloads. Network code that can only be tested live is
 * network code that does not get tested.
 */

import { isValidTimeZone, viewerTimeZone } from './time.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const REVERSE_GEOCODE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

/** Shorter than this and the search is all noise. */
export const MIN_QUERY_LENGTH = 2;

/**
 * A failure with a `kind` the UI can branch on and a `message` it can show
 * as-is. Every message is written for someone who does not know or care that
 * an API exists.
 */
export class PlacesError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'PlacesError';
    this.kind = kind;
  }
}

/* ------------------------------------------------------------------ *
 * Parsing — pure, and where the tests live
 * ------------------------------------------------------------------ */

/**
 * A region line, with the blanks and the echoes taken out.
 *
 * "Singapore, Singapore" tells the reader nothing the name did not, and
 * neither does a subdivision that repeats the city. An empty result is fine —
 * a city-state needs no region.
 */
function buildRegion(name, ...parts) {
  const seen = new Set([name.trim().toLowerCase()]);
  const kept = [];

  for (const part of parts) {
    const value = typeof part === 'string' ? part.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(value);
  }

  return kept.join(', ');
}

/**
 * One geocoding hit into the shape the app passes around.
 * Returns `null` for an entry too broken to use, so one bad row in an
 * otherwise good response does not throw the whole list away.
 */
function toPlace(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.name !== 'string' || !entry.name.trim()) return null;

  const lat = Number(entry.latitude);
  const lon = Number(entry.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  // Country-level entries (searching "Singapore") carry no admin1 at all.
  const name = entry.name.trim();
  const region = buildRegion(name, entry.admin1, entry.country);

  // An unrecognised zone name is treated as no zone: the sun math falls back
  // to anchoring on longitude and the UI says times are in the viewer's zone,
  // rather than silently labelling them with the wrong one.
  const zone = isValidTimeZone(entry.timezone) ? entry.timezone : null;

  return {
    name,
    region,
    lat,
    lon,
    timeZone: zone ?? viewerTimeZone(),
    zoneIsGuess: zone === null,
    featureCode: typeof entry.feature_code === 'string' ? entry.feature_code : '',
    population: Number.isFinite(entry.population) ? entry.population : 0,
    source: 'search',
  };
}

/** Of two entries that would show the same label, which to keep. */
function preferredOf(a, b) {
  // A populated place beats an administrative division: searching "Singapore"
  // returns both the city (PPLC) and the country (PCLI), which render
  // identically, and the city is what was meant.
  const aIsSettlement = a.featureCode.startsWith('PPL');
  const bIsSettlement = b.featureCode.startsWith('PPL');
  if (aIsSettlement !== bIsSettlement) return aIsSettlement ? a : b;
  return b.population > a.population ? b : a;
}

/**
 * A geocoding response into a list of places.
 *
 * @param {unknown} payload the parsed JSON body
 * @returns {Array<object>} possibly empty; an empty list is a valid answer
 */
export function parseSearchResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new PlacesError('malformed', 'The place search sent something unreadable.');
  }

  // A query with no matches omits `results` entirely rather than sending an
  // empty array, so this cannot assume the key exists.
  const entries = Array.isArray(payload.results) ? payload.results : [];

  const places = [];
  const indexByLabel = new Map();

  for (const entry of entries) {
    const place = toPlace(entry);
    if (!place) continue;

    const label = `${place.name}|${place.region}`;
    if (indexByLabel.has(label)) {
      const at = indexByLabel.get(label);
      places[at] = preferredOf(places[at], place);
      continue;
    }
    indexByLabel.set(label, places.length);
    places.push(place);
  }

  return places;
}

/**
 * The IANA zone out of a forecast response.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function parseTimeZoneResponse(payload) {
  const zone = payload && typeof payload === 'object' ? payload.timezone : null;
  if (typeof zone === 'string' && isValidTimeZone(zone)) return zone;
  throw new PlacesError('malformed', 'The time zone lookup sent something unexpected.');
}

/**
 * A reverse-geocoding response into a name and a region, either of which may
 * be empty — the caller decides what to show instead.
 *
 * Absent values arrive as empty strings rather than null or a missing key, so
 * everything here has to test for content, not presence. `city` is empty well
 * away from towns, but `locality` often still carries something useful: a
 * point in the middle of the Pacific comes back as "Tuamotus".
 *
 * @param {unknown} payload
 * @returns {{name: string, region: string}}
 */
export function parseReverseGeocodeResponse(payload) {
  if (!payload || typeof payload !== 'object') return { name: '', region: '' };

  const filled = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

  const name = filled(payload.city) || filled(payload.locality);
  return {
    name,
    region: buildRegion(name, payload.principalSubdivision, payload.countryName),
  };
}

/** A geolocation PositionError into one of ours. */
export function fromGeolocationError(error) {
  switch (error?.code) {
    case 1:
      return new PlacesError(
        'geolocation-denied',
        'Location permission was declined. Search for a city instead.'
      );
    case 2:
      return new PlacesError(
        'geolocation-unavailable',
        'Your device could not work out where it is. Search for a city instead.'
      );
    case 3:
      return new PlacesError(
        'geolocation-timeout',
        'Finding your location took too long. Try again, or search for a city.'
      );
    default:
      return new PlacesError(
        'geolocation-failed',
        'Could not get your location. Search for a city instead.'
      );
  }
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

async function fetchJson(url, { signal } = {}) {
  let response;
  try {
    // Deliberately no headers. Any custom header would make this a
    // non-simple request, and the browser would send a CORS preflight —
    // which the geocoding host answers with 404.
    response = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new PlacesError(
      'offline',
      'Could not reach the place service. Check your connection and try again.'
    );
  }

  if (!response.ok) {
    throw new PlacesError(
      'http',
      `The place service is not answering right now (${response.status}). Try again shortly.`
    );
  }

  try {
    return await response.json();
  } catch {
    throw new PlacesError('malformed', 'The place service sent something unreadable.');
  }
}

/**
 * Cities matching a query, most prominent first.
 *
 * @param {string} query
 * @param {{signal?: AbortSignal, count?: number}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function searchPlaces(query, { signal, count = 8 } = {}) {
  const trimmed = String(query ?? '').trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];

  const url =
    `${GEOCODE_URL}?name=${encodeURIComponent(trimmed)}` +
    `&count=${count}&language=en&format=json`;

  return parseSearchResponse(await fetchJson(url, { signal }));
}

/**
 * The time zone at a pair of coordinates.
 *
 * Geolocation and map clicks give coordinates with no zone attached, and the
 * app promises times in the *place's* local clock — so this has to be asked
 * for. If the lookup fails the viewer's own zone stands in, flagged, so the UI
 * can say so instead of mislabelling the result.
 *
 * @returns {Promise<{timeZone: string, guessed: boolean}>}
 */
export async function resolveTimeZone(lat, lon, { signal } = {}) {
  const url =
    `${FORECAST_URL}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&timezone=auto&current=temperature_2m`;

  try {
    const payload = await fetchJson(url, { signal });
    return { timeZone: parseTimeZoneResponse(payload), guessed: false };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { timeZone: viewerTimeZone(), guessed: true };
  }
}

/**
 * What a pair of coordinates is called.
 *
 * Never throws for a failed lookup: an empty name is a perfectly good answer
 * (the caller falls back to the coordinates themselves), and a name is a
 * nicety rather than something the app depends on. Only an abort propagates.
 *
 * @returns {Promise<{name: string, region: string}>}
 */
export async function describePlace(lat, lon, { signal } = {}) {
  const url =
    `${REVERSE_GEOCODE_URL}?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}` +
    `&localityLanguage=en`;

  try {
    return parseReverseGeocodeResponse(await fetchJson(url, { signal }));
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { name: '', region: '' };
  }
}

/**
 * Where the browser thinks you are.
 *
 * @param {{timeout?: number}} [options]
 * @returns {Promise<{lat:number, lon:number, accuracy:number}>}
 */
export function locate({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new PlacesError(
        'geolocation-unsupported',
        'This browser cannot report your location. Search for a city instead.'
      ));
      return;
    }

    // The geolocation API is refused outright on plain http. Localhost counts
    // as secure, and GitHub Pages is https, so this only bites on an
    // http-served copy.
    if (globalThis.isSecureContext === false) {
      reject(new PlacesError(
        'insecure-context',
        'Location needs a secure (https) connection. Search for a city instead.'
      ));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy,
      }),
      (error) => reject(fromGeolocationError(error)),
      // High accuracy would wake the GPS for no benefit: a few hundred metres
      // moves sunrise by well under a second.
      { enableHighAccuracy: false, timeout, maximumAge: 300000 }
    );
  });
}
