import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { crc16CcittFalse, validateEdfCrcEntry } from "../src/edfParser.js";

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

function hex16(value) {
  return (value & 0xffff).toString(16).padStart(4, "0");
}

function hex32(value) {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function swapHexBytes(valueHex) {
  return valueHex.match(/../g).reverse().join("");
}

function crc16Xmodem(bytes) {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function crc16Modbus(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

function crc32Ieee(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function sidecarMatches(sidecarHex, bytes) {
  if (!sidecarHex) return [];
  const candidates = {
    crc16CcittFalse: hex16(crc16CcittFalse(bytes, 0, bytes.byteLength)),
    crc16Xmodem: hex16(crc16Xmodem(bytes)),
    crc16Modbus: hex16(crc16Modbus(bytes)),
    crc32Ieee: hex32(crc32Ieee(bytes)),
    adler32: hex32(adler32(bytes)),
  };
  return Object.entries(candidates).flatMap(([name, value]) => {
    const forms = [
      { endian: "big", hex: value },
      { endian: "little", hex: swapHexBytes(value) },
    ];
    return forms
      .filter((form) => sidecarHex.includes(form.hex))
      .map((form) => ({ name, endian: form.endian, hex: form.hex }));
  });
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
  const parsed = await validateEdfCrcEntry({
    name: path.basename(edfPath),
    relativePath: path.relative(root, edfPath),
    file: { arrayBuffer: async () => toArrayBuffer(data), size: data.byteLength, lastModified: 0 },
  });
  rows.push({
    file: path.relative(root, edfPath),
    sidecarBytes: sidecar?.byteLength || 0,
    sidecarHex: sidecar ? hex(sidecar) : "",
    internalRecords: parsed.crc.internal.total,
    internalBad: parsed.crc.internal.bad,
    wholeFileCcittFalse: crc16CcittFalse(new Uint8Array(data), 0, data.byteLength).toString(16).padStart(4, "0"),
    commonChecksumMatches: sidecarMatches(sidecar ? hex(sidecar) : "", new Uint8Array(data)),
  });
}

console.log(JSON.stringify({
  root,
  note: "ResMed .crc sidecars are 8-byte binary values. This script reports them, known internal record CRCs, and common checksum candidates found inside each sidecar; strict sidecar validation still needs a proven vendor algorithm.",
  rows,
}, null, 2));
