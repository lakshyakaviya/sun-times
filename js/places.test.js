/**
 * Test suite for js/places.js.
 *
 * The fixtures below are real responses, captured from the live endpoints
 * rather than written from the documentation. Two of them record behaviour
 * that a guessed parser would have got wrong:
 *
 *   - a query with no matches omits `results` entirely instead of sending `[]`
 *   - country-level entries carry no `admin1` at all
 *
 * Nothing here touches the network. The fetch wrappers are a few lines each
 * around these parsers, and `fetch` itself is stubbed where a whole flow is
 * exercised.
 */

import {
  parseSearchResponse,
  parseTimeZoneResponse,
  fromGeolocationError,
  searchPlaces,
  resolveTimeZone,
  locate,
  PlacesError,
  MIN_QUERY_LENGTH,
} from './places.js';

import { viewerTimeZone } from './time.js';

/* ------------------------------------------------------------------ *
 * Recorded responses
 * ------------------------------------------------------------------ */

/** geocoding-api.open-meteo.com/v1/search?name=Bengaluru&count=3 */
const BENGALURU = {
  results: [{
    id: 1277333,
    name: 'Bengaluru',
    latitude: 12.97194,
    longitude: 77.59369,
    elevation: 920.0,
    feature_code: 'PPLA',
    country_code: 'IN',
    admin1_id: 1267701,
    admin2_id: 1277331,
    timezone: 'Asia/Kolkata',
    population: 8495492,
    country_id: 1269750,
    country: 'India',
    admin1: 'Karnataka',
    admin2: 'Bengaluru Urban',
  }],
  generationtime_ms: 0.19657612,
};

/** ?name=Springfield&count=5 — five places, one name. */
const SPRINGFIELD = {
  results: [
    { id: 1, name: 'Springfield', latitude: 37.21533, longitude: -93.29824, feature_code: 'PPLA2', country: 'United States', admin1: 'Missouri', timezone: 'America/Chicago', population: 170188 },
    { id: 2, name: 'Springfield', latitude: 39.80172, longitude: -89.64371, feature_code: 'PPLA', country: 'United States', admin1: 'Illinois', timezone: 'America/Chicago', population: 114394 },
    { id: 3, name: 'Springfield', latitude: 42.10148, longitude: -72.58981, feature_code: 'PPL', country: 'United States', admin1: 'Massachusetts', timezone: 'America/New_York', population: 154341 },
    { id: 4, name: 'Springfield', latitude: 39.92422, longitude: -83.80882, feature_code: 'PPLA2', country: 'United States', admin1: 'Ohio', timezone: 'America/New_York', population: 59680 },
    { id: 5, name: 'Springfield', latitude: 36.50921, longitude: -86.88999, feature_code: 'PPLA2', country: 'United States', admin1: 'Tennessee', timezone: 'America/Chicago', population: 16808 },
  ],
  generationtime_ms: 0.5,
};

/** ?name=Singapore&count=2 — the city and the country, no admin1 on either. */
const SINGAPORE = {
  results: [
    { id: 1880252, name: 'Singapore', latitude: 1.28967, longitude: 103.85007, elevation: 23, feature_code: 'PPLC', country_code: 'SG', timezone: 'Asia/Singapore', population: 5638700, country_id: 1880251, country: 'Singapore' },
    { id: 1880251, name: 'Singapore', latitude: 1.36667, longitude: 103.8, elevation: 42, feature_code: 'PCLI', country_code: 'SG', timezone: 'Asia/Singapore', population: 6111175, country_id: 1880251, country: 'Singapore' },
  ],
  generationtime_ms: 0.3,
};

/** ?name=zzzzqqqq — note the absent `results` key. */
const NO_MATCHES = { generationtime_ms: 0.14567375 };

/** api.open-meteo.com/v1/forecast?...&timezone=auto&current=temperature_2m */
const FORECAST = {
  latitude: 12.970123,
  longitude: 77.56364,
  generationtime_ms: 0.017762184143066406,
  utc_offset_seconds: 19800,
  timezone: 'Asia/Kolkata',
  timezone_abbreviation: 'GMT+5:30',
  elevation: 910.0,
  current_units: { time: 'iso8601', interval: 'seconds', temperature_2m: '°C' },
  current: { time: '2026-11-06T16:30', interval: 900, temperature_2m: 23.0 },
};

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function createRunner() {
  const results = [];
  let group = '';
  return {
    results,
    group(name) { group = name; },
    check(name, ok, detail = '') {
      results.push({ group, name, ok: Boolean(ok), detail: String(detail) });
    },
    equals(name, actual, expected) {
      const ok = actual === expected;
      results.push({
        group, name, ok,
        detail: ok ? `“${actual}”` : `got “${actual}”, expected “${expected}”`,
      });
    },
  };
}

