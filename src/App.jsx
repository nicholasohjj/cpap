import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CalendarDays,
  Download,
  Droplets,
  FileText,
  FolderOpen,
  Gauge,
  Info,
  ListChecks,
  Moon,
  Printer,
  RefreshCw,
  Search,
  Upload,
  Wind,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { civilClockLabel, civilDateLabel, epochMsToCivil, parseEdfEntry } from "./edfParser.js";

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

const KNOWN_TYPES = ["STR", "BRP", "PLD", "SAD", "EVE", "CSL"];
const PARSE_CACHE_VERSION = "v3";
const COMPLIANCE_MINUTES = 240;
const LEAK_REVIEW_L_MIN = 24;
const EVENT_CLUSTER_GAP_SECONDS = 180;
const EVENT_CLUSTER_MIN_EVENTS = 3;
const EVENT_FOCUS_PAD_SECONDS = 90;
const EMPTY_DIAGNOSTICS = {
  totalInput: 0,
  supportedInput: 0,
  skipped: 0,
  edf: 0,
  crcFiles: 0,
  parsed: 0,
  failed: 0,
  failures: [],
  skippedFiles: [],
  cacheHits: 0,
  cacheMisses: 0,
  parseMs: null,
  crc: {
    validating: false,
    checkedRecords: 0,
    badRecords: 0,
    pendingFiles: 0,
    sidecars: 0,
    missingSidecars: 0,
  },
};
const SAMPLE_EDF_PATHS = [
  "/sample-data/20260712/20260713_005314_CSL.crc",
  "/sample-data/20260712/20260713_005314_CSL.edf",
  "/sample-data/20260712/20260713_005314_EVE.crc",
  "/sample-data/20260712/20260713_005314_EVE.edf",
  "/sample-data/20260712/20260713_005316_BRP.crc",
  "/sample-data/20260712/20260713_005316_BRP.edf",
  "/sample-data/20260712/20260713_005317_PLD.crc",
  "/sample-data/20260712/20260713_005317_PLD.edf",
  "/sample-data/20260712/20260713_005317_SAD.crc",
  "/sample-data/20260712/20260713_005317_SAD.edf",
];

let workerRequestId = 0;
let edfWorker = null;

function getEdfWorker() {
  if (typeof Worker === "undefined") return null;
  if (!edfWorker) {
    edfWorker = new Worker(new URL("./edfWorker.js", import.meta.url), { type: "module" });
  }
  return edfWorker;
}

function requestWorkerFiles(type, entries, mode, options = {}) {
  const worker = getEdfWorker();
  if (!worker) return null;
  const id = workerRequestId + 1;
  workerRequestId = id;

  return new Promise((resolve, reject) => {
    const handleMessage = (event) => {
      if (event.data?.id !== id) return;
      if (event.data.progress) {
        options.onProgress?.(event.data);
        return;
      }
      worker.removeEventListener("message", handleMessage);
      options.signal?.removeEventListener("abort", handleAbort);
      if (event.data.ok) {
        resolve({
          files: event.data.files || [],
          failures: event.data.failures || [],
          results: event.data.results || [],
        });
      }
      else reject(new Error(event.data.cancelled ? "Parsing cancelled" : event.data.error || "EDF worker failed"));
    };
    const handleAbort = () => {
      worker.postMessage({ id, type: "cancel" });
    };
    worker.addEventListener("message", handleMessage);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    worker.postMessage({ id, type, entries, mode });
  });
}

function toFileEntry(file) {
  return {
    file,
    name: file.name,
    relativePath: file.webkitRelativePath || file.relativePath || file.name,
  };
}

function fileEntriesFromList(fileList) {
  return [...fileList]
    .map(toFileEntry);
}

function cacheKey(entry) {
  return `${PARSE_CACHE_VERSION}|${entry.relativePath}|${entry.file.size || 0}|${entry.file.lastModified || 0}`;
}

function openParseCache() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open("cpap-edf-cache", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("summary");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function getCachedSummaries(entries) {
  const db = await openParseCache();
  if (!db) return { cached: new Map(), missing: entries };
  const cached = new Map();
  const missing = [];
  await Promise.all(entries.map((entry) => new Promise((resolve) => {
    const request = db.transaction("summary", "readonly").objectStore("summary").get(cacheKey(entry));
    request.onsuccess = () => {
      if (request.result) cached.set(entry.relativePath, request.result);
      else missing.push(entry);
      resolve();
    };
    request.onerror = () => {
      missing.push(entry);
      resolve();
    };
  })));
  db.close();
  return { cached, missing };
}

async function putCachedSummaries(entries, files) {
  const db = await openParseCache();
  if (!db) return;
  const entryByPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  await new Promise((resolve) => {
    const tx = db.transaction("summary", "readwrite");
    const store = tx.objectStore("summary");
    files.forEach((file) => {
      const entry = entryByPath.get(file.relativePath);
      if (entry) store.put(file, cacheKey(entry));
    });
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
  db.close();
}

async function clearParseCache() {
  const db = await openParseCache();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction("summary", "readwrite");
    tx.objectStore("summary").clear();
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
  db.close();
}

function isoDate(date) {
  if (!date) return "";
  if (date.year) return civilDateLabel(date);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function civilToSortMs(value) {
  if (!value) return 0;
  if (Number.isFinite(value)) return value;
  if (value.year) return Date.UTC(value.year, value.month - 1, value.day, value.hour || 0, value.minute || 0, value.second || 0);
  return value.getTime?.() || 0;
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

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function leakUnitLabel(prefs) {
  return prefs.leakUnit === "lps" ? "L/s" : "L/min";
}

function leakFromLps(value, prefs) {
  if (!Number.isFinite(value)) return null;
  return prefs.leakUnit === "lps" ? value : value * 60;
}

function leakFromLmin(value, prefs) {
  if (!Number.isFinite(value)) return null;
  return prefs.leakUnit === "lps" ? value / 60 : value;
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

async function parseEdfFile(input, mode = "summary") {
  const file = input.file || input;
  const relativePath = input.relativePath || file.webkitRelativePath || file.name;
  const parsed = await parseEdfEntry({ file, name: file.name || relativePath, relativePath }, mode, input.crcSidecar, input.options || {});
  return {
    ...parsed,
    sourceFile: file,
  };
}

async function hydrateSignals(fileRecord, mode = "detail") {
  if ((mode === "detail" && fileRecord.signalsLoaded) || (mode === "flow" && fileRecord.flowLoaded)) return fileRecord;
  if (fileRecord.header.labels.includes("EDF Annotations")) {
    return { ...fileRecord, signalsLoaded: true };
  }
  const parsed = await parseEdfFile({
    file: fileRecord.sourceFile,
    relativePath: fileRecord.relativePath,
    options: { skipCrc: true, parseAnnotations: false },
  }, mode);
  return {
    ...fileRecord,
    signals: { ...fileRecord.signals, ...parsed.signals },
    signalsLoaded: mode === "detail" ? true : fileRecord.signalsLoaded,
    flowLoaded: mode === "flow" ? true : fileRecord.flowLoaded,
  };
}

async function hydrateSignalFiles(files, mode = "detail") {
  const entries = files
    .filter((file) => file.sourceFile)
    .map((file) => ({ file: file.sourceFile, name: file.fileName, relativePath: file.relativePath }));
  const workerResult = entries.length ? await requestWorkerFiles("hydrateFiles", entries, mode) : null;
  if (workerResult) {
    const byPath = new Map(workerResult.files.map((file) => [file.relativePath, file]));
    return files.map((file) => {
      const hydrated = byPath.get(file.relativePath);
      if (!hydrated) return file;
      return {
        ...file,
        ...hydrated,
        sourceFile: file.sourceFile,
        signals: { ...file.signals, ...hydrated.signals },
        signalsLoaded: file.signalsLoaded || hydrated.signalsLoaded,
        flowLoaded: file.flowLoaded || hydrated.flowLoaded,
        crc: file.crc || hydrated.crc,
      };
    });
  }
  return Promise.all(files.map((file) => hydrateSignals(file, mode)));
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
  const startMs = fileStartMs(file);
  if (!startMs || !Number.isFinite(groupStartMs)) return 0;
  return Math.max(0, (startMs - groupStartMs) / 1000);
}

function combinedSignal(files, type, label, groupStartMs) {
  return files
    .filter((file) => file.header.type === type && file.signals?.[label]?.length)
    .sort((a, b) => fileStartMs(a) - fileStartMs(b))
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

function isRespiratoryEvent(event) {
  return /(apnea|hypopnea|rera|flow limitation)/i.test(event.label || "");
}

function eventBucket(label) {
  if (/central/i.test(label)) return "Central";
  if (/obstructive/i.test(label)) return "Obstructive";
  if (/hypopnea/i.test(label)) return "Hypopnea";
  if (/rera/i.test(label)) return "RERA";
  if (/flow limitation/i.test(label)) return "Flow limitation";
  if (/apnea/i.test(label)) return "Apnea";
  return label || "Event";
}

function eventTypeSummary(events) {
  const counts = events.reduce((out, event) => {
    const label = eventBucket(event.label);
    out[label] = (out[label] || 0) + 1;
    return out;
  }, {});
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `${label} ${count}`)
    .join(", ");
}

function buildEventClusters(events) {
  const respiratory = events
    .filter(isRespiratoryEvent)
    .slice()
    .sort((a, b) => a.onset - b.onset);
  const clusters = [];
  let current = [];

  const flush = () => {
    if (current.length >= EVENT_CLUSTER_MIN_EVENTS) {
      const start = current[0].onset;
      const end = Math.max(...current.map((event) => event.onset + event.duration));
      const duration = Math.max(1, end - start);
      clusters.push({
        id: clusters.length + 1,
        start,
        end,
        startLabel: timeLabel(start),
        endLabel: timeLabel(end),
        duration,
        count: current.length,
        rate: current.length / (duration / 3600),
        longestSeconds: Math.max(...current.map((event) => event.duration || 0)),
        avgPressure: mean(current.map((event) => event.pressure)),
        avgLeak: mean(current.map((event) => event.leak)),
        typeSummary: eventTypeSummary(current),
        events: current,
      });
    }
    current = [];
  };

  respiratory.forEach((event) => {
    const last = current[current.length - 1];
    if (!last || event.onset - (last.onset + last.duration) <= EVENT_CLUSTER_GAP_SECONDS) {
      current.push(event);
      return;
    }
    flush();
    current.push(event);
  });
  flush();
  return clusters;
}

function buildSession(files) {
  const grouped = groupByType(files);
  const str = grouped.STR[0] || null;
  const primary =
    files
      .filter((file) => file.header.type !== "STR")
      .sort((a, b) => fileStartMs(a) - fileStartMs(b))[0] ||
    str ||
    files[0] ||
    null;
  const groupStartMs = primary ? fileStartMs(primary) || null : null;

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
  const segments = files
    .filter((file) => ["BRP", "PLD", "SAD"].includes(file.header.type) && file.header.recordDuration > 0)
    .map((file) => {
      const start = relativeStart(file, groupStartMs);
      const end = start + file.header.recordCount * file.header.recordDuration;
      return {
        type: file.header.type,
        start,
        end,
        startLabel: timeLabel(start),
        endLabel: timeLabel(end),
        fileName: file.fileName,
      };
    })
    .sort((a, b) => a.start - b.start);
  const gaps = [];
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].start - segments[i - 1].end > 60) {
      gaps.push({
        start: segments[i - 1].end,
        end: segments[i].start,
        startLabel: timeLabel(segments[i - 1].end),
        endLabel: timeLabel(segments[i].start),
      });
    }
  }
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
  const annotatedEvents = events.map((event) => ({
    ...event,
    time: timeLabel(event.onset),
    pressure: nearestAt(pressure.length ? pressure : pressure40ms, event.onset),
    leak: nearestAt(leak, event.onset),
  }));
  const eventClusters = buildEventClusters(annotatedEvents);

  return {
    files,
    grouped,
    primary,
    start: primary?.header.startedAtCivil || primary?.header.startedAt || null,
    date: isoDate(primary?.header.startedAtCivil || primary?.header.startedAt || null),
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
    rawSeries: {
      flow,
      pressure40ms,
    },
    events: annotatedEvents,
    eventClusters,
    segments,
    gaps,
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
    crc: file.crc || null,
  }));
}

function crcOverview(files) {
  return files.reduce(
    (summary, file) => {
      const internal = file.crc?.internal;
      if (internal?.checked) {
        summary.checked += internal.total;
        summary.bad += internal.bad;
      }
      if (file.header.type !== "STR") {
        if (file.crc?.sidecar?.present) summary.sidecars += 1;
        else summary.missingSidecars += 1;
      }
      return summary;
    },
    { checked: 0, bad: 0, sidecars: 0, missingSidecars: 0 }
  );
}

function crcDiagnostics(files) {
  const overview = crcOverview(files);
  const pendingFiles = files.filter((file) => file.crc?.internal && !file.crc.internal.checked).length;
  return {
    validating: false,
    checkedRecords: overview.checked,
    badRecords: overview.bad,
    pendingFiles,
    sidecars: overview.sidecars,
    missingSidecars: overview.missingSidecars,
  };
}

function crcDiagnosticsFromResults(results, totalFiles) {
  const checkedRecords = results.reduce((sum, row) => sum + (row.crc?.internal?.total || 0), 0);
  const badRecords = results.reduce((sum, row) => sum + (row.crc?.internal?.bad || 0), 0);
  const sidecarEligible = results.filter((row) => row.type !== "STR");
  const sidecars = sidecarEligible.filter((row) => row.crc?.sidecar?.present).length;
  return {
    validating: false,
    checkedRecords,
    badRecords,
    pendingFiles: Math.max(0, totalFiles - results.length),
    sidecars,
    missingSidecars: Math.max(0, sidecarEligible.length - sidecars),
  };
}

function mergeCrcResults(files, results) {
  const byPath = new Map(results.map((row) => [row.relativePath, row]));
  return files.map((file) => {
    const updated = byPath.get(file.relativePath);
    if (!updated) return file;
    return {
      ...file,
      crc: {
        ...file.crc,
        ...updated.crc,
      },
    };
  });
}

function mergeDiagnostics(base, updates) {
  return {
    ...base,
    ...updates,
    crc: {
      ...base.crc,
      ...(updates.crc || {}),
    },
  };
}

function crcStatusLabel(row) {
  const internal = row.crc.internal;
  if (!internal?.checked && /pending/i.test(internal?.reason || "")) return "CRC pending";
  if (!internal?.checked) return "not checked";
  if (/pending/i.test(internal.reason || "")) return "CRC pending";
  const recordStatus = internal.bad ? `${internal.bad}/${internal.total} bad` : `${internal.total}/${internal.total} ok`;
  const sidecarStatus = row.crc.sidecar?.present ? "sidecar" : "no sidecar";
  return `${recordStatus}, ${sidecarStatus}`;
}

function signalRecordValue(file, label, recordIndex) {
  const signal = file?.signals?.[label];
  if (!signal?.length) return null;
  const samplesPerRecord = file.header.samplesPerRecord[file.header.labels.indexOf(label)] || 1;
  const point = signal[recordIndex * samplesPerRecord];
  return Number.isFinite(point?.value) ? point.value : null;
}

function signalRecordSamples(file, label, recordIndex) {
  const signal = file?.signals?.[label];
  const signalIndex = file?.header.labels.indexOf(label) ?? -1;
  if (!signal?.length || signalIndex < 0) return [];
  const samplesPerRecord = file.header.samplesPerRecord[signalIndex] || 1;
  const start = recordIndex * samplesPerRecord;
  return signal.slice(start, start + samplesPerRecord).map((point) => point.value);
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
        const date = dateFromUnixDay(dateSignal) || (Number.isFinite(file.header.startedAtMs)
          ? new Date(file.header.startedAtMs + record * file.header.recordDuration * 1000)
          : null);
        const leak95 = signalRecordValue(file, "Leak.95", record);
        const maskOns = signalRecordSamples(file, "MaskOn", record);
        const maskOffs = signalRecordSamples(file, "MaskOff", record);
        const maskWindows = maskOns
          .map((on, index) => {
            const off = maskOffs[index];
            if (!Number.isFinite(on) || !Number.isFinite(off) || (on === 0 && off === 0)) return null;
            const normalizedOff = off < on ? off + 1440 : off;
            if (normalizedOff <= on) return null;
            return { on, off: normalizedOff, rawOff: off, minutes: normalizedOff - on };
          })
          .filter(Boolean);
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
          maskWindows,
        });
      }
    });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function recentDailyRows(rows, count = 30) {
  return rows
    .filter((row) => row.date)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-count);
}

