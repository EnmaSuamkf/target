/**
 * Schedule recurrence math for scheduled workflows: when does a series run
 * next, which runs fell inside a window the hub was offline for, and how a
 * run's instant reads in the schedule's own timezone.
 *
 * Why Intl only. The hub has zero runtime dependencies (hub/package.json) and a
 * cron or date library would be the first; the only thing such a library adds
 * here is timezone data, and the Node runtime already ships the full IANA
 * database behind Intl.DateTimeFormat. Everything below is built on one
 * primitive — "what does the wall clock read in <zone> at instant t"
 * (`wallClock`) — and inverts it where needed (`resolveLocal`).
 *
 * Why an explicit timezone and not the hub's local one. A schedule is a wall
 * clock promise ("every weekday at 09:00 in Madrid"): the laptop running the
 * hub may travel, and a server-created series is authored in the operator's
 * zone, not the hub's. So every function takes the zone, and the instants they
 * return are absolute (Date), which is what gets stored as next_run_at.
 *
 * DST (decision D6). Two local times need a rule:
 *  - a NON-EXISTENT time (inside a spring-forward gap, e.g. 02:30 in New York
 *    on the March change, or 00:30 in Santiago in September, where midnight is
 *    skipped) resolves to the next valid instant — the transition itself, which
 *    reads 03:00 / 01:00 on the wall. The run still happens that day instead of
 *    silently vanishing.
 *  - an AMBIGUOUS time (inside a fall-back overlap, e.g. 01:30 in New York on
 *    the November change) resolves to its FIRST occurrence only. Because every
 *    occurrence is resolved from a local date, never by adding 24h to the
 *    previous instant, the repeated hour can never produce a second run.
 */

export type ScheduleSpec =
  | { kind: "once"; at: string } // local "YYYY-MM-DDTHH:mm"
  | { kind: "daily"; time: string } // local "HH:mm"
  | { kind: "weekly"; days: number[]; time: string }; // days 0=Sunday..6

export interface ScheduleFieldError {
  field: "spec" | "kind" | "at" | "time" | "days" | "timezone" | "includePrevious";
  message: string;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

let supportedZones: Set<string> | null = null;

/**
 * A zone is valid when it's in Intl's canonical list, or when Intl accepts it
 * AND reports it back verbatim. The second clause admits what the list leaves
 * out but a browser can legitimately report as its own zone ("UTC", and IANA
 * links such as "Asia/Calcutta"), while still rejecting what Intl merely
 * tolerates: it matches zones case-insensitively ("america/new_york") and maps
 * "GMT" to "UTC", and a zone that doesn't round-trip would be stored under a
 * name nothing else recognises.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  supportedZones ??= new Set(Intl.supportedValuesOf("timeZone"));
  if (supportedZones.has(tz)) return true;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone === tz;
  } catch {
    return false;
  }
}

/** Field errors for a schedule; an empty array means it's valid. Whether a
 * `once` is already in the past is NOT checked here — that depends on "now",
 * and nextOccurrence answers it (null). */
export function validateSchedule(spec: unknown, timezone: unknown): ScheduleFieldError[] {
  const errors: ScheduleFieldError[] = [];
  if (!isValidTimeZone(timezone)) {
    errors.push({ field: "timezone", message: "timezone must be a valid IANA time zone (e.g. Europe/Madrid)" });
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    errors.push({ field: "spec", message: "schedule must be an object" });
    return errors;
  }
  const s = spec as Record<string, unknown>;
  if (s.kind === "once") {
    if (typeof s.at !== "string" || !parseLocalDateTime(s.at)) {
      errors.push({ field: "at", message: "at must be a valid local date and time, YYYY-MM-DDTHH:mm" });
    }
  } else if (s.kind === "daily" || s.kind === "weekly") {
    if (typeof s.time !== "string" || !TIME_RE.test(s.time)) {
      errors.push({ field: "time", message: "time must be HH:mm (00:00–23:59)" });
    }
    if (s.kind === "weekly") {
      const days = s.days;
      if (!Array.isArray(days) || days.length === 0) {
        errors.push({ field: "days", message: "days must list at least one day of the week" });
      } else if (!days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        errors.push({ field: "days", message: "days must be integers from 0 (Sunday) to 6 (Saturday)" });
      } else if (new Set(days).size !== days.length) {
        errors.push({ field: "days", message: "days must not repeat" });
      }
    }
  } else {
    errors.push({ field: "kind", message: 'kind must be "once", "daily" or "weekly"' });
  }
  return errors;
}

/**
 * The first run strictly AFTER `after`, or null when there is none (a `once`
 * whose instant is not in the future). Strictly after, so feeding a run's own
 * instant back in yields the following run — that's how the scheduler advances
 * a series after firing (or skipping) it.
 */
export function nextOccurrence(spec: ScheduleSpec, timezone: string, after: Date): Date | null {
  const afterMs = after.getTime();
  if (spec.kind === "once") {
    const p = parseLocalDateTime(spec.at);
    if (!p) return null;
    const t = resolveLocal(timezone, p.y, p.m, p.d, p.hh, p.mm);
    return t > afterMs ? new Date(t) : null;
  }
  const [hh, mm] = spec.time.split(":").map(Number);
  const days = spec.kind === "weekly" ? new Set(spec.days) : null;
  if (days && days.size === 0) return null;
  const start = wallClock(timezone, afterMs);
  // Walk local calendar dates from the one `after` falls on. Eight days covers
  // a full week plus today's run having already passed; a weekly spec with any
  // day always matches within that.
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    if (days && !days.has(date.getUTCDay())) continue;
    const t = resolveLocal(timezone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hh, mm);
    if (t > afterMs) return new Date(t);
  }
  return null;
}

