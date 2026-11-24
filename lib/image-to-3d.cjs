'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { buildGlbFromParts } = require('./glb.cjs');

// ============================================================================
// Pure-JS PNG / BMP Codec (node:zlib only, zero external dependencies)
// ============================================================================

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let palette = null;
  let trns = null;
  const idatChunks = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bit depth (${bitDepth}); only 8-bit PNGs are supported.`);
      }
      if (data[12] !== 0) {
        throw new Error('Interlaced PNGs are not supported by the pure-JS decoder.');
      }
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height || !idatChunks.length) {
    throw new Error('Malformed PNG: missing IHDR or IDAT.');
  }

  const channelsMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = channelsMap[colorType];
  if (!bpp) throw new Error(`Unsupported PNG color type: ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const rowBytes = width * bpp;
  const unfiltered = new Uint8Array(height * rowBytes);

  for (let y = 0; y < height; y += 1) {
    const srcStart = y * (rowBytes + 1);
    const filter = raw[srcStart];
    const rowOut = y * rowBytes;
    const prevOut = (y - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const val = raw[srcStart + 1 + x];
      const a = x >= bpp ? unfiltered[rowOut + x - bpp] : 0;
      const b = y > 0 ? unfiltered[prevOut + x] : 0;
      const c = (x >= bpp && y > 0) ? unfiltered[prevOut + x - bpp] : 0;
      let recon = val;
      if (filter === 1) recon = (val + a) & 0xff;
      else if (filter === 2) recon = (val + b) & 0xff;
      else if (filter === 3) recon = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon = (val + paethPredictor(a, b, c)) & 0xff;
      unfiltered[rowOut + x] = recon;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const dst = i * 4;
    if (colorType === 6) {
      rgba[dst] = unfiltered[dst];
      rgba[dst + 1] = unfiltered[dst + 1];
      rgba[dst + 2] = unfiltered[dst + 2];
      rgba[dst + 3] = unfiltered[dst + 3];
    } else if (colorType === 2) {
      const src = i * 3;
      rgba[dst] = unfiltered[src];
      rgba[dst + 1] = unfiltered[src + 1];
      rgba[dst + 2] = unfiltered[src + 2];
      rgba[dst + 3] = 255;
    } else if (colorType === 0) {
      const g = unfiltered[i];
      rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g; rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      const g = unfiltered[i * 2];
      rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g; rgba[dst + 3] = unfiltered[i * 2 + 1];
    } else if (colorType === 3 && palette) {
      const idx = unfiltered[i];
      rgba[dst] = palette[idx * 3] || 0;
      rgba[dst + 1] = palette[idx * 3 + 1] || 0;
      rgba[dst + 2] = palette[idx * 3 + 2] || 0;
      rgba[dst + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }

  return { width, height, rgba };
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const dstRow = y * (stride + 1);
    raw[dstRow] = 0; // filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, dstRow + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function decodeBmp(buffer) {
  if (buffer.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('Invalid BMP signature.');
  }
  const dataOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bpp = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  if (compression !== 0 || (bpp !== 24 && bpp !== 32)) {
    throw new Error(`Unsupported BMP format (${bpp}bpp, compression=${compression}).`);
  }

  const bytesPerPixel = bpp / 8;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const rgba = new Uint8Array(width * height * 4);
  const topDown = rawHeight < 0;

  for (let y = 0; y < height; y += 1) {
    const srcY = topDown ? y : height - 1 - y;
    const rowStart = dataOffset + srcY * rowSize;
    for (let x = 0; x < width; x += 1) {
      const s = rowStart + x * bytesPerPixel;
      const d = (y * width + x) * 4;
      rgba[d] = buffer[s + 2];
      rgba[d + 1] = buffer[s + 1];
      rgba[d + 2] = buffer[s];
      rgba[d + 3] = bpp === 32 ? buffer[s + 3] : 255;
    }
  }
  return { width, height, rgba };
}

function loadImageRgba(imagePath) {
  const resolved = path.resolve(imagePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Image file not found: ${resolved}`);
  }
  const buf = fs.readFileSync(resolved);
  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    return decodePng(buf);
  }
  if (buf.toString('ascii', 0, 2) === 'BM') {
    return decodeBmp(buf);
  }

  // On Windows, convert JPEG/WebP/GIF cleanly using built-in .NET System.Drawing
  if (process.platform === 'win32') {
    const tmpPng = path.join(os.tmpdir(), `meshforge-conv-${process.pid}-${Date.now()}.png`);
    const ps = `Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('${resolved.replace(/'/g, "''")}'); $img.Save('${tmpPng.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose()`;
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 15000 });
      const pngBuf = fs.readFileSync(tmpPng);
      return decodePng(pngBuf);
    } finally {
      try { if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng); } catch {}
    }
  }

  throw new Error('Pure-JS image decoder supports PNG and BMP natively (convert JPEG/WebP to PNG first on this OS).');
}

function resizeRgba(src, targetMaxDim) {
  const scale = Math.min(1, targetMaxDim / Math.max(src.width, src.height));
  const w = Math.max(8, Math.round(src.width * scale));
  const h = Math.max(8, Math.round(src.height * scale));
  if (w === src.width && h === src.height) return src;

  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor((y + 0.5) * src.height / h));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor((x + 0.5) * src.width / w));
      const s = (sy * src.width + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = src.rgba[s];
      out[d + 1] = src.rgba[s + 1];
      out[d + 2] = src.rgba[s + 2];
      out[d + 3] = src.rgba[s + 3];
    }
  }
  return { width: w, height: h, rgba: out };
}

// ============================================================================
// Image Segmentation + Felzenszwalb-Huttenlocher Exact O(W*H) Euclidean EDT
// ============================================================================

function computeForegroundMask(img) {
  const { width: w, height: h, rgba } = img;
  const n = w * h;
  let transparentCount = 0;
  for (let i = 0; i < n; i += 1) {
    if (rgba[i * 4 + 3] < 128) transparentCount += 1;
  }

  // Case 1: Image already has an alpha cutout
  if (transparentCount > n * 0.03 && transparentCount < n * 0.98) {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      mask[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
    }
    return mask;
  }

  // Case 2: Solid/studio background -> BFS flood-fill from borders using corner color similarity
  const corners = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)];
  let bgR = 0, bgG = 0, bgB = 0;
  for (const idx of corners) {
    bgR += rgba[idx * 4];
    bgG += rgba[idx * 4 + 1];
    bgB += rgba[idx * 4 + 2];
  }
  bgR /= 4; bgG /= 4; bgB /= 4;

  const visited = new Uint8Array(n);
  const bgMask = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const threshSq = 46 * 46;

  function tryPush(idx) {
    if (visited[idx]) return;
    visited[idx] = 1;
    const p = idx * 4;
    const dr = rgba[p] - bgR;
    const dg = rgba[p + 1] - bgG;
    const db = rgba[p + 2] - bgB;
    if (dr * dr + dg * dg + db * db <= threshSq) {
      bgMask[idx] = 1;
      queue[tail++] = idx;
    }
  }

  for (let x = 0; x < w; x += 1) { tryPush(x); tryPush((h - 1) * w + x); }
  for (let y = 0; y < h; y += 1) { tryPush(y * w); tryPush(y * w + (w - 1)); }

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) tryPush(idx - 1);
    if (x + 1 < w) tryPush(idx + 1);
    if (y > 0) tryPush(idx - w);
    if (y + 1 < h) tryPush(idx + w);
  }

  const mask = new Uint8Array(n);
  let fgCount = 0;
  for (let i = 0; i < n; i += 1) {
    mask[i] = bgMask[i] ? 0 : 1;
    if (mask[i]) fgCount += 1;
  }
  // If no clear border background was separated, treat inner 90% as foreground
  if (fgCount < n * 0.04) {
    mask.fill(1);
  }
  return mask;
}

function edt1d(f, n) {
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q += 1) {
    let s;
    while (true) {
      const r = v[k];
      s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
      if (s > z[k]) break;
      k -= 1;
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
  return d;
}

/**
 * Exact O(W*H) Euclidean Distance Transform from background pixels (mask[i] === 0).
 */
function computeDistanceTransform(mask, w, h) {
  const INF = 1e12;
  const grid = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    grid[i] = mask[i] ? INF : 0;
  }

  const colBuf = new Float32Array(h);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) colBuf[y] = grid[y * w + x];
    const dtCol = edt1d(colBuf, h);
    for (let y = 0; y < h; y += 1) grid[y * w + x] = dtCol[y];
  }

  const rowBuf = new Float32Array(w);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) rowBuf[x] = grid[y * w + x];
    const dtRow = edt1d(rowBuf, w);
    for (let x = 0; x < w; x += 1) out[y * w + x] = Math.sqrt(dtRow[x]);
  }
  return out;
}

function lumaAt(rgba, idx) {
  const p = idx * 4;
  return (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
}

/**
 * Mode 1: Teddy / MonsterMash-style 2D->3D Inflation from silhouette + EDT + micro-relief + UV texture.
 */
function buildInflatedMeshGlb(img, { gridMax = 76, depthScale = 0.28, reliefStrength = 0.04 } = {}) {
  const texImg = resizeRgba(img, 512);
  const texPng = encodePng(texImg.width, texImg.height, texImg.rgba);
  const grid = resizeRgba(img, gridMax);
  const { width: w, height: h, rgba } = grid;

  const mask = computeForegroundMask(grid);
  const dist = computeDistanceTransform(mask, w, h);
  let maxDist = 1;
  for (let i = 0; i < dist.length; i += 1) {
    if (dist[i] > maxDist) maxDist = dist[i];
  }

  const aspect = w / h;
  const sizeX = aspect >= 1 ? 1.8 : 1.8 * aspect;
  const sizeY = aspect >= 1 ? 1.8 / aspect : 1.8;

  const positions = [];
  const uvs = [];
  const indices = [];

  const frontIdx = new Int32Array(w * h).fill(-1);
  const backIdx = new Int32Array(w * h).fill(-1);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const dNorm = Math.min(1, dist[i] / maxDist);
      const pillow = Math.sqrt(Math.max(0, 1 - Math.pow(1 - dNorm, 2)));
      const micro = (lumaAt(rgba, i) - 0.5) * reliefStrength * dNorm;
      const z = Math.max(0.008, pillow * depthScale + micro);

      const wx = ((x / (w - 1)) - 0.5) * sizeX;
      const wy = (0.5 - (y / (h - 1))) * sizeY;
      const u = x / (w - 1);
      const v = y / (h - 1);

      frontIdx[i] = positions.length / 3;
      positions.push(wx, wy, z);
      uvs.push(u, v);

      backIdx[i] = positions.length / 3;
      positions.push(wx, wy, -z * 0.85);
      uvs.push(u, v);
    }
  }

  for (let y = 0; y < h - 1; y += 1) {
    for (let x = 0; x < w - 1; x += 1) {
      const i00 = y * w + x;
      const i10 = i00 + 1;
      const i01 = i00 + w;
      const i11 = i01 + 1;
      if (frontIdx[i00] >= 0 && frontIdx[i10] >= 0 && frontIdx[i01] >= 0 && frontIdx[i11] >= 0) {
        indices.push(frontIdx[i00], frontIdx[i01], frontIdx[i10], frontIdx[i10], frontIdx[i01], frontIdx[i11]);
        indices.push(backIdx[i00], backIdx[i10], backIdx[i01], backIdx[i10], backIdx[i11], backIdx[i01]);
      }
    }
  }

  // Stitch silhouette boundary edges between front and back surfaces for a watertight closed mesh
  const stitchEdge = (a, b) => {
    indices.push(frontIdx[a], backIdx[a], frontIdx[b]);
    indices.push(frontIdx[b], backIdx[a], backIdx[b]);
  };
  for (let y = 0; y < h - 1; y += 1) {
    for (let x = 0; x < w - 1; x += 1) {
      const i00 = y * w + x;
      const i10 = i00 + 1;
      const i01 = i00 + w;
      if (frontIdx[i00] >= 0 && frontIdx[i10] >= 0) {
        const upEmpty = y === 0 || frontIdx[(y - 1) * w + x] < 0 || frontIdx[(y - 1) * w + x + 1] < 0;
        const downEmpty = frontIdx[i01] < 0 || frontIdx[i01 + 1] < 0;
        if (upEmpty) stitchEdge(i00, i10);
        if (downEmpty) stitchEdge(i10, i00);
      }
      if (frontIdx[i00] >= 0 && frontIdx[i01] >= 0) {
        const leftEmpty = x === 0 || frontIdx[y * w + x - 1] < 0 || frontIdx[(y + 1) * w + x - 1] < 0;
        const rightEmpty = frontIdx[i10] < 0 || frontIdx[i01 + 1] < 0;
        if (leftEmpty) stitchEdge(i01, i00);
        if (rightEmpty) stitchEdge(i00, i01);
      }
    }
  }

  return buildGlbFromParts({
    generator: 'meshforge-mcp-image-inflate',
    images: [{ buffer: texPng, mimeType: 'image/png' }],
    parts: [
      {
        name: 'InflatedMesh3D',
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
        indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
        material: {
          name: 'ProjectedImagePBR',
          textureIndex: 0,
          metallicFactor: 0.08,
          roughnessFactor: 0.52,
          doubleSided: true
        }
      }
    ]
  });
}

/**
 * Mode 2: Solid Heightmap / Bas-Relief / Lithophane Slab from pixel luminance + 3x3 smoothing + UV texture.
 */
function buildReliefMeshGlb(img, { gridMax = 80, depthScale = 0.24, baseThickness = 0.06, invert = false } = {}) {
  const texImg = resizeRgba(img, 512);
  const texPng = encodePng(texImg.width, texImg.height, texImg.rgba);
  const grid = resizeRgba(img, gridMax);
  const { width: w, height: h, rgba } = grid;

  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const val = lumaAt(rgba, i);
    luma[i] = invert ? 1 - val : val;
  }

  // 3x3 Gaussian smoothing pass to avoid jagged pixel spikes
  const smooth = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0, wt = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = Math.max(0, Math.min(h - 1, y + dy));
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = Math.max(0, Math.min(w - 1, x + dx));
          const k = (dx === 0 && dy === 0) ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
          sum += luma[ny * w + nx] * k;
          wt += k;
        }
      }
      smooth[y * w + x] = sum / wt;
    }
  }

  const aspect = w / h;
  const sizeX = aspect >= 1 ? 1.8 : 1.8 * aspect;
  const sizeY = aspect >= 1 ? 1.8 / aspect : 1.8;

  const positions = [];
  const uvs = [];
  const indices = [];

  // Front vertices: 0 .. w*h-1
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const wx = ((x / (w - 1)) - 0.5) * sizeX;
      const wy = (0.5 - (y / (h - 1))) * sizeY;
      const wz = baseThickness + smooth[i] * depthScale;
      positions.push(wx, wy, wz);
      uvs.push(x / (w - 1), y / (h - 1));
    }
  }

  // Back flat base vertices: w*h .. 2*w*h-1
  const backOffset = w * h;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const wx = ((x / (w - 1)) - 0.5) * sizeX;
      const wy = (0.5 - (y / (h - 1))) * sizeY;
      positions.push(wx, wy, 0);
      uvs.push(x / (w - 1), y / (h - 1));
    }
  }

  for (let y = 0; y < h - 1; y += 1) {
    for (let x = 0; x < w - 1; x += 1) {
      const a = y * w + x;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
      const ba = backOffset + a, bb = backOffset + b, bc = backOffset + c, bd = backOffset + d;
      indices.push(ba, bb, bc, bb, bd, bc);
    }
  }

  // Stitch 4 solid perimeter walls
  for (let x = 0; x < w - 1; x += 1) {
    const t0 = x, t1 = x + 1;
    indices.push(t0, t1, backOffset + t0, t1, backOffset + t1, backOffset + t0);
    const b0 = (h - 1) * w + x, b1 = b0 + 1;
    indices.push(b0, backOffset + b0, b1, b1, backOffset + b0, backOffset + b1);
  }
  for (let y = 0; y < h - 1; y += 1) {
    const l0 = y * w, l1 = (y + 1) * w;
    indices.push(l0, backOffset + l0, l1, l1, backOffset + l0, backOffset + l1);
    const r0 = y * w + (w - 1), r1 = (y + 1) * w + (w - 1);
    indices.push(r0, r1, backOffset + r0, r1, backOffset + r1, backOffset + r0);
  }

  return buildGlbFromParts({
    generator: 'meshforge-mcp-image-relief',
    images: [{ buffer: texPng, mimeType: 'image/png' }],
    parts: [
      {
        name: 'ReliefMesh3D',
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
        indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
        material: {
          name: 'ReliefImagePBR',
          textureIndex: 0,
          metallicFactor: 0.05,
          roughnessFactor: 0.58
        }
      }
    ]
  });
}

function generateFromImagePureCode(imagePath, { mode = 'inflate', gridMax = 76, depthScale = 0.28, invert = false } = {}) {
  const img = loadImageRgba(imagePath);
  if (mode === 'relief' || mode === 'heightmap' || mode === 'lithophane') {
    return {
      glb: buildReliefMeshGlb(img, { gridMax, depthScale, invert }),
      technique: 'luminance-relief-heightmap',
      sourceSize: { width: img.width, height: img.height }
    };
  }
  return {
    glb: buildInflatedMeshGlb(img, { gridMax, depthScale }),
    technique: 'edt-silhouette-inflation',
    sourceSize: { width: img.width, height: img.height }
  };
}

module.exports = {
  decodePng,
  encodePng,
  decodeBmp,
  loadImageRgba,
  computeForegroundMask,
  computeDistanceTransform,
  buildInflatedMeshGlb,
  buildReliefMeshGlb,
  generateFromImagePureCode
};
