import { buildCrcSidecars, crcPathForEdf, parseEdfEntry } from "./edfParser.js";

const cancelled = new Set();

async function parseEntries(id, entries, mode, type) {
  const sidecars = await buildCrcSidecars(entries);
  const edfEntries = entries.filter((entry) => /\.edf$/i.test(entry.name));
  const files = [];

  for (let index = 0; index < edfEntries.length; index += 1) {
    if (cancelled.has(id)) {
      cancelled.delete(id);
      self.postMessage({ id, ok: false, cancelled: true, error: "Parsing cancelled" });
      return;
    }

    const entry = edfEntries[index];
    files.push(await parseEdfEntry(entry, mode, sidecars.get(crcPathForEdf(entry.relativePath))));
    self.postMessage({
      id,
      progress: true,
      type,
      done: index + 1,
      total: edfEntries.length,
      fileName: entry.relativePath,
    });
  }

  self.postMessage({ id, ok: true, files });
}

self.onmessage = async (event) => {
  const { id, type, entries = [], mode = "summary" } = event.data || {};
  try {
    if (type === "cancel") {
      cancelled.add(id);
      return;
    }
    if (type === "parseFiles" || type === "hydrateFiles") {
      await parseEntries(id, entries, mode, type);
      return;
    }
    self.postMessage({ id, ok: false, error: `Unknown worker request: ${type}` });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : "EDF worker failed" });
  }
};
