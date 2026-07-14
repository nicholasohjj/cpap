const INVALID_DIGITAL = new Set([-32768, 32767]);
const CRC_PENDING = { checked: false, ok: 0, bad: 0, total: 0, reason: "CRC pending" };

function cancellationError() {
  const err = new Error("Parsing cancelled");
  err.name = "AbortError";
  return err;
}

function checkCancelled(options = {}) {
  if (options.signal?.aborted || options.shouldCancel?.()) {
    throw cancellationError();
  }
}

function toArrayBufferFromChunks(chunks, totalBytes) {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach((chunk) => {
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    out.set(view, offset);
    offset += view.byteLength;
  });
  return out.buffer;
}

async function readArrayBufferWithChecks(file, options = {}) {
  checkCancelled(options);
  const buffer = await file.arrayBuffer();
  checkCancelled(options);
  return buffer;
}

export async function readFileBuffer(file, options = {}) {
  if (!file) throw new Error("Missing file data");
  if (file.stream && !options.preferArrayBuffer) {
    const reader = file.stream().getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        checkCancelled(options);
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      checkCancelled(options);
      return toArrayBufferFromChunks(chunks, total);
    } catch (err) {
      try {
        await reader.cancel();
      } catch {
        // Reader cancellation can fail after the browser already closed it.
      }
      throw err;
    }
  }
  if (file.arrayBuffer) return readArrayBufferWithChecks(file, options);
  throw new Error("File object does not expose arrayBuffer()");
}

async function readFileSlice(file, start, end, options = {}) {
  checkCancelled(options);
  if (file.slice) {
    return readFileBuffer(file.slice(start, end), options);
  }
  const full = await readFileBuffer(file, options);
  return full.slice(start, end);
}

export async function readEdfHeaderBuffer(file, options = {}) {
  const lead = await readFileSlice(file, 0, 256, options);
  if (lead.byteLength < 256) throw new Error("EDF header is truncated");
  const leadView = new DataView(lead);
  const headerBytes = numberField(ascii(leadView, 184, 8), 0);
  if (!Number.isFinite(headerBytes) || headerBytes < 256) {
    throw new Error("EDF header byte count is invalid");
  }
  if (headerBytes === 256) return lead;
  return readFileSlice(file, 0, headerBytes, options);
}

export function ascii(view, start, length) {
  let out = "";
  for (let i = start; i < start + length && i < view.byteLength; i += 1) {
    const code = view.getUint8(i);
    out += code >= 32 && code <= 126 ? String.fromCharCode(code) : " ";
  }
  return out.trim();
}

export function latin1(view, start, length) {
  let out = "";
  for (let i = start; i < start + length && i < view.byteLength; i += 1) {
    out += String.fromCharCode(view.getUint8(i));
  }
  return out;
}

export function numberField(text, fallback = null) {
  const n = Number(String(text).trim());
  return Number.isFinite(n) ? n : fallback;
}

export function parseStartDate(dateText, timeText) {
  const [day, month, year] = dateText.split(".").map((part) => Number(part));
  const [hour, minute, second] = timeText.split(".").map((part) => Number(part));
  if (!day || !month || year === undefined) return null;
  return {
    year: year < 85 ? 2000 + year : 1900 + year,
    month,
    day,
    hour: hour || 0,
    minute: minute || 0,
    second: second || 0,
  };
}

export function civilToEpochMs(civil) {
  if (!civil) return null;
  return Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour || 0, civil.minute || 0, civil.second || 0);
}

