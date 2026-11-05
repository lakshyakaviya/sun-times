/**
 * Solar event math — NOAA / Meeus low-precision algorithm.
 *
 * Pure module: no DOM, no network, no state. Accurate to well under a minute
 * for sunrise and sunset at non-polar latitudes, which is far better than the
 * one-minute resolution this app displays.
 *
 * Every time this module returns is a real UTC instant (a `Date`). Formatting
 * for display is the caller's job.
 *
 * Dates going *in* are plain civil dates: `{ year, month, day }` with month
 * 1-12, the calendar date *at the place*. Each call anchors on the solar day
 * whose transit is nearest noon on that date, so pass the place's IANA zone
 * whenever it is known: a few places run clocks far from their solar time
 * (Kiritimati is at 157°W on UTC+14, western China is on Beijing time), and
 * without the zone the longitude fallback can land on the adjacent day.
 */

import { zonedWallTimeToUtcMs } from './time.js';

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = 23.4397 * RAD;

/**
 * Altitudes of the sun's centre, in degrees, that define each event.
 * -0.833° puts the sun's *upper limb* on the horizon once mean atmospheric
 * refraction (~34') and the solar semi-diameter (~16') are accounted for —
 * this is the standard definition of sunrise and sunset.
 */
export const ALTITUDE = {
  sunriseSunset: -0.833,
  goldenHour: 6,
};

/* ------------------------------------------------------------------ *
 * Civil date helpers
 * ------------------------------------------------------------------ */

/** `'2026-11-05'` → `{ year: 2026, month: 11, day: 5 }` */
export function civilDateFromISO(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!match) throw new RangeError(`Not an ISO date: ${iso}`);
  return { year: +match[1], month: +match[2], day: +match[3] };
}

/** `{ year: 2026, month: 11, day: 5 }` → `'2026-11-05'` */
export function toISODate({ year, month, day }) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** Civil date `delta` days away, normalised across month and year ends. */
export function addDays({ year, month, day }, delta) {
  const t = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/* ------------------------------------------------------------------ *
 * Julian day conversions
 * ------------------------------------------------------------------ */

const toJulian = (ms) => ms / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date(Math.round((j + 0.5 - J1970) * DAY_MS));
const toDays = (ms) => toJulian(ms) - J2000;

/* ------------------------------------------------------------------ *
 * Position of the sun
 * ------------------------------------------------------------------ */

const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M) {
  // Equation of the centre, then perihelion of the Earth's orbit.
  const centre = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + centre + RAD * 102.9372 + Math.PI;
}

const declination = (L) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
const rightAscension = (L) => Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L));
const siderealTime = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;

/* ------------------------------------------------------------------ *
 * Transit and event times
 * ------------------------------------------------------------------ */

const J0 = 0.0009;

const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

/**
 * Hour angle at which the sun's centre sits at altitude `hRad`, or `null` when
 * that altitude is never reached on this day (the polar cases).
 */
