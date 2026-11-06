/**
 * The map — a third way to pick a place, alongside search and geolocation.
 *
 * Leaflet is loaded from a CDN as a classic script, so it arrives as a global
 * rather than something this module can import. That makes its absence a real
 * possibility: a blocked CDN, a corporate proxy, a first load with no network.
 * `createMap` returns `null` in that case and the caller carries on without a
 * map — nothing else in the app depends on it, and the sun maths needs no
 * network at all.
 */

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Where the map looks before a place has been picked. */
const WORLD_VIEW = { center: [20, 0], zoom: 2 };

/** Close enough to see streets, for a place arriving from search. */
const PLACE_ZOOM = 10;

/** Is Leaflet actually here? */
export const isMapAvailable = () => typeof globalThis.L !== 'undefined';

/**
 * Fold a longitude back into -180..180.
 *
 * Leaflet's world repeats horizontally, so panning east and clicking returns
 * longitudes like 200 or -430. Those are the same meridian, but they would be
 * displayed as nonsense and rejected by the geocoding APIs.
 */
export function wrapLongitude(lon) {
  // Leave an ordinary longitude exactly as it came. The arithmetic below is
  // not bit-exact — it turns 77.5946 into 77.59460000000001 — and coordinates
  // get compared and stored, so there is no sense introducing drift into the
  // overwhelmingly common case.
  if (lon >= -180 && lon <= 180) return lon;

  // The antimeridian comes back as -180 rather than 180. Same meridian.
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Mount a map in `container`.
 *
 * @param {HTMLElement} container
 * @param {{onPick: (lat:number, lon:number) => void, place?: {lat:number, lon:number}}} options
 * @returns {{moveTo: Function, invalidate: Function} | null} null if Leaflet is missing
 */
export function createMap(container, { onPick, place } = {}) {
  const L = globalThis.L;
  if (!L) return null;

  const map = L.map(container, {
    center: place ? [place.lat, place.lon] : WORLD_VIEW.center,
    zoom: place ? PLACE_ZOOM : WORLD_VIEW.zoom,
    // Keep panning across the date line continuous rather than hitting a wall.
    worldCopyJump: true,
    // The page scrolls; a map that swallowed the wheel would trap the reader.
    scrollWheelZoom: false,
  });

  L.tileLayer(TILE_URL, {
    maxZoom: 19,
    attribution: ATTRIBUTION,
  }).addTo(map);

  // Wheel zoom is off by default so the page keeps scrolling, but once the map
  // has been clicked into, zooming is what the wheel is for.
  map.on('focus', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());

  let marker = null;

  const pick = (lat, lon) => onPick?.(lat, wrapLongitude(lon));

  map.on('click', (event) => pick(event.latlng.lat, event.latlng.lng));

  /** Put the marker at a place, without reporting it back as a new pick. */
  const moveTo = (lat, lon, { recentre = true } = {}) => {
    if (!marker) {
      marker = L.marker([lat, lon], {
        draggable: true,
        autoPan: true,
        keyboard: true,
        title: 'The chosen place — drag to move it',
      }).addTo(map);

      // Dragging reports the new spot; setLatLng below does not fire this, so
      // there is no loop between the map and the app's state.
      marker.on('dragend', () => {
        const { lat: draggedLat, lng } = marker.getLatLng();
        pick(draggedLat, lng);
      });
    } else {
      marker.setLatLng([lat, lon]);
    }

    if (recentre) {
      // Zoom in for a first pick, but never pull the reader back out if they
      // have zoomed in themselves.
      map.setView([lat, lon], Math.max(map.getZoom(), PLACE_ZOOM), { animate: true });
    }
  };

  // Leaflet measures its container on creation. If that happened while the
  // panel was still being laid out, the tiles come out the wrong size until
  // something tells it to measure again.
  const invalidate = () => map.invalidateSize();
  setTimeout(invalidate, 0);

  if (place) moveTo(place.lat, place.lon, { recentre: false });

  return { moveTo, invalidate, map };
}