export function epochMsToCivil(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

export function civilDateLabel(civil) {
  if (!civil) return "";
  return `${civil.year}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")}`;
}

export function civilClockLabel(civil) {
  if (!civil) return "--:--";
  return `${String(civil.hour || 0).padStart(2, "0")}:${String(civil.minute || 0).padStart(2, "0")}`;
}

export function fileKind(name) {
  if (/^STR\.edf$/i.test(name)) return "STR";
  const match = name.match(/_([A-Z]{3})\.edf$/i);
  return match ? match[1].toUpperCase() : "EDF";
}

export function parseEdfHeader(buffer, fileName) {
  if (!buffer || buffer.byteLength < 256) throw new Error("EDF header is truncated");
  const view = new DataView(buffer);
  const signalCount = numberField(ascii(view, 252, 4), 0);
  if (!Number.isInteger(signalCount) || signalCount <= 0 || signalCount > 512) {
    throw new Error(`EDF signal count is invalid: ${signalCount}`);
  }

  let offset = 256;
  const readFields = (width, mapper = (x) => x) => {
    const end = offset + signalCount * width;
    if (end > view.byteLength) throw new Error("EDF signal header is truncated");
    const values = [];
    for (let i = 0; i < signalCount; i += 1) {
      values.push(mapper(ascii(view, offset + i * width, width)));
    }
    offset = end;
    return values;
  };

  const labels = readFields(16);
  const transducers = readFields(80);
  const dimensions = readFields(8);
  const physicalMin = readFields(8, (v) => numberField(v, 0));
  const physicalMax = readFields(8, (v) => numberField(v, 0));
  const digitalMin = readFields(8, (v) => numberField(v, 0));
  const digitalMax = readFields(8, (v) => numberField(v, 0));
  const prefilters = readFields(80);
  const samplesPerRecord = readFields(8, (v) => numberField(v, 0));
  const reservedSignals = readFields(32);
  const headerBytes = numberField(ascii(view, 184, 8), offset);
  const recordCount = numberField(ascii(view, 236, 8), 0);
  const recordDuration = numberField(ascii(view, 244, 8), 0);
  const startDate = ascii(view, 168, 8);
  const startTime = ascii(view, 176, 8);
  const startedAtCivil = parseStartDate(startDate, startTime);
  const startedAtMs = civilToEpochMs(startedAtCivil);

  if (!Number.isFinite(headerBytes) || headerBytes < offset) {
    throw new Error("EDF declared header size is invalid");
  }

  return {
    fileName,
    type: fileKind(fileName),
    version: ascii(view, 0, 8),
    patient: ascii(view, 8, 80),
    recording: ascii(view, 88, 80),
    startDate,
    startTime,
    startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs) : null,
    startedAtCivil,
    startedAtMs,
    headerBytes,
    reserved: ascii(view, 192, 44),
    recordCount,
    recordDuration,
    signalCount,
    labels,
    transducers,
    dimensions,
    physicalMin,
    physicalMax,
    digitalMin,
    digitalMax,
    prefilters,
    samplesPerRecord,
    reservedSignals,
    recordSampleCount: samplesPerRecord.reduce((sum, value) => sum + value, 0),
  };
}

export function digitalToPhysical(digital, header, signalIndex) {
  const dMin = header.digitalMin[signalIndex];
  const dMax = header.digitalMax[signalIndex];
  const pMin = header.physicalMin[signalIndex];
  const pMax = header.physicalMax[signalIndex];
  if (dMax === dMin) return digital;
  return ((digital - dMin) * (pMax - pMin)) / (dMax - dMin) + pMin;
}

export function parseSignalSeries(buffer, header, signalIndex, options = {}) {
  const view = new DataView(buffer);
  const values = [];
  const samplesBeforeSignal = header.samplesPerRecord.slice(0, signalIndex).reduce((sum, value) => sum + value, 0);
  const bytesPerRecord = header.recordSampleCount * 2;
  const signalSamples = header.samplesPerRecord[signalIndex];
  const sampleStep = signalSamples ? header.recordDuration / signalSamples : 0;

  for (let record = 0; record < header.recordCount; record += 1) {
    if (record % 25 === 0) checkCancelled(options);
    const recordOffset = header.headerBytes + record * bytesPerRecord;
    const signalOffset = recordOffset + samplesBeforeSignal * 2;
    for (let sample = 0; sample < signalSamples; sample += 1) {
      const byteOffset = signalOffset + sample * 2;
      if (byteOffset + 2 > view.byteLength) break;
      const digital = view.getInt16(byteOffset, true);
      const outsideRange = digital < header.digitalMin[signalIndex] || digital > header.digitalMax[signalIndex];
      const value = INVALID_DIGITAL.has(digital) || outsideRange ? null : digitalToPhysical(digital, header, signalIndex);
      values.push({ t: record * header.recordDuration + sample * sampleStep, value, digital });
    }
  }
  return values;
}

export function signalLabelsForMode(header, mode) {
  if (mode === "summary" || mode === "scan") return header.type === "STR" ? header.labels : [];
  if (mode === "detail") return header.type === "PLD" || header.type === "SAD" ? header.labels : [];
  if (mode === "flow") return header.type === "BRP" ? ["Flow.40ms", "Press.40ms"] : [];
  if (mode === "all") return header.labels;
  return [];
}

