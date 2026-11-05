/**
 * Wiring: state, rendering, and the date controls.
 *
 * The app has two halves that meet at a narrow seam — something decides
 * *where*, and this file turns a where plus a when into what you see:
 *
 *   { lat, lon, timeZone, name }  →  computed sun times  →  the page
 *
 * Only the left-hand side is still scaffolded. `FIXED_PLACE` below stands in
 * for the search box, the map and geolocation, so the display path can be
 * built and checked against known values with no network and no permission
 * prompts in the way. Later steps replace that constant with a real picker and
 * nothing here needs to change.
 */

import {
  sunTimes,
  dayLengthDelta,
  sunPosition,
  civilDateFromISO,
  toISODate,
  addDays,
} from './sun.js';

import { civilDateInZone } from './time.js';

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

/**
 * Scaffolding, removed once the picker exists. Bengaluru is a useful stand-in
 * because +5:30 is not a whole number of hours, so a careless offset shows up
 * immediately.
 */
const FIXED_PLACE = {
  name: 'Bengaluru',
  region: 'Karnataka, India',
  lat: 12.9716,
  lon: 77.5946,
  timeZone: 'Asia/Kolkata',
};

const state = {
  place: FIXED_PLACE,
  date: civilDateInZone(Date.now(), FIXED_PLACE.timeZone),
};

const el = (id) => document.getElementById(id);

const dom = {
  sky: el('sky'),
  placeName: el('place-name'),
  placeMeta: el('place-meta'),
  dateInput: el('date-input'),
  prevDay: el('prev-day'),
  nextDay: el('next-day'),
  today: el('today-btn'),
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
  bits.push(`times in ${formatZoneLabel(now, place.timeZone)}`);
  dom.placeMeta.textContent = bits.join(' · ');

  dom.dateInput.value = toISODate(date);
  dom.dateInput.setAttribute('aria-label', `Date — showing ${formatDateLabel(date)}`);
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
  const { altitude, azimuth } = sunPosition(Date.now(), place.lat, place.lon);

  let phase;
  if (altitude > 6) phase = 'day';
  else if (altitude < -6) phase = 'night';
  else phase = azimuth < 180 ? 'dawn' : 'dusk';

  dom.sky.dataset.phase = phase;
}

function render() {
  const { place, date } = state;
  const sun = sunTimes(date, place.lat, place.lon, place.timeZone);
  const delta = dayLengthDelta(date, place.lat, place.lon, place.timeZone);

  renderPlace();
  renderCards(sun, delta);
  renderSky();
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
  render();
}

function wireDateControls() {
  dom.dateInput.min = '1900-01-01';
  dom.dateInput.max = '2100-12-31';

  dom.dateInput.addEventListener('change', () => {
    try {
      setDate(civilDateFromISO(dom.dateInput.value));
    } catch {
      // Cleared or half-typed: put the current date back rather than blanking
      // the whole page.
      dom.dateInput.value = toISODate(state.date);
    }
  });

  dom.prevDay.addEventListener('click', () => setDate(addDays(state.date, -1)));
  dom.nextDay.addEventListener('click', () => setDate(addDays(state.date, 1)));
  dom.today.addEventListener('click', () =>
    setDate(civilDateInZone(Date.now(), state.place.timeZone))
  );
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

wireDateControls();
render();

// Keep the backdrop honest as the day goes on. Only the sky changes, so this
// does no real work.
setInterval(renderSky, 60000);
