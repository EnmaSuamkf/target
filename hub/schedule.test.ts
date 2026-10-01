/**
 * Tests for schedule.ts: the recurrence math behind scheduled workflows.
 *
 * Every expectation is an absolute UTC instant, worked out by hand from the
 * zone's rules, so a regression in the Intl-based inversion shows up as a wrong
 * instant rather than as a wrong string that happens to look right. The DST
 * cases pin decision D6 in three zones whose transitions differ in kind:
 *  - America/New_York: 02:00 → 03:00 in March, 02:00 → 01:00 in November;
 *  - Europe/Madrid: 02:00 → 03:00 and 03:00 → 02:00 (last Sundays, at 01:00Z);
 *  - America/Santiago: the change happens AT MIDNIGHT, so in September the
 *    local date starts at 01:00 (00:xx doesn't exist) and in April the
 *    previous evening's 23:xx happens twice — the case that breaks code
 *    assuming "midnight always exists".
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatInZone,
  isValidTimeZone,
  nextOccurrence,
  occurrencesBetween,
  validateSchedule,
  type ScheduleSpec,
} from "./schedule.ts";

const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => d?.toISOString() ?? null;

// --- once -------------------------------------------------------------------

test("once resolves its local time in the schedule's zone", () => {
  const spec: ScheduleSpec = { kind: "once", at: "2026-10-05T09:15" };
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", at("2026-10-01T00:00:00Z"))), "2026-10-05T07:15:00.000Z");
  assert.equal(iso(nextOccurrence(spec, "America/New_York", at("2026-10-01T00:00:00Z"))), "2026-10-05T13:15:00.000Z");
  assert.equal(iso(nextOccurrence(spec, "UTC", at("2026-10-01T00:00:00Z"))), "2026-10-05T09:15:00.000Z");
});

test("once in the past (or exactly now) has no next occurrence", () => {
  const spec: ScheduleSpec = { kind: "once", at: "2026-10-05T09:15" };
  assert.equal(nextOccurrence(spec, "Europe/Madrid", at("2026-10-06T00:00:00Z")), null);
  // strictly after: the run's own instant is not its next occurrence
  assert.equal(nextOccurrence(spec, "Europe/Madrid", at("2026-10-05T07:15:00Z")), null);
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", at("2026-10-05T07:14:59Z"))), "2026-10-05T07:15:00.000Z");
});

// --- daily ------------------------------------------------------------------

test("daily runs later today when the time is still ahead, otherwise tomorrow", () => {
  const spec: ScheduleSpec = { kind: "daily", time: "09:00" };
  // 08:00 in Madrid (CEST) → today 09:00
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", at("2026-09-30T06:00:00Z"))), "2026-09-30T07:00:00.000Z");
  // exactly 09:00 → tomorrow (strictly after)
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", at("2026-09-30T07:00:00Z"))), "2026-10-01T07:00:00.000Z");
  // 10:00 → tomorrow
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", at("2026-09-30T08:00:00Z"))), "2026-10-01T07:00:00.000Z");
});

test("daily uses the local date of the zone, not of UTC", () => {
  // 23:30 on Sep 30 in New York is already Oct 1 in UTC; the next 23:45 run is
  // still Sep 30 local.
  const spec: ScheduleSpec = { kind: "daily", time: "23:45" };
  assert.equal(iso(nextOccurrence(spec, "America/New_York", at("2026-10-01T03:30:00Z"))), "2026-10-01T03:45:00.000Z");
});

test("daily at midnight", () => {
  const spec: ScheduleSpec = { kind: "daily", time: "00:00" };
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", at("2026-09-30T12:00:00Z"))), "2026-09-30T22:00:00.000Z");
  assert.equal(formatInZone(at("2026-09-30T22:00:00Z"), "Europe/Madrid"), "2026-10-01 00:00");
});

// --- weekly -----------------------------------------------------------------

test("weekly picks the next listed weekday", () => {
  // Mon/Wed/Fri at 09:00 Madrid. 2026-09-30 is a Wednesday.
  const spec: ScheduleSpec = { kind: "weekly", days: [1, 3, 5], time: "09:00" };
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", at("2026-09-30T06:00:00Z"))), "2026-09-30T07:00:00.000Z");
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", at("2026-09-30T08:00:00Z"))), "2026-10-02T07:00:00.000Z");
});

test("weekly wraps around the end of the week", () => {
  // Only Monday. From Tuesday Sep 29 the next is Monday Oct 5.
  const monday: ScheduleSpec = { kind: "weekly", days: [1], time: "09:00" };
  assert.equal(iso(nextOccurrence(monday, "Europe/Madrid", at("2026-09-29T12:00:00Z"))), "2026-10-05T07:00:00.000Z");
  // Only Sunday (0), asked on Saturday Oct 3 → Sunday Oct 4.
  const sunday: ScheduleSpec = { kind: "weekly", days: [0], time: "18:00" };
  assert.equal(iso(nextOccurrence(sunday, "Europe/Madrid", at("2026-10-03T12:00:00Z"))), "2026-10-04T16:00:00.000Z");
  // Only Wednesday, asked on Wednesday after the run → a full week later.
  const wed: ScheduleSpec = { kind: "weekly", days: [3], time: "09:00" };
  assert.equal(iso(nextOccurrence(wed, "Europe/Madrid", at("2026-09-30T08:00:00Z"))), "2026-10-07T07:00:00.000Z");
});

test("weekly day order in the spec doesn't matter", () => {
  const a: ScheduleSpec = { kind: "weekly", days: [5, 1], time: "09:00" };
  const b: ScheduleSpec = { kind: "weekly", days: [1, 5], time: "09:00" };
  const after = at("2026-09-30T12:00:00Z");
  assert.equal(iso(nextOccurrence(a, "Europe/Madrid", after)), iso(nextOccurrence(b, "Europe/Madrid", after)));
});

// --- DST: spring forward (non-existent local time → next valid instant) ------

test("DST gap, America/New_York: 02:30 on the March change runs at 03:00 EDT", () => {
  const spec: ScheduleSpec = { kind: "daily", time: "02:30" };
  const t = nextOccurrence(spec, "America/New_York", at("2026-03-06T12:00:00Z"));
  assert.equal(iso(t), "2026-03-07T07:30:00.000Z"); // Mar 7 still EST
  const gap = nextOccurrence(spec, "America/New_York", t!);
  assert.equal(iso(gap), "2026-03-08T07:00:00.000Z");
  assert.equal(formatInZone(gap!, "America/New_York"), "2026-03-08 03:00");
  // and the day after is back to 02:30, now EDT
  assert.equal(iso(nextOccurrence(spec, "America/New_York", gap!)), "2026-03-09T06:30:00.000Z");
});

test("DST gap, Europe/Madrid: 02:30 on the March change runs at 03:00 CEST", () => {
  const spec: ScheduleSpec = { kind: "once", at: "2026-03-29T02:30" };
  const t = nextOccurrence(spec, "Europe/Madrid", at("2026-03-01T00:00:00Z"));
  assert.equal(iso(t), "2026-03-29T01:00:00.000Z");
  assert.equal(formatInZone(t!, "Europe/Madrid"), "2026-03-29 03:00");
  // times on either side of the gap are untouched
  assert.equal(iso(nextOccurrence({ kind: "once", at: "2026-03-29T01:59" }, "Europe/Madrid", at("2026-03-01T00:00:00Z"))), "2026-03-29T00:59:00.000Z");
  assert.equal(iso(nextOccurrence({ kind: "once", at: "2026-03-29T03:00" }, "Europe/Madrid", at("2026-03-01T00:00:00Z"))), "2026-03-29T01:00:00.000Z");
});

test("DST gap, America/Santiago: midnight is skipped in September, 00:30 runs at 01:00", () => {
  // Sunday 2026-09-06: 00:00 -04 → 01:00 -03 (04:00Z).
  const spec: ScheduleSpec = { kind: "daily", time: "00:30" };
  const t = nextOccurrence(spec, "America/Santiago", at("2026-09-05T12:00:00Z"));
  assert.equal(iso(t), "2026-09-06T04:00:00.000Z");
  assert.equal(formatInZone(t!, "America/Santiago"), "2026-09-06 01:00");
  assert.equal(iso(nextOccurrence(spec, "America/Santiago", t!)), "2026-09-07T03:30:00.000Z");
  // weekly on Sunday hits the same gap and still runs that Sunday
  const sunday: ScheduleSpec = { kind: "weekly", days: [0], time: "00:00" };
  assert.equal(iso(nextOccurrence(sunday, "America/Santiago", at("2026-09-02T12:00:00Z"))), "2026-09-06T04:00:00.000Z");
});

// --- DST: fall back (ambiguous local time → first occurrence, once) ----------

test("DST overlap, America/New_York: 01:30 on the November change runs once, at the EDT one", () => {
  const spec: ScheduleSpec = { kind: "daily", time: "01:30" };
  const first = nextOccurrence(spec, "America/New_York", at("2026-10-31T12:00:00Z"));
  assert.equal(iso(first), "2026-11-01T05:30:00.000Z"); // 01:30 EDT
  // asking again between the two 01:30s must NOT yield the repeated one (06:30Z)
  const next = nextOccurrence(spec, "America/New_York", first!);
  assert.equal(iso(next), "2026-11-02T06:30:00.000Z"); // Nov 2, 01:30 EST
  assert.equal(iso(nextOccurrence(spec, "America/New_York", at("2026-11-01T06:00:00Z"))), "2026-11-02T06:30:00.000Z");
});

test("DST overlap, Europe/Madrid: 02:30 on the October change runs once, at the CEST one", () => {
  const spec: ScheduleSpec = { kind: "daily", time: "02:30" };
  const first = nextOccurrence(spec, "Europe/Madrid", at("2026-10-24T12:00:00Z"));
  assert.equal(iso(first), "2026-10-25T00:30:00.000Z");
  assert.equal(iso(nextOccurrence(spec, "Europe/Madrid", first!)), "2026-10-26T01:30:00.000Z");
  const runs = occurrencesBetween(spec, "Europe/Madrid", at("2026-10-24T12:00:00Z"), at("2026-10-26T12:00:00Z"));
  assert.deepEqual(runs.map(iso), ["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
});

test("DST overlap, America/Santiago: 23:30 repeats on the April change and runs once", () => {
  // Sunday 2026-04-05 00:00 -03 → Saturday 23:00 -04 (03:00Z): Saturday's
  // 23:00–23:59 happens twice.
  const spec: ScheduleSpec = { kind: "daily", time: "23:30" };
  const first = nextOccurrence(spec, "America/Santiago", at("2026-04-04T12:00:00Z"));
  assert.equal(iso(first), "2026-04-05T02:30:00.000Z"); // first 23:30 (-03)
  assert.equal(formatInZone(first!, "America/Santiago"), "2026-04-04 23:30");
  const next = nextOccurrence(spec, "America/Santiago", first!);
  assert.equal(iso(next), "2026-04-06T03:30:00.000Z"); // Sunday 23:30 (-04), not the repeat at 03:30Z Apr 5
  // and midnight on Sunday exists exactly once
  assert.equal(iso(nextOccurrence({ kind: "once", at: "2026-04-05T00:00" }, "America/Santiago", at("2026-04-01T00:00:00Z"))), "2026-04-05T04:00:00.000Z");
});

// --- occurrencesBetween -----------------------------------------------------

test("occurrencesBetween lists runs in [from, to), oldest first", () => {
  const spec: ScheduleSpec = { kind: "daily", time: "09:00" };
  const runs = occurrencesBetween(spec, "Europe/Madrid", at("2026-09-28T07:00:00Z"), at("2026-10-01T07:00:00Z"));
  assert.deepEqual(runs.map(iso), ["2026-09-28T07:00:00.000Z", "2026-09-29T07:00:00.000Z", "2026-09-30T07:00:00.000Z"]);
});

test("occurrencesBetween spans a DST change and honours the limit", () => {
  const weekly: ScheduleSpec = { kind: "weekly", days: [0], time: "10:00" };
  const runs = occurrencesBetween(weekly, "America/New_York", at("2026-10-20T00:00:00Z"), at("2026-11-10T00:00:00Z"));
  assert.deepEqual(runs.map(iso), ["2026-10-25T14:00:00.000Z", "2026-11-01T15:00:00.000Z", "2026-11-08T15:00:00.000Z"]);
  const daily: ScheduleSpec = { kind: "daily", time: "09:00" };
  assert.equal(occurrencesBetween(daily, "UTC", at("2020-01-01T00:00:00Z"), at("2026-01-01T00:00:00Z"), 5).length, 5);
});

test("occurrencesBetween of a once returns it only when inside the window", () => {
  const spec: ScheduleSpec = { kind: "once", at: "2026-10-05T09:15" };
  assert.equal(occurrencesBetween(spec, "UTC", at("2026-10-01T00:00:00Z"), at("2026-10-10T00:00:00Z")).length, 1);
  assert.equal(occurrencesBetween(spec, "UTC", at("2026-10-06T00:00:00Z"), at("2026-10-10T00:00:00Z")).length, 0);
});

// --- formatInZone -----------------------------------------------------------

test("formatInZone renders the zone's wall clock", () => {
  const d = at("2026-09-30T22:05:00Z");
  assert.equal(formatInZone(d, "UTC"), "2026-09-30 22:05");
  assert.equal(formatInZone(d, "Europe/Madrid"), "2026-10-01 00:05");
  assert.equal(formatInZone(d, "America/New_York"), "2026-09-30 18:05");
  assert.equal(formatInZone(d, "Asia/Kolkata"), "2026-10-01 03:35");
});

// --- validation -------------------------------------------------------------

test("valid schedules have no errors", () => {
  assert.deepEqual(validateSchedule({ kind: "once", at: "2026-10-05T09:15" }, "Europe/Madrid"), []);
  assert.deepEqual(validateSchedule({ kind: "daily", time: "00:00" }, "UTC"), []);
  assert.deepEqual(validateSchedule({ kind: "weekly", days: [0, 6], time: "23:59" }, "America/Santiago"), []);
});

test("timezone must be a real IANA zone, spelled as Intl reports it", () => {
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Asia/Calcutta"), true); // IANA link a browser may report
  for (const tz of ["Mars/Olympus", "", "america/new_york", "GMT+2", 42, null, undefined]) {
    assert.equal(isValidTimeZone(tz), false, String(tz));
    const errors = validateSchedule({ kind: "daily", time: "09:00" }, tz);
    assert.deepEqual(errors.map((e) => e.field), ["timezone"], String(tz));
  }
});

test("invalid times, dates and kinds are reported per field", () => {
  const fields = (spec: unknown) => validateSchedule(spec, "UTC").map((e) => e.field);
  for (const time of ["9:00", "24:00", "12:60", "12:00:00", "", 900, undefined]) {
    assert.deepEqual(fields({ kind: "daily", time }), ["time"], String(time));
  }
  for (const a of ["2026-02-30T10:00", "2026-13-01T10:00", "2026-10-05 09:15", "2026-10-05T25:00", "2026-10-05", 0]) {
    assert.deepEqual(fields({ kind: "once", at: a }), ["at"], String(a));
  }
  assert.deepEqual(fields({ kind: "hourly", time: "09:00" }), ["kind"]);
  assert.deepEqual(fields({}), ["kind"]);
  assert.deepEqual(fields(null), ["spec"]);
  assert.deepEqual(fields("daily"), ["spec"]);
  assert.deepEqual(fields([]), ["spec"]);
});

test("weekly days must be non-empty, 0..6 integers, without repeats", () => {
  const fields = (days: unknown) => validateSchedule({ kind: "weekly", days, time: "09:00" }, "UTC").map((e) => e.field);
  for (const days of [[], undefined, "1,2", [7], [-1], [1.5], ["1"], [1, 1]]) {
    assert.deepEqual(fields(days), ["days"], JSON.stringify(days));
  }
  // errors combine
  assert.deepEqual(
    validateSchedule({ kind: "weekly", days: [], time: "9" }, "nowhere").map((e) => e.field).sort(),
    ["days", "time", "timezone"],
  );
});
