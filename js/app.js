/**
 * Wiring: state, rendering, the place picker and the date controls.
 *
 * The app has two halves that meet at a narrow seam — something decides
 * *where*, and this file turns a where plus a when into what you see:
 *
 *   { lat, lon, timeZone, name }  →  computed sun times  →  the page
 *
 * The search box and the location button both funnel into `setPlace`, so the
 * rendering below neither knows nor cares which was used. The map will join
 * them on the same footing.
 */

import {
  sunTimes,
  dayLengthDelta,
  sunPosition,
  civilDateFromISO,
  toISODate,
  addDays,
} from './sun.js';

import { civilDateInZone, viewerTimeZone } from './time.js';

import {
  searchPlaces,
  resolveTimeZone,
  describePlace,
  locate,
  MIN_QUERY_LENGTH,
} from './places.js';

import { createMap } from './map.js';

import {
  detectStorage,
  readSavedPlaces,
  writeSavedPlaces,
  readLastPlace,
  writeLastPlace,
  addSavedPlace,
  removeSavedPlace,
  samePlace,
  parseUrlState,
  buildUrlQuery,
  MAX_SAVED,
} from './store.js';

import {
  formatTimeWithDay,
  formatTimeRange,
  formatDuration,
  formatDayLengthDelta,
  formatCoordinates,
  formatZoneLabel,
  formatDateLabel,
  machineDateTime,
  dayMarker,
} from './format.js';

const state = {
  /** `null` until a place has been picked. */
  place: null,
  date: civilDateInZone(Date.now(), viewerTimeZone()),
  /**
   * Whether the date on screen was asked for, or is just "today". Picking a
   * new place keeps a date you chose, but re-reads today from the new zone —
   * Tokyo at 02:00 is already tomorrow by London's reckoning.
   */
  dateIsExplicit: false,
  /** Pinned places, in the order they were pinned. */
  saved: [],
};

/** `null` where the browser will not let the page store anything. */
const storage = detectStorage();

const el = (id) => document.getElementById(id);

const dom = {
  sky: el('sky'),
  placeName: el('place-name'),
  placeMeta: el('place-meta'),
  dateInput: el('date-input'),
  prevDay: el('prev-day'),
  nextDay: el('next-day'),
  today: el('today-btn'),
  searchForm: el('search-form'),
  searchInput: el('search-input'),
  locateBtn: el('locate-btn'),
  searchResults: el('search-results'),
  pickerStatus: el('picker-status'),
  map: el('map'),
  mapPlaceholder: el('map-placeholder'),
  saveBtn: el('save-btn'),
  savedList: el('saved-list'),
  savedEmpty: el('saved-empty'),
  cards: {
    sunrise: { value: el('sunrise-value'), note: el('sunrise-note') },
    sunset: { value: el('sunset-value'), note: el('sunset-note') },
    goldenMorning: { value: el('golden-morning-value'), note: el('golden-morning-note') },
    goldenEvening: { value: el('golden-evening-value'), note: el('golden-evening-note') },
    dayLength: { value: el('daylength-value'), note: el('daylength-note') },
  },
};

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Put a value in a card. When `instant` is given the value is wrapped in a
 * `<time>` element carrying the machine-readable instant; otherwise it is
 * plain text (for "the sun doesn't rise today", and for durations).
 */
function setCardValue(card, text, instant, timeZone) {
  if (instant) {
    const time = document.createElement('time');
    time.dateTime = machineDateTime(instant, timeZone);
    time.textContent = text;
    card.value.replaceChildren(time);
  } else {
    card.value.textContent = text;
  }
}

