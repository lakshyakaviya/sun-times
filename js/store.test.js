/**
 * Test suite for js/store.js.
 *
 * Two kinds of check here. The ordinary kind — a place survives a round trip
 * through the URL, pinning twice does not duplicate — and the kind that
 * matters more: what happens when the input is hostile or the storage is
 * broken. A link can be edited by anyone, and localStorage can be blocked,
 * full, or holding something another page wrote.
 */

import {
  normalisePlace,
  samePlace,
  addSavedPlace,
  removeSavedPlace,
  detectStorage,
  readSavedPlaces,
  writeSavedPlaces,
  readLastPlace,
  writeLastPlace,
  parseUrlState,
  buildUrlQuery,
  SAVED_KEY,
  LAST_KEY,
  MAX_SAVED,
} from './store.js';

import { viewerTimeZone } from './time.js';

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
        detail: ok ? `${actual}` : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      });
    },
  };
}

/** A stand-in for localStorage, with the quirks that matter. */
function fakeStorage({ initial = {}, failWrites = false } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (failWrites) throw new Error('QuotaExceededError');
      data.set(key, String(value));
    },
    removeItem: (key) => { data.delete(key); },
  };
}

const TOKYO = {
  name: 'Tokyo', region: 'Tokyo, Japan',
  lat: 35.6895, lon: 139.69171, timeZone: 'Asia/Tokyo', zoneIsGuess: false,
};
const LONDON = {
  name: 'London', region: 'England, United Kingdom',
  lat: 51.50853, lon: -0.12574, timeZone: 'Europe/London', zoneIsGuess: false,
};

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

