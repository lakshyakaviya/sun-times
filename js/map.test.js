/**
 * Test suite for js/map.js.
 *
 * `createMap` reads Leaflet off the global at call time, which means a stand-in
 * can be put there and the module exercised with no browser and no CDN. What
 * this cannot check is tiles actually drawing — that needs eyes on a page.
 */

import { createMap, isMapAvailable, wrapLongitude } from './map.js';

/* ------------------------------------------------------------------ *
 * A stand-in for Leaflet
 * ------------------------------------------------------------------ */

function fakeLeaflet() {
  const made = { maps: [], tileLayers: [], markers: [] };

  const withEvents = (target) => {
    const handlers = {};
    target.handlers = handlers;
    target.on = (type, handler) => { (handlers[type] ??= []).push(handler); return target; };
    target.fire = (type, event) => { for (const h of handlers[type] ?? []) h(event); };
    return target;
  };

  const L = {
    map(container, options) {
      const map = withEvents({
        container,
        options,
        center: options.center,
        zoom: options.zoom,
        views: [],
        invalidatedTimes: 0,
        wheelEnabled: options.scrollWheelZoom !== false,
        setView(center, zoom) {
          map.center = center;
          map.zoom = zoom;
          map.views.push({ center, zoom });
          return map;
        },
        getZoom: () => map.zoom,
        invalidateSize() { map.invalidatedTimes += 1; },
      });
      map.scrollWheelZoom = {
        enable() { map.wheelEnabled = true; },
        disable() { map.wheelEnabled = false; },
      };
      made.maps.push(map);
      return map;
    },

    tileLayer(url, options) {
      const layer = { url, options, addedTo: null };
      layer.addTo = (map) => { layer.addedTo = map; return layer; };
      made.tileLayers.push(layer);
      return layer;
    },

    marker(latlng, options) {
      const marker = withEvents({ latlng, options, addedTo: null });
      marker.addTo = (map) => { marker.addedTo = map; return marker; };
      marker.setLatLng = (next) => { marker.latlng = next; return marker; };
      marker.getLatLng = () => ({ lat: marker.latlng[0], lng: marker.latlng[1] });
      made.markers.push(marker);
      return marker;
    },
  };

  return { L, made };
}

/** Install the stand-in for the duration of `body`. */
async function withLeaflet(body) {
  const previous = globalThis.L;
  const { L, made } = fakeLeaflet();
  globalThis.L = L;
  try {
    return await body(made);
  } finally {
    if (previous === undefined) delete globalThis.L;
    else globalThis.L = previous;
  }
}

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
        detail: ok ? `${actual}` : `got ${actual}, expected ${expected}`,
      });
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