export function parseSignals(buffer, header, mode, options = {}) {
  const labels = new Set(signalLabelsForMode(header, mode));
  const signals = {};
  header.labels.forEach((label, index) => {
    if (label === "Crc16" || label === "EDF Annotations" || !labels.has(label)) return;
    signals[label] = parseSignalSeries(buffer, header, index, options);
  });
  return signals;
}

export function parseAnnotationText(text) {
  const events = [];
  const chunks = text.split("\u0000").filter(Boolean);
  chunks.forEach((chunk) => {
    const match = chunk.match(/^([+-]?\d+(?:\.\d+)?)(?:\u0015(\d+(?:\.\d+)?))?\u0014([\s\S]*)$/);
    if (!match) return;
    const onset = Number(match[1]);
    const duration = match[2] === undefined ? 0 : Number(match[2]);
    const labels = match[3].split("\u0014").map((value) => value.trim()).filter(Boolean);
    labels.forEach((label) => {
      if (label !== "Recording starts") events.push({ onset, duration, label });
    });
  });
  return events;
}

export function parseAnnotations(buffer, header, options = {}) {
  const view = new DataView(buffer);
  const annIndex = header.labels.findIndex((label) => label === "EDF Annotations");
  if (annIndex < 0) return [];
  const samplesBeforeSignal = header.samplesPerRecord.slice(0, annIndex).reduce((sum, value) => sum + value, 0);
  const bytesPerRecord = header.recordSampleCount * 2;
  const events = [];
  for (let record = 0; record < header.recordCount; record += 1) {
    if (record % 50 === 0) checkCancelled(options);
    const offset = header.headerBytes + record * bytesPerRecord + samplesBeforeSignal * 2;
    const length = header.samplesPerRecord[annIndex] * 2;
    events.push(...parseAnnotationText(latin1(view, offset, length)));
  }
  return events.sort((a, b) => a.onset - b.onset);
}

