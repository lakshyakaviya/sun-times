/**
 * Solar event math — the NOAA Solar Calculator equations.
 *
 * Pure module: no DOM, no network, no state. Sunrise and sunset land within
 * about 15 seconds of published almanac times at ordinary latitudes, which is
 * well inside the one-minute resolution this app displays. Accuracy degrades
 * above roughly 72° of latitude, where the sun crosses the horizon at such a
 * shallow angle that small errors in its position become large errors in time.
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
 *
 * On the choice of series: the widely copied compact formulation (a fixed
 * mean-anomaly rate plus the J2000 longitude of perihelion) carries a phase
 * error that grows about 0.017° a year as the perihelion precesses — roughly
 * 0.45° by 2026, which shows up as 0.18° of declination error near the
 * equinoxes and shifts sunrise by over a minute at high latitudes. The series
 * below carry their own time dependence, so they do not drift.
 */

import { zonedWallTimeToUtcMs } from './time.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const J2000 = 2451545;

/** Degree-argument trig, to keep the astronomical series readable. */
const sin = (deg) => Math.sin(deg * RAD);
const cos = (deg) => Math.cos(deg * RAD);
const tan = (deg) => Math.tan(deg * RAD);

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
 * The sun's position, as a series in Julian centuries
 * ------------------------------------------------------------------ */

const julianDay = (ms) => ms / DAY_MS + 2440587.5;

/**
 * Where the sun is, and how far apparent time has drifted from mean time.
 *
 * @param {number} ms epoch milliseconds
 * @returns {{declination:number, rightAscension:number, equationOfTime:number}}
 *   declination and right ascension in degrees, equation of time in minutes
 */
function solarModel(ms) {
  const T = (julianDay(ms) - J2000) / 36525; // Julian centuries since J2000

  // Geometric mean longitude and mean anomaly of the sun.
  const meanLongitude = 280.46646 + T * (36000.76983 + T * 0.0003032);
  const meanAnomaly = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const eccentricity = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  // Equation of the centre: the correction from a circular orbit to the real one.
  const centre =
    sin(meanAnomaly) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    sin(2 * meanAnomaly) * (0.019993 - 0.000101 * T) +
    sin(3 * meanAnomaly) * 0.000289;

  // Apparent longitude folds in nutation and the aberration of light.
  const lunarNode = 125.04 - 1934.136 * T;
  const apparentLongitude = meanLongitude + centre - 0.00569 - 0.00478 * sin(lunarNode);

  // Obliquity of the ecliptic, with the nutation correction.
  const meanObliquity =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * cos(lunarNode);

  const declination = Math.asin(sin(obliquity) * sin(apparentLongitude)) * DEG;
  const rightAscension =
    Math.atan2(cos(obliquity) * sin(apparentLongitude), cos(apparentLongitude)) * DEG;

  // Equation of time, in minutes: apparent solar time minus mean solar time.
  const y = tan(obliquity / 2) ** 2;
  const equationOfTime =
    4 * DEG * (
      y * sin(2 * meanLongitude) -
      2 * eccentricity * sin(meanAnomaly) +
      4 * eccentricity * y * sin(meanAnomaly) * cos(2 * meanLongitude) -
      0.5 * y * y * sin(4 * meanLongitude) -
      1.25 * eccentricity * eccentricity * sin(2 * meanAnomaly)
    );

  return { declination, rightAscension, equationOfTime };
}

/* ------------------------------------------------------------------ *
 * Anchoring a solar day
 * ------------------------------------------------------------------ */

/**
 * A UTC instant inside the local day of `civilDate` at this place, used to pick
 * which solar day to report on. Local noon by the place's own clock when we
 * know its zone; mean solar noon from the longitude otherwise.
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

/**
 * The instant the sun crosses the meridian, on the solar day nearest `anchorMs`.
 *
 * Mean noon is 720 minutes after UTC midnight, shifted 4 minutes per degree of
 * longitude; the equation of time carries it to apparent noon. Iterated once
 * so the equation of time is evaluated at transit rather than at midnight.
 */