function buildComplianceReport(rows) {
  const recentRows = recentDailyRows(rows, 30);
  const usageRows = recentRows.filter((row) => Number.isFinite(row.usageMinutes));
  const compliantRows = usageRows.filter((row) => row.usageMinutes >= COMPLIANCE_MINUTES);
  return {
    rows: recentRows,
    nights: recentRows.length,
    nightsWithUsage: usageRows.length,
    compliantNights: compliantRows.length,
    percent: usageRows.length ? (compliantRows.length / usageRows.length) * 100 : null,
    avgUsageHours: mean(usageRows.map((row) => row.usageMinutes / 60)),
    avgAhi: mean(recentRows.map((row) => row.ahi)),
    avgLeak95LMin: mean(recentRows.map((row) => row.leak95LMin)),
    avgPressure95: mean(recentRows.map((row) => row.pressure95)),
    startDate: recentRows[0]?.date || "",
    endDate: recentRows[recentRows.length - 1]?.date || "",
  };
}

function valueOrFallback(primary, fallback) {
  return Number.isFinite(primary) ? primary : fallback;
}

function buildSleepSummary(session, dailyRows, prefs) {
  const dailyForDate = dailyRows.find((row) => row.date === session.date) || dailyRows[dailyRows.length - 1] || null;
  const therapySeconds = session.therapySeconds > 0
    ? session.therapySeconds
    : (Number.isFinite(dailyForDate?.usageMinutes) ? dailyForDate.usageMinutes * 60 : null);
  const ahi = valueOrFallback(session.indexes.ahi, dailyForDate?.ahi);
  const leak95LMin = Number.isFinite(session.stats.leak95)
    ? session.stats.leak95 * 60
    : dailyForDate?.leak95LMin;
  const pressure95 = valueOrFallback(session.stats.pressure95, dailyForDate?.pressure95);
  const pressureMedian = session.stats.pressureMedian;
  const leakDisplay = leakFromLmin(leak95LMin, prefs);
  const review = [];
  const positives = [];
  const signalWarnings = [];

  if (therapySeconds > 0) {
    if (therapySeconds < COMPLIANCE_MINUTES * 60) {
      review.push(`Therapy time was ${durationLabel(therapySeconds)}, below the common 4-hour compliance threshold.`);
    } else {
      positives.push(`Therapy time was ${durationLabel(therapySeconds)}, meeting the common 4-hour compliance threshold.`);
    }
  } else {
    review.push("No therapy duration could be calculated from the selected files.");
  }

  if (Number.isFinite(ahi)) {
    if (ahi < 5) positives.push(`AHI was ${compact(ahi, 2)}/hr, within the commonly used treated target range.`);
    else if (ahi < 10) review.push(`AHI was ${compact(ahi, 2)}/hr, above the commonly used treated target range.`);
    else review.push(`AHI was ${compact(ahi, 2)}/hr, which is high enough to review with the detailed charts.`);
  } else {
    signalWarnings.push("AHI could not be calculated from this selection.");
  }

  if (Number.isFinite(leak95LMin)) {
    if (leak95LMin >= LEAK_REVIEW_L_MIN) {
      review.push(`95% leak was ${compact(leakDisplay, 1)} ${leakUnitLabel(prefs)}, above the ${LEAK_REVIEW_L_MIN} L/min review line.`);
    } else {
      positives.push(`95% leak was ${compact(leakDisplay, 1)} ${leakUnitLabel(prefs)}, below the ${LEAK_REVIEW_L_MIN} L/min review line.`);
    }
  } else {
    signalWarnings.push("Leak data was not available.");
  }

  if (!Number.isFinite(pressure95)) signalWarnings.push("Pressure statistics were not available.");
  if (!session.series.flow.length) signalWarnings.push("Raw breath flow is not loaded or not available.");
  if (!session.series.spo2.length) signalWarnings.push("No valid SpO2 samples were found.");
  if (session.eventClusters?.length) {
    review.push(`${session.eventClusters.length} event cluster${session.eventClusters.length === 1 ? "" : "s"} found; inspect the cluster panel and event focus chart.`);
  }

  const headline = [
    therapySeconds > 0 ? `Used for ${durationLabel(therapySeconds)}` : "Usage unavailable",
    Number.isFinite(ahi) ? `AHI ${compact(ahi, 2)}/hr` : "AHI unavailable",
    Number.isFinite(leak95LMin) ? `95% leak ${compact(leakDisplay, 1)} ${leakUnitLabel(prefs)}` : "leak unavailable",
    review.length ? `${review.length} item${review.length === 1 ? "" : "s"} to review` : "no major review flags",
  ].join(". ");

  return {
    headline,
    positives,
    review,
    signalWarnings,
    metrics: {
      therapySeconds,
      ahi,
      pressure95,
      pressureMedian,
      leak95LMin,
      leakDisplay,
      eventCounts: session.eventCounts,
    },
  };
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

function fileStartMs(file) {
  return file.header.startedAtMs || file.header.startedAt?.getTime() || 0;
}

function fileDurationMs(file) {
  const recordSpan = file.header.recordCount * file.header.recordDuration;
  const annotationEnd = file.annotations?.length
    ? Math.max(...file.annotations.map((event) => event.onset + event.duration))
    : 0;
  return Math.max(recordSpan, annotationEnd) * 1000;
}

function clockLabel(date) {
  if (!date) return "--:--";
  if (Number.isFinite(date)) return civilClockLabel(epochMsToCivil(date));
  if (date.year) return civilClockLabel(date);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function findMaskWindowForCluster(cluster, dailyRows) {
  if (!cluster.startMs) return null;
  const start = new Date(cluster.startMs);
  const date = isoDate(start);
  const minute = start.getUTCHours() * 60 + start.getUTCMinutes();
  const row = dailyRows.find((item) => item.date === date);
  const window = row?.maskWindows?.find((item) => minute >= item.on && minute <= item.off);
  return window ? `${minuteOfDayLabel(window.on)}-${minuteOfDayLabel(window.rawOff)}` : null;
}

function buildSessionClusters(groupId, files, dailyRows = []) {
  const sorted = files
    .slice()
    .sort((a, b) => fileStartMs(a) - fileStartMs(b) || a.relativePath.localeCompare(b.relativePath));
  const clusters = [];
  const gapMs = 10 * 60 * 1000;

  sorted.forEach((file) => {
    const startMs = fileStartMs(file);
    const endMs = startMs + fileDurationMs(file);
    const current = clusters[clusters.length - 1];
    if (!current || (startMs && current.endMs && startMs > current.endMs + gapMs)) {
      clusters.push({ files: [file], startMs, endMs: Math.max(endMs, startMs), typeCounts: {} });
    } else {
      current.files.push(file);
      current.endMs = Math.max(current.endMs, endMs, startMs);
    }
    const target = clusters[clusters.length - 1];
    target.typeCounts[file.header.type] = (target.typeCounts[file.header.type] || 0) + 1;
  });

  return clusters.map((cluster, index) => {
    const maskWindow = findMaskWindowForCluster(cluster, dailyRows);
    return {
      id: `${groupId}#${index + 1}`,
      label: `${clockLabel(cluster.startMs || null)}-${clockLabel(cluster.endMs || null)}`,
      maskWindow,
      start: cluster.startMs ? epochMsToCivil(cluster.startMs) : null,
      end: cluster.endMs ? epochMsToCivil(cluster.endMs) : null,
      endSeconds: cluster.startMs && cluster.endMs ? (cluster.endMs - cluster.startMs) / 1000 : 0,
      files: cluster.files,
      typeCounts: cluster.typeCounts,
    };
  });
}

function buildTherapyGroups(files, dailyRows = []) {
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
        .sort((a, b) => fileStartMs(a) - fileStartMs(b));
      const startFile = sorted.find((file) => fileStartMs(file));
      const start = startFile?.header.startedAtCivil || startFile?.header.startedAt || null;
      const endSeconds = start
        ? Math.max(...sorted.map((file) => fileEndSeconds(file, fileStartMs(startFile))))
        : 0;
      const typeCounts = sorted.reduce((counts, file) => {
        counts[file.header.type] = (counts[file.header.type] || 0) + 1;
        return counts;
      }, {});
      const sessions = buildSessionClusters(id, sorted, dailyRows);
      return {
        id,
        label: id.replace(/^DATALOG\//, ""),
        files: sorted,
        start,
        endSeconds,
        typeCounts,
        sessions,
      };
    })
    .sort((a, b) => civilToSortMs(a.start) - civilToSortMs(b.start));
}

function statusForSignal(series) {
  if (!series?.length) return "missing";
  const valid = series.filter((point) => Number.isFinite(point.value));
  if (!valid.length) return "no valid samples";
  return `${valid.length.toLocaleString()} samples`;
}

function UploadPanel({ onLoad, onLoadSample, onCancel, onClearCache, error, loading, progress, cacheStats }) {
  const [dragging, setDragging] = useState(false);

  async function handleFiles(fileList) {
    await onLoad(fileEntriesFromList(fileList));
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
              accept=".edf,.crc"
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
          Expected sample set: <code>BRP</code>, <code>PLD</code>, <code>SAD</code>, <code>EVE</code>, <code>CSL</code>, plus optional <code>.crc</code> sidecars.
        </div>
        <div className="cache-actions">
          <span>{cacheStats?.hits ? `${cacheStats.hits} cached summaries used` : "Parser cache ready"}</span>
          <button type="button" className="secondary-button inline-action" onClick={onClearCache} disabled={loading}>
            Clear parser cache
          </button>
        </div>
        {loading ? (
          <div className="status-line progress-line">
            <span>
              {progress?.total
                ? `Parsing ${progress.done} / ${progress.total}${progress.fileName ? ` · ${progress.fileName}` : ""}`
                : "Preparing EDF records..."}
            </span>
            <button type="button" className="secondary-button inline-action" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : null}
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

function timeInRange(value, range) {
  if (!range) return true;
  return value >= range.start && value <= range.end;
}

function filterChartData(data, range, key = "time") {
  if (!range) return data;
  return data.filter((point) => timeInRange(point[key], range));
}

function chartRangeLabel(range) {
  if (!range) return "Full night";
  return `${timeLabel(range.start)} to ${timeLabel(range.end)}`;
}

function moveRange(range, fullEnd, delta) {
  const span = Math.max(60, range.end - range.start);
  const start = clamp(range.start + delta, 0, Math.max(0, fullEnd - span));
  return { start, end: Math.min(fullEnd, start + span) };
}

function zoomRange(range, fullEnd, factor) {
  const center = (range.start + range.end) / 2;
  const currentSpan = Math.max(60, range.end - range.start);
  const span = clamp(currentSpan * factor, 60, Math.max(60, fullEnd));
  const start = clamp(center - span / 2, 0, Math.max(0, fullEnd - span));
  return { start, end: Math.min(fullEnd, start + span) };
}

function ChartControls({ range, fullEnd, onChange }) {
  if (!range || fullEnd <= 60) return null;
  const span = range.end - range.start;
  const panStep = Math.max(60, span * 0.35);
  return (
    <div className="chart-controls">
      <div className="range-readout">
        <Search size={14} />
        <span>{chartRangeLabel(range)}</span>
      </div>
      <div className="chart-control-buttons">
        <button type="button" className="icon-button" aria-label="Pan left" title="Pan left" onClick={() => onChange(moveRange(range, fullEnd, -panStep))}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in" onClick={() => onChange(zoomRange(range, fullEnd, 0.5))}>
          <ZoomIn size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out" onClick={() => onChange(zoomRange(range, fullEnd, 2))}>
          <ZoomOut size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Pan right" title="Pan right" onClick={() => onChange(moveRange(range, fullEnd, panStep))}>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="secondary-button inline-action" onClick={() => onChange({ start: 0, end: fullEnd })}>
          Reset
        </button>
      </div>
    </div>
  );
}

function TimelineChart({ session, prefs, range, crosshairTime, onCrosshair }) {
  const chartData = useMemo(
    () =>
      mergeSeries(session.series.pressure, [
        { key: "pressure", series: session.series.pressure },
        { key: "leakDisplay", series: session.series.leak.map((point) => ({ ...point, value: leakFromLps(point.value, prefs) })) },
        { key: "respiration", series: session.series.respiration },
      ]),
    [session, prefs]
  );
  const rangedData = filterChartData(chartData, range);
  const eventMarkers = session.events.filter((event) => timeInRange(event.onset, range)).slice(0, 80);
  const clusters = (session.eventClusters || []).filter((cluster) => cluster.end >= range.start && cluster.start <= range.end);
  const gaps = session.gaps.filter((gap) => gap.end >= range.start && gap.start <= range.end);
  const segments = session.segments.filter((segment) => segment.start >= range.start && segment.start <= range.end);
  if (!rangedData.length) return <EmptyState label="No pressure, leak, or respiration samples in the selected range." />;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart
        data={rangedData}
        syncId="session-charts"
        syncMethod="value"
        margin={{ top: 10, right: 22, left: -8, bottom: 4 }}
        onMouseMove={(state) => {
          const time = state?.activePayload?.[0]?.payload?.time;
          if (Number.isFinite(time)) onCrosshair?.(time);
        }}
        onMouseLeave={() => onCrosshair?.(null)}
      >
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
        <Tooltip cursor={{ stroke: COLORS.text, strokeOpacity: 0.18 }} content={<ChartTooltip />} />
        {Number.isFinite(crosshairTime) && timeInRange(crosshairTime, range) ? (
          <ReferenceLine x={timeLabel(crosshairTime)} yAxisId="left" stroke={COLORS.text} strokeOpacity={0.28} />
        ) : null}
        {clusters.map((cluster) => (
          <ReferenceArea
            key={`cluster-${cluster.id}`}
            x1={timeLabel(cluster.start)}
            x2={timeLabel(cluster.end)}
            yAxisId="left"
            fill={COLORS.amber}
            fillOpacity={0.08}
          />
        ))}
        {gaps.map((gap, index) => (
          <ReferenceArea
            key={`gap-${index}`}
            x1={timeLabel(Math.max(gap.start, range.start))}
            x2={timeLabel(Math.min(gap.end, range.end))}
            fill={COLORS.coral}
            fillOpacity={0.08}
            yAxisId="left"
          />
        ))}
        {segments.map((segment, index) => (
          <ReferenceLine
            key={`segment-${segment.type}-${index}`}
            x={segment.startLabel}
            yAxisId="left"
            stroke={COLORS.faint}
            strokeDasharray="3 4"
            strokeOpacity={0.55}
          />
        ))}
        {eventMarkers.map((event, index) => (
          <ReferenceLine
            key={`event-${event.onset}-${index}`}
            x={event.time}
            yAxisId="left"
            stroke={/central/i.test(event.label) ? COLORS.amber : /obstructive/i.test(event.label) ? COLORS.coral : COLORS.blue}
            strokeOpacity={0.28}
          />
        ))}
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
          dataKey="leakDisplay"
          name={`Leak ${leakUnitLabel(prefs)}`}
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

function FlowChart({ session, canLoadFlow, flowLoading, onLoadFlow, range, crosshairTime, onCrosshair }) {
  const data = filterChartData(session.series.flow, range).map((point) => ({ ...point, flow: point.value }));
  if (!data.length) {
    return (
      <EmptyState label={canLoadFlow ? "BRP waveform data is available but not loaded yet." : "No BRP flow signal was loaded."}>
        {canLoadFlow ? (
          <button type="button" className="secondary-button inline-action" onClick={onLoadFlow} disabled={flowLoading}>
            {flowLoading ? "Loading flow..." : "Load BRP flow"}
          </button>
        ) : null}
      </EmptyState>
    );
  }

  return <CanvasWaveform data={data} range={range} crosshairTime={crosshairTime} onCrosshair={onCrosshair} />;
}

function CanvasWaveform({ data, range, crosshairTime, onCrosshair }) {
  const canvasRef = useRef(null);
  const layoutRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data.length) return;
    const parent = canvas.parentElement;
    const width = parent?.clientWidth || 800;
    const height = 240;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0d1425";
    ctx.fillRect(0, 0, width, height);

    const values = data.map((point) => point.flow).filter(Number.isFinite);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const minLabel = `${compact(min, 2)} L/s`;
    const maxLabel = `${compact(max, 2)} L/s`;
    ctx.font = "11px SFMono-Regular, Consolas, monospace";
    const leftPad = Math.ceil(Math.max(ctx.measureText(minLabel).width, ctx.measureText(maxLabel).width)) + 16;
    const rightPad = 24;
    const topPad = 24;
    const bottomPad = 34;
    const plotWidth = Math.max(1, width - leftPad - rightPad);
    const plotHeight = Math.max(1, height - topPad - bottomPad);
    const valueRange = Math.max(0.1, max - min);
    const domainStart = Number.isFinite(range?.start) ? range.start : data[0]?.time || 0;
    const domainEnd = Number.isFinite(range?.end) ? range.end : data[data.length - 1]?.time || domainStart + 1;
    const domainSpan = Math.max(1, domainEnd - domainStart);
    const xForTime = (time) => leftPad + ((time - domainStart) / domainSpan) * plotWidth;
    const yFor = (value) => topPad + (1 - (value - min) / valueRange) * plotHeight;
    layoutRef.current = { leftPad, rightPad, width, domainStart, domainEnd, domainSpan };

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const y = topPad + (i / 4) * plotHeight;
      ctx.moveTo(leftPad, y);
      ctx.lineTo(width - rightPad, y);
    }
    ctx.stroke();

    ctx.strokeStyle = COLORS.teal;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    data.forEach((point, index) => {
      const x = xForTime(point.time);
      const y = yFor(point.flow);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (Number.isFinite(crosshairTime) && crosshairTime >= domainStart && crosshairTime <= domainEnd) {
      const x = xForTime(crosshairTime);
      ctx.strokeStyle = "rgba(237, 242, 247, 0.32)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, topPad);
      ctx.lineTo(x, topPad + plotHeight);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = x < width - 120 ? "left" : "right";
      ctx.fillText(timeLabel(crosshairTime), x < width - 120 ? x + 6 : x - 6, topPad + 12);
    }

    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(maxLabel, 8, topPad);
    ctx.fillText(minLabel, 8, topPad + plotHeight);
    ctx.textBaseline = "alphabetic";
    ctx.fillText(data[0]?.label || "00:00:00", leftPad, height - 8);
    ctx.textAlign = "right";
    ctx.fillText(data[data.length - 1]?.label || "", width - rightPad, height - 8);
  }, [data, range, crosshairTime]);

  function handleMouseMove(event) {
    const layout = layoutRef.current;
    if (!layout) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, layout.leftPad, layout.width - layout.rightPad);
    const ratio = (x - layout.leftPad) / Math.max(1, layout.width - layout.leftPad - layout.rightPad);
    onCrosshair?.(layout.domainStart + ratio * layout.domainSpan);
  }

  return (
    <div className="canvas-wrap">
      <canvas
        ref={canvasRef}
        aria-label="Flow waveform"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => onCrosshair?.(null)}
      />
    </div>
  );
}

function OximetryChart({ session, range, crosshairTime, onCrosshair }) {
  const data = useMemo(
    () =>
      mergeSeries(session.series.spo2, [
        { key: "spo2", series: session.series.spo2 },
        { key: "pulse", series: session.series.pulse },
      ]),
    [session]
  );
  const rangedData = filterChartData(data, range);
  if (!data.length) return <EmptyState label="No valid SAD oximetry samples were found." />;
  if (!rangedData.length) return <EmptyState label="No valid oximetry samples in the selected range." />;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart
        data={rangedData}
        syncId="session-charts"
        syncMethod="value"
        margin={{ top: 8, right: 22, left: -8, bottom: 0 }}
        onMouseMove={(state) => {
          const time = state?.activePayload?.[0]?.payload?.time;
          if (Number.isFinite(time)) onCrosshair?.(time);
        }}
        onMouseLeave={() => onCrosshair?.(null)}
      >
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
        <Tooltip cursor={{ stroke: COLORS.text, strokeOpacity: 0.18 }} content={<ChartTooltip />} />
        {Number.isFinite(crosshairTime) && timeInRange(crosshairTime, range) ? (
          <ReferenceLine x={timeLabel(crosshairTime)} yAxisId="left" stroke={COLORS.text} strokeOpacity={0.28} />
        ) : null}
        <Line yAxisId="left" type="monotone" dataKey="spo2" name="SpO2 %" stroke={COLORS.teal} strokeWidth={1.8} dot={false} />
        <Line yAxisId="right" type="monotone" dataKey="pulse" name="Pulse bpm" stroke={COLORS.coral} strokeWidth={1.5} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function EventDetailPanel({ event, session, onClear, prefs, canLoadFlow, flowLoading, onLoadFlow }) {
  if (!event) return <EmptyState label="Select an event row to inspect a focused pressure/leak window." />;
  const start = Math.max(0, event.onset - EVENT_FOCUS_PAD_SECONDS);
  const end = event.onset + EVENT_FOCUS_PAD_SECONDS;
  const focusRange = { start, end };
  const pressure = session.series.pressure.filter((point) => point.time >= start && point.time <= end);
  const leak = session.series.leak
    .filter((point) => point.time >= start && point.time <= end)
    .map((point) => ({ ...point, value: leakFromLps(point.value, prefs) }));
  const rawFlow = (session.rawSeries?.flow || []).filter((point) => point.t >= start && point.t <= end);
  const flow = rawFlow.map((point) => ({ time: point.t, label: timeLabel(point.t), value: round(point.value, 3), flow: point.value }));
  const chartData = mergeSeries(pressure, [
    { key: "pressure", series: pressure },
    { key: "leakDisplay", series: leak },
    { key: "flow", series: flow },
  ]);

  return (
    <div>
      <div className="event-detail-head">
        <div>
          <strong>{event.label}</strong>
          <span>{event.time} · {compact(event.duration, 0)}s · {durationLabel(end - start)} focus</span>
        </div>
        <button type="button" className="secondary-button inline-action" onClick={onClear}>Clear</button>
      </div>
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 18, left: -8, bottom: 0 }}>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis dataKey="label" minTickGap={34} tick={{ fill: COLORS.faint, fontSize: 11 }} axisLine={{ stroke: COLORS.border }} tickLine={false} />
          <YAxis tick={{ fill: COLORS.faint, fontSize: 11 }} axisLine={false} tickLine={false} width={38} />
          <Tooltip content={<ChartTooltip />} />
          <ReferenceLine x={event.time} stroke={COLORS.amber} strokeDasharray="4 3" />
          <Line type="monotone" dataKey="pressure" name="Pressure cmH2O" stroke={COLORS.amber} strokeWidth={2} dot={false} connectNulls />
          <Line type="monotone" dataKey="leakDisplay" name={`Leak ${leakUnitLabel(prefs)}`} stroke={COLORS.teal} strokeWidth={1.6} dot={false} connectNulls />
          <Line type="monotone" dataKey="flow" name="Flow L/s" stroke={COLORS.blue} strokeWidth={1.2} dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
      {flow.length ? (
        <div className="event-waveform">
          <CanvasWaveform data={flow} range={focusRange} />
        </div>
      ) : canLoadFlow ? (
        <EmptyState label={flowLoading ? "Loading raw BRP flow for this event..." : "Raw BRP waveform is available for this event."}>
          <button type="button" className="secondary-button inline-action" onClick={onLoadFlow} disabled={flowLoading}>
            {flowLoading ? "Loading flow..." : "Load raw event flow"}
          </button>
        </EmptyState>
      ) : null}
    </div>
  );
}