export function crc16CcittFalse(bytes, start, end) {
  let crc = 0xffff;
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export function validateRecordCrc(buffer, header, options = {}) {
  const crcIndex = header.labels.findIndex((label) => label === "Crc16");
  if (crcIndex < 0 || header.samplesPerRecord[crcIndex] !== 1) {
    return { checked: false, ok: 0, bad: 0, total: 0, reason: "No Crc16 signal" };
  }

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const bytesPerRecord = header.recordSampleCount * 2;
  const crcOffsetInRecord = header.samplesPerRecord.slice(0, crcIndex).reduce((sum, value) => sum + value, 0) * 2;
  let ok = 0;
  let bad = 0;

  for (let record = 0; record < header.recordCount; record += 1) {
    if (record % 100 === 0) checkCancelled(options);
    const recordStart = header.headerBytes + record * bytesPerRecord;
    const crcOffset = recordStart + crcOffsetInRecord;
    if (crcOffset + 2 > buffer.byteLength) {
      bad += 1;
      continue;
    }
    const stored = view.getUint16(crcOffset, true);
    const computed = crc16CcittFalse(bytes, recordStart, crcOffset);
    if (stored === computed) ok += 1;
    else bad += 1;
  }

  return { checked: true, ok, bad, total: ok + bad };
}

export function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function crcPathForEdf(relativePath) {
  return relativePath.replace(/\.edf$/i, ".crc");
}

function sidecarInfo(crcSidecar) {
  return crcSidecar
    ? { present: true, bytes: crcSidecar.bytes, hex: crcSidecar.hex }
    : { present: false, bytes: 0, hex: "" };
}

function shouldParseAnnotations(header, options = {}) {
  return options.parseAnnotations !== false && header.labels.includes("EDF Annotations");
}

function shouldValidateCrc(mode, options = {}) {
  if (options.skipCrc === true) return false;
  return mode !== "scan";
}

function needsFullBuffer(header, mode, options = {}) {
  return (
    signalLabelsForMode(header, mode).length > 0 ||
    shouldParseAnnotations(header, options) ||
    shouldValidateCrc(mode, options)
  );
}

export async function parseEdfEntry(entry, mode = "summary", crcSidecar = null, options = {}) {
  const relativePath = entry.relativePath || entry.name;
  const headerBuffer = await readEdfHeaderBuffer(entry.file, options);
  const header = parseEdfHeader(headerBuffer, entry.name || relativePath);
  const fullNeeded = needsFullBuffer(header, mode, options);
  const buffer = fullNeeded ? await readFileBuffer(entry.file, options) : headerBuffer;
  const annotations = shouldParseAnnotations(header, options) ? parseAnnotations(buffer, header, options) : [];
  const signals = parseSignals(buffer, header, mode, options);
  const internalCrc = shouldValidateCrc(mode, options) ? validateRecordCrc(buffer, header, options) : { ...CRC_PENDING };
  const summarySignalsLoaded = (mode === "summary" || mode === "scan") && header.type === "STR";

  return {
    fileName: entry.name || relativePath,
    relativePath,
    header,
    annotations,
    signals,
    signalsLoaded:
      mode === "all" ||
      summarySignalsLoaded ||
      (mode === "detail" && (header.type === "PLD" || header.type === "SAD")) ||
      (mode === "flow" && header.type === "BRP") ||
      header.labels.includes("EDF Annotations"),
    flowLoaded: mode === "flow" && header.type === "BRP",
    crc: {
      internal: internalCrc,
      sidecar: sidecarInfo(crcSidecar),
    },
  };
}

export async function validateEdfCrcEntry(entry, crcSidecar = null, options = {}) {
  const relativePath = entry.relativePath || entry.name;
  const buffer = await readFileBuffer(entry.file, options);
  const header = parseEdfHeader(buffer, entry.name || relativePath);
  return {
    fileName: entry.name || relativePath,
    relativePath,
    type: header.type,
    crc: {
      internal: validateRecordCrc(buffer, header, options),
      sidecar: sidecarInfo(crcSidecar),
    },
  };
}

export async function buildCrcSidecars(entries, options = {}) {
  const map = new Map();
  const crcEntries = entries.filter((entry) => /\.crc$/i.test(entry.name || entry.relativePath || ""));
  for (const entry of crcEntries) {
    checkCancelled(options);
    const buffer = await readFileBuffer(entry.file, options);
    map.set(entry.relativePath || entry.name, { bytes: buffer.byteLength, hex: toHex(buffer) });
  }
  return map;
}

function failureForEntry(entry, err) {
  return {
    fileName: entry.name || entry.relativePath || "unknown",
    relativePath: entry.relativePath || entry.name || "unknown",
    error: err instanceof Error ? err.message : "Failed to parse EDF file",
  };
}

function isCancelError(err) {
  return err?.name === "AbortError" || /cancelled/i.test(err?.message || "");
}

export async function parseEdfEntriesSafely(entries, mode = "scan", options = {}) {
  const sidecars = options.sidecars || await buildCrcSidecars(entries, options);
  const edfEntries = entries.filter((entry) => /\.edf$/i.test(entry.name || entry.relativePath || ""));
  const files = [];
  const failures = [];

  for (let index = 0; index < edfEntries.length; index += 1) {
    const entry = edfEntries[index];
    try {
      checkCancelled(options);
      files.push(await parseEdfEntry(entry, mode, sidecars.get(crcPathForEdf(entry.relativePath || entry.name)), options));
    } catch (err) {
      if (isCancelError(err)) throw err;
      failures.push(failureForEntry(entry, err));
    }
    options.onProgress?.({
      done: index + 1,
      total: edfEntries.length,
      fileName: entry.relativePath || entry.name,
      failures: failures.length,
    });
  }

  return { files, failures };
}

export async function validateCrcEntriesSafely(entries, options = {}) {
  const sidecars = options.sidecars || await buildCrcSidecars(entries, options);
  const edfEntries = entries.filter((entry) => /\.edf$/i.test(entry.name || entry.relativePath || ""));
  const results = [];
  const failures = [];

  for (let index = 0; index < edfEntries.length; index += 1) {
    const entry = edfEntries[index];
    try {
      checkCancelled(options);
      results.push(await validateEdfCrcEntry(entry, sidecars.get(crcPathForEdf(entry.relativePath || entry.name)), options));
    } catch (err) {
      if (isCancelError(err)) throw err;
      failures.push(failureForEntry(entry, err));
    }
    options.onProgress?.({
      done: index + 1,
      total: edfEntries.length,
      fileName: entry.relativePath || entry.name,
      failures: failures.length,
    });
  }

  return { results, failures };
}
