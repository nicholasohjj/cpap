import { parseEdfEntriesSafely, validateCrcEntriesSafely } from "./edfParser.js";

const cancelled = new Set();

function shouldCancel(id) {
  return cancelled.has(id);
}

function progressFor(id, type) {
  return (progress) => {
    self.postMessage({
      id,
      progress: true,
      type,
      ...progress,
    });
  };
}

async function parseEntries(id, entries, mode, type) {
  try {
    const result = await parseEdfEntriesSafely(entries, mode, {
      skipCrc: mode === "scan" || type === "hydrateFiles",
      shouldCancel: () => shouldCancel(id),
      onProgress: progressFor(id, type),
    });
    cancelled.delete(id);
    self.postMessage({ id, ok: true, ...result });
  } catch (err) {
    const wasCancelled = shouldCancel(id);
    cancelled.delete(id);
    self.postMessage({
      id,
      ok: false,
      cancelled: wasCancelled,
      error: err instanceof Error ? err.message : "EDF worker failed",
    });
  }
}

async function validateEntries(id, entries, type) {
  try {
    const result = await validateCrcEntriesSafely(entries, {
      shouldCancel: () => shouldCancel(id),
      onProgress: progressFor(id, type),
    });
    cancelled.delete(id);
    self.postMessage({ id, ok: true, ...result });
  } catch (err) {
    const wasCancelled = shouldCancel(id);
    cancelled.delete(id);
    self.postMessage({
      id,
      ok: false,
      cancelled: wasCancelled,
      error: err instanceof Error ? err.message : "EDF worker failed",
    });
  }
}

self.onmessage = async (event) => {
  const { id, type, entries = [], mode = "scan" } = event.data || {};
  if (type === "cancel") {
    cancelled.add(id);
    return;
  }
  if (type === "parseFiles" || type === "hydrateFiles") {
    await parseEntries(id, entries, mode, type);
    return;
  }
  if (type === "validateCrc") {
    await validateEntries(id, entries, type);
    return;
  }
  self.postMessage({ id, ok: false, error: `Unknown worker request: ${type}` });
};
