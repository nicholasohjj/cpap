import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseEdfEntry } from "../src/edfParser.js";

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

const files = await walk(root);
const edfs = files.filter((file) => /\.edf$/i.test(file));
const crcs = files.filter((file) => /\.crc$/i.test(file));
const parsed = [];

for (const file of edfs) {
  const buffer = await readFile(file);
  const info = await stat(file);
  parsed.push(await parseEdfEntry({
    name: path.basename(file),
    relativePath: path.relative(root, file),
    file: {
      size: info.size,
      lastModified: info.mtimeMs,
      arrayBuffer: async () => toArrayBuffer(buffer),
    },
  }, "summary"));
}

const byType = parsed.reduce((counts, file) => {
  counts[file.header.type] = (counts[file.header.type] || 0) + 1;
  return counts;
}, {});
const crcBad = parsed.reduce((sum, file) => sum + (file.crc.internal?.bad || 0), 0);
const recordsChecked = parsed.reduce((sum, file) => sum + (file.crc.internal?.total || 0), 0);

console.log(JSON.stringify({
  root,
  edfFiles: edfs.length,
  crcFiles: crcs.length,
  byType,
  recordsChecked,
  crcBad,
  firstStart: parsed[0]?.header.startDate || null,
  lastStart: parsed[parsed.length - 1]?.header.startDate || null,
}, null, 2));
