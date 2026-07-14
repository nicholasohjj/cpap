const INVALID_DIGITAL = new Set([-32768, 32767]);

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
  const fullYear = year < 85 ? 2000 + year : 1900 + year;
  return new Date(fullYear, month - 1, day, hour || 0, minute || 0, second || 0);
}

export function fileKind(name) {
  if (/^STR\.edf$/i.test(name)) return "STR";
  const match = name.match(/_([A-Z]{3})\.edf$/i);
  return match ? match[1].toUpperCase() : "EDF";
}

export function parseEdfHeader(buffer, fileName) {
  const view = new DataView(buffer);
  const signalCount = numberField(ascii(view, 252, 4), 0);
  let offset = 256;
  const readFields = (width, mapper = (x) => x) => {
    const values = [];
    for (let i = 0; i < signalCount; i += 1) {
      values.push(mapper(ascii(view, offset + i * width, width)));
    }
    offset += signalCount * width;
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

  return {
    fileName,
    type: fileKind(fileName),
    version: ascii(view, 0, 8),
    patient: ascii(view, 8, 80),
    recording: ascii(view, 88, 80),
    startDate,
    startTime,
    startedAt: parseStartDate(startDate, startTime),
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

export function parseSignalSeries(buffer, header, signalIndex) {
  const view = new DataView(buffer);
  const values = [];
  const samplesBeforeSignal = header.samplesPerRecord.slice(0, signalIndex).reduce((sum, value) => sum + value, 0);
  const bytesPerRecord = header.recordSampleCount * 2;
  const signalSamples = header.samplesPerRecord[signalIndex];
  const sampleStep = signalSamples ? header.recordDuration / signalSamples : 0;

  for (let record = 0; record < header.recordCount; record += 1) {
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
  if (mode === "summary") return header.type === "STR" ? header.labels : [];
  if (mode === "detail") return header.type === "PLD" || header.type === "SAD" ? header.labels : [];
  if (mode === "flow") return header.type === "BRP" ? ["Flow.40ms", "Press.40ms"] : [];
  if (mode === "all") return header.labels;
  return [];
}

export function parseSignals(buffer, header, mode) {
  const labels = new Set(signalLabelsForMode(header, mode));
  const signals = {};
  header.labels.forEach((label, index) => {
    if (label === "Crc16" || label === "EDF Annotations" || !labels.has(label)) return;
    signals[label] = parseSignalSeries(buffer, header, index);
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

export function parseAnnotations(buffer, header) {
  const view = new DataView(buffer);
  const annIndex = header.labels.findIndex((label) => label === "EDF Annotations");
  if (annIndex < 0) return [];
  const samplesBeforeSignal = header.samplesPerRecord.slice(0, annIndex).reduce((sum, value) => sum + value, 0);
  const bytesPerRecord = header.recordSampleCount * 2;
  const events = [];
  for (let record = 0; record < header.recordCount; record += 1) {
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

export function validateRecordCrc(buffer, header) {
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

export async function parseEdfEntry(entry, mode, crcSidecar) {
  const buffer = await entry.file.arrayBuffer();
  const header = parseEdfHeader(buffer, entry.name);
  const annotations = header.labels.includes("EDF Annotations") ? parseAnnotations(buffer, header) : [];
  const signals = parseSignals(buffer, header, mode);
  const internalCrc = validateRecordCrc(buffer, header);
  return {
    fileName: entry.name,
    relativePath: entry.relativePath,
    header,
    annotations,
    signals,
    signalsLoaded:
      mode === "all" ||
      (mode === "summary" && header.type === "STR") ||
      (mode === "detail" && (header.type === "PLD" || header.type === "SAD")) ||
      (mode === "flow" && header.type === "BRP") ||
      header.labels.includes("EDF Annotations"),
    flowLoaded: mode === "flow" && header.type === "BRP",
    crc: {
      internal: internalCrc,
      sidecar: crcSidecar
        ? { present: true, bytes: crcSidecar.bytes, hex: crcSidecar.hex }
        : { present: false, bytes: 0, hex: "" },
    },
  };
}

export async function buildCrcSidecars(entries) {
  const map = new Map();
  const crcEntries = entries.filter((entry) => /\.crc$/i.test(entry.name));
  for (const entry of crcEntries) {
    const buffer = await entry.file.arrayBuffer();
    map.set(entry.relativePath, { bytes: buffer.byteLength, hex: toHex(buffer) });
  }
  return map;
}
