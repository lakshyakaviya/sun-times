/**
 * Test suite for js/sun.js and js/time.js.
 *
 * Runs in two places off this one source: `test.html` renders it in a browser,
 * and `node js/sun.test.js` prints it to a terminal and exits non-zero on
 * failure.
 *
 * Published sunrise/sunset tables are only used as a sanity anchor (two of
 * them). The weight of the suite is on checks that cannot be satisfied by a
 * plausible-looking wrong answer:
 *
 *   - `sunPosition()` derives the sun's altitude from sidereal time and right
 *     ascension, a different formulation from the hour-angle transit solver
 *     behind `sunTimes()`. Feeding each event time back through it must put the
 *     sun at the altitude that defines that event. Two independent paths have
 *     to agree.
 *   - Physical identities that hold regardless of implementation: equinox days
 *     are ~12h everywhere, sunrise and sunset azimuths are symmetric about the
 *     meridian, solar noon is within the equation of time of mean noon.
 *   - Regressions for the cases that actually bit: calendar-day anchoring where
 *     a country's clock is far from its solar time, and the polar flags.
 */

import {
  sunTimes,
  sunPosition,
  dayLengthDelta,
  civilDateFromISO,
  toISODate,
  addDays,
  ALTITUDE,
} from './sun.js';

import {
  zoneOffsetMs,
  zonedWallTimeToUtcMs,
  civilDateInZone,
  wallTimeInZone,
  isValidTimeZone,
} from './time.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Values from published almanac tables, used as an absolute anchor. */
const PUBLISHED = [
  {
    place: 'London', lat: 51.5074, lon: -0.1278, tz: 'Europe/London',
    date: '2026-06-21', sunrise: '04:43', sunset: '21:21', note: 'June solstice',
  },
  {
    place: 'London', lat: 51.5074, lon: -0.1278, tz: 'Europe/London',
    date: '2026-12-21', sunrise: '08:04', sunset: '15:53', note: 'December solstice',
  },
];

/** A spread of latitudes, longitudes, and clock-vs-solar-time oddities. */
const PLACES = [
  { name: 'Reykjavík',  lat:  64.1466, lon:  -21.9426, tz: 'Atlantic/Reykjavik' },
  { name: 'London',     lat:  51.5074, lon:   -0.1278, tz: 'Europe/London' },
  { name: 'New York',   lat:  40.7128, lon:  -74.0060, tz: 'America/New_York' },
  { name: 'Kashgar',    lat:  39.4704, lon:   75.9898, tz: 'Asia/Shanghai' },
  { name: 'Tokyo',      lat:  35.6762, lon:  139.6503, tz: 'Asia/Tokyo' },
  { name: 'Bengaluru',  lat:  12.9716, lon:   77.5946, tz: 'Asia/Kolkata' },
  { name: 'Kiritimati', lat:   1.8721, lon: -157.4278, tz: 'Pacific/Kiritimati' },
  { name: 'Nairobi',    lat:  -1.2921, lon:   36.8219, tz: 'Africa/Nairobi' },
  { name: 'Sydney',     lat: -33.8688, lon:  151.2093, tz: 'Australia/Sydney' },
  { name: 'Ushuaia',    lat: -54.8019, lon:  -68.3030, tz: 'America/Argentina/Ushuaia' },
];

const DATES = [
  '2026-01-15', '2026-03-20', '2026-05-02', '2026-06-21',
  '2026-09-23', '2026-11-05', '2026-12-21', '2027-03-14',
];

/* ------------------------------------------------------------------ *
 * Tiny assertion harness
 * ------------------------------------------------------------------ */

function createRunner() {
  const results = [];
  let group = '';
  return {
    results,
    group(name) { group = name; },
    /** Record a pass/fail. `detail` should carry the measured value either way. */
    check(name, ok, detail = '') {
      results.push({ group, name, ok: Boolean(ok), detail: String(detail) });
    },
    /** Record a numeric tolerance check, reporting the measured error. */
    within(name, actual, expected, tolerance, unit = '') {
      const error = Math.abs(actual - expected);
      results.push({
        group,
        name,
        ok: error <= tolerance,
        detail: `${actual.toFixed(3)}${unit} vs ${expected.toFixed(3)}${unit}` +
                ` — off by ${error.toFixed(3)}${unit}, tolerance ${tolerance}${unit}`,
      });
    },
  };
}