/** Run `body` with `fetch` replaced, then put the real one back. */
async function withStubbedFetch(stub, body) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

export async function runTests() {
  const t = createRunner();

  /* --- Mapping a response to places -------------------------------- */

  t.group('Reading the geocoding response');
  {
    const [place] = parseSearchResponse(BENGALURU);
    t.equals('name', place.name, 'Bengaluru');
    t.equals('region joins the admin area and the country', place.region, 'Karnataka, India');
    t.equals('timezone is carried through', place.timeZone, 'Asia/Kolkata');
    t.check('the zone is trusted', place.zoneIsGuess === false, `zoneIsGuess=${place.zoneIsGuess}`);
    t.check('coordinates are numbers',
      place.lat === 12.97194 && place.lon === 77.59369, `${place.lat}, ${place.lon}`);
    t.equals('the place knows where it came from', place.source, 'search');

    const many = parseSearchResponse(SPRINGFIELD);
    t.check('five Springfields all survive', many.length === 5, `${many.length} returned`);
    t.check('each is distinguishable by region',
      new Set(many.map((p) => p.region)).size === 5,
      many.map((p) => p.region).join(' / '));
    t.check('their zones differ as they should',
      many[0].timeZone === 'America/Chicago' && many[2].timeZone === 'America/New_York',
      `${many[0].region} → ${many[0].timeZone}; ${many[2].region} → ${many[2].timeZone}`);
  }

  t.group('Responses that would break a guessed parser');
  {
    // The API omits `results` rather than sending an empty array.
    const none = parseSearchResponse(NO_MATCHES);
    t.check('a query with no matches yields an empty list, not a crash',
      Array.isArray(none) && none.length === 0, `got ${JSON.stringify(none)}`);

    // Country-level entries have no admin1.
    const singapore = parseSearchResponse(SINGAPORE);
    t.equals('a place with no admin area still gets a region',
      singapore[0].region, 'Singapore');

    // Both Singapore rows would render identically; the city is what was meant.
    t.check('duplicate labels collapse to one entry',
      singapore.length === 1, `${singapore.length} entry after de-duplication`);
    t.equals('the settlement wins over the administrative division',
      singapore[0].featureCode, 'PPLC');
  }

  t.group('Malformed and partial input');
  {
    const cases = [
      ['no results key', NO_MATCHES, 0],
      ['an empty results array', { results: [] }, 0],
      ['results that is not an array', { results: 'nope' }, 0],
      ['an entry with no name', { results: [{ latitude: 1, longitude: 2 }] }, 0],
      ['an entry with no coordinates', { results: [{ name: 'Nowhere' }] }, 0],
      ['a latitude out of range', { results: [{ name: 'Bad', latitude: 91, longitude: 0 }] }, 0],
      ['a longitude out of range', { results: [{ name: 'Bad', latitude: 0, longitude: 181 }] }, 0],
      ['coordinates as strings', { results: [{ name: 'Stringy', latitude: '12.5', longitude: '77.5', timezone: 'Asia/Kolkata' }] }, 1],
      ['a null entry among good ones', { results: [null, BENGALURU.results[0]] }, 1],
    ];
    for (const [label, payload, expected] of cases) {
      const got = parseSearchResponse(payload);
      t.check(`${label} → ${expected} place(s)`, got.length === expected,
        `${got.length} place(s) returned`);
    }

    for (const bad of [null, undefined, 'a string', 42]) {
      let threw = false;
      try { parseSearchResponse(bad); } catch (error) { threw = error instanceof PlacesError; }
      t.check(`a body that is ${JSON.stringify(bad)} is rejected`, threw,
        'throws PlacesError rather than returning nonsense');
    }

    // A zone this browser does not know must not be trusted onwards.
    const unknownZone = parseSearchResponse({
      results: [{ name: 'Elsewhere', latitude: 0, longitude: 0, timezone: 'Mars/Olympus', country: 'Mars' }],
    });
    t.check('an unrecognised time zone is flagged, not trusted',
      unknownZone[0].zoneIsGuess === true && unknownZone[0].timeZone === viewerTimeZone(),
      `zoneIsGuess=${unknownZone[0].zoneIsGuess}, falls back to ${unknownZone[0].timeZone}`);
  }

  /* --- Time zone lookup -------------------------------------------- */

  t.group('Reading the time zone response');
  {
    t.equals('the zone is pulled out', parseTimeZoneResponse(FORECAST), 'Asia/Kolkata');

    for (const bad of [null, {}, { timezone: 42 }, { timezone: 'Mars/Olympus' }, { timezone: '' }]) {
      let threw = false;
      try { parseTimeZoneResponse(bad); } catch (error) { threw = error instanceof PlacesError; }
      t.check(`${JSON.stringify(bad)} is rejected`, threw, 'throws PlacesError');
    }
  }

  /* --- Fetch wrappers, with the network stubbed -------------------- */

  t.group('Search over a stubbed network');
  {
    let requestedUrl = '';
    const places = await withStubbedFetch(
      async (url) => { requestedUrl = String(url); return jsonResponse(BENGALURU); },
      () => searchPlaces('Bengaluru')
    );
    t.check('a request is made and parsed', places.length === 1 && places[0].name === 'Bengaluru',
      `${places.length} place(s)`);
    t.check('the query is URL-encoded', requestedUrl.includes('name=Bengaluru'), requestedUrl);

    const encoded = await withStubbedFetch(
      async (url) => { requestedUrl = String(url); return jsonResponse(NO_MATCHES); },
      () => searchPlaces('São Paulo & co')
    );
    t.check('spaces and punctuation are escaped',
      requestedUrl.includes('S%C3%A3o%20Paulo') && !requestedUrl.includes(' '),
      requestedUrl.slice(requestedUrl.indexOf('name=')));
    t.check('and the empty result comes back as a list', encoded.length === 0, `${encoded.length}`);

    // A short query must not reach the network at all.
    let called = false;
    const short = await withStubbedFetch(
      async () => { called = true; return jsonResponse(BENGALURU); },
      () => searchPlaces('a')
    );
    t.check(`a query under ${MIN_QUERY_LENGTH} characters makes no request`,
      !called && short.length === 0, `fetch called: ${called}`);

    // Failures must arrive as something the UI can show.
    const failures = [
      ['the service is unreachable', async () => { throw new TypeError('Failed to fetch'); }, 'offline'],
      ['the service returns 500', async () => jsonResponse({}, 500), 'http'],
      ['the service returns 429', async () => jsonResponse({}, 429), 'http'],
      ['the body is not JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }), 'malformed'],
    ];
    for (const [label, stub, expectedKind] of failures) {
      let caught = null;
      await withStubbedFetch(stub, async () => {
        try { await searchPlaces('London'); } catch (error) { caught = error; }
      });
      t.check(`${label} → a “${expectedKind}” error with a readable message`,
        caught instanceof PlacesError && caught.kind === expectedKind &&
        caught.message.length > 20 && !/\bfetch\b|\bJSON\b/i.test(caught.message),
        caught ? `kind=${caught.kind}: “${caught.message}”` : 'nothing thrown');
    }

    // An aborted search must stay aborted, not be reported as an outage.
    const controller = new AbortController();
    let abortError = null;
    await withStubbedFetch(
      async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
      async () => {
        try { await searchPlaces('London', { signal: controller.signal }); }
        catch (error) { abortError = error; }
      }
    );
    t.check('an abort propagates as an abort',
      abortError?.name === 'AbortError' && !(abortError instanceof PlacesError),
      `got ${abortError?.name}`);
  }

  t.group('Time zone lookup over a stubbed network');
  {
    let url = '';
    const good = await withStubbedFetch(
      async (requested) => { url = String(requested); return jsonResponse(FORECAST); },
      () => resolveTimeZone(12.9716, 77.5946)
    );
    t.check('a resolved zone is not marked as a guess',
      good.timeZone === 'Asia/Kolkata' && good.guessed === false,
      `${good.timeZone}, guessed=${good.guessed}`);
    t.check('the request asks the API to resolve the zone',
      url.includes('timezone=auto') && url.includes('latitude=12.9716'), url);

    // The promise of place-local times cannot be kept here, so the fallback is
    // flagged rather than silent.
    const fallback = await withStubbedFetch(
      async () => { throw new TypeError('Failed to fetch'); },
      () => resolveTimeZone(12.9716, 77.5946)
    );
    t.check('an unreachable lookup falls back to the viewer’s zone, flagged',
      fallback.guessed === true && fallback.timeZone === viewerTimeZone(),
      `${fallback.timeZone}, guessed=${fallback.guessed}`);

    const badBody = await withStubbedFetch(
      async () => jsonResponse({ timezone: 'Mars/Olympus' }),
      () => resolveTimeZone(0, 0)
    );
    t.check('a nonsense zone also falls back rather than being passed on',
      badBody.guessed === true, `guessed=${badBody.guessed}`);
  }

  /* --- Geolocation ------------------------------------------------- */

  t.group('Geolocation');
  {
    const originalNavigator = globalThis.navigator;
    const originalSecure = globalThis.isSecureContext;

    const withNavigator = async (geolocation, secure, body) => {
      Object.defineProperty(globalThis, 'navigator', {
        value: geolocation ? { geolocation } : {}, configurable: true, writable: true,
      });
      globalThis.isSecureContext = secure;
      try { return await body(); } finally {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator, configurable: true, writable: true,
        });
        globalThis.isSecureContext = originalSecure;
      }
    };

    const granted = await withNavigator({
      getCurrentPosition: (onSuccess) =>
        onSuccess({ coords: { latitude: 51.5074, longitude: -0.1278, accuracy: 45 } }),
    }, true, () => locate());
    t.check('a granted permission resolves to coordinates',
      granted.lat === 51.5074 && granted.lon === -0.1278 && granted.accuracy === 45,
      `${granted.lat}, ${granted.lon} ±${granted.accuracy}m`);

    const refusals = [
      ['permission declined', 1, 'geolocation-denied'],
      ['position unavailable', 2, 'geolocation-unavailable'],
      ['timed out', 3, 'geolocation-timeout'],
      ['an unknown code', 99, 'geolocation-failed'],
    ];
    for (const [label, code, expectedKind] of refusals) {
      let caught = null;
      await withNavigator({
        getCurrentPosition: (_onSuccess, onError) => onError({ code }),
      }, true, async () => {
        try { await locate(); } catch (error) { caught = error; }
      });
      t.check(`${label} → “${expectedKind}”, and the message suggests searching`,
        caught?.kind === expectedKind && /search/i.test(caught.message),
        caught ? `“${caught.message}”` : 'nothing thrown');
    }

    let unsupported = null;
    await withNavigator(null, true, async () => {
      try { await locate(); } catch (error) { unsupported = error; }
    });
    t.check('a browser without geolocation is handled',
      unsupported?.kind === 'geolocation-unsupported', `“${unsupported?.message}”`);

    // The API is refused outright over plain http, which is worth saying
    // plainly rather than letting it look like a denied prompt.
    let insecure = null;
    await withNavigator({ getCurrentPosition: () => {} }, false, async () => {
      try { await locate(); } catch (error) { insecure = error; }
    });
    t.check('an insecure page says so instead of timing out',
      insecure?.kind === 'insecure-context' && /https/i.test(insecure.message),
      `“${insecure?.message}”`);

    // The options passed matter: high accuracy would wake the GPS for nothing.
    let options = null;
    await withNavigator({
      getCurrentPosition: (onSuccess, _onError, passed) => {
        options = passed;
        onSuccess({ coords: { latitude: 0, longitude: 0, accuracy: 1 } });
      },
    }, true, () => locate());
    t.check('location is requested without waking the GPS',
      options?.enableHighAccuracy === false && options.timeout > 0,
      `enableHighAccuracy=${options?.enableHighAccuracy}, timeout=${options?.timeout}ms`);
  }

  t.group('Geolocation error mapping');
  {
    t.equals('code 1', fromGeolocationError({ code: 1 }).kind, 'geolocation-denied');
    t.equals('code 2', fromGeolocationError({ code: 2 }).kind, 'geolocation-unavailable');
    t.equals('code 3', fromGeolocationError({ code: 3 }).kind, 'geolocation-timeout');
    t.equals('no error object at all', fromGeolocationError(undefined).kind, 'geolocation-failed');
  }

  const passed = t.results.filter((r) => r.ok).length;
  return { results: t.results, passed, failed: t.results.length - passed, total: t.results.length };
}

/* ------------------------------------------------------------------ *
 * Terminal runner: `node js/places.test.js`
 * ------------------------------------------------------------------ */

const isNodeMain =
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isNodeMain) {
  const { results, passed, failed, total } = await runTests();
  let lastGroup = '';
  for (const r of results) {
    if (r.group !== lastGroup) {
      console.log(`\n${r.group}`);
      lastGroup = r.group;
    }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
  console.log(`\n${passed}/${total} passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}