function renderPlace() {
  const { place, date } = state;
  const now = Date.now();

  dom.placeName.textContent = place.name;

  const bits = [];
  if (place.region) bits.push(place.region);
  bits.push(formatCoordinates(place.lat, place.lon));
  // Be honest when the zone could not be established: the app's whole premise
  // is that times are on the clock of the place you picked.
  bits.push(
    place.zoneIsGuess
      ? `time zone unknown — times in your own, ${formatZoneLabel(now, place.timeZone)}`
      : `times in ${formatZoneLabel(now, place.timeZone)}`
  );
  dom.placeMeta.textContent = bits.join(' · ');

  dom.dateInput.value = toISODate(date);
  dom.dateInput.setAttribute('aria-label', `Date — showing ${formatDateLabel(date)}`);
}

/** Before anything has been picked: no values, no invented default place. */
function renderEmptyState() {
  dom.placeName.textContent = 'No place chosen yet';
  dom.placeMeta.textContent =
    'Search for a city or use your location to see sunrise, sunset and golden hour.';
  dom.dateInput.value = toISODate(state.date);

  for (const card of Object.values(dom.cards)) {
    card.value.textContent = '—';
    card.note.textContent = '';
  }
  dom.sky.dataset.phase = 'day';
}

function renderCards(sun, delta) {
  const { place, date } = state;
  const { timeZone } = place;
  const { cards } = dom;

  if (sun.polar === 'midnight-sun') {
    setCardValue(cards.sunrise, 'No sunrise');
    cards.sunrise.note.textContent = 'The sun is already up, and stays up.';
    setCardValue(cards.sunset, 'No sunset');
    cards.sunset.note.textContent = 'Midnight sun — it never drops below the horizon.';
  } else if (sun.polar === 'polar-night') {
    setCardValue(cards.sunrise, 'No sunrise');
    cards.sunrise.note.textContent = 'Polar night — the sun stays below the horizon.';
    setCardValue(cards.sunset, 'No sunset');
    cards.sunset.note.textContent = 'It never rises, so it never sets.';
  } else {
    setCardValue(
      cards.sunrise,
      formatTimeWithDay(sun.sunrise, timeZone, date),
      sun.sunrise,
      timeZone
    );
    // The note carries an explanation only when there is something to explain:
    // a time that lands outside the date being viewed.
    cards.sunrise.note.textContent = dayMarker(sun.sunrise, timeZone, date)
      ? 'Before midnight, on the day before.'
      : '';

    setCardValue(
      cards.sunset,
      formatTimeWithDay(sun.sunset, timeZone, date),
      sun.sunset,
      timeZone
    );
    cards.sunset.note.textContent = dayMarker(sun.sunset, timeZone, date)
      ? 'After midnight, so it falls on the next day.'
      : '';
  }

  // Golden hour
  if (!sun.golden) {
    setCardValue(cards.goldenMorning, 'None');
    cards.goldenMorning.note.textContent =
      sun.polar === 'midnight-sun'
        ? 'With no sunrise there is no morning golden hour; the light stays low around midnight instead.'
        : 'The sun never comes up.';
    setCardValue(cards.goldenEvening, 'None');
    cards.goldenEvening.note.textContent =
      sun.polar === 'midnight-sun' ? 'Likewise for the evening.' : 'The sun never comes up.';
  } else {
    const morning = sun.golden.morning;
    const evening = sun.golden.evening;

    setCardValue(cards.goldenMorning, formatTimeRange(morning.start, morning.end, timeZone));
    cards.goldenMorning.note.textContent = sun.goldenAllDay
      ? 'The sun never climbs above 6° today, so the light stays low all day.'
      : `${formatDuration((morning.end - morning.start) / 1000)} from sunrise.`;

    setCardValue(cards.goldenEvening, formatTimeRange(evening.start, evening.end, timeZone));
    cards.goldenEvening.note.textContent = sun.goldenAllDay
      ? 'Golden from noon right through to sunset.'
      : `${formatDuration((evening.end - evening.start) / 1000)} until sunset.`;
  }

  // Day length
  if (sun.polar === 'polar-night') {
    setCardValue(cards.dayLength, 'No daylight');
    cards.dayLength.note.textContent = 'The sun stays below the horizon for the whole day.';
  } else if (sun.polar === 'midnight-sun') {
    setCardValue(cards.dayLength, '24 h');
    cards.dayLength.note.textContent = 'Daylight all the way round the clock.';
  } else {
    setCardValue(cards.dayLength, formatDuration(sun.dayLengthSeconds));
    cards.dayLength.note.textContent = delta
      ? formatDayLengthDelta(delta.seconds)
      : 'No comparison available for yesterday.';
  }
}

