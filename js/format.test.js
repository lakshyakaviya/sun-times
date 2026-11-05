/**
 * Test suite for js/format.js.
 *
 * Runs alongside the solar suite: `test.html` renders both, and
 * `node js/format.test.js` prints this one and exits non-zero on failure.
 *
 * `Intl` output varies a little between ICU versions — notably en-US now puts
 * a narrow no-break space before AM/PM — so string comparisons go through
 * `normalise()` rather than asserting byte-for-byte output. Locale is always
 * passed explicitly here; the app leaves it undefined so it follows the
 * viewer, which is exactly what a test must not depend on.
 */

import {
  roundToMinute,
  formatTime,
  formatTimeRange,
  formatTimeWithDay,
  dayMarker,
  formatUtcOffset,
  formatZoneLabel,
  formatDateLabel,
  machineDateTime,
  formatDuration,
  formatDayLengthDelta,
  formatCoordinates,
} from './format.js';

import { sunTimes, civilDateFromISO } from './sun.js';

/** Collapse the exotic spaces Intl emits, and case, before comparing. */
const normalise = (value) =>
  String(value).replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function createRunner() {
  const results = [];
  let group = '';
  return {
    results,
    group(name) { group = name; },
    check(name, ok, detail = '') {
      results.push({ group, name, ok: Boolean(ok), detail: String(detail) });
    },
    /** Assert a formatted string, comparing normalised. */
    equals(name, actual, expected) {
      const ok = normalise(actual) === normalise(expected);
      results.push({
        group,
        name,
        ok,
        detail: ok ? `“${actual}”` : `got “${actual}”, expected “${expected}”`,
      });
    },
  };
}

