import { civilClockLabel, epochMsToCivil } from "../edfParser.js";
import {
  COMPLIANCE_MINUTES,
  EVENT_CLUSTER_GAP_SECONDS,
  EVENT_CLUSTER_MIN_EVENTS,
  KNOWN_TYPES,
  LEAK_REVIEW_L_MIN,
} from "./constants.js";
import {
  civilToSortMs,
  clockLabel,
  compact,
  downsampleSeries,
  durationLabel,
  isoDate,
  leakFromLmin,
  leakUnitLabel,
  mean,
  minMax,
  minuteOfDayLabel,
  nearestAt,
  percentile,
  sampleEvery,
  timeLabel,
} from "./format.js";

export function groupByType(files) {
  const grouped = {};
  KNOWN_TYPES.forEach((type) => {
    grouped[type] = files.filter((file) => file.header.type === type);
  });
  grouped.EDF = files.filter((file) => !KNOWN_TYPES.includes(file.header.type));
  return grouped;
}

export function fileStartMs(file) {
  return file.header.startedAtMs || file.header.startedAt?.getTime() || 0;
}

export function fileDurationMs(file) {
  const recordSpan = file.header.recordCount * file.header.recordDuration;
  const annotationEnd = file.annotations?.length
    ? Math.max(...file.annotations.map((event) => event.onset + event.duration))
    : 0;
  return Math.max(recordSpan, annotationEnd) * 1000;
}

export function relativeStart(file, groupStartMs) {
  const startMs = fileStartMs(file);
  if (!startMs || !Number.isFinite(groupStartMs)) return 0;
  return Math.max(0, (startMs - groupStartMs) / 1000);
}

export function combinedSignal(files, type, label, groupStartMs) {
  return files
    .filter((file) => file.header.type === type && file.signals?.[label]?.length)
    .sort((a, b) => fileStartMs(a) - fileStartMs(b))
    .flatMap((file) => {
      const offset = relativeStart(file, groupStartMs);
      return file.signals[label].map((point) => ({ ...point, t: point.t + offset }));
    })
    .sort((a, b) => a.t - b.t);
}

export function fileEndSeconds(file, groupStartMs) {
  const recordSpan = file.header.recordCount * file.header.recordDuration;
  const annotationEnd = file.annotations?.length
    ? Math.max(...file.annotations.map((event) => event.onset + event.duration))
    : 0;
  return relativeStart(file, groupStartMs) + Math.max(recordSpan, annotationEnd);
}

export function isRespiratoryEvent(event) {
  return /(apnea|hypopnea|rera|flow limitation)/i.test(event.label || "");
}

export function eventBucket(label) {
  if (/central/i.test(label)) return "Central";
  if (/obstructive/i.test(label)) return "Obstructive";
  if (/hypopnea/i.test(label)) return "Hypopnea";
  if (/rera/i.test(label)) return "RERA";
  if (/flow limitation/i.test(label)) return "Flow limitation";
  if (/apnea/i.test(label)) return "Apnea";
  return label || "Event";
}

export function eventTypeSummary(events) {
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

export function buildEventClusters(events) {
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

export function buildSession(files) {
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

export function mergeSeries(base, additions) {
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

export function buildOverviewRows(files) {
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

export function crcOverview(files) {
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

export function crcDiagnostics(files) {
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

export function crcDiagnosticsFromResults(results, totalFiles) {
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

export function mergeCrcResults(files, results) {
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

export function mergeDiagnostics(base, updates) {
  return {
    ...base,
    ...updates,
    crc: {
      ...base.crc,
      ...(updates.crc || {}),
    },
  };
}

export function crcStatusLabel(row) {
  const internal = row.crc.internal;
  if (!internal?.checked && /pending/i.test(internal?.reason || "")) return "CRC pending";
  if (!internal?.checked) return "not checked";
  if (/pending/i.test(internal.reason || "")) return "CRC pending";
  const recordStatus = internal.bad ? `${internal.bad}/${internal.total} bad` : `${internal.total}/${internal.total} ok`;
  const sidecarStatus = row.crc.sidecar?.present ? "sidecar" : "no sidecar";
  return `${recordStatus}, ${sidecarStatus}`;
}

export function signalRecordValue(file, label, recordIndex) {
  const signal = file?.signals?.[label];
  if (!signal?.length) return null;
  const samplesPerRecord = file.header.samplesPerRecord[file.header.labels.indexOf(label)] || 1;
  const point = signal[recordIndex * samplesPerRecord];
  return Number.isFinite(point?.value) ? point.value : null;
}

export function signalRecordSamples(file, label, recordIndex) {
  const signal = file?.signals?.[label];
  const signalIndex = file?.header.labels.indexOf(label) ?? -1;
  if (!signal?.length || signalIndex < 0) return [];
  const samplesPerRecord = file.header.samplesPerRecord[signalIndex] || 1;
  const start = recordIndex * samplesPerRecord;
  return signal.slice(start, start + samplesPerRecord).map((point) => point.value);
}

export function dateFromUnixDay(dayValue) {
  if (!Number.isFinite(dayValue)) return null;
  const rounded = Math.round(dayValue);
  if (rounded < 0 || rounded > 30000) return null;
  return new Date(rounded * 86400000);
}

export function buildDailyRows(files) {
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

export function recentDailyRows(rows, count = 30) {
  return rows
    .filter((row) => row.date)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-count);
}

export function buildComplianceReport(rows) {
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

export function valueOrFallback(primary, fallback) {
  return Number.isFinite(primary) ? primary : fallback;
}

export function buildSleepSummary(session, dailyRows, prefs) {
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

export function datalogGroupKey(file) {
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

export function findMaskWindowForCluster(cluster, dailyRows) {
  if (!cluster.startMs) return null;
  const start = new Date(cluster.startMs);
  const date = isoDate(start);
  const minute = start.getUTCHours() * 60 + start.getUTCMinutes();
  const row = dailyRows.find((item) => item.date === date);
  const window = row?.maskWindows?.find((item) => minute >= item.on && minute <= item.off);
  return window ? `${minuteOfDayLabel(window.on)}-${minuteOfDayLabel(window.rawOff)}` : null;
}

export function buildSessionClusters(groupId, files, dailyRows = []) {
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

export function buildTherapyGroups(files, dailyRows = []) {
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

export function statusForSignal(series) {
  if (!series?.length) return "missing";
  const valid = series.filter((point) => Number.isFinite(point.value));
  if (!valid.length) return "no valid samples";
  return `${valid.length.toLocaleString()} samples`;
}
