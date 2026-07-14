import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { crc16CcittFalse, parseEdfEntry } from "../src/edfParser.js";

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

function hex(buffer) {
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const files = await walk(root);
const edfs = files.filter((file) => /\.edf$/i.test(file)).sort();
const rows = [];

for (const edfPath of edfs) {
  const crcPath = edfPath.replace(/\.edf$/i, ".crc");
  let sidecar = null;
  try {
    sidecar = await readFile(crcPath);
  } catch {
    sidecar = null;
  }
  const data = await readFile(edfPath);
  const parsed = await parseEdfEntry({
    name: path.basename(edfPath),
    relativePath: path.relative(root, edfPath),
    file: { arrayBuffer: async () => toArrayBuffer(data), size: data.byteLength, lastModified: 0 },
  }, "summary");
  rows.push({
    file: path.relative(root, edfPath),
    sidecarBytes: sidecar?.byteLength || 0,
    sidecarHex: sidecar ? hex(sidecar) : "",
    internalRecords: parsed.crc.internal.total,
    internalBad: parsed.crc.internal.bad,
    wholeFileCcittFalse: crc16CcittFalse(new Uint8Array(data), 0, data.byteLength).toString(16).padStart(4, "0"),
  });
}

console.log(JSON.stringify({
  root,
  note: "ResMed .crc sidecars are 8-byte binary values. This script reports them and known internal record CRCs; strict sidecar validation still needs the vendor sidecar algorithm.",
  rows,
}, null, 2));