export function runTests() {
  const t = createRunner();

  /* --- Validating an untrusted place ------------------------------- */

  t.group('Validating a place');
  {
    const tokyo = normalisePlace(TOKYO);
    t.check('a good place comes back intact',
      tokyo?.name === 'Tokyo' && tokyo.lat === 35.6895 && tokyo.timeZone === 'Asia/Tokyo',
      JSON.stringify(tokyo));
    t.equals('and is not marked as a guess', tokyo.zoneIsGuess, false);

    // The URL hands everything over as a string.
    const fromStrings = normalisePlace({ lat: '35.6895', lon: '139.6917', name: 'Tokyo', timeZone: 'Asia/Tokyo' });
    t.check('string coordinates are accepted and converted',
      fromStrings?.lat === 35.6895 && typeof fromStrings.lon === 'number',
      JSON.stringify(fromStrings));

    t.equals('no coordinates at all is not a place', normalisePlace({ name: 'Nowhere' }), null);
    t.equals('a latitude alone is not a place', normalisePlace({ lat: 10 }), null);
    t.equals('a latitude off the globe is refused', normalisePlace({ lat: 91, lon: 0 }), null);
    t.equals('a longitude off the globe is refused', normalisePlace({ lat: 0, lon: 181 }), null);
    t.equals('words where numbers belong', normalisePlace({ lat: 'north', lon: 'east' }), null);
    t.equals('NaN is refused', normalisePlace({ lat: NaN, lon: 0 }), null);
    t.equals('Infinity is refused', normalisePlace({ lat: 0, lon: Infinity }), null);
    t.equals('null', normalisePlace(null), null);
    t.equals('a string instead of an object', normalisePlace('Tokyo'), null);
    t.equals('an array', normalisePlace([35, 139]), null);

    t.check('the poles and the date line are inside the globe',
      normalisePlace({ lat: 90, lon: 180 }) !== null && normalisePlace({ lat: -90, lon: -180 }) !== null,
      'boundaries accepted');

    const messy = normalisePlace({ lat: 0, lon: 0, name: '  Null Island  ', region: '  Atlantic  ' });
    t.equals('a name is trimmed', messy.name, 'Null Island');
    t.equals('and so is a region', messy.region, 'Atlantic');

    const long = normalisePlace({ lat: 0, lon: 0, name: 'x'.repeat(500), region: 'y'.repeat(500) });
    t.check('an absurdly long name is cut down', long.name.length <= 80, `${long.name.length} characters`);
    t.check('and an absurdly long region', long.region.length <= 120, `${long.region.length} characters`);

    const unnamed = normalisePlace({ lat: 12.9716, lon: 77.5946 });
    t.equals('a place with no name keeps an empty one', unnamed.name, '');
    t.check('rather than inventing one', unnamed.lat === 12.9716, 'coordinates still good');

    // Zones are the one field the app cannot afford to be wrong about.
    const madeUp = normalisePlace({ lat: 35.6895, lon: 139.6917, timeZone: 'Mars/Olympus_Mons' });
    t.equals('an unknown zone name falls back to the viewer’s', madeUp.timeZone, viewerTimeZone());
    t.equals('and is flagged as a guess, so the UI can say so', madeUp.zoneIsGuess, true);

    t.equals('a missing zone is a guess too',
      normalisePlace({ lat: 0, lon: 0 }).zoneIsGuess, true);
    t.equals('an empty zone string is a guess',
      normalisePlace({ lat: 0, lon: 0, timeZone: '' }).zoneIsGuess, true);
    t.equals('a non-string zone is a guess',
      normalisePlace({ lat: 0, lon: 0, timeZone: 42 }).zoneIsGuess, true);

    // A place whose zone was never established must not come back from
    // storage looking verified.
    const wasGuess = normalisePlace({ ...TOKYO, zoneIsGuess: true });
    t.equals('a zone that was already a guess stays one', wasGuess.zoneIsGuess, true);
    t.equals('and the unverified name is not kept', wasGuess.timeZone, viewerTimeZone());
  }

  /* --- Identity ---------------------------------------------------- */

  t.group('Telling two places apart');
  {
    t.equals('a place is itself', samePlace(TOKYO, TOKYO), true);
    t.equals('Tokyo is not London', samePlace(TOKYO, LONDON), false);

    // A place that has been through the URL has had its coordinates rounded,
    // so exact comparison would call it a different place.
    t.equals('rounding in the URL does not create a second place',
      samePlace(TOKYO, { lat: 35.6895, lon: 139.6917 }), true);
    t.equals('a few metres apart is the same spot',
      samePlace({ lat: 35.68950, lon: 139.69171 }, { lat: 35.68953, lon: 139.69169 }), true);
    t.equals('a few hundred metres apart is not',
      samePlace({ lat: 35.6895, lon: 139.6917 }, { lat: 35.6995, lon: 139.6917 }), false);
    t.equals('null is nothing', samePlace(null, TOKYO), false);
    t.equals('and neither is undefined', samePlace(TOKYO, undefined), false);
  }

  /* --- The pinned list --------------------------------------------- */

  t.group('Pinning and unpinning');
  {
    const empty = [];
    const one = addSavedPlace(empty, TOKYO);
    t.equals('pinning adds one', one.places.length, 1);
    t.equals('and says so', one.added, true);
    t.equals('without touching the list it was given', empty.length, 0);

    const two = addSavedPlace(one.places, LONDON);
    t.equals('a second place is added', two.places.length, 2);
    t.check('in the order they were pinned',
      two.places[0].name === 'Tokyo' && two.places[1].name === 'London',
      two.places.map((p) => p.name).join(', '));

    const again = addSavedPlace(two.places, TOKYO);
    t.equals('pinning the same place again adds nothing', again.places.length, 2);
    t.equals('and explains why', again.reason, 'duplicate');

    const nudged = addSavedPlace(two.places, { ...TOKYO, lat: 35.68952, name: 'Tōkyō' });
    t.equals('nor does the same spot under another name', nudged.added, false);

    const junk = addSavedPlace(two.places, { name: 'Atlantis' });
    t.equals('a place with no coordinates cannot be pinned', junk.added, false);
    t.equals('and is called invalid, not full', junk.reason, 'invalid');

    let full = [];
    for (let i = 0; i < MAX_SAVED; i++) {
      full = addSavedPlace(full, { lat: i, lon: 0, name: `Place ${i}`, timeZone: 'UTC' }).places;
    }
    t.equals('the list fills up at the cap', full.length, MAX_SAVED);
    const overflow = addSavedPlace(full, { lat: 80, lon: 80, name: 'One more', timeZone: 'UTC' });
    t.equals('and refuses the next one', overflow.added, false);
    t.equals('saying it is full, so the UI can offer the right advice', overflow.reason, 'full');
    t.check('nothing the reader pinned is silently dropped',
      overflow.places.length === MAX_SAVED && overflow.places[0].name === 'Place 0',
      'the oldest pin is still there');

    const gone = removeSavedPlace(two.places, TOKYO);
    t.equals('unpinning removes it', gone.length, 1);
    t.equals('leaving the others', gone[0].name, 'London');
    t.equals('unpinning something not pinned changes nothing',
      removeSavedPlace(two.places, { lat: 0, lon: 0 }).length, 2);
    t.equals('a nudged coordinate still unpins the right one',
      removeSavedPlace(two.places, { ...TOKYO, lat: 35.68952 }).length, 1);
  }

  /* --- Storage ----------------------------------------------------- */

  t.group('Storage that works');
  {
    const store = fakeStorage();
    t.check('a usable storage is handed back', detectStorage(store) === store, 'probed and accepted');
    t.check('the probe key does not linger', store.data.size === 0, `${store.data.size} key(s) left`);

    t.equals('nothing stored yet reads as no places', readSavedPlaces(store).length, 0);
    t.equals('and no last place', readLastPlace(store), null);

    t.equals('writing reports success', writeSavedPlaces(store, [normalisePlace(TOKYO), normalisePlace(LONDON)]), true);
    const back = readSavedPlaces(store);
    t.equals('both places come back', back.length, 2);
    t.check('with their names, coordinates and zones',
      back[0].name === 'Tokyo' && back[0].timeZone === 'Asia/Tokyo' && samePlace(back[0], TOKYO),
      JSON.stringify(back[0]));
    t.check('and the stored row carries nothing it does not need',
      !('featureCode' in JSON.parse(store.data.get(SAVED_KEY))[0]),
      Object.keys(JSON.parse(store.data.get(SAVED_KEY))[0]).join(', '));

    writeLastPlace(store, normalisePlace(LONDON));
    t.check('the last place round-trips', samePlace(readLastPlace(store), LONDON),
      JSON.stringify(readLastPlace(store)));
    t.check('under its own key', store.data.has(LAST_KEY), [...store.data.keys()].join(', '));
    t.equals('writing no last place is not an error', writeLastPlace(store, null), false);
  }

  t.group('Storage that is damaged');
  {
    // Anything on the origin can write to these keys, and a write can be cut
    // short. None of it may stop the app from starting.
    t.equals('a key holding something that is not JSON',
      readSavedPlaces(fakeStorage({ initial: { [SAVED_KEY]: '{oh dear' } })).length, 0);
    t.equals('a key holding JSON that is not a list',
      readSavedPlaces(fakeStorage({ initial: { [SAVED_KEY]: '{"a":1}' } })).length, 0);
    t.equals('a key holding null', readSavedPlaces(fakeStorage({ initial: { [SAVED_KEY]: 'null' } })).length, 0);
    t.equals('an empty string', readSavedPlaces(fakeStorage({ initial: { [SAVED_KEY]: '' } })).length, 0);
    t.equals('a last place that is not JSON',
      readLastPlace(fakeStorage({ initial: { [LAST_KEY]: 'undefined' } })), null);

    const mixed = fakeStorage({
      initial: {
        [SAVED_KEY]: JSON.stringify([
          TOKYO,
          { name: 'Broken' },                  // no coordinates
          null,
          { lat: 999, lon: 999, name: 'Off world' },
          LONDON,
        ]),
      },
    });
    const kept = readSavedPlaces(mixed);
    t.equals('the good rows survive a list with bad ones in it', kept.length, 2);
    t.check('and they are the right ones',
      kept[0].name === 'Tokyo' && kept[1].name === 'London',
      kept.map((p) => p.name).join(', '));

    const duplicated = fakeStorage({
      initial: { [SAVED_KEY]: JSON.stringify([TOKYO, { ...TOKYO, name: 'Tokyo again' }]) },
    });
    t.equals('duplicates in storage are collapsed', readSavedPlaces(duplicated).length, 1);

    const overfull = fakeStorage({
      initial: {
        [SAVED_KEY]: JSON.stringify(
          Array.from({ length: 500 }, (_, i) => ({ lat: i / 10, lon: 0, name: `P${i}`, timeZone: 'UTC' }))
        ),
      },
    });
    t.equals('a store with far too many rows is cut to the cap',
      readSavedPlaces(overfull).length, MAX_SAVED);
  }

  t.group('Storage that refuses');
  {
    // Safari's private window has a zero quota: the object exists and throws
    // on the first write. That has to be found before the app relies on it.
    t.equals('a storage that throws on write is not offered',
      detectStorage(fakeStorage({ failWrites: true })), null);
    t.equals('neither is a missing one', detectStorage(null), null);

    // Chrome with site data blocked throws on the property access itself.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('Access is denied for this document.'); },
    });
    let threw = false;
    let detected;
    try {
      detected = detectStorage();
    } catch {
      threw = true;
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete globalThis.localStorage;
    }
    t.equals('a storage that throws on being read does not throw out of here', threw, false);
    t.equals('it reports nothing available', detected, null);

    // With no storage, every call still has to answer sensibly.
    t.equals('reading pins without a storage gives none', readSavedPlaces(null).length, 0);
    t.equals('reading the last place gives nothing', readLastPlace(null), null);
    t.equals('writing pins reports the failure', writeSavedPlaces(null, [normalisePlace(TOKYO)]), false);
    t.equals('writing the last place reports it too', writeLastPlace(null, normalisePlace(TOKYO)), false);

    t.equals('and a storage that cannot be written to reports the failure',
      writeSavedPlaces(fakeStorage({ failWrites: true }), [normalisePlace(TOKYO)]), false);
  }

  /* --- The URL ----------------------------------------------------- */

  t.group('Reading a link');
  {
    const { place, date } = parseUrlState('?lat=35.6895&lon=139.6917&name=Tokyo&region=Japan&tz=Asia%2FTokyo&date=2026-06-21');
    t.check('a full link gives a place',
      place?.name === 'Tokyo' && place.timeZone === 'Asia/Tokyo' && place.region === 'Japan',
      JSON.stringify(place));
    t.check('with the coordinates it carried', samePlace(place, TOKYO), `${place.lat}, ${place.lon}`);
    t.equals('and the date', date && `${date.year}-${date.month}-${date.day}`, '2026-6-21');

    t.equals('a leading ? is optional',
      parseUrlState('lat=0&lon=0')?.place?.lat, 0);
    t.equals('an empty query gives no place', parseUrlState('')?.place, null);
    t.equals('and no date', parseUrlState('')?.date, null);
    t.equals('no query at all is fine', parseUrlState(undefined)?.place, null);

    t.equals('a longitude without a latitude is not a location',
      parseUrlState('?lon=139.6917&name=Tokyo')?.place, null);
    t.equals('an off-globe latitude is refused',
      parseUrlState('?lat=200&lon=0')?.place, null);
    t.equals('so is a latitude that is not a number',
      parseUrlState('?lat=somewhere&lon=nice')?.place, null);

    t.equals('a nonsense date is ignored rather than fatal',
      parseUrlState('?lat=0&lon=0&date=last-tuesday')?.date, null);
    t.equals('and an impossible one',
      parseUrlState('?lat=0&lon=0&date=2026-13-45')?.date, null);
    t.check('while the place still comes through',
      parseUrlState('?lat=0&lon=0&date=rubbish')?.place !== null, 'a bad date costs you only the date');

    t.equals('a made-up zone in a link does not get believed',
      parseUrlState('?lat=0&lon=0&tz=Totally/Made_Up')?.place?.zoneIsGuess, true);

    const spaced = parseUrlState('?lat=40.7128&lon=-74.006&name=New+York&region=New+York%2C+United+States');
    t.equals('a name with a space decodes', spaced.place.name, 'New York');
    t.equals('and a region with a comma', spaced.place.region, 'New York, United States');

    const unicode = parseUrlState(`?lat=35.0116&lon=135.7681&name=${encodeURIComponent('京都')}`);
    t.equals('a name that is not in Latin letters survives', unicode.place.name, '京都');

    // A link is editable by anyone, so the length cap matters here most.
    const huge = parseUrlState(`?lat=0&lon=0&name=${'A'.repeat(5000)}`);
    t.check('a link carrying an enormous name is cut down',
      huge.place.name.length <= 80, `${huge.place.name.length} characters`);

    t.equals('unknown parameters are simply ignored',
      parseUrlState('?lat=0&lon=0&evil=<script>&utm_source=x')?.place?.lat, 0);
    t.equals('a repeated parameter takes the first',
      parseUrlState('?lat=10&lat=20&lon=0')?.place?.lat, 10);
  }

  t.group('Writing a link');
  {
    const query = buildUrlQuery({ place: normalisePlace(TOKYO), date: { year: 2026, month: 6, day: 21 } });
    t.check('it starts with a ?', query.startsWith('?'), query);
    t.check('and carries the place', /lat=35\.6895/.test(query) && /lon=139\.6917/.test(query), query);
    t.check('the zone', /tz=Asia%2FTokyo/.test(query), query);
    t.check('and the date', /date=2026-06-21/.test(query), query);

    t.check('coordinates are not written out to full float precision',
      !/139\.69171/.test(query), query);

    const noDate = buildUrlQuery({ place: normalisePlace(TOKYO), date: null });
    t.check('a view of today carries no date, so a shared link means “today”',
      !noDate.includes('date='), noDate);

    const guessed = buildUrlQuery({ place: normalisePlace({ ...TOKYO, zoneIsGuess: true }) });
    t.check('a zone nobody verified is not passed on to anyone else',
      !guessed.includes('tz='), guessed);

    const unnamed = buildUrlQuery({ place: normalisePlace({ lat: -30, lon: -130 }) });
    t.check('an unnamed point still produces a usable link',
      /lat=-30/.test(unnamed) && !unnamed.includes('name='), unnamed);

    t.equals('nothing to say means an empty query', buildUrlQuery({ place: null, date: null }), '');
    t.equals('and no argument at all does not throw', buildUrlQuery(), '');

    const dateOnly = buildUrlQuery({ place: null, date: { year: 2026, month: 1, day: 5 } });
    t.equals('a date without a place is still written', dateOnly, '?date=2026-01-05');

    // The round trip is what actually makes a reload work.
    const round = parseUrlState(buildUrlQuery({ place: normalisePlace(LONDON), date: { year: 2026, month: 12, day: 21 } }));
    t.check('a place survives being written and read back',
      samePlace(round.place, LONDON) && round.place.name === 'London'
        && round.place.region === 'England, United Kingdom'
        && round.place.timeZone === 'Europe/London' && round.place.zoneIsGuess === false,
      JSON.stringify(round.place));
    t.check('and so does the date',
      round.date.year === 2026 && round.date.month === 12 && round.date.day === 21,
      JSON.stringify(round.date));

    const awkward = normalisePlace({ lat: 0, lon: 0, name: 'Ménière & Co, 50% off', timeZone: 'UTC' });
    const escaped = parseUrlState(buildUrlQuery({ place: awkward }));
    t.equals('a name full of punctuation survives the round trip',
      escaped.place.name, 'Ménière & Co, 50% off');
  }

  const passed = t.results.filter((r) => r.ok).length;
  return { results: t.results, passed, failed: t.results.length - passed, total: t.results.length };
}

/* ------------------------------------------------------------------ *
 * Terminal runner: `node js/store.test.js`
 * ------------------------------------------------------------------ */

const isNodeMain =
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isNodeMain) {
  const { results, passed, failed, total } = runTests();
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
