/**
 * Time-zone arithmetic built on `Intl.DateTimeFormat`.
 *
 * The platform already ships the IANA database, including every historical and
 * future DST rule, so nothing here hand-rolls an offset. Internally all time is
 * a UTC epoch millisecond count; a zone is only ever applied at the edges.
 */

const PARTS_FORMAT_CACHE = new Map();

function partsFormatter(timeZone) {
  let fmt = PARTS_FORMAT_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS_FORMAT_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock fields an instant shows in `timeZone`. */
export function wallTimeInZone(instant, timeZone) {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  const parts = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(ms)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** UTC offset of `timeZone` at `instant`, in milliseconds (east positive). */
export function zoneOffsetMs(instant, timeZone) {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  const w = wallTimeInZone(ms, timeZone);
  const asIfUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Compare at second resolution; the sub-second part of `ms` is not in `w`.
  return asIfUTC - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant at which `timeZone` reads the given wall-clock time.
 *
 * The offset depends on the instant we are solving for, so we guess, measure
 * the offset there, and correct once — enough for anything outside the one
 * ambiguous hour of a DST transition, and this is only ever called for noon.
 *
 * @returns {number} epoch milliseconds
 */
export function zonedWallTimeToUtcMs({ year, month, day, hour = 12, minute = 0 }, timeZone) {
  const asIfUTC = Date.UTC(year, month - 1, day, hour, minute);
  const guess = asIfUTC - zoneOffsetMs(asIfUTC, timeZone);
  return asIfUTC - zoneOffsetMs(guess, timeZone);
}

/** Today's calendar date in `timeZone`, as `{ year, month, day }`. */
export function civilDateInZone(instant, timeZone) {
  const { year, month, day } = wallTimeInZone(instant, timeZone);
  return { year, month, day };
}

/** True when `timeZone` is a zone name this browser actually knows. */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The viewer's own zone, e.g. `'Asia/Kolkata'`. */
export function viewerTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
