import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  CalendarDays,
  Droplets,
  FolderOpen,
  Gauge,
  Info,
  ListChecks,
  Moon,
  RefreshCw,
  Upload,
  Wind,
} from "lucide-react";
import {
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const COLORS = {
  bg: "#0b1020",
  panel: "#121a2e",
  panel2: "#172037",
  border: "#27324b",
  border2: "#34415e",
  text: "#edf2f7",
  muted: "#95a3b8",
  faint: "#65738c",
  teal: "#4ecdc4",
  blue: "#6ea8fe",
  amber: "#f2b84b",
  coral: "#ff7769",
  green: "#82d173",
  grid: "#27324b",
};

const INVALID_DIGITAL = new Set([-32768, 32767]);
const KNOWN_TYPES = ["STR", "BRP", "PLD", "SAD", "EVE", "CSL"];
const SAMPLE_EDF_PATHS = [
  "/sample-data/20260712/20260713_005314_CSL.edf",
  "/sample-data/20260712/20260713_005314_EVE.edf",
  "/sample-data/20260712/20260713_005316_BRP.edf",
  "/sample-data/20260712/20260713_005317_PLD.edf",
  "/sample-data/20260712/20260713_005317_SAD.edf",
];

function ascii(view, start, length) {
  let out = "";
  for (let i = start; i < start + length && i < view.byteLength; i += 1) {
    const code = view.getUint8(i);
    out += code >= 32 && code <= 126 ? String.fromCharCode(code) : " ";
  }
  return out.trim();
}

function latin1(view, start, length) {
  let out = "";
  for (let i = start; i < start + length && i < view.byteLength; i += 1) {
    out += String.fromCharCode(view.getUint8(i));
  }
  return out;
}

function numberField(text, fallback = null) {
  const n = Number(String(text).trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseStartDate(dateText, timeText) {
  const [day, month, year] = dateText.split(".").map((part) => Number(part));
  const [hour, minute, second] = timeText.split(".").map((part) => Number(part));
  if (!day || !month || year === undefined) return null;
  const fullYear = year < 85 ? 2000 + year : 1900 + year;
  return new Date(fullYear, month - 1, day, hour || 0, minute || 0, second || 0);
}

function isoDate(date) {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function timeLabel(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function durationLabel(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function compact(value, digits = 1) {
  const rounded = round(value, digits);
  return rounded === null ? "--" : String(rounded);
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function percentile(values, p) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const index = ((valid.length - 1) * p) / 100;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return valid[lo];
  return valid[lo] * (hi - index) + valid[hi] * (index - lo);
}

function minMax(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return { min: null, max: null };
  let min = valid[0];
  let max = valid[0];
  for (let i = 1; i < valid.length; i += 1) {
    if (valid[i] < min) min = valid[i];
    if (valid[i] > max) max = valid[i];
  }
  return { min, max };
}

function fileKind(name) {
  if (/^STR\.edf$/i.test(name)) return "STR";
  const match = name.match(/_([A-Z]{3})\.edf$/i);
  return match ? match[1].toUpperCase() : "EDF";
}

function parseEdfHeader(buffer, fileName) {
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

function digitalToPhysical(digital, header, signalIndex) {
  const dMin = header.digitalMin[signalIndex];
  const dMax = header.digitalMax[signalIndex];
  const pMin = header.physicalMin[signalIndex];
  const pMax = header.physicalMax[signalIndex];
  if (dMax === dMin) return digital;
  return ((digital - dMin) * (pMax - pMin)) / (dMax - dMin) + pMin;
}

function parseSignalSeries(buffer, header, signalIndex, intervalSeconds) {
  const view = new DataView(buffer);
  const values = [];
  const samplesBeforeSignal = header.samplesPerRecord
    .slice(0, signalIndex)
    .reduce((sum, value) => sum + value, 0);
  const bytesPerRecord = header.recordSampleCount * 2;
  const signalSamples = header.samplesPerRecord[signalIndex];
  const sampleStep = intervalSeconds || (signalSamples ? header.recordDuration / signalSamples : 0);

  for (let record = 0; record < header.recordCount; record += 1) {
    const recordOffset = header.headerBytes + record * bytesPerRecord;
    const signalOffset = recordOffset + samplesBeforeSignal * 2;
    for (let sample = 0; sample < signalSamples; sample += 1) {
      const byteOffset = signalOffset + sample * 2;
      if (byteOffset + 2 > view.byteLength) break;
      const digital = view.getInt16(byteOffset, true);
      const outsideRange = digital < header.digitalMin[signalIndex] || digital > header.digitalMax[signalIndex];
      const value = INVALID_DIGITAL.has(digital) || outsideRange ? null : digitalToPhysical(digital, header, signalIndex);
      values.push({
        t: record * header.recordDuration + sample * sampleStep,
        value,
        digital,
      });
    }
  }
  return values;
}

function parseAllSignals(buffer, header) {
  const signals = {};
  header.labels.forEach((label, index) => {
    if (label === "Crc16" || label === "EDF Annotations") return;
    signals[label] = parseSignalSeries(buffer, header, index);
  });
  return signals;
}

function parseAnnotationText(text) {
  const events = [];
  const chunks = text.split("\u0000").filter(Boolean);
  chunks.forEach((chunk) => {
    const match = chunk.match(/^([+-]?\d+(?:\.\d+)?)(?:\u0015(\d+(?:\.\d+)?))?\u0014([\s\S]*)$/);
    if (!match) return;
    const onset = Number(match[1]);
    const duration = match[2] === undefined ? 0 : Number(match[2]);
    const labels = match[3]
      .split("\u0014")
      .map((value) => value.trim())
      .filter(Boolean);
    labels.forEach((label) => {
      if (label !== "Recording starts") {
        events.push({ onset, duration, label });
      }
    });
  });
  return events;
}

function parseAnnotations(buffer, header) {
  const view = new DataView(buffer);
  const annIndex = header.labels.findIndex((label) => label === "EDF Annotations");
  if (annIndex < 0) return [];

  const samplesBeforeSignal = header.samplesPerRecord
    .slice(0, annIndex)
    .reduce((sum, value) => sum + value, 0);
  const bytesPerRecord = header.recordSampleCount * 2;
  const events = [];
  for (let record = 0; record < header.recordCount; record += 1) {
    const offset = header.headerBytes + record * bytesPerRecord + samplesBeforeSignal * 2;
    const length = header.samplesPerRecord[annIndex] * 2;
    const text = latin1(view, offset, length);
    events.push(...parseAnnotationText(text));
  }
  return events.sort((a, b) => a.onset - b.onset);
}

async function readFileBuffer(file) {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function parseEdfFile(file) {
  const buffer = await readFileBuffer(file);
  const header = parseEdfHeader(buffer, file.name || file.webkitRelativePath || "unknown.edf");
  const annotations = header.labels.includes("EDF Annotations") ? parseAnnotations(buffer, header) : [];
  const signals = header.type === "STR" ? parseAllSignals(buffer, header) : {};
  return {
    fileName: file.name,
    relativePath: file.webkitRelativePath || file.name,
    sourceFile: file,
    header,
    annotations,
    signals,
    signalsLoaded: header.type === "STR" || header.labels.includes("EDF Annotations"),
  };
}

async function hydrateSignals(fileRecord) {
  if (fileRecord.signalsLoaded) return fileRecord;
  if (fileRecord.header.labels.includes("EDF Annotations")) {
    return { ...fileRecord, signalsLoaded: true };
  }
  const buffer = await readFileBuffer(fileRecord.sourceFile);
  return {
    ...fileRecord,
    signals: parseAllSignals(buffer, fileRecord.header),
    signalsLoaded: true,
  };
}

async function hydrateSignalFiles(files) {
  return Promise.all(files.map(hydrateSignals));
}

function nearestAt(series, seconds) {
  if (!series?.length) return null;
  const index = Math.max(0, Math.min(series.length - 1, Math.round(seconds / inferStep(series))));
  return series[index]?.value ?? null;
}

function inferStep(series) {
  if (!series || series.length < 2) return 1;
  return Math.max(0.001, series[1].t - series[0].t);
}

function downsampleSeries(series, maxPoints = 1200) {
  if (!series?.length) return [];
  const clean = series.filter((point) => Number.isFinite(point.value));
  if (clean.length <= maxPoints) {
    return clean.map((point) => ({ time: point.t, label: timeLabel(point.t), value: round(point.value, 3) }));
  }
  const bucketSize = Math.ceil(clean.length / maxPoints);
  const output = [];
  for (let i = 0; i < clean.length; i += bucketSize) {
    const bucket = clean.slice(i, i + bucketSize);
    const avg = mean(bucket.map((point) => point.value));
    output.push({
      time: bucket[Math.floor(bucket.length / 2)].t,
      label: timeLabel(bucket[Math.floor(bucket.length / 2)].t),
      value: round(avg, 3),
    });
  }
  return output;
}

function sampleEvery(series, every = 1) {
  if (!series?.length) return [];
  return series
    .filter((_, index) => index % every === 0)
    .filter((point) => Number.isFinite(point.value))
    .map((point) => ({ time: point.t, label: timeLabel(point.t), value: round(point.value, 3) }));
}

function groupByType(files) {
  const grouped = {};
  KNOWN_TYPES.forEach((type) => {
    grouped[type] = files.filter((file) => file.header.type === type);
  });
  grouped.EDF = files.filter((file) => !KNOWN_TYPES.includes(file.header.type));
  return grouped;
}

function relativeStart(file, groupStartMs) {
  if (!file?.header.startedAt || !Number.isFinite(groupStartMs)) return 0;
  return Math.max(0, (file.header.startedAt.getTime() - groupStartMs) / 1000);
}

function combinedSignal(files, type, label, groupStartMs) {
  return files
    .filter((file) => file.header.type === type && file.signals?.[label]?.length)
    .sort((a, b) => (a.header.startedAt?.getTime() || 0) - (b.header.startedAt?.getTime() || 0))
    .flatMap((file) => {
      const offset = relativeStart(file, groupStartMs);
      return file.signals[label].map((point) => ({ ...point, t: point.t + offset }));
    })
    .sort((a, b) => a.t - b.t);
}

function fileEndSeconds(file, groupStartMs) {
  const recordSpan = file.header.recordCount * file.header.recordDuration;
  const annotationEnd = file.annotations?.length
    ? Math.max(...file.annotations.map((event) => event.onset + event.duration))
    : 0;
  return relativeStart(file, groupStartMs) + Math.max(recordSpan, annotationEnd);
}

function buildSession(files) {
  const grouped = groupByType(files);
  const str = grouped.STR[0] || null;
  const primary =
    files
      .filter((file) => file.header.type !== "STR")
      .sort((a, b) => (a.header.startedAt?.getTime() || 0) - (b.header.startedAt?.getTime() || 0))[0] ||
    str ||
    files[0] ||
    null;
  const groupStartMs = primary?.header.startedAt?.getTime() || null;

  const flow = combinedSignal(files, "BRP", "Flow.40ms", groupStartMs);
  const pressure40ms = combinedSignal(files, "BRP", "Press.40ms", groupStartMs);
  const pressure = combinedSignal(files, "PLD", "Press.2s", groupStartMs);
  const maskPressure = combinedSignal(files, "PLD", "MaskPress.2s", groupStartMs);
  const leak = combinedSignal(files, "PLD", "Leak.2s", groupStartMs);
  const respiration = combinedSignal(files, "PLD", "RespRate.2s", groupStartMs);
  const tidalVolume = combinedSignal(files, "PLD", "TidVol.2s", groupStartMs);
  const minuteVent = combinedSignal(files, "PLD", "MinVent.2s", groupStartMs);
  const flowLimit = combinedSignal(files, "PLD", "FlowLim.2s", groupStartMs);
  const snore = combinedSignal(files, "PLD", "Snore.2s", groupStartMs);
  const spo2 = combinedSignal(files, "SAD", "SpO2.1s", groupStartMs);
  const pulse = combinedSignal(files, "SAD", "Pulse.1s", groupStartMs);
  const events = files
    .filter((file) => file.header.type === "EVE" || file.header.type === "CSL")
    .flatMap((file) => {
      const offset = relativeStart(file, groupStartMs);
      return (file.annotations || []).map((event) => ({
        ...event,
        onset: event.onset + offset,
      }));
    })
    .sort((a, b) => a.onset - b.onset);
  const therapySeconds = Math.max(
    0,
    ...files
      .filter((file) => file.header.type !== "STR")
      .map((file) => fileEndSeconds(file, groupStartMs)),
    ...events.map((event) => event.onset + event.duration)
  );
  const centralEvents = events.filter((event) => /central apnea/i.test(event.label));
  const obstructiveEvents = events.filter((event) => /obstructive apnea/i.test(event.label));
  const hypopneaEvents = events.filter((event) => /hypopnea/i.test(event.label));
  const apneaEvents = events.filter((event) => /apnea/i.test(event.label));
  const hours = therapySeconds / 3600;
  const ahi = hours > 0 ? (apneaEvents.length + hypopneaEvents.length) / hours : null;
  const cai = hours > 0 ? centralEvents.length / hours : null;
  const oai = hours > 0 ? obstructiveEvents.length / hours : null;

  const pressureValues = pressure.length ? pressure.map((point) => point.value) : pressure40ms.map((point) => point.value);
  const maskPressureValues = maskPressure.map((point) => point.value);
  const leakValues = leak.map((point) => point.value);
  const flowValues = flow.map((point) => point.value);
  const respValues = respiration.map((point) => point.value);
  const spo2Values = spo2.map((point) => point.value).filter((value) => Number.isFinite(value) && value >= 0);
  const pulseValues = pulse.map((point) => point.value).filter((value) => Number.isFinite(value) && value > 0);

  return {
    files,
    grouped,
    primary,
    start: primary?.header.startedAt || null,
    date: isoDate(primary?.header.startedAt || null),
    therapySeconds,
    eventCounts: {
      all: events.length,
      central: centralEvents.length,
      obstructive: obstructiveEvents.length,
      hypopnea: hypopneaEvents.length,
      apnea: apneaEvents.length,
    },
    indexes: {
      ahi,
      cai,
      oai,
    },
    stats: {
      pressureMedian: percentile(pressureValues, 50),
      pressure95: percentile(pressureValues, 95),
      maskPressure95: percentile(maskPressureValues, 95),
      leakMedian: percentile(leakValues, 50),
      leak95: percentile(leakValues, 95),
      flowMinMax: minMax(flowValues),
      respirationMedian: percentile(respValues, 50),
      respiration95: percentile(respValues, 95),
      tidalVolumeMedian: percentile(tidalVolume.map((point) => point.value), 50),
      minuteVentMedian: percentile(minuteVent.map((point) => point.value), 50),
      flowLimit95: percentile(flowLimit.map((point) => point.value), 95),
      snore95: percentile(snore.map((point) => point.value), 95),
      spo2Median: percentile(spo2Values, 50),
      spo2Low: percentile(spo2Values, 1),
      pulseMedian: percentile(pulseValues, 50),
    },
    series: {
      flow: downsampleSeries(flow, 1200),
      pressure: sampleEvery(pressure.length ? pressure : pressure40ms, pressure.length ? 1 : 50),
      leak: sampleEvery(leak),
      respiration: sampleEvery(respiration),
      tidalVolume: sampleEvery(tidalVolume),
      minuteVent: sampleEvery(minuteVent),
      flowLimit: sampleEvery(flowLimit),
      snore: sampleEvery(snore),
      spo2: sampleEvery(spo2),
      pulse: sampleEvery(pulse),
    },
    events: events.map((event) => ({
      ...event,
      time: timeLabel(event.onset),
      pressure: nearestAt(pressure.length ? pressure : pressure40ms, event.onset),
      leak: nearestAt(leak, event.onset),
    })),
  };
}

function mergeSeries(base, additions) {
  const byTime = new Map();
  base.forEach((point) => byTime.set(point.time, { time: point.time, label: point.label }));
  additions.forEach(({ key, series }) => {
    series.forEach((point) => {
      const row = byTime.get(point.time) || { time: point.time, label: point.label };
      row[key] = point.value;
      byTime.set(point.time, row);
    });
  });
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function buildOverviewRows(files) {
  return files.map((file) => ({
    name: file.relativePath,
    type: file.header.type,
    start: `${file.header.startDate} ${file.header.startTime}`,
    records: file.header.recordCount,
    duration: file.header.recordDuration,
    signals: file.header.labels.filter((label) => label !== "Crc16").join(", "),
    samples: file.header.recordSampleCount,
    headerBytes: file.header.headerBytes,
  }));
}

function signalRecordValue(file, label, recordIndex) {
  const signal = file?.signals?.[label];
  if (!signal?.length) return null;
  const samplesPerRecord = file.header.samplesPerRecord[file.header.labels.indexOf(label)] || 1;
  const point = signal[recordIndex * samplesPerRecord];
  return Number.isFinite(point?.value) ? point.value : null;
}

function dateFromUnixDay(dayValue) {
  if (!Number.isFinite(dayValue)) return null;
  const rounded = Math.round(dayValue);
  if (rounded < 0 || rounded > 30000) return null;
  return new Date(rounded * 86400000);
}

function buildDailyRows(files) {
  const rows = [];
  files
    .filter((file) => file.header.type === "STR")
    .forEach((file) => {
      for (let record = 0; record < file.header.recordCount; record += 1) {
        const dateSignal = signalRecordValue(file, "Date", record);
        const date = dateFromUnixDay(dateSignal) || (file.header.startedAt
          ? new Date(file.header.startedAt.getTime() + record * file.header.recordDuration * 1000)
          : null);
        const leak95 = signalRecordValue(file, "Leak.95", record);
        rows.push({
          date: isoDate(date) || `Record ${record + 1}`,
          usageMinutes: signalRecordValue(file, "OnDuration", record) ?? signalRecordValue(file, "Duration", record),
          ahi: signalRecordValue(file, "AHI", record),
          ai: signalRecordValue(file, "AI", record),
          hi: signalRecordValue(file, "HI", record),
          cai: signalRecordValue(file, "CAI", record),
          oai: signalRecordValue(file, "OAI", record),
          leak95LMin: Number.isFinite(leak95) ? leak95 * 60 : null,
          pressure95: signalRecordValue(file, "MaskPress.95", record) ?? signalRecordValue(file, "BlowPress.95", record),
          patientHours: signalRecordValue(file, "PatientHours", record),
          csrMinutes: signalRecordValue(file, "CSR", record),
        });
      }
    });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function datalogGroupKey(file) {
  const path = file.relativePath || file.fileName;
  const parts = path.split("/").filter(Boolean);
  const datalogIndex = parts.findIndex((part) => part.toUpperCase() === "DATALOG");
  if (datalogIndex >= 0 && parts[datalogIndex + 1]) {
    return `DATALOG/${parts[datalogIndex + 1]}`;
  }
  if (parts.length > 1 && /^\d{8}$/.test(parts[parts.length - 2])) {
    return parts[parts.length - 2];
  }
  const dateMatch = file.fileName.match(/^(\d{8})_/);
  if (dateMatch) return dateMatch[1];
  return "Selected EDF files";
}

function buildTherapyGroups(files) {
  const therapyFiles = files.filter((file) => ["BRP", "PLD", "SAD", "EVE", "CSL"].includes(file.header.type));
  const map = new Map();
  therapyFiles.forEach((file) => {
    const id = datalogGroupKey(file);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(file);
  });

  return [...map.entries()]
    .map(([id, groupFiles]) => {
      const sorted = groupFiles
        .slice()
        .sort((a, b) => (a.header.startedAt?.getTime() || 0) - (b.header.startedAt?.getTime() || 0));
      const start = sorted.find((file) => file.header.startedAt)?.header.startedAt || null;
      const endSeconds = start
        ? Math.max(...sorted.map((file) => fileEndSeconds(file, start.getTime())))
        : 0;
      const typeCounts = sorted.reduce((counts, file) => {
        counts[file.header.type] = (counts[file.header.type] || 0) + 1;
        return counts;
      }, {});
      return {
        id,
        label: id.replace(/^DATALOG\//, ""),
        files: sorted,
        start,
        endSeconds,
        typeCounts,
      };
    })
    .sort((a, b) => (a.start?.getTime() || 0) - (b.start?.getTime() || 0));
}

function statusForSignal(series) {
  if (!series?.length) return "missing";
  const valid = series.filter((point) => Number.isFinite(point.value));
  if (!valid.length) return "no valid samples";
  return `${valid.length.toLocaleString()} samples`;
}

function UploadPanel({ onLoad, onLoadSample, error, loading }) {
  const [dragging, setDragging] = useState(false);

  async function handleFiles(fileList) {
    const files = [...fileList].filter((file) => /\.edf$/i.test(file.name));
    await onLoad(files);
  }

  return (
    <main className="screen upload-screen">
      <div
        className={`dropzone ${dragging ? "is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
      >
        <Moon className="brand-icon" size={30} />
        <h1>CPAP EDF dashboard</h1>
        <p>
          Load a ResMed EDF folder or individual EDF files. The parser reads headers, EDF+
          annotations, 40 ms breath data, 2 s therapy metrics, oximetry, and daily STR summary files.
        </p>
        <div className="upload-actions">
          <label className="primary-button">
            <FolderOpen size={16} />
            Choose folder
            <input
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              onChange={(event) => handleFiles(event.target.files)}
            />
          </label>
          <label className="secondary-button">
            <Upload size={16} />
            Choose EDF files
            <input
              type="file"
              accept=".edf"
              multiple
              onChange={(event) => handleFiles(event.target.files)}
            />
          </label>
          <button type="button" className="secondary-button" onClick={onLoadSample} disabled={loading}>
            <Activity size={16} />
            Load sample
          </button>
        </div>
        <div className="hint">
          Expected sample set: <code>BRP</code>, <code>PLD</code>, <code>SAD</code>, <code>EVE</code>, <code>CSL</code>.
        </div>
        {loading ? <div className="status-line">Parsing EDF records...</div> : null}
        {error ? (
          <div className="error-line">
            <AlertCircle size={15} />
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function StatCard({ icon: Icon, label, value, unit, sub, tone = "teal" }) {
  return (
    <section className="stat-card">
      <div className="stat-label">
        <Icon size={14} className={`tone-${tone}`} />
        <span>{label}</span>
      </div>
      <div className="stat-value">
        {value}
        {unit ? <span>{unit}</span> : null}
      </div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </section>
  );
}

function Panel({ title, note, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        {note ? <span>{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="tooltip-label">{label}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} style={{ color: entry.color }}>
          {entry.name || entry.dataKey}: {compact(entry.value, 2)}
        </div>
      ))}
    </div>
  );
}

function TimelineChart({ session }) {
  const chartData = useMemo(
    () =>
      mergeSeries(session.series.pressure, [
        { key: "pressure", series: session.series.pressure },
        { key: "leakLMin", series: session.series.leak.map((point) => ({ ...point, value: point.value * 60 })) },
        { key: "respiration", series: session.series.respiration },
      ]),
    [session]
  );

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={chartData} margin={{ top: 10, right: 22, left: -8, bottom: 4 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis
          dataKey="label"
          minTickGap={36}
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={{ stroke: COLORS.border }}
          tickLine={false}
        />
        <YAxis
          yAxisId="left"
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={38}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={38}
        />
        <Tooltip content={<ChartTooltip />} />
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="pressure"
          name="Pressure cmH2O"
          stroke={COLORS.amber}
          strokeWidth={2}
          dot={false}
          connectNulls
        />
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="leakLMin"
          name="Leak L/min"
          stroke={COLORS.teal}
          strokeWidth={1.8}
          dot={false}
          connectNulls
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="respiration"
          name="Resp rate"
          stroke={COLORS.blue}
          strokeWidth={1.6}
          dot={false}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function FlowChart({ session }) {
  const data = session.series.flow.map((point) => ({ ...point, flow: point.value }));
  if (!data.length) return <EmptyState label="No BRP flow signal was loaded." />;

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis
          dataKey="label"
          minTickGap={38}
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={{ stroke: COLORS.border }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={38}
        />
        <Tooltip content={<ChartTooltip />} />
        <Line
          type="monotone"
          dataKey="flow"
          name="Flow L/s"
          stroke={COLORS.teal}
          strokeWidth={1.4}
          dot={false}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function OximetryChart({ session }) {
  const data = useMemo(
    () =>
      mergeSeries(session.series.spo2, [
        { key: "spo2", series: session.series.spo2 },
        { key: "pulse", series: session.series.pulse },
      ]),
    [session]
  );
  if (!data.length) return <EmptyState label="No valid SAD oximetry samples were found." />;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 22, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis
          dataKey="label"
          minTickGap={38}
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={{ stroke: COLORS.border }}
          tickLine={false}
        />
        <YAxis
          yAxisId="left"
          domain={[80, 100]}
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={38}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={38}
        />
        <Tooltip content={<ChartTooltip />} />
        <Line yAxisId="left" type="monotone" dataKey="spo2" name="SpO2 %" stroke={COLORS.teal} strokeWidth={1.8} dot={false} />
        <Line yAxisId="right" type="monotone" dataKey="pulse" name="Pulse bpm" stroke={COLORS.coral} strokeWidth={1.5} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function EventsChart({ session }) {
  const data = session.events.map((event) => ({
    ...event,
    y: 1,
    color: /central/i.test(event.label) ? COLORS.amber : /obstructive/i.test(event.label) ? COLORS.coral : COLORS.blue,
  }));
  if (!data.length) return <EmptyState label="No scored respiratory events were found." />;

  return (
    <ResponsiveContainer width="100%" height={130}>
      <ComposedChart data={data} margin={{ top: 10, right: 18, left: -20, bottom: 0 }}>
        <XAxis
          dataKey="time"
          minTickGap={34}
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={{ stroke: COLORS.border }}
          tickLine={false}
        />
        <YAxis hide domain={[0, 1.4]} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const event = payload[0].payload;
            return (
              <div className="tooltip">
                <div className="tooltip-label">{event.time}</div>
                <div>{event.label}</div>
                <div>Duration: {compact(event.duration, 0)}s</div>
                <div>Pressure: {compact(event.pressure, 1)} cmH2O</div>
                <div>Leak: {compact((event.leak || 0) * 60, 1)} L/min</div>
              </div>
            );
          }}
        />
        <Scatter dataKey="y" name="Events">
          {data.map((event, index) => (
            <Cell key={`${event.onset}-${index}`} fill={event.color} />
          ))}
        </Scatter>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function EventTable({ events }) {
  if (!events.length) return <EmptyState label="No event annotations to show." />;
  return (
    <div className="table-wrap compact-table">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Duration</th>
            <th>Pressure</th>
            <th>Leak</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`${event.onset}-${event.label}-${index}`}>
              <td>{event.time}</td>
              <td>{event.label}</td>
              <td>{compact(event.duration, 0)}s</td>
              <td>{compact(event.pressure, 1)} cmH2O</td>
              <td>{compact((event.leak || 0) * 60, 1)} L/min</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailySummaryPanel({ rows }) {
  if (!rows.length) return null;
  const chartRows = rows.map((row) => ({
    date: row.date,
    label: row.date.slice(5),
    usageHours: Number.isFinite(row.usageMinutes) ? round(row.usageMinutes / 60, 2) : null,
    ahi: row.ahi,
    pressure95: row.pressure95,
    leak95LMin: row.leak95LMin,
  }));

  return (
    <Panel title="Daily STR summary" note={`${rows.length} daily records`}>
      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart data={chartRows} margin={{ top: 8, right: 22, left: -8, bottom: 0 }}>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis
            dataKey="label"
            minTickGap={28}
            tick={{ fill: COLORS.faint, fontSize: 11 }}
            axisLine={{ stroke: COLORS.border }}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            tick={{ fill: COLORS.faint, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={38}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fill: COLORS.faint, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={38}
          />
          <Tooltip content={<ChartTooltip />} />
          <Line yAxisId="left" type="monotone" dataKey="usageHours" name="Usage hrs" stroke={COLORS.teal} strokeWidth={2} dot={false} />
          <Line yAxisId="right" type="monotone" dataKey="ahi" name="AHI" stroke={COLORS.amber} strokeWidth={1.8} dot={false} />
          <Line yAxisId="left" type="monotone" dataKey="pressure95" name="Pressure 95%" stroke={COLORS.blue} strokeWidth={1.4} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="table-wrap compact-table daily-table">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Usage</th>
              <th>AHI</th>
              <th>CAI</th>
              <th>OAI</th>
              <th>Leak 95</th>
              <th>Pressure 95</th>
              <th>CSR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td>{Number.isFinite(row.usageMinutes) ? durationLabel(row.usageMinutes * 60) : "--"}</td>
                <td>{compact(row.ahi, 2)}</td>
                <td>{compact(row.cai, 2)}</td>
                <td>{compact(row.oai, 2)}</td>
                <td>{compact(row.leak95LMin, 1)} L/min</td>
                <td>{compact(row.pressure95, 1)} cmH2O</td>
                <td>{compact(row.csrMinutes, 0)}m</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function FilesTable({ rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Type</th>
            <th>Start</th>
            <th>Records</th>
            <th>Record dur</th>
            <th>Samples/record</th>
            <th>Signals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{row.type}</td>
              <td>{row.start}</td>
              <td>{row.records}</td>
              <td>{row.duration}s</td>
              <td>{row.samples}</td>
              <td>{row.signals}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignalHealth({ session }) {
  const items = [
    ["Flow.40ms", session.series.flow],
    ["Press.2s", session.series.pressure],
    ["Leak.2s", session.series.leak],
    ["RespRate.2s", session.series.respiration],
    ["SpO2.1s", session.series.spo2],
    ["Pulse.1s", session.series.pulse],
  ];
  return (
    <div className="signal-health">
      {items.map(([label, series]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{statusForSignal(series)}</strong>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ label }) {
  return (
    <div className="empty-state">
      <Info size={16} />
      {label}
    </div>
  );
}

function ExportOverview({ parsed, groups, selectedGroupId, onSelectGroup, detailLoading, dailyRows }) {
  const strLoaded = dailyRows.length > 0;
  const edfCount = parsed.length;
  const latestGroup = groups[groups.length - 1];

  return (
    <Panel title="Export overview" note={strLoaded ? `${dailyRows.length} STR daily records` : "No STR summary loaded"}>
      <div className="overview-grid">
        <div>
          <span>EDF files</span>
          <strong>{edfCount}</strong>
        </div>
        <div>
          <span>DATALOG nights</span>
          <strong>{groups.length}</strong>
        </div>
        <div>
          <span>Latest night</span>
          <strong>{latestGroup?.label || "--"}</strong>
        </div>
      </div>
      {groups.length ? (
        <div className="night-picker">
          <label htmlFor="night-select">Detailed night</label>
          <select id="night-select" value={selectedGroupId} onChange={(event) => onSelectGroup(event.target.value)}>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.label} · {group.files.length} EDFs · {durationLabel(group.endSeconds)}
              </option>
            ))}
          </select>
          {detailLoading ? <span>Loading signal detail...</span> : null}
        </div>
      ) : (
        <EmptyState label="No DATALOG therapy EDF files were found in this selection." />
      )}
    </Panel>
  );
}

function Dashboard({ parsed, onReset }) {
  const groups = useMemo(() => buildTherapyGroups(parsed), [parsed]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [detailFiles, setDetailFiles] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || groups[groups.length - 1] || null,
    [groups, selectedGroupId]
  );
  const activeFiles = detailFiles.length ? detailFiles : selectedGroup?.files || parsed;
  const session = useMemo(() => buildSession(activeFiles), [activeFiles]);
  const rows = useMemo(() => buildOverviewRows(parsed), [parsed]);
  const dailyRows = useMemo(() => buildDailyRows(parsed), [parsed]);
  const sessionDate = session.date || "Unknown date";
  const summaryOnly = dailyRows.length > 0 && session.therapySeconds === 0;
  const avgDailyUsageHours = mean(dailyRows.map((row) => (Number.isFinite(row.usageMinutes) ? row.usageMinutes / 60 : null)));
  const avgDailyAhi = mean(dailyRows.map((row) => row.ahi));
  const avgDailyLeak95 = mean(dailyRows.map((row) => row.leak95LMin));
  const avgDailyPressure95 = mean(dailyRows.map((row) => row.pressure95));
  const latestPatientHours = [...dailyRows].reverse().find((row) => Number.isFinite(row.patientHours))?.patientHours ?? null;
  const leak95LMin = summaryOnly
    ? avgDailyLeak95
    : Number.isFinite(session.stats.leak95)
      ? session.stats.leak95 * 60
      : null;
  const flowRange = session.stats.flowMinMax;

  useEffect(() => {
    if (!groups.length) {
      setSelectedGroupId("");
      return;
    }
    if (!selectedGroupId || !groups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(groups[groups.length - 1].id);
    }
  }, [groups, selectedGroupId]);

  useEffect(() => {
    let cancelled = false;
    async function hydrateSelectedGroup() {
      if (!selectedGroup) {
        setDetailFiles([]);
        return;
      }
      setDetailLoading(true);
      try {
        const hydrated = await hydrateSignalFiles(selectedGroup.files);
        if (!cancelled) setDetailFiles(hydrated);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }
    setDetailFiles([]);
    hydrateSelectedGroup();
    return () => {
      cancelled = true;
    };
  }, [selectedGroup]);

  return (
    <main className="screen">
      <header className="hero">
        <div>
          <div className="eyebrow">
            <Moon size={18} />
            Sleep therapy session
          </div>
          <h1>{sessionDate}</h1>
          <p>
            {groups.length ? `${groups.length} DATALOG night${groups.length === 1 ? "" : "s"}` : durationLabel(session.therapySeconds)}
            {" "}loaded from {parsed.length} EDF file{parsed.length === 1 ? "" : "s"}. Parsed on device, no upload required.
          </p>
        </div>
        <button type="button" className="reset-button" onClick={onReset}>
          <RefreshCw size={15} />
          Load another set
        </button>
      </header>

      <section className="stats-grid">
        <StatCard
          icon={CalendarDays}
          label={summaryOnly ? "Daily records" : "Therapy time"}
          value={summaryOnly ? String(dailyRows.length) : durationLabel(session.therapySeconds)}
          unit={summaryOnly ? "nights" : ""}
          sub={summaryOnly ? `avg ${compact(avgDailyUsageHours, 1)} hrs/night` : `${session.primary?.header.recordCount || 0} primary records`}
        />
        <StatCard
          icon={Activity}
          label="AHI"
          value={compact(summaryOnly ? avgDailyAhi : session.indexes.ahi, 2)}
          unit="/hr"
          sub={summaryOnly ? "daily average" : `${session.eventCounts.all} annotations`}
          tone={(summaryOnly ? avgDailyAhi : session.indexes.ahi) !== null && (summaryOnly ? avgDailyAhi : session.indexes.ahi) < 5 ? "green" : "amber"}
        />
        <StatCard
          icon={Gauge}
          label="Pressure 95%"
          value={compact(summaryOnly ? avgDailyPressure95 : session.stats.pressure95, 1)}
          unit="cmH2O"
          sub={summaryOnly ? "daily average" : `median ${compact(session.stats.pressureMedian, 1)} cmH2O`}
          tone="amber"
        />
        <StatCard
          icon={Droplets}
          label="Leak 95%"
          value={compact(leak95LMin, 1)}
          unit="L/min"
          sub={summaryOnly ? "daily average" : `median ${compact((session.stats.leakMedian || 0) * 60, 1)} L/min`}
        />
        <StatCard
          icon={Wind}
          label={summaryOnly ? "Patient hours" : "Flow range"}
          value={summaryOnly ? compact(latestPatientHours, 1) : `${compact(flowRange.min, 2)} to ${compact(flowRange.max, 2)}`}
          unit={summaryOnly ? "hrs" : "L/s"}
          sub={summaryOnly ? "latest STR value" : "downsampled for chart"}
        />
      </section>

      <ExportOverview
        parsed={parsed}
        groups={groups}
        selectedGroupId={selectedGroup?.id || ""}
        onSelectGroup={setSelectedGroupId}
        detailLoading={detailLoading}
        dailyRows={dailyRows}
      />

      <div className="content-grid">
        <Panel title="Therapy timeline" note="pressure, leak, respiratory rate">
          <TimelineChart session={session} />
        </Panel>

        <Panel title="Event summary" note="from EDF+ annotations" className="side-panel">
          <div className="event-counts">
            <div>
              <span>Central</span>
              <strong>{session.eventCounts.central}</strong>
            </div>
            <div>
              <span>Obstructive</span>
              <strong>{session.eventCounts.obstructive}</strong>
            </div>
            <div>
              <span>Hypopnea</span>
              <strong>{session.eventCounts.hypopnea}</strong>
            </div>
          </div>
          <EventsChart session={session} />
        </Panel>
      </div>

      <div className="content-grid">
        <Panel title="Breath flow" note="BRP Flow.40ms">
          <FlowChart session={session} />
        </Panel>
        <Panel title="Oximetry" note="SAD SpO2.1s and Pulse.1s">
          <OximetryChart session={session} />
        </Panel>
      </div>

      <div className="content-grid">
        <Panel title="Events" note="pressure/leak sampled near event onset">
          <EventTable events={session.events} />
        </Panel>
        <Panel title="Signal health" note="valid parsed samples">
          <SignalHealth session={session} />
          <div className="note-box">
            <ListChecks size={16} />
            The included sample SAD file contains only invalid oximetry placeholders, so SpO2 and
            pulse intentionally show as unavailable.
          </div>
        </Panel>
      </div>

      <DailySummaryPanel rows={dailyRows} />

      <Panel title="Loaded EDF files" note="header-derived structure">
        <FilesTable rows={rows} />
      </Panel>
    </main>
  );
}

export default function CpapDashboard() {
  const [parsed, setParsed] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function parseFiles(files) {
    const parsedFiles = [];
    for (const file of files) {
      parsedFiles.push(await parseEdfFile(file));
    }
    parsedFiles.sort((a, b) => {
      const aTime = a.header.startedAt?.getTime() || 0;
      const bTime = b.header.startedAt?.getTime() || 0;
      return aTime - bTime || a.relativePath.localeCompare(b.relativePath);
    });
    setParsed(parsedFiles);
  }

  async function handleLoad(files) {
    setError("");
    if (!files.length) {
      setError("No EDF files were selected.");
      return;
    }
    setLoading(true);
    try {
      await parseFiles(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse the selected EDF files.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadSample() {
    setError("");
    setLoading(true);
    try {
      const files = await Promise.all(
        SAMPLE_EDF_PATHS.map(async (samplePath) => {
          const response = await fetch(samplePath);
          if (!response.ok) throw new Error(`Could not load ${samplePath}`);
          const buffer = await response.arrayBuffer();
          return {
            name: samplePath.split("/").pop(),
            webkitRelativePath: samplePath.replace(/^\/sample-data\//, ""),
            arrayBuffer: () => Promise.resolve(buffer),
          };
        })
      );
      await parseFiles(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the bundled sample EDF files.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <style>{styles}</style>
      {parsed.length ? (
        <Dashboard parsed={parsed} onReset={() => setParsed([])} />
      ) : (
        <UploadPanel onLoad={handleLoad} onLoadSample={handleLoadSample} error={error} loading={loading} />
      )}
    </div>
  );
}

const styles = `
.app-shell {
  min-height: 100vh;
  color: ${COLORS.text};
  background:
    radial-gradient(circle at 18% 6%, rgba(78, 205, 196, 0.16), transparent 28rem),
    radial-gradient(circle at 86% 14%, rgba(110, 168, 254, 0.15), transparent 24rem),
    ${COLORS.bg};
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.screen {
  width: min(1480px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 28px 0 40px;
}

.upload-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.dropzone {
  width: min(580px, 100%);
  padding: 44px 34px;
  text-align: center;
  background: rgba(18, 26, 46, 0.92);
  border: 1px dashed ${COLORS.border2};
  border-radius: 10px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.26);
}

.dropzone.is-dragging {
  border-color: ${COLORS.teal};
}

.brand-icon {
  color: ${COLORS.teal};
}

h1, h2, p {
  margin: 0;
}

.dropzone h1 {
  margin-top: 16px;
  font-size: 28px;
  letter-spacing: 0;
}

.dropzone p {
  margin: 12px auto 0;
  max-width: 460px;
  color: ${COLORS.muted};
  font-size: 14px;
  line-height: 1.6;
}

.upload-actions {
  margin-top: 26px;
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}

.primary-button,
.secondary-button,
.reset-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 14px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.primary-button {
  background: ${COLORS.teal};
  border: 1px solid ${COLORS.teal};
  color: #06111c;
}

.secondary-button,
.reset-button {
  background: transparent;
  border: 1px solid ${COLORS.border2};
  color: ${COLORS.text};
}

.secondary-button:disabled {
  cursor: wait;
  opacity: 0.65;
}

input[type="file"] {
  display: none;
}

.hint,
.status-line,
.error-line {
  margin-top: 18px;
  font-size: 12px;
  color: ${COLORS.faint};
}

code {
  color: ${COLORS.teal};
  font-family: "SFMono-Regular", Consolas, monospace;
}

.error-line {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: ${COLORS.coral};
}

.hero {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 18px;
  padding: 30px;
  background: rgba(18, 26, 46, 0.9);
  border: 1px solid ${COLORS.border};
  border-radius: 10px;
}

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: ${COLORS.teal};
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.hero h1 {
  margin-top: 8px;
  font-size: clamp(30px, 4vw, 52px);
  line-height: 1;
  letter-spacing: 0;
}

.hero p {
  margin-top: 10px;
  color: ${COLORS.muted};
  font-size: 14px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(150px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.stat-card,
.panel {
  background: rgba(18, 26, 46, 0.92);
  border: 1px solid ${COLORS.border};
  border-radius: 10px;
}

.stat-card {
  padding: 16px;
  min-width: 0;
}

.stat-label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: ${COLORS.muted};
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.tone-teal { color: ${COLORS.teal}; }
.tone-amber { color: ${COLORS.amber}; }
.tone-green { color: ${COLORS.green}; }

.stat-value {
  margin-top: 9px;
  color: ${COLORS.text};
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.15;
  overflow-wrap: anywhere;
}

.stat-value span {
  margin-left: 5px;
  color: ${COLORS.muted};
  font-size: 12px;
  font-family: Inter, sans-serif;
}

.stat-sub {
  margin-top: 6px;
  color: ${COLORS.faint};
  font-size: 12px;
}

.content-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.8fr);
  gap: 14px;
  margin-top: 14px;
}

.panel {
  padding: 16px;
  min-width: 0;
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.panel-head h2 {
  font-size: 15px;
  letter-spacing: 0;
}

.panel-head span {
  color: ${COLORS.faint};
  font-size: 12px;
  text-align: right;
}

.tooltip {
  padding: 9px 11px;
  background: #0d1425;
  border: 1px solid ${COLORS.border2};
  border-radius: 8px;
  color: ${COLORS.text};
  font-size: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}

.tooltip-label {
  margin-bottom: 5px;
  color: ${COLORS.muted};
  font-family: "SFMono-Regular", Consolas, monospace;
}

.event-counts {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.overview-grid div {
  padding: 12px;
  background: ${COLORS.panel2};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
}

.overview-grid span,
.night-picker label,
.night-picker span {
  display: block;
  color: ${COLORS.muted};
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.overview-grid strong {
  display: block;
  margin-top: 5px;
  color: ${COLORS.text};
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 20px;
}

.night-picker {
  display: grid;
  grid-template-columns: auto minmax(220px, 1fr) auto;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.night-picker select {
  width: 100%;
  min-width: 0;
  height: 38px;
  padding: 0 10px;
  color: ${COLORS.text};
  background: #0d1425;
  border: 1px solid ${COLORS.border2};
  border-radius: 8px;
  font: 13px Inter, sans-serif;
}

.event-counts div,
.signal-health div {
  padding: 10px;
  background: ${COLORS.panel2};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
}

.event-counts span,
.signal-health span {
  display: block;
  color: ${COLORS.muted};
  font-size: 11px;
}

.event-counts strong,
.signal-health strong {
  display: block;
  margin-top: 4px;
  color: ${COLORS.text};
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 19px;
}

.signal-health {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.signal-health strong {
  font-size: 13px;
}

.note-box,
.empty-state {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  margin-top: 12px;
  padding: 11px;
  color: ${COLORS.muted};
  background: rgba(78, 205, 196, 0.08);
  border: 1px solid rgba(78, 205, 196, 0.24);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.45;
}

.empty-state {
  min-height: 120px;
  align-items: center;
  justify-content: center;
  background: ${COLORS.panel2};
  border-color: ${COLORS.border};
}

.table-wrap {
  overflow: auto;
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
}

.compact-table {
  max-height: 260px;
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 780px;
  font-size: 12px;
}

th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 10px 12px;
  color: ${COLORS.muted};
  background: #11192d;
  border-bottom: 1px solid ${COLORS.border};
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

td {
  padding: 9px 12px;
  color: ${COLORS.text};
  border-bottom: 1px solid ${COLORS.border};
  font-family: "SFMono-Regular", Consolas, monospace;
  white-space: nowrap;
}

td:last-child {
  white-space: normal;
  min-width: 280px;
  color: ${COLORS.muted};
  font-family: Inter, sans-serif;
}

@media (max-width: 980px) {
  .stats-grid,
  .content-grid {
    grid-template-columns: 1fr;
  }

  .hero {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 620px) {
  .screen {
    width: min(100vw - 20px, 1480px);
    padding-top: 10px;
  }

  .dropzone,
  .hero,
  .panel {
    padding: 18px;
  }

  .stats-grid {
    grid-template-columns: 1fr;
  }

  .signal-health,
  .event-counts,
  .overview-grid,
  .night-picker {
    grid-template-columns: 1fr;
  }

  .upload-actions {
    flex-direction: column;
  }
}
`;
