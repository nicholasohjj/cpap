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
import {
  buildCompliancePdfSections,
  buildDoctorReportSections,
  clusterRowsForExport,
  complianceRowsForExport,
  downloadPdfFromSections,
  downloadText,
  openPrintableReport,
  reportDateSlug,
  toCsv,
} from "./lib/export.js";
import {
  clamp,
  compact,
  durationLabel,
  envelopeSeries,
  leakFromLmin,
  leakFromLps,
  leakUnitLabel,
  maskWindowLabel,
  maskWindowSummary,
  mean,
  round,
  sliceByTime,
  timeLabel,
} from "./lib/format.js";
import {
  clearParseCache,
  fileEntriesFromDataTransfer,
  fileEntriesFromList,
  getCachedSummaries,
  hydrateSignalFiles,
  parseEdfFile,
  putCachedSummaries,
  requestWorkerFiles,
} from "./lib/parseCache.js";
import {
  buildComplianceReport,
  buildDailyRows,
  buildOverviewRows,
  buildSession,
  buildSleepSummary,
  buildTherapyGroups,
  crcDiagnostics,
  crcDiagnosticsFromResults,
  crcOverview,
  crcStatusLabel,
  fileStartMs,
  mergeCrcResults,
  mergeDiagnostics,
  mergeSeries,
  statusForSignal,
} from "./lib/session.js";

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

