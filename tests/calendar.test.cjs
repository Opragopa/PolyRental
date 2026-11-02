const { test } = require("node:test");
const assert = require("node:assert/strict");
const { selectRange, periodError, addDays } = require("../app/miniapp_static/range-calendar.js");

test("two taps complete a range; third restarts; earlier tap restarts", () => {
  const minimum = "2026-10-30";
  const first = selectRange({}, minimum, minimum);
  assert.deepEqual(first, {start: minimum, end: ""});
  assert.deepEqual(selectRange(first, "2026-10-29", minimum), first);
  const second = selectRange(first, "2026-11-02", minimum);
  assert.deepEqual(second, {start: minimum, end: "2026-11-02"});
  assert.deepEqual(selectRange(second, "2026-11-03", minimum), {start:"2026-11-03", end:""});
  assert.deepEqual(selectRange({start:"2026-11-03", end:""}, minimum, minimum), first);
});
test("same day range allowed when the end time is later, in Moscow", () => {
  const start = "2026-10-30T10:00";
  assert.equal(periodError(start, "2026-10-30T18:00", "2026-10-30", 0), "");
  assert.match(periodError(start, start, "2026-10-30", 0), /позже/);
  assert.match(periodError(start, "2026-10-30T09:00", "2026-10-30", 0), /позже/);
  assert.match(periodError(start, "2026-10-30T18:00", "2026-10-31", 0), /текущую или будущую дату/);
  assert.match(periodError(start, "2026-10-30T18:00", "2026-10-30", Date.parse("2026-10-30T07:01Z")), /будущем/);
  assert.match(periodError(start, "", "2026-10-30", 0), /двумя/);
  assert.match(periodError(start, "2026-10-30T25:00", "2026-10-30", 0), /время/);
  assert.match(periodError("2027-02-30T10:00", "2027-03-02T10:00", "2026-10-30", 0), /дату/);
});
test("date arithmetic crosses month, leap day and year without device timezone", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
});
