/**
 * Presentation helpers: instants, durations and coordinates into the strings
 * the page shows. Pure — no DOM, no state.
 *
 * Locale is left undefined by default so `Intl` follows the viewer's own
 * browser settings: whoever is reading decides 12- or 24-hour, not the place
 * being looked at. The zone, by contrast, is always the place's own.
 */

import { wallTimeInZone, zoneOffsetMs } from './time.js';

const MINUTE_MS = 60000;

/**
 * Round an instant to the nearest minute.
 *
 * `Intl` truncates, so a sunrise computed at 04:43:40 would display as 04:43
 * when the honest answer is 04:44 — every time in the app reading up to 59
 * seconds early, and disagreeing with published tables about half the time.
 * The solar model is accurate to roughly 15 seconds; truncating would throw
 * that away at the last step.
 */
export function roundToMinute(instant) {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  return new Date(Math.round(ms / MINUTE_MS) * MINUTE_MS);
}

/* ------------------------------------------------------------------ *
 * Clock times
 * ------------------------------------------------------------------ */

const formatterCache = new Map();

function cachedFormatter(locale, options) {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

const twelveHourCache = new Map();

/** Does this locale write clock times on a 12-hour dial? */
function usesTwelveHourClock(locale) {
  const key = locale ?? '';
  if (!twelveHourCache.has(key)) {
    const resolved = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
    twelveHourCache.set(key, resolved.hour12 === true);
  }
  return twelveHourCache.get(key);
}

/**
 * Hour padding follows the locale's own convention rather than one house
 * style: a 24-hour clock pads to "06:15", a 12-hour clock does not — "6:15 AM"
 * is right and "06:15 AM" looks like a timetable. `hourCycle: 'h23'` keeps
 * midnight at 00:00 instead of the 24:00 some locales would otherwise print.
 */
const timeFormatter = (locale, timeZone) =>
  usesTwelveHourClock(locale)
    ? cachedFormatter(locale, { timeZone, hour: 'numeric', minute: '2-digit' })
    : cachedFormatter(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A clock time in the place's zone, e.g. `'06:15'` or `'6:15 AM'`. */
export function formatTime(instant, timeZone, locale) {
  return timeFormatter(locale, timeZone).format(roundToMinute(instant));
}

/**
 * The same time split into its clock face and its am/pm marker, so a range can
 * print the marker once (`'6:15 – 6:44 AM'`). `dayPeriod` is `''` in 24-hour
 * locales.
 */
function timeParts(instant, timeZone, locale) {
  const parts = timeFormatter(locale, timeZone).formatToParts(roundToMinute(instant));
  const clock = parts
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim();
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value ?? '';
  return { clock, dayPeriod };
}

/**
 * A start-to-end window, collapsing a shared am/pm marker.
 * `'05:38 – 06:44'`, or `'6:15 – 6:44 AM'`.
 */
export function formatTimeRange(start, end, timeZone, locale) {
  const from = timeParts(start, timeZone, locale);
  const to = timeParts(end, timeZone, locale);
  if (from.dayPeriod && from.dayPeriod === to.dayPeriod) {
    return `${from.clock} – ${to.clock} ${to.dayPeriod}`;
  }
  return `${formatTime(start, timeZone, locale)} – ${formatTime(end, timeZone, locale)}`;
}

/**
 * A short date label for an instant that falls outside the date being viewed,
 * or `null` when it falls inside it.
 *
 * High-latitude summers need this: Reykjavík's midsummer sunset is at 00:03
 * the *following* morning, and a card reading a bare "00:03" looks like it
 * happens before sunrise.
 */
export function dayMarker(instant, timeZone, referenceCivilDate, locale) {
  const rounded = roundToMinute(instant);
  const wall = wallTimeInZone(rounded, timeZone);
  if (
    wall.year === referenceCivilDate.year &&
    wall.month === referenceCivilDate.month &&
    wall.day === referenceCivilDate.day
  ) {
    return null;
  }
  return cachedFormatter(locale, { timeZone, day: 'numeric', month: 'short' }).format(rounded);
}

/** `'06:15'` plus `' (22 Jun)'` when the time lands on another date. */
export function formatTimeWithDay(instant, timeZone, referenceCivilDate, locale) {
  const marker = dayMarker(instant, timeZone, referenceCivilDate, locale);
  const time = formatTime(instant, timeZone, locale);
  return marker ? `${time} (${marker})` : time;
}

/* ------------------------------------------------------------------ *
 * Zones and dates
 * ------------------------------------------------------------------ */

/** `'+5:30'`, `'-5'`, `'+0'` — the UTC offset in effect at `instant`. */
export function formatUtcOffset(instant, timeZone) {
  const offsetMinutes = zoneOffsetMs(instant, timeZone) / MINUTE_MS;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = Math.round(absolute % 60);
  return minutes ? `${sign}${hours}:${String(minutes).padStart(2, '0')}` : `${sign}${hours}`;
}

/**
 * How the page says which clock it is using: `'IST (UTC+5:30)'`, or just
 * `'UTC+1'` where the zone has no distinct abbreviation.
 */
export function formatZoneLabel(instant, timeZone, locale) {
  const parts = cachedFormatter(locale, { timeZone, timeZoneName: 'short' })
    .formatToParts(instant);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  const offset = `UTC${formatUtcOffset(instant, timeZone)}`;

  // Only show a name that tells the reader something the offset does not.
  // Zones with no abbreviation of their own report names like "GMT+5:30",
  // which would read "GMT+5:30 (UTC+5:30)" — so anything containing digits
  // gives way to the offset. A bare "GMT" does stand on its own, though.
  if (!name || /\d/.test(name)) return offset;
  if (name === 'GMT' || name === 'UTC') return name;
  return `${name} (${offset})`;
}

/** `'Thursday, 5 November 2026'` for a civil date, in the viewer's locale. */
export function formatDateLabel({ year, month, day }, locale) {
  // Noon UTC, formatted as UTC: no zone can shift it onto another date.
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return cachedFormatter(locale, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);
}

/**
 * A machine-readable value for a `<time datetime="…">` attribute, carrying the
 * place's offset: `'2026-11-05T06:15:00+05:30'`.
 */
export function machineDateTime(instant, timeZone) {
  const rounded = roundToMinute(instant);
  const wall = wallTimeInZone(rounded, timeZone);
  const offsetMinutes = zoneOffsetMs(rounded, timeZone) / MINUTE_MS;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${String(wall.year).padStart(4, '0')}-${pad(wall.month)}-${pad(wall.day)}` +
    `T${pad(wall.hour)}:${pad(wall.minute)}:00` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(Math.round(absolute % 60))}`
  );
}

/* ------------------------------------------------------------------ *
 * Durations
 * ------------------------------------------------------------------ */

/**
 * A length of time as prose: `'13 h 45 m'`, or `'66 min'` for short spans.
 *
 * Deliberately not clock-shaped — "13:45" for a day length reads as a quarter
 * to two. Spans under 90 minutes stay in minutes, since that is how golden
 * hour is actually talked about.
 */
export function formatDuration(seconds) {
  const totalMinutes = Math.round(Math.abs(seconds) / 60);
  if (totalMinutes < 90) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} h ${minutes} m` : `${hours} h`;
}

/**
 * The day-length change as a sentence: `'1 min 47 s longer than yesterday'`.
 * The words carry the sign, so no +/- is needed.
 */
export function formatDayLengthDelta(seconds) {
  if (seconds === 0) return 'the same length as yesterday';
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  const amount = minutes
    ? (remainder ? `${minutes} min ${remainder} s` : `${minutes} min`)
    : `${remainder} s`;
  return `${amount} ${seconds > 0 ? 'longer' : 'shorter'} than yesterday`;
}

/* ------------------------------------------------------------------ *
 * Places
 * ------------------------------------------------------------------ */

/** `'12.97°N, 77.59°E'` */
export function formatCoordinates(lat, lon, digits = 2) {
  const latitude = `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'}`;
  const longitude = `${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latitude}, ${longitude}`;
}
