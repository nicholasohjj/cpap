import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseEdfEntriesSafely, validateCrcEntriesSafely } from "../src/edfParser.js";

const root = process.argv[2] || "20260712";

async function walk(dir) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...await walk(full));
    else if (/\.(edf|crc)$/i.test(item.name)) out.push(full);
  }
  return out;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function entryFor(file) {
  const info = await stat(file);
  return {
    name: path.basename(file),
    relativePath: path.relative(root, file),
    file: {
      size: info.size,
      lastModified: info.mtimeMs,
      arrayBuffer: async () => toArrayBuffer(await readFile(file)),
    },
  };
}

const files = await walk(root);
const entries = await Promise.all(files.sort().map(entryFor));
const edfs = entries.filter((entry) => /\.edf$/i.test(entry.name));
const crcs = entries.filter((entry) => /\.crc$/i.test(entry.name));
const scanned = await parseEdfEntriesSafely(entries, "scan", { skipCrc: true });
const crc = await validateCrcEntriesSafely(entries);

const byType = scanned.files.reduce((counts, file) => {
  counts[file.header.type] = (counts[file.header.type] || 0) + 1;
  return counts;
}, {});
const crcBad = crc.results.reduce((sum, file) => sum + (file.crc.internal?.bad || 0), 0);
const recordsChecked = crc.results.reduce((sum, file) => sum + (file.crc.internal?.total || 0), 0);

console.log(JSON.stringify({
  root,
  edfFiles: edfs.length,
  crcFiles: crcs.length,
  parsedFiles: scanned.files.length,
  scanFailures: scanned.failures,
  crcFailures: crc.failures,
  byType,
  recordsChecked,
  crcBad,
  firstStart: scanned.files[0]?.header.startDate || null,
  lastStart: scanned.files[scanned.files.length - 1]?.header.startDate || null,
}, null, 2));
