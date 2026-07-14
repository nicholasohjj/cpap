import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAnnotations, parseEdfEntry, parseEdfHeader, parseSignals } from "../src/edfParser.js";

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