export function runTests() {
  const t = createRunner();

  const KOLKATA = 'Asia/Kolkata';
  const NEW_YORK = 'America/New_York';
  const REYKJAVIK = 'Atlantic/Reykjavik';

  /* --- Rounding ---------------------------------------------------- */

  t.group('Rounding to the minute');
  {
    // 04:43:40 must present as 04:44, not 04:43. Intl truncates on its own,
    // which would make every time in the app read up to 59 seconds early.
    const late = new Date('2026-06-21T04:43:40Z');
    t.equals('a time 40 s past the minute rounds up', roundToMinute(late).toISOString(),
      '2026-06-21T04:44:00.000Z');

    const early = new Date('2026-06-21T04:43:20Z');
    t.equals('a time 20 s past the minute rounds down', roundToMinute(early).toISOString(),
      '2026-06-21T04:43:00.000Z');

    t.equals('exactly 30 s rounds up',
      roundToMinute(new Date('2026-06-21T04:43:30Z')).toISOString(),
      '2026-06-21T04:44:00.000Z');

    t.equals('formatTime rounds rather than truncating',
      formatTime(new Date('2026-11-05T00:43:40Z'), 'UTC', 'en-GB'), '00:44');

    t.check('a number is accepted as well as a Date',
      roundToMinute(Date.UTC(2026, 10, 5, 6, 15, 40)).getTime() === Date.UTC(2026, 10, 5, 6, 16),
      'epoch milliseconds round the same way');
  }

  /* --- Clock times ------------------------------------------------- */

  t.group('Clock times follow the viewer’s locale, in the place’s zone');
  {
    // 00:45 UTC is 06:15 in Kolkata (+5:30).
    const instant = new Date('2026-11-05T00:45:00Z');
    t.equals('24-hour locale', formatTime(instant, KOLKATA, 'en-GB'), '06:15');
    t.equals('12-hour locale', formatTime(instant, KOLKATA, 'en-US'), '6:15 AM');
    t.equals('the half-hour offset is applied', formatTime(instant, KOLKATA, 'en-GB'), '06:15');
    t.equals('the same instant in another zone',
      formatTime(instant, NEW_YORK, 'en-GB'), '19:45');

    t.equals('an afternoon time in a 12-hour locale',
      formatTime(new Date('2026-11-05T12:21:00Z'), KOLKATA, 'en-US'), '5:51 PM');
  }

  /* --- Ranges ------------------------------------------------------ */

  t.group('Golden-hour ranges');
  {
    const start = new Date('2026-11-05T00:45:00Z'); // 06:15 IST
    const end = new Date('2026-11-05T01:14:00Z');   // 06:44 IST
    t.equals('24-hour range', formatTimeRange(start, end, KOLKATA, 'en-GB'), '06:15 – 06:44');
    t.equals('a shared AM/PM marker is printed once',
      formatTimeRange(start, end, KOLKATA, 'en-US'), '6:15 – 6:44 AM');

    const morning = new Date('2026-11-05T06:00:00Z'); // 11:30 IST
    const afternoon = new Date('2026-11-05T08:00:00Z'); // 13:30 IST
    t.equals('a range crossing midday keeps both markers',
      formatTimeRange(morning, afternoon, KOLKATA, 'en-US'), '11:30 AM – 1:30 PM');
  }

  /* --- Times that land on another date ----------------------------- */

  t.group('Times that fall outside the date being viewed');
  {
    const date = civilDateFromISO('2026-06-21');
    const sun = sunTimes(date, 64.1466, -21.9426, REYKJAVIK);

    // Reykjavík's midsummer sunset is just after local midnight, on the 22nd.
    t.check('a sunset after local midnight is marked with its date',
      /22 jun/.test(normalise(formatTimeWithDay(sun.sunset, REYKJAVIK, date, 'en-GB'))),
      `sunset renders as “${formatTimeWithDay(sun.sunset, REYKJAVIK, date, 'en-GB')}”`);

    t.check('a sunrise on the viewed date carries no marker',
      dayMarker(sun.sunrise, REYKJAVIK, date, 'en-GB') === null,
      `sunrise renders as “${formatTimeWithDay(sun.sunrise, REYKJAVIK, date, 'en-GB')}”`);

    t.equals('the marker is a short date',
      dayMarker(sun.sunset, REYKJAVIK, date, 'en-GB'), '22 Jun');

    // A plain day in a plain zone needs no marker at all.
    const plain = civilDateFromISO('2026-11-05');
    const bengaluru = sunTimes(plain, 12.9716, 77.5946, KOLKATA);
    t.check('neither event is marked on an ordinary day',
      dayMarker(bengaluru.sunrise, KOLKATA, plain) === null &&
      dayMarker(bengaluru.sunset, KOLKATA, plain) === null,
      `${formatTime(bengaluru.sunrise, KOLKATA, 'en-GB')} to ` +
      `${formatTime(bengaluru.sunset, KOLKATA, 'en-GB')}, both on 5 Nov`);
  }

  /* --- Zones and dates --------------------------------------------- */

  t.group('Zone and date labels');
  {
    const november = new Date('2026-11-05T06:00:00Z');
    const july = new Date('2026-07-05T06:00:00Z');

    t.equals('a half-hour offset', formatUtcOffset(november, KOLKATA), '+5:30');
    t.equals('a whole-hour negative offset', formatUtcOffset(november, NEW_YORK), '-5');
    t.equals('the same zone on summer time', formatUtcOffset(july, NEW_YORK), '-4');
    t.equals('a zero offset', formatUtcOffset(november, 'Europe/London'), '+0');
    t.equals('a quarter-hour offset', formatUtcOffset(november, 'Australia/Eucla'), '+8:45');
    t.equals('the far side of the date line', formatUtcOffset(november, 'Pacific/Kiritimati'), '+14');

    t.check('a named zone shows its abbreviation and its offset',
      /utc\+5:30/.test(normalise(formatZoneLabel(november, KOLKATA, 'en-GB'))),
      `“${formatZoneLabel(november, KOLKATA, 'en-GB')}”`);

    // Kiritimati has no abbreviation of its own, so Intl names it "GMT+14";
    // repeating that as "GMT+14 (UTC+14)" tells the reader nothing.
    t.equals('a zone with no abbreviation shows only the offset',
      formatZoneLabel(november, 'Pacific/Kiritimati', 'en-GB'), 'UTC+14');

    // But a bare "GMT" does stand on its own.
    t.equals('GMT needs no offset beside it',
      formatZoneLabel(november, 'Atlantic/Reykjavik', 'en-GB'), 'GMT');

    // Punctuation in a long date varies between ICU versions, so check the
    // parts rather than the exact string.
    const label = formatDateLabel(civilDateFromISO('2026-11-05'), 'en-GB');
    t.check('a date label reads as prose',
      /thursday/.test(normalise(label)) && /november/.test(normalise(label)) &&
      label.includes('5') && label.includes('2026'),
      `“${label}”`);

    // The label must not drift onto the neighbouring day for any viewer.
    t.check('the date label is immune to the viewer’s own zone',
      formatDateLabel(civilDateFromISO('2026-01-01'), 'en-GB').includes('2026') &&
      formatDateLabel(civilDateFromISO('2026-12-31'), 'en-GB').includes('31'),
      `${formatDateLabel(civilDateFromISO('2026-01-01'), 'en-GB')} / ` +
      `${formatDateLabel(civilDateFromISO('2026-12-31'), 'en-GB')}`);
  }

  /* --- Machine-readable output ------------------------------------- */

  t.group('<time datetime> values');
  {
    const instant = new Date('2026-11-05T00:45:00Z');
    t.equals('carries the place’s offset',
      machineDateTime(instant, KOLKATA), '2026-11-05T06:15:00+05:30');
    t.equals('a negative offset is zero-padded',
      machineDateTime(instant, NEW_YORK), '2026-11-04T19:45:00-05:00');
    t.equals('a +14 offset',
      machineDateTime(instant, 'Pacific/Kiritimati'), '2026-11-05T14:45:00+14:00');

    const parsedBack = new Date(machineDateTime(instant, KOLKATA));
    t.check('the value parses back to the same minute',
      parsedBack.getTime() === roundToMinute(instant).getTime(),
      `${machineDateTime(instant, KOLKATA)} → ${parsedBack.toISOString()}`);
  }

  /* --- Durations --------------------------------------------------- */

  t.group('Durations read as prose, not as clock times');
  {
    t.equals('a day length', formatDuration(13 * 3600 + 45 * 60), '13 h 45 m');
    t.equals('a whole number of hours', formatDuration(24 * 3600), '24 h');
    t.equals('a golden hour stays in minutes', formatDuration(66 * 60), '66 min');
    t.equals('just under the threshold', formatDuration(89 * 60), '89 min');
    t.equals('exactly at the threshold', formatDuration(90 * 60), '1 h 30 m');
    t.equals('zero', formatDuration(0), '0 min');
    t.equals('seconds round to the nearest minute', formatDuration(100), '2 min');
    t.check('a day length never looks like a clock time',
      !formatDuration(13 * 3600 + 45 * 60).includes(':'),
      '“13 h 45 m” cannot be misread as a quarter to two');
  }

  t.group('Day-length change');
  {
    t.equals('longer', formatDayLengthDelta(107), '1 min 47 s longer than yesterday');
    t.equals('shorter', formatDayLengthDelta(-123), '2 min 3 s shorter than yesterday');
    t.equals('a whole number of minutes', formatDayLengthDelta(120), '2 min longer than yesterday');
    t.equals('under a minute', formatDayLengthDelta(-45), '45 s shorter than yesterday');
    t.equals('a second either way still reads',
      formatDayLengthDelta(1), '1 s longer than yesterday');
    t.equals('no change at all', formatDayLengthDelta(0), 'the same length as yesterday');
  }

  /* --- Coordinates ------------------------------------------------- */

  t.group('Coordinates');
  {
    t.equals('north and east', formatCoordinates(12.9716, 77.5946), '12.97°N, 77.59°E');
    t.equals('south and west', formatCoordinates(-33.8688, -70.6693), '33.87°S, 70.67°W');
    t.equals('the equator reads north', formatCoordinates(0, 0), '0.00°N, 0.00°E');
    t.equals('more precision on request',
      formatCoordinates(12.9716, 77.5946, 4), '12.9716°N, 77.5946°E');
  }

  const passed = t.results.filter((r) => r.ok).length;
  return { results: t.results, passed, failed: t.results.length - passed, total: t.results.length };
}

/* ------------------------------------------------------------------ *
 * Terminal runner: `node js/format.test.js`
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
