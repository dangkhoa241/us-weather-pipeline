// src/lib/time.js
// Local wall-clock time for a UTC instant. Warehouses group days/weeks/… by `local_time`, so a city's
// "day" is its own local day. Storage stays UTC; `local_time` is an extra, derived column.

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * The wall-clock time in `timeZone` at instant `date`, returned as a Date whose UTC fields hold that
 * wall-clock time (e.g. 2026-01-01T08:00Z in America/Los_Angeles → 2026-01-01T00:00Z).
 */
export function localWallClock(date, timeZone) {
  const p = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map(({ type, value }) => [type, value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}
