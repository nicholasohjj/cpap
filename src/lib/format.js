import { civilClockLabel, civilDateLabel, epochMsToCivil } from "../edfParser.js";

export function isoDate(date) {
  if (!date) return "";
  if (date.year) return civilDateLabel(date);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function civilToSortMs(value) {
  if (!value) return 0;
  if (Number.isFinite(value)) return value;
  if (value.year) return Date.UTC(value.year, value.month - 1, value.day, value.hour || 0, value.minute || 0, value.second || 0);
  return value.getTime?.() || 0;
}

export function timeLabel(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function durationLabel(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function compact(value, digits = 1) {
  const rounded = round(value, digits);
  return rounded === null ? "--" : String(rounded);
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function leakUnitLabel(prefs) {
  return prefs.leakUnit === "lps" ? "L/s" : "L/min";
}

export function leakFromLps(value, prefs) {
  if (!Number.isFinite(value)) return null;
  return prefs.leakUnit === "lps" ? value : value * 60;
}

export function leakFromLmin(value, prefs) {
  if (!Number.isFinite(value)) return null;
  return prefs.leakUnit === "lps" ? value / 60 : value;
}

export function mean(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function percentile(values, p) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const index = ((valid.length - 1) * p) / 100;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return valid[lo];
  return valid[lo] * (hi - index) + valid[hi] * (index - lo);
}

export function minMax(values) {
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

export function inferStep(series) {
  if (!series || series.length < 2) return 1;
  return Math.max(0.001, series[1].t - series[0].t);
}

// First index whose `key` is >= target; series must be sorted by that key.
export function lowerBound(series, target, key = "t") {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][key] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Series may be stitched from several files with gaps, so search by time rather than index math.
export function nearestAt(series, seconds, maxDistance = Math.max(2, inferStep(series) * 2)) {
  if (!series?.length || !Number.isFinite(seconds)) return null;
  const index = lowerBound(series, seconds);
  const candidates = [series[index - 1], series[index]].filter(Boolean);
  const nearest = candidates.reduce((best, point) => (
    !best || Math.abs(point.t - seconds) < Math.abs(best.t - seconds) ? point : best
  ), null);
  if (!nearest || Math.abs(nearest.t - seconds) > maxDistance) return null;
  return Number.isFinite(nearest.value) ? nearest.value : null;
}

export function sliceByTime(series, start, end, key = "t") {
  if (!series?.length) return [];
  return series.slice(lowerBound(series, start, key), lowerBound(series, end + 1e-9, key));
}

// Min/max per bucket keeps breath amplitude visible where averaging would flatten the waveform.
export function envelopeSeries(series, maxBuckets = 1200) {
  const clean = (series || []).filter((point) => Number.isFinite(point.value));
  const toPoint = (point) => ({ time: point.t, label: timeLabel(point.t), value: round(point.value, 3) });
  if (clean.length <= maxBuckets * 2) return clean.map(toPoint);
  const bucketSize = Math.ceil(clean.length / maxBuckets);
  const output = [];
  for (let i = 0; i < clean.length; i += bucketSize) {
    let lo = clean[i];
    let hi = clean[i];
    for (let j = i + 1; j < Math.min(clean.length, i + bucketSize); j += 1) {
      if (clean[j].value < lo.value) lo = clean[j];
      if (clean[j].value > hi.value) hi = clean[j];
    }
    if (lo === hi) output.push(toPoint(lo));
    else if (lo.t < hi.t) output.push(toPoint(lo), toPoint(hi));
    else output.push(toPoint(hi), toPoint(lo));
  }
  return output;
}

export function sampleEvery(series, every = 1) {
  if (!series?.length) return [];
  return series
    .filter((_, index) => index % every === 0)
    .filter((point) => Number.isFinite(point.value))
    .map((point) => ({ time: point.t, label: timeLabel(point.t), value: round(point.value, 3) }));
}

export function clockLabel(date) {
  if (!date) return "--:--";
  if (Number.isFinite(date)) return civilClockLabel(epochMsToCivil(date));
  if (date.year) return civilClockLabel(date);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function minuteOfDayLabel(minutes) {
  if (!Number.isFinite(minutes)) return "--:--";
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const NOON_MINUTES = 12 * 60;
const NOON_MS = NOON_MINUTES * 60 * 1000;

// ResMed STR MaskOn/MaskOff values are minutes since noon of the STR record date.
export function maskWindowLabel(window) {
  return `${minuteOfDayLabel(window.on + NOON_MINUTES)}-${minuteOfDayLabel(window.off + NOON_MINUTES)}`;
}

export function maskWindowSummary(windows) {
  if (!windows?.length) return "--";
  return windows.map(maskWindowLabel).join(", ");
}

// ResMed (and OSCAR) assign anything before noon to the previous day's night.
export function therapyDayFor(ms) {
  if (!Number.isFinite(ms) || !ms) return "";
  return isoDate(new Date(ms - NOON_MS));
}

export function minutesSinceTherapyNoon(ms) {
  const day = therapyDayFor(ms);
  if (!day) return null;
  return (ms - (Date.parse(`${day}T00:00:00Z`) + NOON_MS)) / 60000;
}