function EventsChart({ session, range, crosshairTime, onCrosshair }) {
  const data = session.events.filter((event) => timeInRange(event.onset, range)).map((event) => ({
    ...event,
    y: 1,
    color: /central/i.test(event.label) ? COLORS.amber : /obstructive/i.test(event.label) ? COLORS.coral : COLORS.blue,
  }));
  if (!session.events.length) return <EmptyState label="No scored respiratory events were found." />;
  if (!data.length) return <EmptyState label="No scored events in the selected range." />;
  const domainStart = range?.start ?? Math.min(...data.map((event) => event.onset));
  const domainEnd = range?.end ?? Math.max(...data.map((event) => event.onset));
  const clusters = (session.eventClusters || []).filter((cluster) => cluster.end >= domainStart && cluster.start <= domainEnd);

  return (
    <ResponsiveContainer width="100%" height={130}>
      <ComposedChart
        data={data}
        margin={{ top: 10, right: 30, left: 8, bottom: 0 }}
        onMouseMove={(state) => {
          const onset = state?.activePayload?.[0]?.payload?.onset;
          if (Number.isFinite(onset)) onCrosshair?.(onset);
        }}
        onMouseLeave={() => onCrosshair?.(null)}
      >
        <XAxis
          type="number"
          dataKey="onset"
          domain={[domainStart, domainEnd]}
          minTickGap={34}
          tickFormatter={timeLabel}
          tick={{ fill: COLORS.faint, fontSize: 11 }}
          axisLine={{ stroke: COLORS.border }}
          tickLine={false}
          tickMargin={8}
        />
        <YAxis hide domain={[0, 1.4]} />
        <Tooltip
          cursor={{ stroke: COLORS.text, strokeOpacity: 0.18 }}
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
        {clusters.map((cluster) => (
          <ReferenceArea
            key={`event-cluster-${cluster.id}`}
            x1={cluster.start}
            x2={cluster.end}
            fill={COLORS.amber}
            fillOpacity={0.08}
          />
        ))}
        {Number.isFinite(crosshairTime) && timeInRange(crosshairTime, range) ? (
          <ReferenceLine x={crosshairTime} stroke={COLORS.text} strokeOpacity={0.28} />
        ) : null}
        <Scatter dataKey="y" name="Events">
          {data.map((event, index) => (
            <Cell key={`${event.onset}-${index}`} fill={event.color} />
          ))}
        </Scatter>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function EventTable({ events, selectedEvent, onSelectEvent, prefs }) {
  if (!events.length) return <EmptyState label="No event annotations to show." />;
  const rows = events.map((event) => ({
    time: event.time,
    label: event.label,
    duration_seconds: round(event.duration, 0),
    onset_seconds: round(event.onset, 0),
    pressure_cmH2O: round(event.pressure, 2),
    [`leak_${leakUnitLabel(prefs).replace("/", "_")}`]: round(leakFromLps(event.leak || 0, prefs), 2),
  }));
  return (
    <>
      <ExportButtons baseName="cpap-events" rows={rows} />
      <VirtualTable
        rows={events}
        maxHeight={260}
        rowKey={(event, index) => `${event.onset}-${event.label}-${index}`}
        rowClassName={(event) => selectedEvent?.onset === event.onset && selectedEvent?.label === event.label ? "selected-row" : ""}
        onRowClick={onSelectEvent}
        columns={[
          { key: "time", header: "Time" },
          { key: "label", header: "Event" },
          { key: "duration", header: "Duration", render: (event) => `${compact(event.duration, 0)}s` },
          { key: "pressure", header: "Pressure", render: (event) => `${compact(event.pressure, 1)} cmH2O` },
          { key: "leak", header: "Leak", render: (event) => `${compact(leakFromLps(event.leak || 0, prefs), 1)} ${leakUnitLabel(prefs)}` },
        ]}
      />
    </>
  );
}

function downloadText(fileName, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n");
}

function sanitizeReportText(value) {
  return String(value ?? "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pdfEscape(value) {
  return sanitizeReportText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapReportLine(text, maxChars = 88) {
  const clean = sanitizeReportText(text);
  if (!clean) return [""];
  const words = clean.split(" ");
  const lines = [];
  let line = "";
  words.forEach((word) => {
    if (!line) {
      line = word;
      return;
    }
    if (`${line} ${word}`.length > maxChars) {
      lines.push(line);
      line = word;
      return;
    }
    line = `${line} ${word}`;
  });
  if (line) lines.push(line);
  return lines;
}

function flattenPdfSections(title, sections) {
  const lines = [title, `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, ""];
  sections.forEach((section) => {
    lines.push(section.title.toUpperCase());
    (section.lines || []).forEach((line) => {
      wrapReportLine(line).forEach((wrapped) => lines.push(wrapped));
    });
    lines.push("");
  });
  return lines;
}

function downloadPdfFromSections(fileName, title, sections) {
  const rawLines = flattenPdfSections(title, sections);
  const linesPerPage = 48;
  const pages = [];
  for (let i = 0; i < rawLines.length; i += linesPerPage) {
    pages.push(rawLines.slice(i, i + linesPerPage));
  }

  const objects = new Map();
  const kids = [];
  const fontObjectId = 3;
  let nextObjectId = 4;

  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(fontObjectId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((pageLines) => {
    const pageObjectId = nextObjectId;
    const contentObjectId = nextObjectId + 1;
    nextObjectId += 2;
    kids.push(`${pageObjectId} 0 R`);
    const content = [
      "BT",
      "/F1 11 Tf",
      "14 TL",
      "40 752 Td",
      ...pageLines.map((line) => `(${pdfEscape(line)}) Tj T*`),
      "ET",
    ].join("\n");
    objects.set(
      pageObjectId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`
    );
    objects.set(contentObjectId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  objects.set(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`);

  const maxObjectId = nextObjectId - 1;
  let pdf = "%PDF-1.4\n";
  const offsets = Array(maxObjectId + 1).fill(0);
  for (let id = 1; id <= maxObjectId; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxObjectId; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  downloadText(fileName, pdf, "application/pdf");
}

function reportDateSlug(value) {
  return (value || "report").replace(/[^0-9A-Za-z-]+/g, "-");
}

function complianceRowsForExport(compliance, prefs) {
  return compliance.rows.map((row) => ({
    date: row.date,
    usage: Number.isFinite(row.usageMinutes) ? durationLabel(row.usageMinutes * 60) : "--",
    compliant: Number.isFinite(row.usageMinutes) && row.usageMinutes >= COMPLIANCE_MINUTES ? "yes" : "no",
    ahi: compact(row.ahi, 2),
    leak_95: `${compact(leakFromLmin(row.leak95LMin, prefs), 1)} ${leakUnitLabel(prefs)}`,
    pressure_95: `${compact(row.pressure95, 1)} cmH2O`,
    mask_windows: maskWindowSummary(row.maskWindows),
  }));
}

function clusterRowsForExport(clusters, prefs) {
  return clusters.map((cluster) => ({
    cluster: cluster.id,
    start: cluster.startLabel,
    end: cluster.endLabel,
    duration: durationLabel(cluster.duration),
    events: cluster.count,
    rate_per_hr: compact(cluster.rate, 1),
    event_mix: cluster.typeSummary,
    avg_pressure: `${compact(cluster.avgPressure, 1)} cmH2O`,
    avg_leak: `${compact(leakFromLps(cluster.avgLeak, prefs), 1)} ${leakUnitLabel(prefs)}`,
  }));
}

function buildCompliancePdfSections(compliance, prefs) {
  return [
    {
      title: "30-Night Compliance",
      lines: [
        `Date range: ${compliance.startDate || "--"} to ${compliance.endDate || "--"}`,
        `Nights with usage: ${compliance.nightsWithUsage}/${compliance.nights}`,
        `Nights >= 4 hours: ${compliance.compliantNights}/${compliance.nightsWithUsage}`,
        `Compliance: ${compact(compliance.percent, 1)}%`,
        `Average usage: ${compact(compliance.avgUsageHours, 2)} hr/night`,
        `Average AHI: ${compact(compliance.avgAhi, 2)}/hr`,
        `Average leak 95%: ${compact(leakFromLmin(compliance.avgLeak95LMin, prefs), 1)} ${leakUnitLabel(prefs)}`,
        `Average pressure 95%: ${compact(compliance.avgPressure95, 1)} cmH2O`,
      ],
    },
    {
      title: "Daily Rows",
      lines: complianceRowsForExport(compliance, prefs).map(
        (row) => `${row.date}: usage ${row.usage}, compliant ${row.compliant}, AHI ${row.ahi}, leak ${row.leak_95}, pressure ${row.pressure_95}`
      ),
    },
  ];
}

function buildDoctorReportSections({ session, summary, compliance, prefs, selectedSections }) {
  const sections = [
    {
      title: "Sleep Summary",
      lines: [
        summary.headline,
        ...summary.positives.map((item) => `OK: ${item}`),
        ...(summary.review.length ? summary.review.map((item) => `Review: ${item}`) : ["Review: no major review flags from the rule-based checks."]),
        ...summary.signalWarnings.map((item) => `Signal note: ${item}`),
      ],
    },
    {
      title: "Key Metrics",
      lines: [
        `Date: ${session.date || "unknown"}`,
        `Therapy time: ${durationLabel(summary.metrics.therapySeconds)}`,
        `AHI: ${compact(summary.metrics.ahi, 2)}/hr`,
        `Pressure 95%: ${compact(summary.metrics.pressure95, 1)} cmH2O`,
        `Pressure median: ${compact(summary.metrics.pressureMedian, 1)} cmH2O`,
        `Leak 95%: ${compact(summary.metrics.leakDisplay, 1)} ${leakUnitLabel(prefs)}`,
        `Events: central ${session.eventCounts.central}, obstructive ${session.eventCounts.obstructive}, hypopnea ${session.eventCounts.hypopnea}`,
      ],
    },
  ];

  if (selectedSections.events) {
    sections.push({
      title: "Event Breakdown",
      lines: [
        `Total annotations: ${session.eventCounts.all}`,
        `Central apnea: ${session.eventCounts.central}`,
        `Obstructive apnea: ${session.eventCounts.obstructive}`,
        `Hypopnea: ${session.eventCounts.hypopnea}`,
      ],
    });
  }

  if (selectedSections.clusters) {
    sections.push({
      title: "Event Clusters",
      lines: session.eventClusters?.length
        ? clusterRowsForExport(session.eventClusters, prefs).map(
            (row) => `Cluster ${row.cluster}: ${row.start}-${row.end}, ${row.events} events, ${row.rate_per_hr}/hr, ${row.event_mix}`
          )
        : ["No event clusters found using the current spacing rule."],
    });
  }

  if (selectedSections.timeline) {
    sections.push({
      title: "Therapy Timeline Chart Notes",
      lines: [
        `Pressure samples: ${session.series.pressure.length.toLocaleString()}`,
        `Leak samples: ${session.series.leak.length.toLocaleString()}`,
        `Respiration samples: ${session.series.respiration.length.toLocaleString()}`,
        `Gaps detected: ${session.gaps.length}`,
      ],
    });
  }

  if (selectedSections.flow) {
    sections.push({
      title: "Breath Flow Chart Notes",
      lines: [
        `Flow samples shown: ${session.series.flow.length.toLocaleString()}`,
        `Flow range: ${compact(session.stats.flowMinMax.min, 2)} to ${compact(session.stats.flowMinMax.max, 2)} L/s`,
      ],
    });
  }

  if (selectedSections.oximetry) {
    sections.push({
      title: "Oximetry Chart Notes",
      lines: [
        `SpO2 median: ${compact(session.stats.spo2Median, 1)}%`,
        `SpO2 low percentile: ${compact(session.stats.spo2Low, 1)}%`,
        `Pulse median: ${compact(session.stats.pulseMedian, 1)} bpm`,
      ],
    });
  }

  if (selectedSections.compliance && compliance.rows.length) {
    sections.push(...buildCompliancePdfSections(compliance, prefs));
  }

  return sections;
}

function ExportButtons({ baseName, rows }) {
  if (!rows.length) return null;
  return (
    <div className="export-actions">
      <button type="button" className="secondary-button" onClick={() => downloadText(`${baseName}.csv`, toCsv(rows), "text/csv")}>
        CSV
      </button>
      <button type="button" className="secondary-button" onClick={() => downloadText(`${baseName}.json`, JSON.stringify(rows, null, 2), "application/json")}>
        JSON
      </button>
    </div>
  );
}

function VirtualTable({ columns, rows, rowKey, rowClassName, onRowClick, maxHeight = 320 }) {
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = 36;
  const overscan = 8;
  const visibleCount = Math.ceil(maxHeight / rowHeight) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const topPad = startIndex * rowHeight;
  const bottomPad = Math.max(0, (rows.length - endIndex) * rowHeight);
  const visibleRows = rows.slice(startIndex, endIndex);

  return (
    <div className="table-wrap" style={{ maxHeight }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => <th key={column.key}>{column.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {topPad ? (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: topPad, padding: 0, border: 0 }} />
            </tr>
          ) : null}
          {visibleRows.map((row, index) => (
            <tr
              key={rowKey(row, startIndex + index)}
              className={rowClassName?.(row) || ""}
              onClick={() => onRowClick?.(row)}
            >
              {columns.map((column) => <td key={column.key}>{column.render ? column.render(row) : row[column.key]}</td>)}
            </tr>
          ))}
          {bottomPad ? (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: bottomPad, padding: 0, border: 0 }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function minuteOfDayLabel(minutes) {
  if (!Number.isFinite(minutes)) return "--:--";
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function maskWindowSummary(windows) {
  if (!windows?.length) return "--";
  return windows.map((window) => `${minuteOfDayLabel(window.on)}-${minuteOfDayLabel(window.rawOff)}`).join(", ");
}

function MaskTimeline({ rows }) {
  const visibleRows = rows.filter((row) => row.maskWindows?.length);
  if (!visibleRows.length) return null;
  return (
    <div className="mask-timeline">
      {visibleRows.map((row) => (
        <div className="mask-row" key={row.date}>
          <span>{row.date}</span>
          <div className="mask-track">
            {row.maskWindows.map((window, index) => (
              <i
                key={`${row.date}-${index}`}
                title={`${row.date} ${minuteOfDayLabel(window.on)}-${minuteOfDayLabel(window.rawOff)}`}
                style={{
                  left: `${Math.min(100, (window.on / 1440) * 100)}%`,
                  width: `${Math.max(0.5, Math.min(100, (window.minutes / 1440) * 100))}%`,
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DailySummaryPanel({ rows, prefs }) {
  if (!rows.length) return null;
  const chartRows = rows.map((row) => ({
    date: row.date,
    label: row.date.slice(5),
    usageHours: Number.isFinite(row.usageMinutes) ? round(row.usageMinutes / 60, 2) : null,
    ahi: row.ahi,
    pressure95: row.pressure95,
    leakDisplay: leakFromLmin(row.leak95LMin, prefs),
  }));
  const exportRows = rows.map((row) => ({
    date: row.date,
    usage_minutes: round(row.usageMinutes, 2),
    mask_windows: maskWindowSummary(row.maskWindows),
    ahi: round(row.ahi, 2),
    hi: round(row.hi, 2),
    ai: round(row.ai, 2),
    cai: round(row.cai, 2),
    oai: round(row.oai, 2),
    [`leak_95_${leakUnitLabel(prefs).replace("/", "_")}`]: round(leakFromLmin(row.leak95LMin, prefs), 2),
    pressure_95_cmH2O: round(row.pressure95, 2),
    patient_hours: round(row.patientHours, 2),
    csr_minutes: round(row.csrMinutes, 2),
  }));

  return (
    <Panel title="Daily STR summary" note={`${rows.length} daily records`}>
      <ExportButtons baseName="cpap-daily-summary" rows={exportRows} />
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
      <MaskTimeline rows={rows} />
      <VirtualTable
        rows={rows}
        maxHeight={260}
        rowKey={(row) => row.date}
        columns={[
          { key: "date", header: "Date" },
          { key: "usage", header: "Usage", render: (row) => Number.isFinite(row.usageMinutes) ? durationLabel(row.usageMinutes * 60) : "--" },
          { key: "ahi", header: "AHI", render: (row) => compact(row.ahi, 2) },
          { key: "cai", header: "CAI", render: (row) => compact(row.cai, 2) },
          { key: "oai", header: "OAI", render: (row) => compact(row.oai, 2) },
          { key: "leak", header: "Leak 95", render: (row) => `${compact(leakFromLmin(row.leak95LMin, prefs), 1)} ${leakUnitLabel(prefs)}` },
          { key: "pressure", header: "Pressure 95", render: (row) => `${compact(row.pressure95, 1)} cmH2O` },
          { key: "mask", header: "Mask windows", render: (row) => maskWindowSummary(row.maskWindows) },
          { key: "csr", header: "CSR", render: (row) => `${compact(row.csrMinutes, 0)}m` },
        ]}
      />
    </Panel>
  );
}

function FilesTable({ rows }) {
  return (
    <VirtualTable
      rows={rows}
      maxHeight={360}
      rowKey={(row) => row.name}
      columns={[
        { key: "name", header: "File" },
        { key: "type", header: "Type" },
        { key: "start", header: "Start" },
        { key: "records", header: "Records" },
        { key: "duration", header: "Record dur", render: (row) => `${row.duration}s` },
        { key: "samples", header: "Samples/record" },
        { key: "crc", header: "CRC", render: crcStatusLabel },
        { key: "signals", header: "Signals" },
      ]}
    />
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

function EmptyState({ label, children }) {
  return (
    <div className="empty-state">
      <Info size={16} />
      <span>{label}</span>
      {children}
    </div>
  );
}

function SleepSummaryPanel({ summary }) {
  return (
    <Panel title="Sleep summary" note="rule-based local analysis">
      <div className="summary-lead">
        <FileText size={18} />
        <strong>{summary.headline}</strong>
      </div>
      <div className="summary-columns">
        <div>
          <h3>Looks okay</h3>
          {summary.positives.length ? (
            summary.positives.map((item) => <p key={item}>{item}</p>)
          ) : (
            <p>No positive flags could be generated from the loaded signals.</p>
          )}
        </div>
        <div>
          <h3>Review</h3>
          {summary.review.length ? (
            summary.review.map((item) => <p key={item}>{item}</p>)
          ) : (
            <p>No major review flags from the current rule set.</p>
          )}
        </div>
        <div>
          <h3>Signal notes</h3>
          {summary.signalWarnings.length ? (
            summary.signalWarnings.map((item) => <p key={item}>{item}</p>)
          ) : (
            <p>Core pressure, leak, event, and flow signals are available.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ComplianceReportPanel({ compliance, prefs }) {
  if (!compliance.rows.length) {
    return (
      <Panel title="30-night compliance" note="STR summary required">
        <EmptyState label="No STR daily summary records were loaded." />
      </Panel>
    );
  }
  const rows = complianceRowsForExport(compliance, prefs);
  return (
    <Panel title="30-night compliance" note={`${compliance.startDate} to ${compliance.endDate}`}>
      <div className="report-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => downloadPdfFromSections(
            `cpap-compliance-${reportDateSlug(compliance.endDate)}.pdf`,
            "CPAP 30-Night Compliance Report",
            buildCompliancePdfSections(compliance, prefs)
          )}
        >
          <Download size={15} />
          PDF
        </button>
      </div>
      <div className="overview-grid compliance-grid">
        <div>
          <span>Nights used</span>
          <strong>{compliance.nightsWithUsage}/{compliance.nights}</strong>
        </div>
        <div>
          <span>Over 4 hours</span>
          <strong>{compliance.compliantNights}</strong>
        </div>
        <div>
          <span>Compliance</span>
          <strong>{compact(compliance.percent, 1)}%</strong>
        </div>
        <div>
          <span>Avg usage</span>
          <strong>{compact(compliance.avgUsageHours, 2)}h</strong>
        </div>
      </div>
      <ExportButtons baseName="cpap-30-night-compliance" rows={rows} />
      <VirtualTable
        rows={rows}
        maxHeight={240}
        rowKey={(row) => row.date}
        columns={[
          { key: "date", header: "Date" },
          { key: "usage", header: "Usage" },
          { key: "compliant", header: ">= 4h" },
          { key: "ahi", header: "AHI" },
          { key: "leak_95", header: "Leak 95" },
          { key: "pressure_95", header: "Pressure 95" },
        ]}
      />
    </Panel>
  );
}

function EventClustersPanel({ clusters, prefs, onSelectEvent }) {
  if (!clusters?.length) {
    return (
      <Panel title="Clusters" note="3+ respiratory events within 3 minutes">
        <EmptyState label="No event clusters found in the selected session." />
      </Panel>
    );
  }
  const rows = clusterRowsForExport(clusters, prefs);
  return (
    <Panel title="Clusters" note={`${clusters.length} cluster${clusters.length === 1 ? "" : "s"} found`}>
      <VirtualTable
        rows={clusters}
        maxHeight={220}
        rowKey={(cluster) => cluster.id}
        onRowClick={(cluster) => onSelectEvent?.(cluster.events[0])}
        columns={[
          { key: "id", header: "#" },
          { key: "start", header: "Start", render: (cluster) => cluster.startLabel },
          { key: "end", header: "End", render: (cluster) => cluster.endLabel },
          { key: "duration", header: "Duration", render: (cluster) => durationLabel(cluster.duration) },
          { key: "events", header: "Events", render: (cluster) => cluster.count },
          { key: "rate", header: "Rate", render: (cluster) => `${compact(cluster.rate, 1)}/hr` },
          { key: "mix", header: "Mix", render: (cluster) => cluster.typeSummary },
        ]}
      />
      <ExportButtons baseName="cpap-event-clusters" rows={rows} />
    </Panel>
  );
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openPrintableReport(title, sections) {
  const body = sections.map((section) => `
    <section>
      <h2>${htmlEscape(section.title)}</h2>
      ${(section.lines || []).map((line) => `<p>${htmlEscape(line)}</p>`).join("")}
    </section>
  `).join("");
  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${htmlEscape(title)}</title>
        <style>
          body { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 34px; color: #111827; }
          h1 { font-size: 22px; margin: 0 0 16px; }
          h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
          p { margin: 4px 0; line-height: 1.35; }
          @media print { button { display: none; } }
        </style>
      </head>
      <body>
        <button onclick="window.print()">Print / Save PDF</button>
        <h1>${htmlEscape(title)}</h1>
        ${body}
      </body>
    </html>`;
  const win = window.open("", "_blank");
  if (!win) {
    downloadText(`${reportDateSlug(title)}.html`, html, "text/html");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
}

function ReportActionsPanel({ session, summary, compliance, prefs }) {
  const [selectedSections, setSelectedSections] = useState({
    timeline: true,
    events: true,
    flow: true,
    oximetry: true,
    clusters: true,
    compliance: true,
  });
  const sections = buildDoctorReportSections({ session, summary, compliance, prefs, selectedSections });
  const toggle = (key) => setSelectedSections((current) => ({ ...current, [key]: !current[key] }));
  return (
    <Panel title="Doctor report" note="PDF and printable summary">
      <div className="report-checks">
        {Object.entries({
          timeline: "Timeline",
          events: "Events",
          flow: "Flow",
          oximetry: "Oximetry",
          clusters: "Clusters",
          compliance: "Compliance",
        }).map(([key, label]) => (
          <label key={key}>
            <input type="checkbox" checked={selectedSections[key]} onChange={() => toggle(key)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <div className="report-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => downloadPdfFromSections(
            `cpap-doctor-report-${reportDateSlug(session.date)}.pdf`,
            "CPAP Doctor Report",
            sections
          )}
        >
          <Download size={15} />
          PDF
        </button>
        <button type="button" className="secondary-button" onClick={() => openPrintableReport("CPAP Doctor Report", sections)}>
          <Printer size={15} />
          Print
        </button>
      </div>
      <div className="note-box">
        <BarChart3 size={16} />
        Chart selections add text summaries of the current charts to the report. The interactive charts remain in the dashboard.
      </div>
    </Panel>
  );
}

function PreferencesPanel({ prefs, onChange }) {
  return (
    <Panel title="Preferences" note="stored in this browser">
      <div className="preferences-grid">
        <label>
          <span>Leak unit</span>
          <select value={prefs.leakUnit} onChange={(event) => onChange({ ...prefs, leakUnit: event.target.value })}>
            <option value="lmin">L/min</option>
            <option value="lps">L/s</option>
          </select>
        </label>
        <label>
          <span>Pressure decimals</span>
          <select value={prefs.pressureDigits} onChange={(event) => onChange({ ...prefs, pressureDigits: Number(event.target.value) })}>
            <option value={1}>1 decimal</option>
            <option value={2}>2 decimals</option>
          </select>
        </label>
      </div>
    </Panel>
  );
}

function CrcNotePanel() {
  return (
    <Panel title="CRC validation" note="record-level strict checks">
      <div className="note-box">
        <ListChecks size={16} />
        Internal EDF record CRCs are validated with CRC-CCITT-FALSE. The 8-byte ResMed .crc sidecars are tracked for presence and inspection; strict sidecar validation still needs the vendor sidecar algorithm.
      </div>
    </Panel>
  );
}

function ImportDiagnosticsPanel({ diagnostics }) {
  if (!diagnostics?.totalInput && !diagnostics?.parsed) return null;
  const crc = diagnostics.crc || EMPTY_DIAGNOSTICS.crc;
  const crcText = crc.validating
    ? `${crc.checkedRecords.toLocaleString()} records checked, ${crc.pendingFiles} files pending`
    : crc.pendingFiles
      ? `${crc.pendingFiles} files pending`
      : `${crc.checkedRecords.toLocaleString()} records checked`;
  const failures = diagnostics.failures || [];

  return (
    <Panel title="Import diagnostics" note={diagnostics.parseMs ? `${compact(diagnostics.parseMs / 1000, 2)}s scan` : "latest import"}>
      <div className="diagnostics-grid">
        <div>
          <span>Input files</span>
          <strong>{diagnostics.totalInput}</strong>
        </div>
        <div>
          <span>Parsed EDF</span>
          <strong>{diagnostics.parsed}</strong>
        </div>
        <div>
          <span>Skipped</span>
          <strong>{diagnostics.skipped}</strong>
        </div>
        <div>
          <span>Failed</span>
          <strong>{diagnostics.failed}</strong>
        </div>
        <div>
          <span>Cache</span>
          <strong>{diagnostics.cacheHits}/{diagnostics.cacheHits + diagnostics.cacheMisses}</strong>
        </div>
        <div>
          <span>CRC</span>
          <strong>{crc.badRecords ? `${crc.badRecords} bad` : crcText}</strong>
        </div>
        <div>
          <span>Sidecars</span>
          <strong>{crc.sidecars}/{crc.sidecars + crc.missingSidecars}</strong>
        </div>
        <div>
          <span>Mode</span>
          <strong>{crc.validating || crc.pendingFiles ? "fast scan" : "complete"}</strong>
        </div>
      </div>
      {failures.length ? (
        <div className="failure-list">
          {failures.slice(0, 6).map((failure) => (
            <div key={failure.relativePath}>
              <strong>{failure.relativePath}</strong>
              <span>{failure.error}</span>
            </div>
          ))}
          {failures.length > 6 ? <p>{failures.length - 6} more failed files hidden.</p> : null}
        </div>
      ) : null}
      {diagnostics.skippedFiles?.length ? (
        <div className="note-box">
          <Info size={16} />
          Skipped {diagnostics.skipped} non-EDF side files from the selected folder.
        </div>
      ) : null}
    </Panel>
  );
}

function ExportOverview({
  parsed,
  groups,
  selectedNightId,
  selectedSessionId,
  onSelectNight,
  onSelectSession,
  detailLoading,
  dailyRows,
}) {
  const strLoaded = dailyRows.length > 0;
  const edfCount = parsed.length;
  const latestGroup = groups[groups.length - 1];
  const selectedNight = groups.find((group) => group.id === selectedNightId) || latestGroup;
  const crc = crcOverview(parsed);
  const pendingCrcFiles = parsed.filter((file) => file.crc?.internal && !file.crc.internal.checked).length;

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
        <div>
          <span>CRC records</span>
          <strong>{pendingCrcFiles ? `${pendingCrcFiles} pending` : crc.bad ? `${crc.bad} bad` : `${crc.checked} ok`}</strong>
        </div>
      </div>
      {groups.length ? (
        <>
          <div className="night-picker">
            <label htmlFor="night-select">Detailed night</label>
            <select id="night-select" value={selectedNight?.id || ""} onChange={(event) => onSelectNight(event.target.value)}>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.label} · {group.sessions.length} sessions · {group.files.length} EDFs
                </option>
              ))}
            </select>
            {detailLoading ? <span>Loading signal detail...</span> : null}
          </div>
          <div className="session-chips">
            {(selectedNight?.sessions || []).map((session) => (
              <button
                type="button"
                key={session.id}
                className={session.id === selectedSessionId ? "is-active" : ""}
                onClick={() => onSelectSession(session.id)}
              >
                <strong>{session.label}</strong>
                <span>
                  {durationLabel(session.endSeconds)} · {session.files.length} EDFs
                  {session.maskWindow ? ` · STR ${session.maskWindow}` : ""}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <EmptyState label="No DATALOG therapy EDF files were found in this selection." />
      )}
    </Panel>
  );
}

function sessionFullChartEnd(session) {
  const seriesEnds = Object.values(session.series || {}).map((series) => series?.[series.length - 1]?.time || 0);
  const eventEnd = session.events?.length
    ? Math.max(...session.events.map((event) => event.onset + event.duration))
    : 0;
  return Math.max(60, session.therapySeconds || 0, eventEnd, ...seriesEnds);
}

function Dashboard({ parsed, diagnostics, onReset }) {
  const dailyRows = useMemo(() => buildDailyRows(parsed), [parsed]);
  const groups = useMemo(() => buildTherapyGroups(parsed, dailyRows), [parsed, dailyRows]);
  const [selectedNightId, setSelectedNightId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [detailFiles, setDetailFiles] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [flowLoading, setFlowLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [chartRange, setChartRange] = useState({ start: 0, end: 60 });
  const [crosshairTime, setCrosshairTime] = useState(null);
  const autoFlowKeyRef = useRef("");
  const [prefs, setPrefs] = useState(() => {
    try {
      return { leakUnit: "lmin", pressureDigits: 1, ...JSON.parse(localStorage.getItem("cpap-prefs") || "{}") };
    } catch {
      return { leakUnit: "lmin", pressureDigits: 1 };
    }
  });
  const selectedNight = useMemo(
    () => groups.find((group) => group.id === selectedNightId) || groups[groups.length - 1] || null,
    [groups, selectedNightId]
  );
  const selectedSession = useMemo(
    () => selectedNight?.sessions.find((session) => session.id === selectedSessionId) || selectedNight?.sessions[selectedNight.sessions.length - 1] || null,
    [selectedNight, selectedSessionId]
  );
  const activeFiles = detailFiles.length ? detailFiles : selectedSession?.files || selectedNight?.files || parsed;
  const session = useMemo(() => buildSession(activeFiles), [activeFiles]);
  const rows = useMemo(() => buildOverviewRows(parsed), [parsed]);
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
  const leak95Display = summaryOnly ? leakFromLmin(leak95LMin, prefs) : leakFromLps(session.stats.leak95, prefs);
  const flowRange = session.stats.flowMinMax;
  const canLoadFlow = Boolean(selectedSession?.files.some((file) => file.header.type === "BRP")) && !session.series.flow.length;
  const fullChartEnd = useMemo(() => sessionFullChartEnd(session), [session]);
  const sleepSummary = useMemo(() => buildSleepSummary(session, dailyRows, prefs), [session, dailyRows, prefs]);
  const compliance = useMemo(() => buildComplianceReport(dailyRows), [dailyRows]);

  useEffect(() => {
    localStorage.setItem("cpap-prefs", JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    setChartRange({ start: 0, end: fullChartEnd });
    setCrosshairTime(null);
  }, [selectedSession?.id, fullChartEnd]);

  useEffect(() => {
    if (!groups.length) {
      setSelectedNightId("");
      setSelectedSessionId("");
      return;
    }
    if (!selectedNightId || !groups.some((group) => group.id === selectedNightId)) {
      setSelectedNightId(groups[groups.length - 1].id);
    }
  }, [groups, selectedNightId]);

  useEffect(() => {
    if (!selectedNight?.sessions.length) {
      setSelectedSessionId("");
      return;
    }
    if (!selectedSessionId || !selectedNight.sessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(selectedNight.sessions[selectedNight.sessions.length - 1].id);
    }
  }, [selectedNight, selectedSessionId]);

  useEffect(() => {
    let cancelled = false;
    async function hydrateSelectedGroup() {
      if (!selectedSession) {
        setDetailFiles([]);
        return;
      }
      setDetailLoading(true);
      try {
        const hydrated = await hydrateSignalFiles(selectedSession.files, "detail");
        if (!cancelled) setDetailFiles(hydrated);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }
    setDetailFiles([]);
    setSelectedEvent(null);
    hydrateSelectedGroup();
    return () => {
      cancelled = true;
    };
  }, [selectedSession]);

  async function handleLoadFlow() {
    if (!selectedSession) return;
    setFlowLoading(true);
    try {
      const baseFiles = detailFiles.length ? detailFiles : selectedSession.files;
      const hydrated = await hydrateSignalFiles(baseFiles, "flow");
      setDetailFiles(hydrated);
    } finally {
      setFlowLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedEvent || !canLoadFlow || flowLoading) return;
    const key = `${selectedSession?.id || ""}:${selectedEvent.onset}:${selectedEvent.label}`;
    if (autoFlowKeyRef.current === key) return;
    autoFlowKeyRef.current = key;
    handleLoadFlow();
  }, [selectedEvent, canLoadFlow, flowLoading]);

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
          value={compact(summaryOnly ? avgDailyPressure95 : session.stats.pressure95, prefs.pressureDigits)}
          unit="cmH2O"
          sub={summaryOnly ? "daily average" : `median ${compact(session.stats.pressureMedian, prefs.pressureDigits)} cmH2O`}
          tone="amber"
        />
        <StatCard
          icon={Droplets}
          label="Leak 95%"
          value={compact(leak95Display, 1)}
          unit={leakUnitLabel(prefs)}
          sub={summaryOnly ? "daily average" : `median ${compact(leakFromLps(session.stats.leakMedian, prefs), 1)} ${leakUnitLabel(prefs)}`}
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
        selectedNightId={selectedNight?.id || ""}
        selectedSessionId={selectedSession?.id || ""}
        onSelectNight={(id) => {
          setSelectedNightId(id);
          setSelectedSessionId("");
        }}
        onSelectSession={setSelectedSessionId}
        detailLoading={detailLoading}
        dailyRows={dailyRows}
      />

      <SleepSummaryPanel summary={sleepSummary} />

      <div className="content-grid">
        <ReportActionsPanel session={session} summary={sleepSummary} compliance={compliance} prefs={prefs} />
        <ComplianceReportPanel compliance={compliance} prefs={prefs} />
      </div>

      <PreferencesPanel prefs={prefs} onChange={setPrefs} />
      <CrcNotePanel />
      <ImportDiagnosticsPanel diagnostics={diagnostics} />
      <ChartControls range={chartRange} fullEnd={fullChartEnd} onChange={setChartRange} />

      <div className="content-grid">
        <Panel title="Therapy timeline" note="pressure, leak, respiratory rate">
          <TimelineChart
            session={session}
            prefs={prefs}
            range={chartRange}
            crosshairTime={crosshairTime}
            onCrosshair={setCrosshairTime}
          />
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
          <EventsChart
            session={session}
            range={chartRange}
            crosshairTime={crosshairTime}
            onCrosshair={setCrosshairTime}
          />
        </Panel>
      </div>

      <div className="content-grid">
        <Panel title="Breath flow" note="BRP Flow.40ms">
          <FlowChart
            session={session}
            canLoadFlow={canLoadFlow}
            flowLoading={flowLoading}
            onLoadFlow={handleLoadFlow}
            range={chartRange}
            crosshairTime={crosshairTime}
            onCrosshair={setCrosshairTime}
          />
        </Panel>
        <Panel title="Oximetry" note="SAD SpO2.1s and Pulse.1s">
          <OximetryChart
            session={session}
            range={chartRange}
            crosshairTime={crosshairTime}
            onCrosshair={setCrosshairTime}
          />
        </Panel>
      </div>

      <div className="content-grid">
        <Panel title="Events" note="pressure/leak sampled near event onset">
          <EventTable events={session.events} selectedEvent={selectedEvent} onSelectEvent={setSelectedEvent} prefs={prefs} />
        </Panel>
        <Panel title="Event focus" note="±60 seconds where available">
          <EventDetailPanel
            event={selectedEvent}
            session={session}
            prefs={prefs}
            canLoadFlow={canLoadFlow}
            flowLoading={flowLoading}
            onLoadFlow={handleLoadFlow}
            onClear={() => setSelectedEvent(null)}
          />
        </Panel>
      </div>

      <EventClustersPanel clusters={session.eventClusters} prefs={prefs} onSelectEvent={setSelectedEvent} />

      <div className="content-grid">
        <Panel title="Signal health" note="valid parsed samples">
          <SignalHealth session={session} />
          <div className="note-box">
            <ListChecks size={16} />
            The included sample SAD file contains only invalid oximetry placeholders, so SpO2 and
            pulse intentionally show as unavailable.
          </div>
        </Panel>
      </div>

      <DailySummaryPanel rows={dailyRows} prefs={prefs} />

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
  const [progress, setProgress] = useState(null);
  const [cacheStats, setCacheStats] = useState({ hits: 0, misses: 0 });
  const [diagnostics, setDiagnostics] = useState(EMPTY_DIAGNOSTICS);
  const parseAbortRef = useRef(null);
  const importRunRef = useRef(0);

  function withSidecarState(files, sourceByPath, crcByPath) {
    return files.map((file) => {
      const crcPath = file.relativePath.replace(/\.edf$/i, ".crc");
      const sidecar = crcByPath.get(crcPath);
      return {
        ...file,
        sourceFile: sourceByPath.get(file.relativePath),
        crc: {
          ...file.crc,
          sidecar: sidecar
            ? {
                present: true,
                bytes: sidecar.file.size || file.crc?.sidecar?.bytes || 0,
                hex: file.crc?.sidecar?.hex || "",
              }
            : { present: false, bytes: 0, hex: "" },
        },
      };
    });
  }

  function sortParsedFiles(files) {
    return files.slice().sort((a, b) => fileStartMs(a) - fileStartMs(b) || a.relativePath.localeCompare(b.relativePath));
  }

  async function validateCrcInBackground(runId, edfEntries, crcEntries) {
    setDiagnostics((current) => mergeDiagnostics(current, {
      crc: {
        ...current.crc,
        validating: true,
        pendingFiles: edfEntries.length,
      },
    }));
    try {
      const result = await requestWorkerFiles("validateCrc", [...edfEntries, ...crcEntries], "crc", {
        onProgress: (event) => {
          if (runId !== importRunRef.current) return;
          setDiagnostics((current) => mergeDiagnostics(current, {
            crc: {
              ...current.crc,
              validating: true,
              pendingFiles: Math.max(0, edfEntries.length - event.done),
            },
          }));
        },
      });
      if (runId !== importRunRef.current) return;
      if (!result) {
        setDiagnostics((current) => mergeDiagnostics(current, {
          crc: {
            ...current.crc,
            validating: false,
          },
        }));
        return;
      }
      const crcFailures = result.failures || [];
      setParsed((current) => mergeCrcResults(current, result.results || []));
      setDiagnostics((previous) => {
        const mergedFailures = [...(previous.failures || []), ...crcFailures];
        return mergeDiagnostics(previous, {
          failed: mergedFailures.length,
          failures: mergedFailures,
          crc: crcDiagnosticsFromResults(result.results || [], previous.parsed || edfEntries.length),
        });
      });
    } catch (err) {
      if (runId !== importRunRef.current) return;
      setDiagnostics((current) => mergeDiagnostics(current, {
        failures: [
          ...(current.failures || []),
          { fileName: "CRC validation", relativePath: "CRC validation", error: err instanceof Error ? err.message : "CRC validation failed" },
        ],
        failed: (current.failures || []).length + 1,
        crc: {
          ...current.crc,
          validating: false,
        },
      }));
    }
  }

  async function parseFiles(inputEntries) {
    const startedAt = performance.now();
    const runId = importRunRef.current + 1;
    importRunRef.current = runId;
    const entries = inputEntries[0]?.file ? inputEntries : fileEntriesFromList(inputEntries);
    const relevantEntries = entries.filter((entry) => /\.(edf|crc)$/i.test(entry.name));
    const skippedEntries = entries.filter((entry) => !/\.(edf|crc)$/i.test(entry.name));
    const edfEntries = relevantEntries.filter((entry) => /\.edf$/i.test(entry.name));
    const sourceByPath = new Map(edfEntries.map((entry) => [entry.relativePath, entry.file]));
    const crcEntries = relevantEntries.filter((entry) => /\.crc$/i.test(entry.name));
    const crcByPath = new Map(crcEntries.map((entry) => [entry.relativePath, entry]));
    const { cached, missing } = await getCachedSummaries(edfEntries);
    setCacheStats({ hits: cached.size, misses: missing.length });
    let parsedFiles = [...cached.values()];
    let failures = [];
    setProgress({ done: cached.size, total: edfEntries.length, fileName: cached.size ? "cache" : "" });

    if (missing.length) {
      const workerEntries = [...missing, ...crcEntries];
      const parsedMissing = await requestWorkerFiles("parseFiles", workerEntries, "scan", {
        signal: parseAbortRef.current?.signal,
        onProgress: (event) => {
          setProgress({
            done: cached.size + event.done,
            total: edfEntries.length,
            fileName: event.fileName,
          });
        },
      });
      if (parsedMissing) {
        parsedFiles = [...parsedFiles, ...parsedMissing.files];
        failures = [...failures, ...parsedMissing.failures];
        await putCachedSummaries(missing, parsedMissing.files);
      } else {
        for (let index = 0; index < missing.length; index += 1) {
          if (parseAbortRef.current?.signal.aborted) throw new Error("Parsing cancelled");
          try {
            parsedFiles.push(await parseEdfFile({ ...missing[index], options: { skipCrc: true } }, "scan"));
          } catch (err) {
            failures.push({
              fileName: missing[index].name,
              relativePath: missing[index].relativePath,
              error: err instanceof Error ? err.message : "Failed to parse EDF file",
            });
          }
          setProgress({ done: cached.size + index + 1, total: edfEntries.length, fileName: missing[index].relativePath });
        }
      }
    }

    parsedFiles = sortParsedFiles(withSidecarState(parsedFiles, sourceByPath, crcByPath));
    const baseDiagnostics = {
      totalInput: entries.length,
      supportedInput: relevantEntries.length,
      skipped: skippedEntries.length,
      skippedFiles: skippedEntries.slice(0, 20).map((entry) => entry.relativePath),
      edf: edfEntries.length,
      crcFiles: crcEntries.length,
      parsed: parsedFiles.length,
      failed: failures.length,
      failures,
      cacheHits: cached.size,
      cacheMisses: missing.length,
      parseMs: performance.now() - startedAt,
      crc: {
        ...crcDiagnostics(parsedFiles),
        validating: parsedFiles.length > 0,
      },
    };
    setDiagnostics(baseDiagnostics);
    if (!parsedFiles.length) {
      throw new Error(failures.length ? `No EDF files could be parsed (${failures.length} failed).` : "No EDF files were parsed.");
    }
    setParsed(parsedFiles);
    validateCrcInBackground(runId, edfEntries, crcEntries);
  }

  async function handleLoad(entries) {
    setError("");
    setDiagnostics(EMPTY_DIAGNOSTICS);
    if (!entries.length || !entries.some((entry) => /\.edf$/i.test(entry.name))) {
      setError("No EDF files were selected.");
      return;
    }
    setLoading(true);
    setProgress(null);
    parseAbortRef.current = new AbortController();
    try {
      await parseFiles(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse the selected EDF files.");
    } finally {
      parseAbortRef.current = null;
      setProgress(null);
      setLoading(false);
    }
  }

  function handleCancel() {
    parseAbortRef.current?.abort();
  }

  function handleReset() {
    importRunRef.current += 1;
    setParsed([]);
    setDiagnostics(EMPTY_DIAGNOSTICS);
    setError("");
  }

  async function handleClearCache() {
    await clearParseCache();
    setCacheStats({ hits: 0, misses: 0 });
  }

  async function handleLoadSample() {
    setError("");
    setDiagnostics(EMPTY_DIAGNOSTICS);
    setLoading(true);
    setProgress(null);
    parseAbortRef.current = new AbortController();
    try {
      const entries = await Promise.all(
        SAMPLE_EDF_PATHS.map(async (samplePath) => {
          const response = await fetch(samplePath);
          if (!response.ok) throw new Error(`Could not load ${samplePath}`);
          const buffer = await response.arrayBuffer();
          const file = new File([buffer], samplePath.split("/").pop(), { type: "application/octet-stream" });
          return {
            file,
            name: file.name,
            relativePath: samplePath.replace(/^\/sample-data\//, ""),
          };
        })
      );
      await parseFiles(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the bundled sample EDF files.");
    } finally {
      parseAbortRef.current = null;
      setProgress(null);
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <style>{styles}</style>
      {parsed.length ? (
        <Dashboard parsed={parsed} diagnostics={diagnostics} onReset={handleReset} />
      ) : (
        <UploadPanel
          onLoad={handleLoad}
          onLoadSample={handleLoadSample}
          onCancel={handleCancel}
          onClearCache={handleClearCache}
          error={error}
          loading={loading}
          progress={progress}
          cacheStats={cacheStats}
        />
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

.cache-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
  color: ${COLORS.faint};
  font-size: 12px;
  flex-wrap: wrap;
}

.progress-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
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

.screen > .panel {
  margin-top: 14px;
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}

.summary-lead {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  background: rgba(78, 205, 196, 0.08);
  border: 1px solid rgba(78, 205, 196, 0.22);
  border-radius: 8px;
  color: ${COLORS.text};
  line-height: 1.45;
}

.summary-lead svg {
  flex: 0 0 auto;
  color: ${COLORS.teal};
  margin-top: 1px;
}

.summary-columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.summary-columns div {
  min-width: 0;
  padding: 12px;
  background: rgba(23, 32, 55, 0.74);
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
}

.summary-columns h3 {
  margin: 0 0 8px;
  font-size: 12px;
  color: ${COLORS.muted};
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.summary-columns p {
  color: ${COLORS.muted};
  font-size: 12px;
  line-height: 1.45;
}

.summary-columns p + p {
  margin-top: 6px;
}

.chart-controls {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(18, 26, 46, 0.92);
  border: 1px solid ${COLORS.border};
  border-radius: 10px;
  flex-wrap: wrap;
}

.range-readout,
.chart-control-buttons,
.report-actions,
.report-checks {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.range-readout {
  color: ${COLORS.muted};
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
}

.range-readout svg {
  color: ${COLORS.teal};
}

.icon-button {
  width: 34px;
  height: 34px;
  display: inline-grid;
  place-items: center;
  border: 1px solid ${COLORS.border2};
  border-radius: 8px;
  background: transparent;
  color: ${COLORS.text};
  cursor: pointer;
}

.icon-button:hover,
.secondary-button:hover,
.reset-button:hover {
  border-color: ${COLORS.teal};
}

.report-checks {
  align-items: stretch;
}

.report-checks label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 9px;
  background: rgba(23, 32, 55, 0.74);
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  color: ${COLORS.muted};
  font-size: 12px;
}

.report-checks input {
  accent-color: ${COLORS.teal};
}

.report-actions {
  margin: 10px 0;
}

.compliance-grid {
  margin-top: 8px;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.diagnostics-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.overview-grid div {
  padding: 12px;
  background: ${COLORS.panel2};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
}

.diagnostics-grid div {
  padding: 11px;
  background: ${COLORS.panel2};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
}

.overview-grid span,
.diagnostics-grid span,
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

.diagnostics-grid strong {
  display: block;
  margin-top: 5px;
  color: ${COLORS.text};
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 16px;
  overflow-wrap: anywhere;
}

.failure-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.failure-list div {
  display: grid;
  gap: 3px;
  padding: 10px;
  background: rgba(255, 119, 105, 0.08);
  border: 1px solid rgba(255, 119, 105, 0.24);
  border-radius: 8px;
}

.failure-list strong {
  color: ${COLORS.text};
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
}

.failure-list span,
.failure-list p {
  margin: 0;
  color: ${COLORS.muted};
  font-size: 12px;
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

.session-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.session-chips button {
  display: grid;
  gap: 3px;
  min-width: 132px;
  padding: 9px 11px;
  text-align: left;
  color: ${COLORS.text};
  background: ${COLORS.panel2};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  cursor: pointer;
}

.session-chips button.is-active {
  border-color: ${COLORS.teal};
  box-shadow: inset 0 0 0 1px rgba(78, 205, 196, 0.28);
}

.session-chips strong {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 13px;
}

.session-chips span {
  color: ${COLORS.muted};
  font-size: 11px;
}

.preferences-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.preferences-grid label {
  display: grid;
  gap: 6px;
  color: ${COLORS.muted};
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.preferences-grid select {
  height: 36px;
  padding: 0 10px;
  color: ${COLORS.text};
  background: #0d1425;
  border: 1px solid ${COLORS.border2};
  border-radius: 8px;
  font: 13px Inter, sans-serif;
}

.export-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin: -2px 0 10px;
}

.export-actions .secondary-button {
  height: 30px;
  padding: 0 10px;
  font-size: 11px;
}

.inline-action {
  height: 32px;
  margin-left: 4px;
  padding: 0 10px;
  font-size: 12px;
}

.mask-timeline {
  display: grid;
  gap: 7px;
  margin: 8px 0 12px;
  padding: 11px;
  background: ${COLORS.panel2};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  max-height: 210px;
  overflow: auto;
}

.mask-row {
  display: grid;
  grid-template-columns: 88px minmax(220px, 1fr);
  align-items: center;
  gap: 10px;
}

.mask-row span {
  color: ${COLORS.muted};
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
}

.mask-track {
  position: relative;
  height: 12px;
  background: #0d1425;
  border: 1px solid ${COLORS.border};
  border-radius: 999px;
  overflow: hidden;
}

.mask-track i {
  position: absolute;
  top: 0;
  bottom: 0;
  display: block;
  background: ${COLORS.teal};
  border-radius: 999px;
}

.canvas-wrap {
  width: 100%;
  min-height: 240px;
  overflow: hidden;
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  background: #0d1425;
}

.canvas-wrap canvas {
  display: block;
}

.event-waveform {
  margin-top: 10px;
}

.event-counts div,
.signal-health div {
  min-width: 0;
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
  overflow-wrap: anywhere;
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
  flex-wrap: wrap;
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

tr.selected-row td {
  background: rgba(78, 205, 196, 0.08);
  color: ${COLORS.text};
}

tbody tr {
  cursor: default;
}

.event-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.event-detail-head strong,
.event-detail-head span {
  display: block;
}

.event-detail-head strong {
  color: ${COLORS.text};
  font-size: 13px;
}

.event-detail-head span {
  margin-top: 3px;
  color: ${COLORS.muted};
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
}

@media (max-width: 980px) {
  .stats-grid,
  .content-grid,
  .summary-columns {
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
  .diagnostics-grid,
  .summary-columns,
  .night-picker,
  .mask-row,
  .preferences-grid {
    grid-template-columns: 1fr;
  }

  .upload-actions {
    flex-direction: column;
  }
}
`;