function UploadPanel({ onLoad, onLoadSample, onCancel, onClearCache, error, loading, progress, cacheStats }) {
  const [dragging, setDragging] = useState(false);

  async function handleInputChange(event) {
    const entries = fileEntriesFromList(event.target.files || []);
    // Clear the input so choosing the same folder again still fires onChange.
    event.target.value = "";
    if (entries.length) await onLoad(entries);
  }

  return (
    <main className="screen upload-screen">
      <div
        className={`dropzone ${dragging ? "is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!loading) setDragging(true);
        }}
        onDragLeave={(event) => {
          // Moving between child elements fires dragleave on the parent; ignore those.
          if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (loading) return;
          // Entries must be read synchronously inside the drop handler.
          fileEntriesFromDataTransfer(event.dataTransfer).then(onLoad);
        }}
      >
        <Moon className="brand-icon" size={30} />
        <h1>CPAP EDF dashboard</h1>
        <p>
          Drop or choose a ResMed SD card / DATALOG folder, or individual EDF files. The parser reads headers, EDF+
          annotations, 40 ms breath data, 2 s therapy metrics, oximetry, and daily STR summary files.
        </p>
        <div className="upload-actions">
          <label className={`primary-button ${loading ? "is-disabled" : ""}`}>
            <FolderOpen size={16} />
            Choose folder
            <input
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              disabled={loading}
              onChange={handleInputChange}
            />
          </label>
          <label className={`secondary-button ${loading ? "is-disabled" : ""}`}>
            <Upload size={16} />
            Choose EDF files
            <input
              type="file"
              accept=".edf,.crc"
              multiple
              disabled={loading}
              onChange={handleInputChange}
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
      <div className="tooltip-label">{Number.isFinite(label) ? timeLabel(label) : label}</div>
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

// Recharts locates axes by element type, so this must be spread onto <XAxis> rather than wrap it.
function timeAxisProps(range, minTickGap = 36) {
  return {
    dataKey: "time",
    type: "number",
    scale: "linear",
    domain: range ? [range.start, range.end] : ["dataMin", "dataMax"],
    allowDataOverflow: true,
    minTickGap,
    tickFormatter: timeLabel,
    tick: { fill: COLORS.faint, fontSize: 11 },
    axisLine: { stroke: COLORS.border },
    tickLine: false,
  };
}

function eventColor(label) {
  if (/central/i.test(label)) return COLORS.amber;
  if (/obstructive/i.test(label)) return COLORS.coral;
  return COLORS.blue;
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
        <XAxis {...timeAxisProps(range)} />
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
          <ReferenceLine x={crosshairTime} yAxisId="left" stroke={COLORS.text} strokeOpacity={0.28} />
        ) : null}
        {clusters.map((cluster) => (
          <ReferenceArea
            key={`cluster-${cluster.id}`}
            x1={Math.max(cluster.start, range.start)}
            x2={Math.min(cluster.end, range.end)}
            yAxisId="left"
            fill={COLORS.amber}
            fillOpacity={0.08}
          />
        ))}
        {gaps.map((gap, index) => (
          <ReferenceArea
            key={`gap-${index}`}
            x1={Math.max(gap.start, range.start)}
            x2={Math.min(gap.end, range.end)}
            fill={COLORS.coral}
            fillOpacity={0.08}
            yAxisId="left"
          />
        ))}
        {segments.map((segment, index) => (
          <ReferenceLine
            key={`segment-${segment.type}-${index}`}
            x={segment.start}
            yAxisId="left"
            stroke={COLORS.faint}
            strokeDasharray="3 4"
            strokeOpacity={0.55}
          />
        ))}
        {eventMarkers.map((event, index) => (
          <ReferenceLine
            key={`event-${event.onset}-${index}`}
            x={event.onset}
            yAxisId="left"
            stroke={eventColor(event.label)}
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
  const data = useMemo(() => {
    const raw = session.rawSeries?.flow || [];
    // Re-sample from the raw 25 Hz signal so zooming in reveals individual breaths.
    const points = raw.length && range
      ? envelopeSeries(sliceByTime(raw, range.start, range.end), 1500)
      : filterChartData(session.series.flow, range);
    return points.map((point) => ({ ...point, flow: point.value }));
  }, [session, range]);
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
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => setContainerWidth(Math.floor(entry.contentRect.width)));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data.length) return;
    const parent = canvas.parentElement;
    const width = containerWidth || parent?.clientWidth || 800;
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

    let min = Infinity;
    let max = -Infinity;
    data.forEach((point) => {
      if (!Number.isFinite(point.flow)) return;
      if (point.flow < min) min = point.flow;
      if (point.flow > max) max = point.flow;
    });
    if (!Number.isFinite(min)) {
      min = -1;
      max = 1;
    }
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
    let penDown = false;
    data.forEach((point) => {
      // Break the line at invalid samples instead of drawing to NaN.
      if (!Number.isFinite(point.flow)) {
        penDown = false;
        return;
      }
      const x = xForTime(point.time);
      const y = yFor(point.flow);
      if (penDown) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      penDown = true;
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
    ctx.fillText(timeLabel(domainStart), leftPad, height - 8);
    ctx.textAlign = "right";
    ctx.fillText(timeLabel(domainEnd), width - rightPad, height - 8);
  }, [data, range, crosshairTime, containerWidth]);

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
        <XAxis {...timeAxisProps(range, 38)} />
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
          <ReferenceLine x={crosshairTime} yAxisId="left" stroke={COLORS.text} strokeOpacity={0.28} />
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
  const rawFlow = sliceByTime(session.rawSeries?.flow || [], start, end);
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
        <ComposedChart data={chartData} margin={{ top: 8, right: 28, left: -8, bottom: 0 }}>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis {...timeAxisProps(focusRange, 34)} />
          <YAxis tick={{ fill: COLORS.faint, fontSize: 11 }} axisLine={false} tickLine={false} width={38} />
          <Tooltip content={<ChartTooltip />} />
          <ReferenceLine x={event.onset} stroke={COLORS.amber} strokeDasharray="4 3" />
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

function EventsChart({ session, prefs, range, crosshairTime, onCrosshair }) {
  const data = session.events.filter((event) => timeInRange(event.onset, range)).map((event) => ({
    ...event,
    y: 1,
    color: eventColor(event.label),
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
                <div>Leak: {compact(leakFromLps(event.leak, prefs), 1)} {leakUnitLabel(prefs)}</div>
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
    [`leak_${leakUnitLabel(prefs).replace("/", "_")}`]: round(leakFromLps(event.leak, prefs), 2),
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
          { key: "leak", header: "Leak", render: (event) => `${compact(leakFromLps(event.leak, prefs), 1)} ${leakUnitLabel(prefs)}` },
        ]}
      />
    </>
  );
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

function MaskTimeline({ rows }) {
  const visibleRows = rows.filter((row) => row.maskWindows?.length);
  if (!visibleRows.length) return null;
  return (
    <div className="mask-timeline">
      <div className="mask-row mask-scale" aria-hidden="true">
        <span />
        <div>
          <span>12:00</span>
          <span>18:00</span>
          <span>00:00</span>
          <span>06:00</span>
          <span>12:00</span>
        </div>
      </div>
      {visibleRows.map((row) => (
        <div className="mask-row" key={row.date}>
          <span>{row.date}</span>
          <div className="mask-track">
            {row.maskWindows.map((window, index) => (
              <i
                key={`${row.date}-${index}`}
                title={`${row.date} night ${maskWindowLabel(window)}`}
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
          {failures.slice(0, 6).map((failure, index) => (
            <div key={`${failure.relativePath}-${index}`}>
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

// Combine two hydration passes (detail + flow) that may finish in either order.
function mergeHydratedFiles(current, next) {
  if (!current.length) return next;
  const byPath = new Map(current.map((file) => [file.relativePath, file]));
  return next.map((file) => {
    const previous = byPath.get(file.relativePath);
    if (!previous) return file;
    return {
      ...file,
      signals: { ...previous.signals, ...file.signals },
      signalsLoaded: previous.signalsLoaded || file.signalsLoaded,
      flowLoaded: previous.flowLoaded || file.flowLoaded,
    };
  });
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
  const hydrationKeyRef = useRef("");
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
  // Background CRC results replace `parsed` with new objects; key hydration on identity, not reference.
  const hydrationKey = selectedSession
    ? `${selectedSession.id}|${selectedSession.files.map((file) => file.relativePath).join(",")}`
    : "";
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
    hydrationKeyRef.current = hydrationKey;
    setDetailFiles([]);
    setSelectedEvent(null);
    setFlowLoading(false);
    if (!selectedSession) return undefined;
    let cancelled = false;
    setDetailLoading(true);
    hydrateSignalFiles(selectedSession.files, "detail")
      .then((hydrated) => {
        if (!cancelled) setDetailFiles((current) => mergeHydratedFiles(current, hydrated));
      })
      .catch((err) => console.error("Failed to load session detail signals", err))
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // selectedSession is captured through hydrationKey; depending on it directly re-hydrates on CRC updates.
  }, [hydrationKey]);

  async function handleLoadFlow() {
    if (!selectedSession) return;
    const key = hydrationKey;
    setFlowLoading(true);
    try {
      const hydrated = await hydrateSignalFiles(selectedSession.files, "flow");
      if (hydrationKeyRef.current === key) setDetailFiles((current) => mergeHydratedFiles(current, hydrated));
    } catch (err) {
      console.error("Failed to load BRP flow", err);
    } finally {
      if (hydrationKeyRef.current === key) setFlowLoading(false);
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
            prefs={prefs}
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
        <Panel title="Event focus" note={`±${EVENT_FOCUS_PAD_SECONDS} seconds where available`}>
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
          {session.grouped.SAD.length && !session.series.spo2.length ? (
            <div className="note-box">
              <ListChecks size={16} />
              The SAD file contains only invalid oximetry placeholders (no oximeter was attached), so
              SpO2 and pulse show as unavailable.
            </div>
          ) : null}
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

.secondary-button:disabled,
.is-disabled {
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

.mask-scale > div {
  display: flex;
  justify-content: space-between;
}

.mask-scale > div span {
  color: ${COLORS.faint};
  font-size: 10px;
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