/**
 * Every run in [from, to), oldest first — what a hub that was offline over that
 * window would have run, for the "N runs missed" notice. Capped so a series
 * left alone for years can't build an unbounded array; a notice only needs the
 * count and a few of the instants.
 */
export function occurrencesBetween(
  spec: ScheduleSpec,
  timezone: string,
  from: Date,
  to: Date,
  limit = 10_000,
): Date[] {
  const out: Date[] = [];
  let next = nextOccurrence(spec, timezone, new Date(from.getTime() - 1));
  while (next && next.getTime() < to.getTime() && out.length < limit) {
    out.push(next);
    next = nextOccurrence(spec, timezone, next);
  }
  return out;
}

/** "YYYY-MM-DD HH:mm" as the wall clock in `timezone` reads at `date`. */
export function formatInZone(date: Date, timezone: string): string {
  const w = wallClock(timezone, date.getTime());
  return `${w.y}-${pad(w.m)}-${pad(w.d)} ${pad(w.hh)}:${pad(w.mm)}`;
}

// ---------------------------------------------------------------------------

interface Wall {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    // h23, not hour12:false: the latter renders midnight as "24" in some ICU
    // builds, which would read as the next day's 00.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, f);
  }
  return f;
}

function wallClock(timezone: string, t: number): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(t))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year, m: parts.month, d: parts.day, hh: parts.hour, mm: parts.minute, ss: parts.second };
}

/** The wall clock reading as if it were UTC — lets wall times be compared and
 * subtracted as plain numbers. */
function wallMs(w: Wall): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
}

/** UTC offset (ms) in effect at instant t; rounded down to the second the
 * formatter can express. */
function offsetAt(timezone: string, t: number): number {
  const whole = t - (((t % 1000) + 1000) % 1000);
  return wallMs(wallClock(timezone, whole)) - whole;
}

/**
 * The instant at which the wall clock in `timezone` reads the given local time,
 * applying the D6 rule (see the header) when it reads it twice or never.
 *
 * The answer is `local - offset` for whichever offset is in effect then, and no
 * zone offset exceeds ±14h, so the offsets in effect a day and a half either
 * side of the local time are the only candidates (transitions are months
 * apart). Each candidate is checked by reading the wall clock back.
 */
function resolveLocal(timezone: string, y: number, m: number, d: number, hh: number, mm: number): number {
  const local = Date.UTC(y, m - 1, d, hh, mm);
  const offsets = [
    ...new Set([
      offsetAt(timezone, local - 1.5 * DAY),
      offsetAt(timezone, local),
      offsetAt(timezone, local + 1.5 * DAY),
    ]),
  ];
  const hits = offsets.map((o) => local - o).filter((t) => wallMs(wallClock(timezone, t)) === local);
  if (hits.length) return Math.min(...hits); // ambiguous → first occurrence
  // Gap: the local time is skipped. Between the instant it maps to under the
  // later (larger) offset — the wall still reads before it — and the one under
  // the earlier offset — already past it — find the first minute whose wall
  // clock has reached it: the transition.
  let lo = local - Math.max(...offsets);
  let hi = local - Math.min(...offsets);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (wallMs(wallClock(timezone, mid)) >= local) hi = mid;
    else lo = mid;
  }
  return hi;
}

function parseLocalDateTime(at: string): { y: number; m: number; d: number; hh: number; mm: number } | null {
  const match = AT_RE.exec(at);
  if (!match) return null;
  const [y, m, d, hh, mm] = match.slice(1).map(Number);
  // Reject calendar dates that don't exist (2026-02-30), which Date.UTC would
  // quietly roll over into March.
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d, hh, mm };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