export async function runTests() {
  const t = createRunner();

  /* --- Longitude wrapping ------------------------------------------ */

  t.group('Longitude wrapping');
  {
    // Leaflet's world repeats sideways, so panning east and clicking hands
    // back longitudes well outside the real range. Those are real meridians,
    // but they would be shown as nonsense and rejected by the APIs.
    t.equals('a longitude already in range is untouched', wrapLongitude(77.5946), 77.5946);
    t.equals('zero', wrapLongitude(0), 0);
    t.equals('just past the date line', wrapLongitude(181), -179);
    t.equals('one world copy east', wrapLongitude(200), -160);
    t.equals('one world copy west', wrapLongitude(-181), 179);
    t.equals('more than one copy out', wrapLongitude(-430), -70);
    t.check('several copies east lands back on the date line',
      Math.abs(wrapLongitude(900)) === 180, `${wrapLongitude(900)}`);
    t.check('the date line itself stays on the date line',
      Math.abs(wrapLongitude(180)) === 180, `${wrapLongitude(180)}`);
    t.check('an in-range longitude keeps its exact value',
      wrapLongitude(77.5946) === 77.5946 && wrapLongitude(-0.1278) === -0.1278,
      'no floating-point drift introduced');
    t.check('everything lands inside the real range',
      [1e4, -1e4, 359, -359, 540, -540, 77.5, 0].every((lon) => {
        const wrapped = wrapLongitude(lon);
        return wrapped >= -180 && wrapped <= 180;
      }),
      'checked a spread of far-out values');
  }

  /* --- Without Leaflet --------------------------------------------- */

  t.group('When Leaflet is missing');
  {
    const previous = globalThis.L;
    delete globalThis.L;
    try {
      t.check('availability is reported honestly', isMapAvailable() === false,
        `isMapAvailable() === ${isMapAvailable()}`);
      t.check('creating a map returns null rather than throwing',
        createMap({}, { onPick() {} }) === null,
        'the caller can fall back to search and geolocation');
    } finally {
      if (previous !== undefined) globalThis.L = previous;
    }
  }

  /* --- Setting up -------------------------------------------------- */

  t.group('Setting up the map');
  {
    await withLeaflet(async (made) => {
      const container = { id: 'map' };
      const handle = createMap(container, { onPick() {} });

      t.check('a handle comes back', handle !== null && typeof handle.moveTo === 'function',
        Object.keys(handle ?? {}).join(', '));

      const [map] = made.maps;
      t.check('the map is mounted in the container given', map.container === container,
        `container id ${map.container.id}`);
      t.check('it opens on a world view', map.options.zoom <= 3,
        `centre ${JSON.stringify(map.options.center)}, zoom ${map.options.zoom}`);
      t.check('panning across the date line is continuous',
        map.options.worldCopyJump === true, `worldCopyJump=${map.options.worldCopyJump}`);

      // A map that ate the wheel would trap a reader trying to scroll past it.
      t.check('the wheel scrolls the page until the map is focused',
        map.options.scrollWheelZoom === false, `scrollWheelZoom=${map.options.scrollWheelZoom}`);
      map.fire('focus');
      t.check('focusing the map hands the wheel over to it', map.wheelEnabled === true,
        `wheelEnabled=${map.wheelEnabled}`);
      map.fire('blur');
      t.check('and blurring gives it back', map.wheelEnabled === false,
        `wheelEnabled=${map.wheelEnabled}`);

      const [tiles] = made.tileLayers;
      t.check('tiles are added to the map', tiles.addedTo === map, 'tile layer attached');
      t.check('OpenStreetMap is credited, as its licence requires',
        /openstreetmap/i.test(tiles.options.attribution ?? ''), tiles.options.attribution);
      t.check('the tile URL is https', tiles.url.startsWith('https://'), tiles.url);

      // Leaflet measures the container once, on creation. If the panel was
      // still settling, the tiles come out the wrong size until it remeasures.
      await tick();
      t.check('the map is told to remeasure after layout settles',
        map.invalidatedTimes >= 1, `invalidateSize called ${map.invalidatedTimes}×`);
    });
  }

  t.group('Opening on a known place');
  {
    await withLeaflet(async (made) => {
      createMap({}, { onPick() {}, place: { lat: 12.9716, lon: 77.5946 } });
      const [map] = made.maps;
      t.check('the view starts at that place',
        map.options.center[0] === 12.9716 && map.options.center[1] === 77.5946,
        JSON.stringify(map.options.center));
      t.check('and close enough to be useful', map.options.zoom >= 8, `zoom ${map.options.zoom}`);
      t.check('a marker is placed straight away', made.markers.length === 1,
        `${made.markers.length} marker(s)`);
      t.check('without yanking the view about',
        map.views.length === 0, `${map.views.length} setView call(s)`);
    });
  }

  /* --- Picking ----------------------------------------------------- */

  t.group('Picking a point');
  {
    await withLeaflet(async (made) => {
      const picks = [];
      createMap({}, { onPick: (lat, lon) => picks.push([lat, lon]) });
      const [map] = made.maps;

      map.fire('click', { latlng: { lat: 51.5074, lng: -0.1278 } });
      t.check('a click reports where it landed',
        picks.length === 1 && picks[0][0] === 51.5074 && picks[0][1] === -0.1278,
        JSON.stringify(picks[0]));

      // Clicking on a repeated copy of the world must not report 200°E.
      map.fire('click', { latlng: { lat: 35.68, lng: 499.69 } });
      t.check('a click on a repeated world copy is folded back into range',
        Math.abs(picks[1][1] - 139.69) < 1e-9, `longitude ${picks[1][1]}`);
    });
  }

  t.group('Moving the marker');
  {
    await withLeaflet(async (made) => {
      const picks = [];
      const handle = createMap({}, { onPick: (lat, lon) => picks.push([lat, lon]) });
      const [map] = made.maps;

      handle.moveTo(12.9716, 77.5946);
      t.check('the first move creates the marker', made.markers.length === 1,
        `${made.markers.length} marker(s)`);
      t.check('the marker is draggable', made.markers[0].options.draggable === true,
        `draggable=${made.markers[0].options.draggable}`);
      t.check('and it has a usable title',
        (made.markers[0].options.title ?? '').length > 0, made.markers[0].options.title);
      t.check('a move reports nothing back', picks.length === 0,
        'no feedback loop between the map and the app state');

      handle.moveTo(35.6895, 139.6917);
      t.check('a later move reuses the same marker', made.markers.length === 1,
        `${made.markers.length} marker(s)`);
      t.check('and takes it to the new spot',
        made.markers[0].latlng[0] === 35.6895, JSON.stringify(made.markers[0].latlng));

      // Dragging, unlike a programmatic move, is the reader choosing a place.
      made.markers[0].latlng = [48.8566, 2.3522];
      made.markers[0].fire('dragend');
      t.check('dragging the marker reports the new spot',
        picks.length === 1 && picks[0][0] === 48.8566,
        JSON.stringify(picks[0]));

      made.markers[0].latlng = [10, 440];
      made.markers[0].fire('dragend');
      t.check('a drag past the date line is folded back too',
        Math.abs(picks[1][1] - 80) < 1e-9, `longitude ${picks[1][1]}`);
    });
  }

  t.group('Zoom behaviour when a place arrives');
  {
    await withLeaflet(async (made) => {
      const handle = createMap({}, { onPick() {} });
      const [map] = made.maps;

      handle.moveTo(12.9716, 77.5946);
      t.check('a first pick zooms in from the world view', map.zoom >= 8,
        `zoom ${map.zoom}`);

      // Someone who has zoomed in to pick a street should not be pulled back.
      map.zoom = 16;
      handle.moveTo(35.6895, 139.6917);
      t.equals('a closer zoom the reader chose is kept', map.zoom, 16);

      map.zoom = 3;
      handle.moveTo(1.35, 103.82);
      t.check('but a far-out view is brought back in', map.zoom >= 8, `zoom ${map.zoom}`);

      const views = map.views.length;
      handle.moveTo(0, 0, { recentre: false });
      t.equals('a move can decline to recentre', map.views.length, views);
    });
  }

  const passed = t.results.filter((r) => r.ok).length;
  return { results: t.results, passed, failed: t.results.length - passed, total: t.results.length };
}

/* ------------------------------------------------------------------ *
 * Terminal runner: `node js/map.test.js`
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
