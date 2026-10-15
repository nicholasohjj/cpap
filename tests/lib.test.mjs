import assert from "node:assert/strict";
import test from "node:test";
import {
  envelopeSeries,
  maskWindowLabel,
  minutesSinceTherapyNoon,
  nearestAt,
  sliceByTime,
  therapyDayFor,
} from "../src/lib/format.js";
import { buildDailyRows, findMaskWindowForCluster } from "../src/lib/session.js";

const series = (points) => points.map(([t, value]) => ({ t, value }));

test("nearestAt searches by time across stitched files with gaps", () => {
  // Two PLD files at 2 s resolution with a 10-minute gap between them.
  const stitched = series([[0, 1], [2, 2], [4, 3], [604, 10], [606, 11]]);
  assert.equal(nearestAt(stitched, 605.2), 11);
  assert.equal(nearestAt(stitched, 3.1), 3);
  assert.equal(nearestAt(stitched, 300), null, "no sample near a gap");
  assert.equal(nearestAt([], 10), null);
});

test("sliceByTime returns the inclusive time window", () => {
  const data = series([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  assert.deepEqual(sliceByTime(data, 1, 3).map((point) => point.t), [1, 2, 3]);
  assert.deepEqual(sliceByTime(data, 10, 20), []);
});

test("envelopeSeries keeps peaks that averaging would flatten", () => {
  const wave = Array.from({ length: 10000 }, (_, i) => ({ t: i * 0.04, value: i % 2 ? 1 : -1 }));
  const out = envelopeSeries(wave, 100);
  assert.ok(out.length <= 200);
  assert.equal(Math.max(...out.map((point) => point.value)), 1);
  assert.equal(Math.min(...out.map((point) => point.value)), -1);
  assert.ok(out.every((point, i) => i === 0 || point.time >= out[i - 1].time), "sorted by time");
});

test("therapy day uses ResMed's noon boundary", () => {
  assert.equal(therapyDayFor(Date.UTC(2026, 6, 13, 0, 53)), "2026-07-12");
  assert.equal(therapyDayFor(Date.UTC(2026, 6, 13, 12, 0)), "2026-07-13");
  assert.equal(minutesSinceTherapyNoon(Date.UTC(2026, 6, 13, 0, 53)), 12 * 60 + 53);
});

test("STR mask windows are minutes since noon", () => {
  assert.equal(maskWindowLabel({ on: 660, off: 1110 }), "23:00-06:30");
  const str = {
    header: {
      type: "STR",
      recordCount: 1,
      recordDuration: 86400,
      startedAtMs: Date.UTC(2026, 6, 12),
      labels: ["Date", "MaskOn", "MaskOff"],
      samplesPerRecord: [1, 2, 2],
    },
    signals: {
      Date: [{ value: Date.UTC(2026, 6, 12) / 86400000 }],
      MaskOn: [{ value: 660 }, { value: 0 }],
      MaskOff: [{ value: 1110 }, { value: 0 }],
    },
  };
  const [row] = buildDailyRows([str]);
  assert.equal(row.date, "2026-07-12");
  assert.deepEqual(row.maskWindows, [{ on: 660, off: 1110, minutes: 450 }]);
  // A session starting at 00:53 on the 13th belongs to the 12th's 23:00-06:30 window.
  assert.equal(findMaskWindowForCluster({ startMs: Date.UTC(2026, 6, 13, 0, 53) }, [row]), "23:00-06:30");
  assert.equal(findMaskWindowForCluster({ startMs: Date.UTC(2026, 6, 13, 9, 0) }, [row]), null);
});