function hourAngle(hRad, phi, dec) {
  const cosH =
    (Math.sin(hRad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH > 1 || cosH < -1) return null;
  return Math.acos(cosH);
}

/**
 * A UTC instant somewhere inside the local day of `civilDate` at this place,
 * used to pick which solar day to report on. Local noon by the place's own
 * clock when we know its zone; mean solar noon from the longitude otherwise.
 */
function noonAnchor(civilDate, lon, timeZone) {
  if (timeZone) {
    try {
      return zonedWallTimeToUtcMs({ ...civilDate, hour: 12 }, timeZone);
    } catch {
      // Unknown zone name — fall through to the longitude estimate.
    }
  }
  const { year, month, day } = civilDate;
  return Date.UTC(year, month - 1, day, 12) - (lon / 15) * 3600000;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Sun events for one calendar day at one place.
 *
 * @param {{year:number, month:number, day:number}} civilDate local calendar date
 * @param {number} lat latitude in degrees, north positive
 * @param {number} lon longitude in degrees, east positive
 * @param {string} [timeZone] IANA zone of the place, e.g. `'Asia/Tokyo'`
 * @returns {{
 *   solarNoon: Date,
 *   sunrise: Date|null,
 *   sunset: Date|null,
 *   dayLengthSeconds: number,
 *   polar: null|'midnight-sun'|'polar-night',
 *   golden: null|{morning:{start:Date,end:Date}, evening:{start:Date,end:Date}},
 *   goldenAllDay: boolean,
 *   maxAltitude: number,
 *   declination: number
 * }}
 */
export function sunTimes(civilDate, lat, lon, timeZone) {
  const lw = RAD * -lon;
  const phi = RAD * lat;

  const d = toDays(noonAnchor(civilDate, lon, timeZone));
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const jNoon = solarTransitJ(ds, M, L);

  const solarNoon = fromJulian(jNoon);
  // Altitude of the sun's centre at transit.
  const maxAltitude = 90 - Math.abs(lat - dec / RAD);

  /** Julian day of the *descending* crossing of `altitudeDeg`, or null. */
  const descendingJ = (altitudeDeg) => {
    const w = hourAngle(altitudeDeg * RAD, phi, dec);
    if (w === null) return null;
    return solarTransitJ(approxTransit(w, lw, n), M, L);
  };
  /** The ascending crossing mirrors the descending one about transit. */
  const ascending = (jDescending) => fromJulian(jNoon - (jDescending - jNoon));

  const jSunset = descendingJ(ALTITUDE.sunriseSunset);

  let polar = null;
  let sunrise = null;
  let sunset = null;
  let dayLengthSeconds;

  if (jSunset === null) {
    // The sun never crosses the horizon today: it is either up all day or down all day.
    polar = maxAltitude > ALTITUDE.sunriseSunset ? 'midnight-sun' : 'polar-night';
    dayLengthSeconds = polar === 'midnight-sun' ? 86400 : 0;
  } else {
    sunset = fromJulian(jSunset);
    sunrise = ascending(jSunset);
    dayLengthSeconds = Math.round((sunset - sunrise) / 1000);
  }

  // Golden hour: sunrise up to +6°, and +6° back down to sunset.
  // Under midnight sun or polar night the morning/evening framing stops making
  // sense (the sun can dip towards the horizon around local midnight instead),
  // so we report no golden hour rather than an invented one.
  let golden = null;
  let goldenAllDay = false;

  if (!polar) {
    const jGolden = descendingJ(ALTITUDE.goldenHour);
    if (jGolden === null) {
      // The sun rises but never climbs to 6° — the whole short day is golden.
      goldenAllDay = true;
      golden = {
        morning: { start: sunrise, end: solarNoon },
        evening: { start: solarNoon, end: sunset },
      };
    } else {
      golden = {
        morning: { start: sunrise, end: ascending(jGolden) },
        evening: { start: fromJulian(jGolden), end: sunset },
      };
    }
  }

  return {
    solarNoon,
    sunrise,
    sunset,
    dayLengthSeconds,
    polar,
    golden,
    goldenAllDay,
    maxAltitude,
    declination: dec / RAD,
  };
}

/**
 * How much longer or shorter this day is than the one before it.
 * `null` when either day has no sunrise/sunset to measure.
 *
 * @returns {{seconds:number, previousDayLengthSeconds:number}|null}
 */
export function dayLengthDelta(civilDate, lat, lon, timeZone) {
  const today = sunTimes(civilDate, lat, lon, timeZone);
  const yesterday = sunTimes(addDays(civilDate, -1), lat, lon, timeZone);
  if (today.polar || yesterday.polar) return null;
  return {
    seconds: today.dayLengthSeconds - yesterday.dayLengthSeconds,
    previousDayLengthSeconds: yesterday.dayLengthSeconds,
  };
}

/**
 * Where the sun is at a given instant, for the time-of-day sky tint.
 *
 * @param {Date|number} instant
 * @returns {{altitude:number, azimuth:number}} degrees; azimuth clockwise from north
 */
export function sunPosition(instant, lat, lon) {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  const lw = RAD * -lon;
  const phi = RAD * lat;

  const d = toDays(ms);
  const L = eclipticLongitude(solarMeanAnomaly(d));
  const dec = declination(L);
  const H = siderealTime(d, lw) - rightAscension(L);

  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  );
  const azimuth = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)
  );

  return { altitude: altitude / RAD, azimuth: (azimuth / RAD + 180 + 360) % 360 };
}