const minutesApart = (a, b) => Math.abs(a.getTime() - b.getTime()) / 60000;

/** `'04:43'` on `date` in `tz`, as a UTC instant. */
function wallTimeInstant(date, hhmm, tz) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return new Date(zonedWallTimeToUtcMs({ ...civilDateFromISO(date), hour, minute }, tz));
}

const hhmm = (instant, tz) =>
  instant === null ? '—' :
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(instant);

/** Shortest signed angular distance from `a` to `b`, in degrees. */
const angleDiff = (a, b) => {
  const d = ((a - b + 540) % 360) - 180;
  return Math.abs(d);
};

const cosDeg = (deg) => Math.cos(deg * Math.PI / 180);

/**
 * The sun's declination at an instant. An observer at the north pole sees the
 * sun at an altitude equal to its declination, which lets the position routine
 * report declination without sun.js having to export it separately.
 */
const declinationOf = (instant) => sunPosition(instant, 90, 0).altitude;

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

export function runTests() {
  const t = createRunner();

  /* --- Published reference times ----------------------------------- */

  t.group('Published almanac times');
  for (const ref of PUBLISHED) {
    const s = sunTimes(civilDateFromISO(ref.date), ref.lat, ref.lon, ref.tz);
    for (const event of ['sunrise', 'sunset']) {
      const expected = wallTimeInstant(ref.date, ref[event], ref.tz);
      const off = s[event] === null ? Infinity : minutesApart(s[event], expected);
      t.check(
        `${ref.place} ${ref.date} ${event} (${ref.note})`,
        off <= 1,
        `computed ${hhmm(s[event], ref.tz)}, published ${ref[event]} — off by ${off.toFixed(1)} min`
      );
    }
  }

  /* --- Cross-check event times against sunPosition() ---------------- */
  // If sunTimes() says the sun sets at 18:51, then the independent position
  // routine must put the sun on the horizon at 18:51.

  t.group('Event times agree with the sun-position formula');
  {
    let worstHorizon = 0, worstHorizonAt = '';
    let worstGolden = 0, worstGoldenAt = '';
    let worstNoonAlt = 0, worstNoonAltAt = '';
    let worstAzExcess = -Infinity, worstAzExcessAt = '';
    let noonAzimuthOk = true, noonAzimuthDetail = '';
    let sampled = 0;

    for (const p of PLACES) {
      for (const iso of DATES) {
        const s = sunTimes(civilDateFromISO(iso), p.lat, p.lon, p.tz);
        const where = `${p.name} ${iso}`;

        // Solar noon altitude must match the closed-form maximum altitude.
        const noonPos = sunPosition(s.solarNoon, p.lat, p.lon);
        const noonErr = Math.abs(noonPos.altitude - s.maxAltitude);
        if (noonErr > worstNoonAlt) { worstNoonAlt = noonErr; worstNoonAltAt = where; }

        // At transit the sun is due south (north of the subsolar latitude) or
        // due north (south of it). Skipped when the sun passes close to the
        // zenith, where azimuth is meaningless: a second of time swings it by
        // degrees, so this says nothing about correctness there.
        if (Math.abs(p.lat - s.declination) > 3) {
          const expectedNoonAz = p.lat > s.declination ? 180 : 0;
          const noonAzErr = angleDiff(noonPos.azimuth, expectedNoonAz);
          if (noonAzErr > 1.5) {
            noonAzimuthOk = false;
            noonAzimuthDetail = `${where}: azimuth ${noonPos.azimuth.toFixed(2)}°, expected ~${expectedNoonAz}°`;
          }
        }

        if (s.polar) continue;
        sampled++;

        for (const [event, instant] of [['sunrise', s.sunrise], ['sunset', s.sunset]]) {
          const err = Math.abs(sunPosition(instant, p.lat, p.lon).altitude - ALTITUDE.sunriseSunset);
          if (err > worstHorizon) { worstHorizon = err; worstHorizonAt = `${where} ${event}`; }
        }

        // Sunrise and sunset sit symmetrically either side of the meridian —
        // but only for a fixed declination. The sun's declination shifts over
        // the course of the day, which skews the pair by a genuinely
        // measurable amount (a quarter of a degree at the equinox in New York,
        // more than half a degree in Reykjavík in spring). So rather than
        // assert symmetry against zero, compare the measured skew with the
        // skew that declination drift predicts:
        //
        //   d(azimuth)/d(declination) = cos δ / (sin az · cos h₀ · cos φ)
        //
        // which leaves only model error in the residual.
        const azRise = sunPosition(s.sunrise, p.lat, p.lon).azimuth;
        const azSet = sunPosition(s.sunset, p.lat, p.lon).azimuth;
        const symErr = angleDiff(azRise + azSet, 360);

        const declinationDrift = Math.abs(declinationOf(s.sunset) - declinationOf(s.sunrise));
        const sensitivity =
          Math.abs(cosDeg(s.declination)) /
          (Math.abs(Math.sin(azRise * Math.PI / 180)) *
           cosDeg(ALTITUDE.sunriseSunset) * Math.abs(cosDeg(p.lat)));
        const excess = symErr - (declinationDrift * sensitivity + 0.05);
        if (excess > worstAzExcess) {
          worstAzExcess = excess;
          worstAzExcessAt = `${where} (measured ${symErr.toFixed(3)}°, ` +
            `predicted ${(declinationDrift * sensitivity).toFixed(3)}°)`;
        }

        if (!s.goldenAllDay) {
          for (const instant of [s.golden.morning.end, s.golden.evening.start]) {
            const err = Math.abs(sunPosition(instant, p.lat, p.lon).altitude - ALTITUDE.goldenHour);
            if (err > worstGolden) { worstGolden = err; worstGoldenAt = where; }
          }
        }
      }
    }

    t.check(
      `sun is on the horizon at sunrise and sunset (${sampled} days sampled)`,
      worstHorizon <= 0.05,
      `worst altitude error ${worstHorizon.toFixed(4)}° at ${worstHorizonAt} (tolerance 0.05°)`
    );
    t.check(
      'sun is at +6° at the golden-hour boundaries',
      worstGolden <= 0.05,
      `worst altitude error ${worstGolden.toFixed(4)}° at ${worstGoldenAt} (tolerance 0.05°)`
    );
    t.check(
      'altitude at solar noon matches maxAltitude',
      worstNoonAlt <= 0.05,
      `worst error ${worstNoonAlt.toFixed(4)}° at ${worstNoonAltAt} (tolerance 0.05°)`
    );
    t.check(
      'sun is on the meridian at solar noon',
      noonAzimuthOk,
      noonAzimuthOk ? 'every sample within 1.5° of due north/south' : noonAzimuthDetail
    );
    t.check(
      'sunrise/sunset azimuth skew matches what declination drift predicts',
      worstAzExcess <= 0,
      `worst residual ${worstAzExcess.toFixed(4)}° beyond the prediction at ${worstAzExcessAt}`
    );
  }

  /* --- Physical identities ----------------------------------------- */

  t.group('Physics that holds everywhere');
  {
    // On an equinox every latitude gets a little over 12 hours, because
    // sunrise and sunset are defined by the sun's upper limb, not its centre.
    let worstEquinox = 0, worstEquinoxAt = '';
    let worstAz = 0, worstAzAt = '';
    for (const iso of ['2026-03-20', '2026-09-23']) {
      for (const lat of [-60, -45, -23.5, 0, 23.5, 45, 60]) {
        const s = sunTimes(civilDateFromISO(iso), lat, 0, 'UTC');
        const hours = s.dayLengthSeconds / 3600;
        const off = Math.abs(hours - 12.12);
        if (off > worstEquinox) { worstEquinox = off; worstEquinoxAt = `${lat}° on ${iso}`; }

        // The equinox sun rises due east everywhere.
        const err = angleDiff(sunPosition(s.sunrise, lat, 0).azimuth, 90);
        if (err > worstAz) { worstAz = err; worstAzAt = `${lat}° on ${iso}`; }
      }
    }
    t.check(
      'equinox day length is ~12h07m at every latitude',
      worstEquinox <= 0.25,
      `worst deviation ${(worstEquinox * 60).toFixed(1)} min at ${worstEquinoxAt} (tolerance 15 min)`
    );
    t.check(
      'equinox sunrise is due east at every latitude',
      worstAz <= 2.5,
      `worst deviation ${worstAz.toFixed(2)}° at ${worstAzAt} (tolerance 2.5°)`
    );

    // Solar noon can only stray from mean noon by the equation of time, which
    // peaks near 16m33s in early November.
    let worstEot = 0, worstEotAt = '';
    for (let month = 1; month <= 12; month++) {
      for (const lon of [-179, -120, -60, -7.5, 0, 7.5, 60, 120, 179]) {
        const date = { year: 2026, month, day: 10 };
        const s = sunTimes(date, 20, lon);
        const meanNoon = Date.UTC(2026, month - 1, 10, 12) - (lon / 15) * 3600000;
        const off = Math.abs(s.solarNoon.getTime() - meanNoon) / 60000;
        if (off > worstEot) { worstEot = off; worstEotAt = `${lon}° in month ${month}`; }
      }
    }
    t.check(
      'solar noon stays within the equation of time of mean noon',
      worstEot <= 17,
      `worst offset ${worstEot.toFixed(1)} min at ${worstEotAt} (bound 16m33s, tolerance 17 min)`
    );

    // Longer days north of the equator in June mean shorter days south of it.
    const juneNorth = sunTimes(civilDateFromISO('2026-06-21'), 45, 0, 'UTC').dayLengthSeconds;
    const juneSouth = sunTimes(civilDateFromISO('2026-06-21'), -45, 0, 'UTC').dayLengthSeconds;
    t.within(
      'June solstice day lengths mirror across the equator',
      (juneNorth + juneSouth) / 3600, 24.2, 0.3, 'h'
    );

    // Singapore is near the equator: barely any seasonal swing.
    const swing = DATES.map((iso) =>
      sunTimes(civilDateFromISO(iso), 1.3521, 103.8198, 'Asia/Singapore').dayLengthSeconds / 3600);
    const spread = Math.max(...swing) - Math.min(...swing);
    t.check(
      'Singapore day length barely moves across the year',
      spread < 0.5,
      `spread ${(spread * 60).toFixed(1)} min between ${Math.min(...swing).toFixed(2)}h and ${Math.max(...swing).toFixed(2)}h`
    );
  }

  /* --- Regression: the solar model must not drift with the epoch ---- */
  // The compact formulation this started on pinned the longitude of perihelion
  // at its J2000 value. Perihelion precesses ~0.017°/yr, so by 2026 the sun's
  // computed longitude lagged by ~0.45°: 0.18° of declination error near the
  // equinoxes, and over a minute of sunrise error at high latitude. The
  // equinoxes are where that lag is most visible — it would move them by
  // ~11 hours, so these checks fail loudly if the drift ever comes back.

  t.group('Solar model is anchored to the right epoch');
  {
    const zeroCrossing = (loMs, hiMs) => {
      for (let i = 0; i < 60; i++) {
        const mid = (loMs + hiMs) / 2;
        if (declinationOf(loMs) * declinationOf(mid) <= 0) hiMs = mid; else loMs = mid;
      }
      return (loMs + hiMs) / 2;
    };

    // Equinoxes and solstices advance by about 5h49m a year (less a day each
    // leap year). These expected instants come from the 2025 events carried
    // forward by that interval, independent of anything in sun.js.
    const equinoxCases = [
      ['March 2026 equinox',     Date.UTC(2026, 2, 18), Date.UTC(2026, 2, 23), Date.UTC(2026, 2, 20, 14, 50)],
      ['September 2026 equinox', Date.UTC(2026, 8, 20), Date.UTC(2026, 8, 25), Date.UTC(2026, 8, 23, 0, 8)],
    ];
    for (const [label, lo, hi, expected] of equinoxCases) {
      const found = zeroCrossing(lo, hi);
      const offMinutes = Math.abs(found - expected) / 60000;
      t.check(`${label} lands within an hour of the published instant`,
        offMinutes <= 60,
        `computed ${new Date(Math.round(found)).toISOString().slice(0, 16).replace('T', ' ')} UTC, ` +
        `expected ${new Date(expected).toISOString().slice(0, 16).replace('T', ' ')} UTC — ` +
        `off by ${offMinutes.toFixed(0)} min (tolerance 60)`);
    }

    // Peak declination equals the obliquity of the ecliptic, 23.436° in 2026.
    let peak = -90, peakAt = 0;
    for (let h = 0; h < 72; h++) {
      const ms = Date.UTC(2026, 5, 20) + h * 1800000;
      const d = declinationOf(ms);
      if (d > peak) { peak = d; peakAt = ms; }
    }
    t.within('peak declination equals the 2026 obliquity of the ecliptic', peak, 23.436, 0.02, '°');
    t.check('peak declination falls on the June solstice',
      new Date(peakAt).toISOString().slice(0, 10) === '2026-06-21',
      `peaks ${new Date(peakAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  }

  /* --- Polar cases -------------------------------------------------- */

  t.group('Midnight sun and polar night');
  {
    const cases = [
      ['Tromsø, June',        69.6492,  18.9553, 'Europe/Oslo',       '2026-06-21', 'midnight-sun'],
      ['Tromsø, December',    69.6492,  18.9553, 'Europe/Oslo',       '2026-12-21', 'polar-night'],
      ['Longyearbyen, June',  78.2232,  15.6267, 'Arctic/Longyearbyen', '2026-06-21', 'midnight-sun'],
      ['Longyearbyen, Dec',   78.2232,  15.6267, 'Arctic/Longyearbyen', '2026-12-21', 'polar-night'],
      ['McMurdo, June',      -77.8419, 166.6863, 'Antarctica/McMurdo', '2026-06-21', 'polar-night'],
      ['McMurdo, December',  -77.8419, 166.6863, 'Antarctica/McMurdo', '2026-12-21', 'midnight-sun'],
      ['Tromsø, equinox',     69.6492,  18.9553, 'Europe/Oslo',       '2026-09-23', null],
    ];
    for (const [label, lat, lon, tz, iso, expected] of cases) {
      const s = sunTimes(civilDateFromISO(iso), lat, lon, tz);
      t.check(
        `${label} → ${expected ?? 'ordinary day'}`,
        s.polar === expected,
        expected === null
          ? `rise ${hhmm(s.sunrise, tz)}, set ${hhmm(s.sunset, tz)}`
          : `polar=${s.polar ?? 'null'}, dayLength=${(s.dayLengthSeconds / 3600).toFixed(1)}h, maxAltitude=${s.maxAltitude.toFixed(1)}°`
      );
    }

    const night = sunTimes(civilDateFromISO('2026-12-21'), 69.6492, 18.9553, 'Europe/Oslo');
    t.check('polar night reports no sunrise, no sunset, no golden hour',
      night.sunrise === null && night.sunset === null && night.golden === null && night.dayLengthSeconds === 0,
      `sunrise=${night.sunrise}, sunset=${night.sunset}, golden=${night.golden}, dayLength=${night.dayLengthSeconds}s`);

    const midnightSun = sunTimes(civilDateFromISO('2026-06-21'), 69.6492, 18.9553, 'Europe/Oslo');
    t.check('midnight sun reports a full 24-hour day',
      midnightSun.dayLengthSeconds === 86400 && midnightSun.solarNoon instanceof Date,
      `dayLength=${midnightSun.dayLengthSeconds}s, solar noon ${hhmm(midnightSun.solarNoon, 'Europe/Oslo')}`);

    t.check('day-length delta is withheld across a polar boundary',
      dayLengthDelta(civilDateFromISO('2026-12-21'), 69.6492, 18.9553, 'Europe/Oslo') === null,
      'returns null rather than a nonsense difference');
  }

  /* --- Calendar-day anchoring -------------------------------------- */

  t.group('Events land on the requested local date');
  {
    // The regression that drove js/time.js into existence: Kiritimati keeps
    // UTC+14 at 157° W, so its clock runs nearly a full day off its solar time.
    let noonOk = true, noonDetail = '';
    let eventOk = true, eventDetail = '';
    const spillovers = [];
    let checked = 0;
    for (const p of PLACES) {
      for (const iso of DATES) {
        const s = sunTimes(civilDateFromISO(iso), p.lat, p.lon, p.tz);
        if (s.polar) continue;
        checked++;

        // Solar noon is the anchor, so it must always land on the asked-for date.
        const noonDate = toISODate(civilDateInZone(s.solarNoon, p.tz));
        if (noonDate !== iso) {
          noonOk = false;
          noonDetail = `${p.name} ${iso}: solar noon fell on ${noonDate}`;
        }

        // Sunrise and sunset normally do too — but on a long summer day at
        // high latitude, sunset genuinely happens after local midnight
        // (Reykjavík in June) and sunrise can precede it. Those must stay
        // within 12 hours of transit, not within the calendar date.
        for (const [event, instant] of [['sunrise', s.sunrise], ['sunset', s.sunset]]) {
          const onDate = toISODate(civilDateInZone(instant, p.tz)) === iso;
          const hoursFromNoon = Math.abs(instant - s.solarNoon) / 3600000;
          if (hoursFromNoon > 12) {
            eventOk = false;
            eventDetail = `${p.name} ${iso}: ${event} is ${hoursFromNoon.toFixed(1)}h from solar noon`;
          }
          if (!onDate) {
            spillovers.push(`${p.name} ${iso} ${event} → ${hhmm(instant, p.tz)} on the adjacent day`);
          }
        }
      }
    }
    t.check(`solar noon always falls on the asked-for local date (${checked} days)`, noonOk,
      noonOk ? 'every place/date pair matched' : noonDetail);
    t.check('sunrise and sunset stay within 12 hours of solar noon', eventOk,
      eventOk
        ? `all ${checked} days consistent; ${spillovers.length} event(s) legitimately cross local midnight`
        : eventDetail);

    // Reykjavík's midsummer sunset lands just after local midnight. This is
    // correct, and the UI has to label it rather than show a bare "00:04".
    const reykjavik = sunTimes(civilDateFromISO('2026-06-21'), 64.1466, -21.9426, 'Atlantic/Reykjavik');
    const sunsetDate = toISODate(civilDateInZone(reykjavik.sunset, 'Atlantic/Reykjavik'));
    t.check('Reykjavík midsummer sunset falls after local midnight, on the next date',
      sunsetDate === '2026-06-22' && reykjavik.dayLengthSeconds > 20 * 3600,
      `sunrise ${hhmm(reykjavik.sunrise, 'Atlantic/Reykjavik')} on 2026-06-21, ` +
      `sunset ${hhmm(reykjavik.sunset, 'Atlantic/Reykjavik')} on ${sunsetDate}, ` +
      `day length ${(reykjavik.dayLengthSeconds / 3600).toFixed(2)}h`);

    const kiritimati = sunTimes(civilDateFromISO('2026-11-05'), 1.8721, -157.4278, 'Pacific/Kiritimati');
    t.check('Kiritimati (UTC+14 at 157°W) resolves to its own calendar day',
      toISODate(civilDateInZone(kiritimati.sunrise, 'Pacific/Kiritimati')) === '2026-11-05',
      `sunrise ${hhmm(kiritimati.sunrise, 'Pacific/Kiritimati')} on ` +
      `${toISODate(civilDateInZone(kiritimati.sunrise, 'Pacific/Kiritimati'))}`);

    // Kashgar runs on Beijing time, so its clock noon is around 15:00 solar.
    const kashgar = sunTimes(civilDateFromISO('2026-11-05'), 39.4704, 75.9898, 'Asia/Shanghai');
    const kashgarNoon = wallTimeInZone(kashgar.solarNoon, 'Asia/Shanghai');
    t.check('Kashgar on Beijing time has a late clock noon',
      kashgarNoon.hour >= 13 && kashgarNoon.hour <= 15,
      `solar noon at ${hhmm(kashgar.solarNoon, 'Asia/Shanghai')} Beijing time`);

    // Without a zone the longitude fallback should still be self-consistent.
    const fallback = sunTimes(civilDateFromISO('2026-11-05'), 51.5074, -0.1278);
    const withZone = sunTimes(civilDateFromISO('2026-11-05'), 51.5074, -0.1278, 'Europe/London');
    t.within('longitude fallback matches the zone-anchored result in London',
      minutesApart(fallback.sunrise, withZone.sunrise), 0, 1, ' min');
  }

  /* --- Invariant sweep --------------------------------------------- */

  t.group('Invariants across the globe and the year');
  {
    let combos = 0, polarSkipped = 0;
    const failures = [];
    for (let month = 1; month <= 12; month++) {
      for (const lat of [-67, -54, -34, -12, 0, 12, 34, 54, 67]) {
        for (const lon of [-179, -120, -60, 0, 60, 120, 179]) {
          const date = { year: 2026, month, day: 15 };
          const s = sunTimes(date, lat, lon);
          combos++;
          if (s.polar) { polarSkipped++; continue; }

          if (!(s.sunrise < s.solarNoon && s.solarNoon < s.sunset)) {
            failures.push(`${lat},${lon} m${month}: noon outside day`);
          }
          if (!(s.dayLengthSeconds > 0 && s.dayLengthSeconds < 86400)) {
            failures.push(`${lat},${lon} m${month}: day length ${s.dayLengthSeconds}s`);
          }
          if (!(s.golden.morning.start <= s.golden.morning.end &&
                s.golden.evening.start <= s.golden.evening.end &&
                s.golden.morning.end <= s.golden.evening.start)) {
            failures.push(`${lat},${lon} m${month}: golden hours out of order`);
          }
          // Day and night must add up.
          const delta = dayLengthDelta(date, lat, lon);
          if (delta !== null && Math.abs(delta.seconds) > 1200) {
            failures.push(`${lat},${lon} m${month}: day length jumped ${delta.seconds}s`);
          }
        }
      }
    }
    t.check(
      `${combos} place/date combinations hold every ordering invariant`,
      failures.length === 0,
      failures.length === 0
        ? `${combos - polarSkipped} ordinary days checked, ${polarSkipped} polar days skipped`
        : `${failures.length} failures, first: ${failures[0]}`
    );

    // Day length must change smoothly day to day — no discontinuity where the
    // solar-day anchor rolls over.
    let worstJump = 0, worstJumpAt = '';
    for (const p of PLACES) {
      let date = civilDateFromISO('2026-02-25');
      for (let i = 0; i < 20; i++) {
        const delta = dayLengthDelta(date, p.lat, p.lon, p.tz);
        if (delta && Math.abs(delta.seconds) > worstJump) {
          worstJump = Math.abs(delta.seconds);
          worstJumpAt = `${p.name} ${toISODate(date)}`;
        }
        date = addDays(date, 1);
      }
    }
    t.check(
      'day length changes by at most a few minutes per day',
      worstJump < 600,
      `largest single-day change ${worstJump}s at ${worstJumpAt} (tolerance 600s)`
    );
  }

  /* --- Time-zone arithmetic ---------------------------------------- */

  t.group('Time-zone arithmetic (js/time.js)');
  {
    const HOUR = 3600000;
    const offsetCases = [
      ['Asia/Kolkata in January',   'Asia/Kolkata',       '2026-01-15',  5.5],
      ['Asia/Kolkata in July',      'Asia/Kolkata',       '2026-07-15',  5.5],
      ['America/New_York in winter','America/New_York',   '2026-01-15', -5],
      ['America/New_York in summer','America/New_York',   '2026-07-15', -4],
      ['Europe/London in winter',   'Europe/London',      '2026-01-15',  0],
      ['Europe/London in summer',   'Europe/London',      '2026-07-15',  1],
      ['Pacific/Kiritimati',        'Pacific/Kiritimati', '2026-11-05', 14],
      ['Australia/Eucla',           'Australia/Eucla',    '2026-11-05',  8.75],
      ['Antarctica/McMurdo in Jan', 'Antarctica/McMurdo', '2026-01-15', 13],
    ];
    for (const [label, tz, iso, expectedHours] of offsetCases) {
      const { year, month, day } = civilDateFromISO(iso);
      const noonish = Date.UTC(year, month - 1, day, 0);
      const hours = zoneOffsetMs(noonish, tz) / HOUR;
      t.check(`${label} is UTC${expectedHours >= 0 ? '+' : ''}${expectedHours}`,
        Math.abs(hours - expectedHours) < 1e-9, `measured UTC${hours >= 0 ? '+' : ''}${hours}`);
    }

    // Noon must round-trip exactly, including on DST transition days.
    let roundTripOk = true, roundTripDetail = 'all zones and dates round-tripped';
    const transitionDates = [...DATES, '2026-03-29', '2026-10-25', '2027-03-14', '2027-11-07'];
    for (const p of PLACES) {
      for (const iso of transitionDates) {
        const civil = civilDateFromISO(iso);
        const utc = zonedWallTimeToUtcMs({ ...civil, hour: 12 }, p.tz);
        const back = wallTimeInZone(utc, p.tz);
        if (back.hour !== 12 || back.minute !== 0 || toISODate(back) !== iso) {
          roundTripOk = false;
          roundTripDetail = `${p.tz} ${iso} → ${toISODate(back)} ${back.hour}:${String(back.minute).padStart(2, '0')}`;
        }
      }
    }
    t.check('local noon round-trips through UTC in every zone, including DST changeover days',
      roundTripOk, roundTripDetail);

    // Spring forward: 02:00 to 03:00 does not exist in New York on 2027-03-14.
    const beforeGap = zonedWallTimeToUtcMs({ year: 2027, month: 3, day: 14, hour: 1, minute: 30 }, 'America/New_York');
    const afterGap = zonedWallTimeToUtcMs({ year: 2027, month: 3, day: 14, hour: 3, minute: 30 }, 'America/New_York');
    t.within('the New York spring-forward hour is one hour wide',
      (afterGap - beforeGap) / HOUR, 1, 1e-9, 'h');

    t.check('zone validation accepts real zones and rejects junk',
      isValidTimeZone('Asia/Tokyo') && isValidTimeZone('UTC') &&
      !isValidTimeZone('Mars/Olympus') && !isValidTimeZone('') && !isValidTimeZone(null),
      'Asia/Tokyo and UTC accepted; Mars/Olympus, empty string and null rejected');
  }

  /* --- Input handling ---------------------------------------------- */

  t.group('Date helpers');
  {
    t.check('civilDateFromISO parses an ISO date',
      JSON.stringify(civilDateFromISO('2026-11-05')) === JSON.stringify({ year: 2026, month: 11, day: 5 }),
      JSON.stringify(civilDateFromISO('2026-11-05')));

    let threw = false;
    try { civilDateFromISO('5 Nov 2026'); } catch { threw = true; }
    t.check('civilDateFromISO rejects anything else', threw, 'throws RangeError on "5 Nov 2026"');

    t.check('addDays crosses a month end', toISODate(addDays(civilDateFromISO('2026-01-31'), 1)) === '2026-02-01',
      toISODate(addDays(civilDateFromISO('2026-01-31'), 1)));
    t.check('addDays crosses a year end', toISODate(addDays(civilDateFromISO('2026-12-31'), 1)) === '2027-01-01',
      toISODate(addDays(civilDateFromISO('2026-12-31'), 1)));
    t.check('addDays handles a leap day', toISODate(addDays(civilDateFromISO('2028-02-28'), 1)) === '2028-02-29',
      toISODate(addDays(civilDateFromISO('2028-02-28'), 1)));
    t.check('addDays steps backwards', toISODate(addDays(civilDateFromISO('2026-03-01'), -1)) === '2026-02-28',
      toISODate(addDays(civilDateFromISO('2026-03-01'), -1)));

    // A bad zone name must not take the whole calculation down.
    const bogus = sunTimes(civilDateFromISO('2026-11-05'), 51.5074, -0.1278, 'Mars/Olympus');
    t.check('an unknown zone falls back to the longitude anchor instead of throwing',
      bogus.sunrise instanceof Date && !Number.isNaN(bogus.sunrise.getTime()),
      `sunrise ${bogus.sunrise?.toISOString?.() ?? 'invalid'}`);

    const delta = dayLengthDelta(civilDateFromISO('2026-06-15'), 51.5074, -0.1278, 'Europe/London');
    t.check('dayLengthDelta reports a small positive change approaching the solstice',
      delta !== null && delta.seconds > 0 && delta.seconds < 120,
      delta === null ? 'null' : `+${delta.seconds}s vs previous day`);
  }

  const passed = t.results.filter((r) => r.ok).length;
  return { results: t.results, passed, failed: t.results.length - passed, total: t.results.length };
}

/* ------------------------------------------------------------------ *
 * Terminal runner: `node js/sun.test.js`
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