function solarTransitMs(anchorMs, lon) {
  const utcMidnight = Math.floor(anchorMs / DAY_MS) * DAY_MS;
  let transit = anchorMs;
  for (let pass = 0; pass < 2; pass++) {
    const { equationOfTime } = solarModel(transit);
    transit = utcMidnight + (720 - 4 * lon - equationOfTime) * MINUTE_MS;
    // Keep the transit on the solar day closest to the anchor.
    while (transit - anchorMs > DAY_MS / 2) transit -= DAY_MS;
    while (anchorMs - transit > DAY_MS / 2) transit += DAY_MS;
  }
  return transit;
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
  const anchorMs = noonAnchor(civilDate, lon, timeZone);
  const transitMs = solarTransitMs(anchorMs, lon);
  const solarNoon = new Date(Math.round(transitMs));

  const declinationAtNoon = solarModel(transitMs).declination;
  // Altitude of the sun's centre at transit.
  const maxAltitude = 90 - Math.abs(lat - declinationAtNoon);

  /**
   * The instant the sun crosses `altitudeDeg`, rising (`direction` -1) or
   * setting (+1), or `null` when it never reaches that altitude today.
   *
   * The hour angle is the sun's angular distance from the meridian, and the
   * sun covers 15° an hour, so four minutes per degree converts it to time.
   * The loop exists because the hour angle depends on the declination *at the
   * crossing*, which is hours from transit — declination moves up to 0.4° a
   * day near the equinoxes, enough to shift an event by a minute if taken
   * from noon. Each pass re-evaluates at the time the last pass estimated.
   */
  const crossing = (altitudeDeg, direction) => {
    let ms = transitMs;
    for (let pass = 0; pass < 3; pass++) {
      const { declination } = solarModel(ms);
      const cosHourAngle =
        (sin(altitudeDeg) - sin(lat) * sin(declination)) / (cos(lat) * cos(declination));
      if (cosHourAngle > 1 || cosHourAngle < -1) return null;
      const hourAngle = Math.acos(cosHourAngle) * DEG;
      ms = transitMs + direction * hourAngle * 4 * MINUTE_MS;
    }
    return new Date(Math.round(ms));
  };

  const sunrise = crossing(ALTITUDE.sunriseSunset, -1);
  const sunset = crossing(ALTITUDE.sunriseSunset, 1);

  let polar = null;
  let dayLengthSeconds;

  if (sunrise === null || sunset === null) {
    // The sun never crosses the horizon today: it is either up all day or down all day.
    polar = maxAltitude > ALTITUDE.sunriseSunset ? 'midnight-sun' : 'polar-night';
    dayLengthSeconds = polar === 'midnight-sun' ? 86400 : 0;
  } else {
    dayLengthSeconds = Math.round((sunset - sunrise) / 1000);
  }

  // Golden hour: sunrise up to +6°, and +6° back down to sunset.
  // Under midnight sun or polar night the morning/evening framing stops making
  // sense (the sun can dip towards the horizon around local midnight instead),
  // so we report no golden hour rather than an invented one.
  let golden = null;
  let goldenAllDay = false;

  if (!polar) {
    const morningEnd = crossing(ALTITUDE.goldenHour, -1);
    const eveningStart = crossing(ALTITUDE.goldenHour, 1);
    if (morningEnd === null || eveningStart === null) {
      // The sun rises but never climbs to 6° — the whole short day is golden.
      goldenAllDay = true;
      golden = {
        morning: { start: sunrise, end: solarNoon },
        evening: { start: solarNoon, end: sunset },
      };
    } else {
      golden = {
        morning: { start: sunrise, end: morningEnd },
        evening: { start: eveningStart, end: sunset },
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
    declination: declinationAtNoon,
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
  const { declination, rightAscension } = solarModel(ms);

  // Greenwich mean sidereal time, then the local hour angle of the sun.
  const gmst = 280.46061837 + 360.98564736629 * (julianDay(ms) - J2000);
  const hourAngle = gmst + lon - rightAscension;

  const altitude =
    Math.asin(sin(lat) * sin(declination) + cos(lat) * cos(declination) * cos(hourAngle)) * DEG;
  const azimuth =
    Math.atan2(sin(hourAngle), cos(hourAngle) * sin(lat) - tan(declination) * cos(lat)) * DEG;

  return { altitude, azimuth: (azimuth + 180 + 360) % 360 };
}