/**
 * Tint the backdrop by where the sun is *right now* at this place — not on the
 * date being viewed, which may be months away. Azimuth decides whether a sun
 * near the horizon is coming up or going down.
 */
function renderSky() {
  const { place } = state;
  if (!place) return;
  const { altitude, azimuth } = sunPosition(Date.now(), place.lat, place.lon);

  let phase;
  if (altitude > 6) phase = 'day';
  else if (altitude < -6) phase = 'night';
  else phase = azimuth < 180 ? 'dawn' : 'dusk';

  dom.sky.dataset.phase = phase;
}

/* ------------------------------------------------------------------ *
 * Pinned places
 * ------------------------------------------------------------------ */

/** One chip: a button to go there, and a button to let it go. */
function chipFor(entry) {
  const label = entry.name || formatCoordinates(entry.lat, entry.lon);

  const item = document.createElement('li');
  item.className = 'saved__chip';
  // So the row shows at a glance which pin you are looking at.
  if (samePlace(entry, state.place)) {
    item.dataset.current = 'true';
    item.setAttribute('aria-current', 'true');
  }

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'saved__chip-go';
  go.textContent = label;
  if (entry.region) go.title = entry.region;
  go.addEventListener('click', () => {
    closeResults();
    // The search box said where we came from, not where we are going.
    dom.searchInput.value = '';
    setStatus('');
    setPlace({ ...entry, name: label });
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'saved__chip-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Unpin ${label}`);
  remove.addEventListener('click', () => {
    state.saved = removeSavedPlace(state.saved, entry);
    persistSaved();
    renderSaved();
  });

  item.append(go, remove);
  return item;
}

function renderSaved() {
  const { saved, place } = state;
  const pinned = Boolean(place) && saved.some((entry) => samePlace(entry, place));

  dom.saveBtn.disabled = !place;
  dom.saveBtn.textContent = pinned ? 'Unpin this place' : 'Pin this place';
  dom.saveBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');

  dom.savedList.replaceChildren(...saved.map(chipFor));
  dom.savedEmpty.hidden = saved.length > 0;
}

/** Store the pinned list, and own up if the browser will not have it. */
function persistSaved() {
  if (state.saved.length && !writeSavedPlaces(storage, state.saved)) {
    setStatus('Pinned for this visit only — this browser will not let the page store anything.');
  }
}

function togglePin() {
  const { place } = state;
  if (!place) return;

  if (state.saved.some((entry) => samePlace(entry, place))) {
    state.saved = removeSavedPlace(state.saved, place);
    // Clear first: a "the row is full" warning from a moment ago is answered
    // by this very click, and must not be left standing.
    setStatus('');
    persistSaved();
    renderSaved();
    return;
  }

  const { places, added, reason } = addSavedPlace(state.saved, place);
  if (!added) {
    // 'full' is the only reason a real place gets refused here.
    setStatus(
      reason === 'full'
        ? `That is ${MAX_SAVED} pinned places — unpin one before pinning another.`
        : 'That place cannot be pinned.'
    );
    return;
  }

  state.saved = places;
  setStatus('');
  persistSaved();
  renderSaved();
}

/* ------------------------------------------------------------------ *
 * The URL
 * ------------------------------------------------------------------ */

/**
 * Mirror the view into the address bar, so it survives a reload and can be
 * pasted to someone else.
 *
 * `replaceState`, not `pushState`: stepping through a week with the arrows
 * would otherwise stack up history entries, and the back button would spend
 * seven presses getting out of the page instead of leaving it.
 */
function syncUrl() {
  const { location, history } = globalThis;
  if (!location || typeof history?.replaceState !== 'function') return;

  const query = buildUrlQuery({
    place: state.place,
    date: state.dateIsExplicit ? state.date : null,
  });

  try {
    history.replaceState(null, '', `${location.pathname}${query}${location.hash}`);
  } catch {
    // Some browsers refuse this on a `file://` page. Nothing depends on the
    // URL having been written.
  }
}

function render() {
  const { place, date } = state;

  if (place) {
    // An unverified zone must not anchor the solar day — fall back to the
    // longitude, which needs no zone database.
    const anchorZone = place.zoneIsGuess ? undefined : place.timeZone;
    const sun = sunTimes(date, place.lat, place.lon, anchorZone);
    const delta = dayLengthDelta(date, place.lat, place.lon, anchorZone);

    renderPlace();
    renderCards(sun, delta);
    renderSky();
  } else {
    renderEmptyState();
  }

  renderSaved();
  syncUrl();
}

/* ------------------------------------------------------------------ *
 * Date controls
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Control surface
 *
 * The two ways the rest of the app changes what is on screen. The search box,
 * the map and geolocation will all funnel into `setPlace`; nothing else needs
 * to know how rendering works.
 * ------------------------------------------------------------------ */

/** Show a different date, keeping the current place. */
export function setDate(civilDate) {
  state.date = civilDate;
  render();
}

/**
 * Show a different place, keeping the date being viewed — switching from
 * Tokyo to Oslo while looking at 21 June should stay on 21 June.
 *
 * @param {{name:string, region?:string, lat:number, lon:number, timeZone:string}} place
 */
export function setPlace(place) {
  state.place = place;
  // A date the viewer asked for survives the change of place; a date that was
  // only ever "today" is re-read from the new zone.
  if (!state.dateIsExplicit) {
    state.date = civilDateInZone(Date.now(), place.timeZone);
  }
  // However the place arrived, the marker follows it, so the map, the search
  // box and the header never disagree about where we are.
  mapHandle?.moveTo(place.lat, place.lon);
  // Remembered for the next visit. Not the date, though: a date chosen a week
  // ago is stale on arrival, where a place is not.
  writeLastPlace(storage, place);
  render();
}

/* ------------------------------------------------------------------ *
 * The place picker
 * ------------------------------------------------------------------ */

const SEARCH_DEBOUNCE_MS = 250;

/** The in-flight search, so a superseded one can be abandoned. */
let searchController = null;
let debounceTimer = 0;
let offered = [];
let activeIndex = -1;

function setStatus(message, tone) {
  dom.pickerStatus.textContent = message;
  if (tone) dom.pickerStatus.dataset.tone = tone;
  else delete dom.pickerStatus.dataset.tone;
}

function closeResults() {
  offered = [];
  activeIndex = -1;
  dom.searchResults.replaceChildren();
  dom.searchResults.hidden = true;
  dom.searchInput.setAttribute('aria-expanded', 'false');
  dom.searchInput.removeAttribute('aria-activedescendant');
}

function highlight(index) {
  activeIndex = index;
  const options = [...dom.searchResults.children];
  options.forEach((option, at) => {
    const isActive = at === index;
    option.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) {
      dom.searchInput.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    }
  });
  if (index < 0) dom.searchInput.removeAttribute('aria-activedescendant');
}

function choose(place) {
  closeResults();
  dom.searchInput.value = place.name;
  setStatus('');
  setPlace(place);
}

function showResults(places) {
  offered = places;
  activeIndex = -1;

  const options = places.map((place, index) => {
    const option = document.createElement('li');
    option.className = 'picker__result';
    option.id = `search-result-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');

    const name = document.createElement('span');
    name.textContent = place.name;

    const where = document.createElement('span');
    where.className = 'picker__result-where';
    where.textContent = place.region;

    option.append(name, where);
    // mousedown, not click: it fires before the input loses focus, so the
    // list is still open when the choice is made.
    option.addEventListener('mousedown', (event) => {
      event.preventDefault();
      choose(place);
    });
    return option;
  });

  dom.searchResults.replaceChildren(...options);
  dom.searchResults.hidden = false;
  dom.searchInput.setAttribute('aria-expanded', 'true');
}

async function runSearch(query) {
  // Abandon whatever was already in flight. Without this, a slow response to
  // "Lon" can arrive after a fast one to "London" and replace it.
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;

  setStatus('Searching…');

  try {
    const places = await searchPlaces(query, { signal: controller.signal });
    if (controller !== searchController) return; // superseded while awaiting

    if (!places.length) {
      closeResults();
      setStatus(`Nothing found for “${query}”. Try a different spelling.`);
      return;
    }

    showResults(places);
    setStatus(
      places.length === 1
        ? '1 match — press Enter to choose it.'
        : `${places.length} matches — use the arrow keys, then Enter.`
    );
  } catch (error) {
    if (error?.name === 'AbortError') return;
    closeResults();
    setStatus(error?.message ?? 'The search did not work. Try again.', 'error');
  }
}

function onSearchInput() {
  clearTimeout(debounceTimer);
  const query = dom.searchInput.value.trim();

  if (query.length < MIN_QUERY_LENGTH) {
    searchController?.abort();
    closeResults();
    setStatus('');
    return;
  }

  debounceTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
}

function onSearchKeydown(event) {
  if (event.key === 'Escape') {
    closeResults();
    setStatus('');
    return;
  }

  if (!offered.length) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    highlight((activeIndex + 1) % offered.length);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlight(activeIndex <= 0 ? offered.length - 1 : activeIndex - 1);
  } else if (event.key === 'Enter' && activeIndex >= 0) {
    event.preventDefault();
    choose(offered[activeIndex]);
  }
}

function onSearchSubmit(event) {
  event.preventDefault();
  clearTimeout(debounceTimer);

  // Enter with a highlighted option takes it; otherwise search immediately
  // rather than waiting out the debounce.
  if (activeIndex >= 0 && offered[activeIndex]) {
    choose(offered[activeIndex]);
    return;
  }

  const query = dom.searchInput.value.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    setStatus(`Type at least ${MIN_QUERY_LENGTH} characters to search.`);
    return;
  }
  runSearch(query);
}

/* ------------------------------------------------------------------ *
 * Coordinates with no name attached
 * ------------------------------------------------------------------ */

/** The pick being resolved, so a quick second click abandons the first. */
let pickController = null;

/**
 * Turn a bare pair of coordinates into a place and show it.
 *
 * Both lookups go out together and the page is updated once, when they land.
 * Rendering immediately would mean showing times on the wrong clock — the zone
 * is not known yet — and then having them jump a moment later.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{fallbackName: string, working: string}} labels
 */
async function adoptCoordinates(lat, lon, { fallbackName, working }) {
  pickController?.abort();
  const controller = new AbortController();
  pickController = controller;

  setStatus(working);

  try {
    const [zone, description] = await Promise.all([
      resolveTimeZone(lat, lon, { signal: controller.signal }),
      describePlace(lat, lon, { signal: controller.signal }),
    ]);

    if (controller !== pickController) return; // a newer pick is in flight

    setPlace({
      name: description.name || fallbackName,
      region: description.region,
      lat,
      lon,
      timeZone: zone.timeZone,
      zoneIsGuess: zone.guessed,
      source: 'coordinates',
    });

    setStatus(
      zone.guessed
        ? 'The time zone lookup failed — times are in your own zone, not this place’s.'
        : ''
    );
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setStatus(error?.message ?? 'Could not work out what is at that spot.', 'error');
  }
}

async function runLocate() {
  dom.locateBtn.disabled = true;
  closeResults();
  setStatus('Finding your location…');

  try {
    const { lat, lon } = await locate();
    await adoptCoordinates(lat, lon, {
      // Only used where the reverse lookup comes back with nothing — mid-ocean,
      // or if the service is down.
      fallbackName: 'Your location',
      working: 'Found you. Working out the time zone…',
    });
  } catch (error) {
    setStatus(error?.message ?? 'Could not get your location.', 'error');
  } finally {
    dom.locateBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * The map
 * ------------------------------------------------------------------ */

let mapHandle = null;

function handleMapPick(lat, lon) {
  closeResults();
  dom.searchInput.value = '';
  adoptCoordinates(lat, lon, {
    fallbackName: 'Selected point',
    working: 'Working out what is there…',
  });
}

function initMap() {
  mapHandle = createMap(dom.map, {
    onPick: handleMapPick,
    place: state.place ?? undefined,
  });

  if (!mapHandle) {
    // Leaflet never arrived. Say so where the map would have been, and leave
    // the rest of the app alone — search and your location still work, and the
    // sun maths never needed the network.
    dom.mapPlaceholder.textContent =
      'The map could not be loaded. Search for a city or use your location instead.';
    return;
  }

  // Leaflet has taken over the container, so the placeholder can go.
  dom.mapPlaceholder.remove();
}

function wirePicker() {
  // Own the closed state rather than inheriting it from the markup, so the
  // attributes and the variables above can never start out disagreeing.
  closeResults();

  dom.searchInput.addEventListener('input', onSearchInput);
  dom.searchInput.addEventListener('keydown', onSearchKeydown);
  dom.searchForm.addEventListener('submit', onSearchSubmit);
  dom.locateBtn.addEventListener('click', runLocate);

  // Dismiss the list when attention moves elsewhere on the page.
  document.addEventListener('click', (event) => {
    if (!dom.searchResults.hidden && !event.target.closest?.('.picker')) closeResults();
  });
}

function wireDateControls() {
  dom.dateInput.min = '1900-01-01';
  dom.dateInput.max = '2100-12-31';

  dom.dateInput.addEventListener('change', () => {
    try {
      const chosen = civilDateFromISO(dom.dateInput.value);
      state.dateIsExplicit = true;
      setDate(chosen);
    } catch {
      // Cleared or half-typed: put the current date back rather than blanking
      // the whole page.
      dom.dateInput.value = toISODate(state.date);
    }
  });

  dom.prevDay.addEventListener('click', () => {
    state.dateIsExplicit = true;
    setDate(addDays(state.date, -1));
  });

  dom.nextDay.addEventListener('click', () => {
    state.dateIsExplicit = true;
    setDate(addDays(state.date, 1));
  });

  dom.today.addEventListener('click', () => {
    state.dateIsExplicit = false;
    setDate(civilDateInZone(Date.now(), state.place?.timeZone ?? viewerTimeZone()));
  });
}

function wireSaved() {
  dom.saveBtn.addEventListener('click', togglePin);
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

/**
 * Pick up where the last visit left off, or where a shared link points.
 *
 * Order matters: a link someone was *sent* has to beat whatever this browser
 * happens to remember, or following a link to Tokyo would show you Bangalore.
 * Geolocation is deliberately not in this chain — a permission prompt nobody
 * asked for is a bad way to open a page.
 */
function restoreState() {
  state.saved = readSavedPlaces(storage);

  const fromUrl = parseUrlState(globalThis.location?.search ?? '');
  if (fromUrl.date) {
    state.date = fromUrl.date;
    state.dateIsExplicit = true;
  }

  const place = fromUrl.place ?? readLastPlace(storage);
  if (!place) return;

  state.place = { ...place, name: place.name || 'Selected point' };
  // Same rule as `setPlace`: a date nobody asked for is read from the zone of
  // the place now on screen.
  if (!state.dateIsExplicit) {
    state.date = civilDateInZone(Date.now(), state.place.timeZone);
  }
}

wireDateControls();
wirePicker();
wireSaved();
restoreState();
render();

// Leaflet is loaded with `defer`, so it is ready by the time a module script
// runs — but check rather than assume, and treat its absence as ordinary.
initMap();

// Keep the backdrop honest as the day goes on. Only the sky changes, so this
// does no real work.
setInterval(renderSky, 60000);
