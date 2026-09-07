import { parseEdfEntry } from "../edfParser.js";
import { PARSE_CACHE_VERSION } from "./constants.js";

let workerRequestId = 0;
let edfWorker = null;

export function getEdfWorker() {
  if (typeof Worker === "undefined") return null;
  if (!edfWorker) {
    edfWorker = new Worker(new URL("../edfWorker.js", import.meta.url), { type: "module" });
  }
  return edfWorker;
}

export function requestWorkerFiles(type, entries, mode, options = {}) {
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

export function toFileEntry(file) {
  return {
    file,
    name: file.name,
    relativePath: file.webkitRelativePath || file.relativePath || file.name,
  };
}

export function fileEntriesFromList(fileList) {
  return [...fileList]
    .map(toFileEntry);
}

export function cacheKey(entry) {
  return `${PARSE_CACHE_VERSION}|${entry.relativePath}|${entry.file.size || 0}|${entry.file.lastModified || 0}`;
}

export function openParseCache() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open("cpap-edf-cache", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("summary");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function getCachedSummaries(entries) {
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

export async function putCachedSummaries(entries, files) {
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

export async function clearParseCache() {
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

export async function parseEdfFile(input, mode = "summary") {
  const file = input.file || input;
  const relativePath = input.relativePath || file.webkitRelativePath || file.name;
  const parsed = await parseEdfEntry({ file, name: file.name || relativePath, relativePath }, mode, input.crcSidecar, input.options || {});
  return {
    ...parsed,
    sourceFile: file,
  };
}

export async function hydrateSignals(fileRecord, mode = "detail") {
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

export async function hydrateSignalFiles(files, mode = "detail") {
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
