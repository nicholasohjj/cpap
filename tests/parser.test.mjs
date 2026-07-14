import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  civilDateLabel,
  parseAnnotations,
  parseEdfEntriesSafely,
  parseEdfEntry,
  parseEdfHeader,
  parseSignals,
  parseStartDate,
  validateCrcEntriesSafely,
} from "../src/edfParser.js";

function bufferToArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function entry(path, relativePath = path) {
  const buffer = await readFile(path);
  return {
    name: path.split("/").pop(),
    relativePath,
    file: {
      size: buffer.byteLength,
      lastModified: 0,
      arrayBuffer: async () => bufferToArrayBuffer(buffer),
    },
  };
}

async function folderEntries(root, relativePrefix = "") {
  const names = await readdir(root);
  return Promise.all(names
    .filter((name) => /\.(edf|crc)$/i.test(name))
    .sort()
    .map((name) => entry(path.join(root, name), path.join(relativePrefix, name))));
}

function percentile(values, p) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  const index = ((valid.length - 1) * p) / 100;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return lo === hi ? valid[lo] : valid[lo] * (hi - index) + valid[hi] * (index - lo);
}

test("parses BRP header and validates record CRC", async () => {
  const parsed = await parseEdfEntry(await entry("20260712/20260713_005316_BRP.edf"), "summary");
  assert.equal(parsed.header.type, "BRP");
  assert.equal(parsed.header.recordCount, 294);
  assert.equal(parsed.header.recordDuration, 60);
  assert.deepEqual(parsed.header.labels, ["Flow.40ms", "Press.40ms", "Crc16"]);
  assert.equal(parsed.crc.internal.checked, true);
  assert.equal(parsed.crc.internal.ok, 294);
  assert.equal(parsed.crc.internal.bad, 0);
});

test("extracts EDF+ event annotations", async () => {
  const parsed = await parseEdfEntry(await entry("20260712/20260713_005314_EVE.edf"), "summary");
  assert.equal(parsed.header.type, "EVE");
  assert.equal(parsed.annotations.length, 5);
  assert.deepEqual(parsed.annotations[0], { onset: 7834, duration: 11, label: "Central Apnea" });
});

test("converts PLD pressure and leak physical values", async () => {
  const raw = bufferToArrayBuffer(await readFile("20260712/20260713_005317_PLD.edf"));
  const header = parseEdfHeader(raw, "20260713_005317_PLD.edf");
  const signals = parseSignals(raw, header, "detail");
  const pressure95 = percentile(signals["Press.2s"].map((point) => point.value), 95);
  const leak95LMin = percentile(signals["Leak.2s"].map((point) => point.value), 95) * 60;
  assert.equal(Math.round(pressure95 * 10) / 10, 8.4);
  assert.equal(Math.round(leak95LMin * 10) / 10, 6.0);
});

test("filters out-of-range SAD placeholder samples", async () => {
  const raw = bufferToArrayBuffer(await readFile("20260712/20260713_005317_SAD.edf"));
  const header = parseEdfHeader(raw, "20260713_005317_SAD.edf");
  const signals = parseSignals(raw, header, "detail");
  const validSpo2 = signals["SpO2.1s"].filter((point) => Number.isFinite(point.value));
  assert.equal(validSpo2.length, 0);
});

test("parses CSL without scoring false events", async () => {
  const raw = bufferToArrayBuffer(await readFile("20260712/20260713_005314_CSL.edf"));
  const header = parseEdfHeader(raw, "20260713_005314_CSL.edf");
  assert.equal(parseAnnotations(raw, header).length, 0);
});

test("scan mode defers record CRC until validation pass", async () => {
  const scan = await parseEdfEntry(await entry("20260712/20260713_005316_BRP.edf"), "scan");
  assert.equal(scan.header.type, "BRP");
  assert.equal(scan.signalsLoaded, false);
  assert.equal(scan.signals["Flow.40ms"], undefined);
  assert.equal(scan.crc.internal.checked, false);
  assert.equal(scan.crc.internal.reason, "CRC pending");

  const { results, failures } = await validateCrcEntriesSafely([
    await entry("20260712/20260713_005316_BRP.edf"),
    await entry("20260712/20260713_005316_BRP.crc"),
  ]);
  assert.equal(failures.length, 0);
  assert.equal(results[0].crc.internal.ok, 294);
  assert.equal(results[0].crc.internal.bad, 0);
  assert.equal(results[0].crc.sidecar.present, true);
});

test("safe batch parsing continues after malformed EDF files", async () => {
  const bad = {
    name: "BROKEN.edf",
    relativePath: "DATALOG/20260712/BROKEN.edf",
    file: {
      size: 12,
      lastModified: 0,
      arrayBuffer: async () => new ArrayBuffer(12),
    },
  };
  const good = await entry("20260712/20260713_005314_EVE.edf", "DATALOG/20260712/20260713_005314_EVE.edf");
  const { files, failures } = await parseEdfEntriesSafely([bad, good], "scan", { skipCrc: true });
  assert.equal(files.length, 1);
  assert.equal(files[0].header.type, "EVE");
  assert.equal(files[0].annotations.length, 5);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].relativePath, "DATALOG/20260712/BROKEN.edf");
});

test("safe batch parsing honors cancellation checks", async () => {
  await assert.rejects(
    parseEdfEntriesSafely([await entry("20260712/20260713_005316_BRP.edf")], "scan", {
      shouldCancel: () => true,
    }),
    /Parsing cancelled/
  );
});

test("parses a full DATALOG-style folder with sidecars", async () => {
  const entries = await folderEntries("20260712", "DATALOG/20260712");
  const { files, failures } = await parseEdfEntriesSafely(entries, "scan", { skipCrc: true });
  const byType = files.reduce((counts, file) => {
    counts[file.header.type] = (counts[file.header.type] || 0) + 1;
    return counts;
  }, {});
  assert.equal(failures.length, 0);
  assert.equal(files.length, 5);
  assert.deepEqual(byType, { CSL: 1, EVE: 1, BRP: 1, PLD: 1, SAD: 1 });
  assert.equal(files.filter((file) => file.crc.sidecar.present).length, 5);
  assert.equal(files.every((file) => file.relativePath.startsWith("DATALOG/20260712/")), true);
});

test("device-local EDF dates stay civil-time stable", async () => {
  const civil = parseStartDate("13.07.26", "00.53.18");
  assert.deepEqual(civil, { year: 2026, month: 7, day: 13, hour: 0, minute: 53, second: 18 });
  assert.equal(civilDateLabel(civil), "2026-07-13");

  const parsed = await parseEdfEntry(await entry("20260712/20260713_005316_BRP.edf"), "scan");
  assert.equal(civilDateLabel(parsed.header.startedAtCivil), "2026-07-13");
  assert.equal(parsed.header.startedAtMs, Date.UTC(2026, 6, 13, 0, 53, 17));
});
