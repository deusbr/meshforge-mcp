'use strict';

const { buildGlbFromParts } = require('./glb.cjs');

// ============================================================================
// Pure-JS Procedural Geometry & SDF Marching Cubes Engine (Zero API Keys)
// ============================================================================

const COLOR_MAP = {
  red: [0.82, 0.2, 0.18], vermelho: [0.82, 0.2, 0.18],
  blue: [0.18, 0.44, 0.85], azul: [0.18, 0.44, 0.85],
  green: [0.22, 0.56, 0.34], verde: [0.22, 0.56, 0.34], musgo: [0.31, 0.38, 0.3],
  yellow: [0.9, 0.72, 0.2], amarelo: [0.9, 0.72, 0.2],
  orange: [0.88, 0.48, 0.14], laranja: [0.88, 0.48, 0.14],
  purple: [0.54, 0.32, 0.78], roxo: [0.54, 0.32, 0.78],
  pink: [0.86, 0.42, 0.58], rosa: [0.86, 0.42, 0.58],
  white: [0.92, 0.91, 0.88], branco: [0.92, 0.91, 0.88],
  black: [0.11, 0.11, 0.12], preto: [0.11, 0.11, 0.12], ebano: [0.13, 0.12, 0.11],
  gray: [0.48, 0.5, 0.52], cinza: [0.48, 0.5, 0.52],
  gold: [0.86, 0.68, 0.26], dourado: [0.86, 0.68, 0.26], ouro: [0.86, 0.68, 0.26],
  copper: [0.79, 0.53, 0.38], cobre: [0.79, 0.53, 0.38], bronze: [0.68, 0.48, 0.3],
  silver: [0.78, 0.8, 0.82], prata: [0.78, 0.8, 0.82], titanium: [0.68, 0.7, 0.69], titanio: [0.68, 0.7, 0.69],
  wood: [0.48, 0.31, 0.19], madeira: [0.48, 0.31, 0.19],
  ceramic: [0.86, 0.83, 0.78], ceramica: [0.86, 0.83, 0.78],
  sand: [0.78, 0.71, 0.61], areia: [0.78, 0.71, 0.61]
};

function hexToRgba(hex) {
  const clean = String(hex || '').replace('#', '');
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16) / 255,
      parseInt(clean[1] + clean[1], 16) / 255,
      parseInt(clean[2] + clean[2], 16) / 255,
      1
    ];
  }
  if (clean.length === 6) {
    return [
      parseInt(clean.slice(0, 2), 16) / 255,
      parseInt(clean.slice(2, 4), 16) / 255,
      parseInt(clean.slice(4, 6), 16) / 255,
      1
    ];
  }
  return [0.78, 0.54, 0.36, 1];
}

function resolveColor(color, fallback = [0.78, 0.54, 0.36, 1]) {
  if (!color) return fallback;
  if (Array.isArray(color)) {
    return [color[0] ?? 0.8, color[1] ?? 0.8, color[2] ?? 0.8, color[3] ?? 1];
  }
  if (typeof color === 'string') {
    if (color.startsWith('#')) return hexToRgba(color);
    const key = color.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (COLOR_MAP[key]) return [...COLOR_MAP[key], 1];
  }
  return fallback;
}

function transformVertices(positions, { position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  const [tx, ty, tz] = position;
  const [rx, ry, rz] = rotation;
  const [sx, sy, sz] = Array.isArray(scale) ? scale : [scale, scale, scale];
  const cx = Math.cos(rx), sinX = Math.sin(rx);
  const cy = Math.cos(ry), sinY = Math.sin(ry);
  const cz = Math.cos(rz), sinZ = Math.sin(rz);

  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    let x = positions[i] * sx;
    let y = positions[i + 1] * sy;
    let z = positions[i + 2] * sz;

    // Rotate X -> Y -> Z
    let y1 = y * cx - z * sinX;
    let z1 = y * sinX + z * cx;
    y = y1; z = z1;

    let x2 = x * cy + z * sinY;
    let z2 = -x * sinY + z * cy;
    x = x2; z = z2;

    let x3 = x * cz - y * sinZ;
    let y3 = x * sinZ + y * cz;
    x = x3; y = y3;

    out[i] = x + tx;
    out[i + 1] = y + ty;
    out[i + 2] = z + tz;
  }
  return out;
}

function makeBoxGeometry(w = 1, h = 1, d = 1) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const faces = [
    [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]],     // front
    [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], // back
    [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]],     // top
    [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], // bottom
    [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]],     // right
    [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]  // left
  ];
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let f = 0; f < 6; f += 1) {
    const base = f * 4;
    for (const v of faces[f]) positions.push(v[0], v[1], v[2]);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

function makeSphereGeometry(radius = 0.5, segW = 28, segH = 18) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let y = 0; y <= segH; y += 1) {
    const v = y / segH;
    const phi = v * Math.PI;
    for (let x = 0; x <= segW; x += 1) {
      const u = x / segW;
      const theta = u * Math.PI * 2;
      positions.push(
        -radius * Math.cos(theta) * Math.sin(phi),
        radius * Math.cos(phi),
        radius * Math.sin(theta) * Math.sin(phi)
      );
      uvs.push(u, 1 - v);
    }
  }
  const stride = segW + 1;
  for (let y = 0; y < segH; y += 1) {
    for (let x = 0; x < segW; x += 1) {
      const a = y * stride + x;
      const b = a + stride;
      const c = b + 1;
      const d = a + 1;
      if (y !== 0) indices.push(a, b, d);
      if (y !== segH - 1) indices.push(b, c, d);
    }
  }
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

function makeLatheGeometry(points, segments = 32) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const rows = points.length;
  for (let i = 0; i <= segments; i += 1) {
    const u = i / segments;
    const theta = u * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (let j = 0; j < rows; j += 1) {
      const [r, y] = points[j];
      positions.push(r * sin, y, r * cos);
      uvs.push(u, j / Math.max(1, rows - 1));
    }
  }
  for (let i = 0; i < segments; i += 1) {
    for (let j = 0; j < rows - 1; j += 1) {
      const a = i * rows + j;
      const b = (i + 1) * rows + j;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

function makeCylinderGeometry(rTop = 0.5, rBot = 0.5, height = 1, segments = 32) {
  const hy = height / 2;
  const profile = [
    [0, -hy],
    [rBot, -hy],
    [rBot, -hy],
    [rTop, hy],
    [rTop, hy],
    [0, hy]
  ];
  return makeLatheGeometry(profile, segments);
}

function makeTorusGeometry(majorR = 0.5, minorR = 0.14, segMajor = 36, segMinor = 18) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= segMinor; j += 1) {
    const v = j / segMinor;
    const phi = v * Math.PI * 2;
    for (let i = 0; i <= segMajor; i += 1) {
      const u = i / segMajor;
      const theta = u * Math.PI * 2;
      const x = (majorR + minorR * Math.cos(phi)) * Math.cos(theta);
      const y = minorR * Math.sin(phi);
      const z = (majorR + minorR * Math.cos(phi)) * Math.sin(theta);
      positions.push(x, y, z);
      uvs.push(u, v);
    }
  }
  const stride = segMajor + 1;
  for (let j = 0; j < segMinor; j += 1) {
    for (let i = 0; i < segMajor; i += 1) {
      const a = j * stride + i;
      const b = a + stride;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

function evalCatmullRom(pts, t) {
  const n = pts.length - 1;
  const scaled = Math.max(0, Math.min(n - 1e-6, t * n));
  const i = Math.floor(scaled);
  const f = scaled - i;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[Math.min(n, i + 1)];
  const p3 = pts[Math.min(n, i + 2)];
  const f2 = f * f;
  const f3 = f2 * f;
  return [0, 1, 2].map((k) =>
    0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * f + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f3)
  );
}

function makeTubeGeometry(points, radius = 0.08, tubularSegments = 48, radialSegments = 16, closedCaps = true) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const centers = [];
  for (let i = 0; i <= tubularSegments; i += 1) {
    centers.push(evalCatmullRom(points, i / tubularSegments));
  }

  for (let i = 0; i <= tubularSegments; i += 1) {
    const p = centers[i];
    const prev = centers[Math.max(0, i - 1)];
    const next = centers[Math.min(tubularSegments, i + 1)];
    let tx = next[0] - prev[0], ty = next[1] - prev[1], tz = next[2] - prev[2];
    const tLen = Math.hypot(tx, ty, tz) || 1;
    tx /= tLen; ty /= tLen; tz /= tLen;

    // Reference up vector
    const up = Math.abs(ty) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    let bx = ty * up[2] - tz * up[1];
    let by = tz * up[0] - tx * up[2];
    let bz = tx * up[1] - ty * up[0];
    const bLen = Math.hypot(bx, by, bz) || 1;
    bx /= bLen; by /= bLen; bz /= bLen;

    const nx = by * tz - bz * ty;
    const ny = bz * tx - bx * tz;
    const nz = bx * ty - by * tx;

    for (let j = 0; j <= radialSegments; j += 1) {
      const v = j / radialSegments;
      const angle = v * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(
        p[0] + radius * (cos * nx + sin * bx),
        p[1] + radius * (cos * ny + sin * by),
        p[2] + radius * (cos * nz + sin * bz)
      );
      uvs.push(i / tubularSegments, v);
    }
  }

  const stride = radialSegments + 1;
  for (let i = 0; i < tubularSegments; i += 1) {
    for (let j = 0; j < radialSegments; j += 1) {
      const a = i * stride + j;
      const b = a + stride;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, b, d, b, c, d);
    }
  }

  if (closedCaps) {
    const startCenterIdx = positions.length / 3;
    positions.push(centers[0][0], centers[0][1], centers[0][2]);
    uvs.push(0.5, 0.5);
    for (let j = 0; j < radialSegments; j += 1) {
      indices.push(startCenterIdx, j + 1, j);
    }
    const endCenterIdx = positions.length / 3;
    const lastRow = tubularSegments * stride;
    positions.push(centers[tubularSegments][0], centers[tubularSegments][1], centers[tubularSegments][2]);
    uvs.push(0.5, 0.5);
    for (let j = 0; j < radialSegments; j += 1) {
      indices.push(endCenterIdx, lastRow + j, lastRow + j + 1);
    }
  }

  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

function makePolygonExtrudeGeometry(polygon2d, depth = 0.2) {
  // Fan triangulation around centroid for star/gear/convex-ish shapes + side walls
  const n = polygon2d.length;
  let cx = 0, cy = 0;
  for (const [px, py] of polygon2d) { cx += px; cy += py; }
  cx /= n; cy /= n;
  const hz = depth / 2;

  const positions = [];
  const uvs = [];
  const indices = [];

  // Front face center = 0, back face center = n + 1
  positions.push(cx, cy, hz); uvs.push(0.5, 0.5);
  for (const [px, py] of polygon2d) {
    positions.push(px, py, hz);
    uvs.push(px + 0.5, py + 0.5);
  }
  positions.push(cx, cy, -hz); uvs.push(0.5, 0.5);
  for (const [px, py] of polygon2d) {
    positions.push(px, py, -hz);
    uvs.push(px + 0.5, py + 0.5);
  }

  const backStart = n + 1;
  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    indices.push(0, 1 + i, 1 + next);
    indices.push(backStart, backStart + 1 + next, backStart + 1 + i);
  }

  // Side walls
  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    const base = positions.length / 3;
    const [ax, ay] = polygon2d[i];
    const [bx, by] = polygon2d[next];
    positions.push(ax, ay, hz, bx, by, hz, bx, by, -hz, ax, ay, -hz);
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

// ============================================================================
// Signed Distance Field (SDF) + Surface-Nets / Tetrahedron Polygonizer
// ============================================================================

function smin(a, b, k = 0.15) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function evalSdfOp(op, x, y, z) {
  if (op.op === 'union') {
    return Math.min(...op.children.map((c) => evalSdfOp(c, x, y, z)));
  }
  if (op.op === 'smoothUnion') {
    const k = op.k || 0.18;
    let d = evalSdfOp(op.children[0], x, y, z);
    for (let i = 1; i < op.children.length; i += 1) {
      d = smin(d, evalSdfOp(op.children[i], x, y, z), k);
    }
    return d;
  }
  if (op.op === 'subtract') {
    let d = evalSdfOp(op.children[0], x, y, z);
    for (let i = 1; i < op.children.length; i += 1) {
      d = Math.max(d, -evalSdfOp(op.children[i], x, y, z));
    }
    return d;
  }
  if (op.op === 'intersect') {
    return Math.max(...op.children.map((c) => evalSdfOp(c, x, y, z)));
  }

  const [px, py, pz] = op.position || [0, 0, 0];
  const lx = x - px, ly = y - py, lz = z - pz;
  if (op.shape === 'sphere') {
    return Math.hypot(lx, ly, lz) - (op.radius ?? 0.5);
  }
  if (op.shape === 'box') {
    const [bx, by, bz] = op.size || [0.8, 0.8, 0.8];
    const r = op.round || 0;
    const dx = Math.abs(lx) - bx * 0.5 + r;
    const dy = Math.abs(ly) - by * 0.5 + r;
    const dz = Math.abs(lz) - bz * 0.5 + r;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0) - r;
  }
  if (op.shape === 'cylinder') {
    const r = op.radius ?? 0.35;
    const h = (op.height ?? 1.0) * 0.5;
    const dx = Math.hypot(lx, lz) - r;
    const dy = Math.abs(ly) - h;
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }
  if (op.shape === 'torus') {
    const major = op.majorRadius ?? 0.5;
    const minor = op.minorRadius ?? 0.16;
    const qx = Math.hypot(lx, lz) - major;
    return Math.hypot(qx, ly) - minor;
  }
  return Math.hypot(lx, ly, lz) - 0.5;
}

/**
 * Polygonizes any SDF tree using Marching Tetrahedra (clean manifold triangles without edge lookup ambiguity).
 */
function makeSdfGeometry(sdfTree, { bounds = 1.4, resolution = 28 } = {}) {
  const n = Math.max(12, Math.min(48, Number(resolution) || 28));
  const minB = -bounds;
  const step = (bounds * 2) / n;
  const grid = new Float32Array((n + 1) * (n + 1) * (n + 1));

  const idx = (ix, iy, iz) => ix + (n + 1) * (iy + (n + 1) * iz);
  for (let iz = 0; iz <= n; iz += 1) {
    const z = minB + iz * step;
    for (let iy = 0; iy <= n; iy += 1) {
      const y = minB + iy * step;
      for (let ix = 0; ix <= n; ix += 1) {
        const x = minB + ix * step;
        grid[idx(ix, iy, iz)] = evalSdfOp(sdfTree, x, y, z);
      }
    }
  }

  const positions = [];
  const uvs = [];
  const indices = [];
  const edgeCache = new Map();

  const corners = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]
  ];
  const tets = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6]
  ];

  function interpEdge(ax, ay, az, va, bx, by, bz, vb) {
    const k1 = `${ax},${ay},${az}`;
    const k2 = `${bx},${by},${bz}`;
    const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    const cached = edgeCache.get(key);
    if (cached !== undefined) return cached;

    const denom = va - vb;
    const t = Math.abs(denom) > 1e-6 ? va / denom : 0.5;
    const wx = minB + (ax + t * (bx - ax)) * step;
    const wy = minB + (ay + t * (by - ay)) * step;
    const wz = minB + (az + t * (bz - az)) * step;
    const vIdx = positions.length / 3;
    positions.push(wx, wy, wz);
    uvs.push((wx - minB) / (bounds * 2), (wy - minB) / (bounds * 2));
    edgeCache.set(key, vIdx);
    return vIdx;
  }

  function emitTri(a, b, c) {
    // Ensure outward winding via SDF gradient at triangle center
    const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
    const cy = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
    const cz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
    const eps = step * 0.35;
    const gx = evalSdfOp(sdfTree, cx + eps, cy, cz) - evalSdfOp(sdfTree, cx - eps, cy, cz);
    const gy = evalSdfOp(sdfTree, cx, cy + eps, cz) - evalSdfOp(sdfTree, cx, cy - eps, cz);
    const gz = evalSdfOp(sdfTree, cx, cy, cz + eps) - evalSdfOp(sdfTree, cx, cy, cz - eps);

    const abx = positions[b * 3] - positions[a * 3];
    const aby = positions[b * 3 + 1] - positions[a * 3 + 1];
    const abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acx = positions[c * 3] - positions[a * 3];
    const acy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const acz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (nx * gx + ny * gy + nz * gz >= 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  }

  for (let iz = 0; iz < n; iz += 1) {
    for (let iy = 0; iy < n; iy += 1) {
      for (let ix = 0; ix < n; ix += 1) {
        const vals = corners.map(([dx, dy, dz]) => grid[idx(ix + dx, iy + dy, iz + dz)]);
        let allNeg = true, allPos = true;
        for (const v of vals) {
          if (v >= 0) allNeg = false;
          if (v < 0) allPos = false;
        }
        if (allNeg || allPos) continue;

        for (const tet of tets) {
          const inside = [];
          const outside = [];
          for (const ci of tet) {
            if (vals[ci] < 0) inside.push(ci);
            else outside.push(ci);
          }
          if (inside.length === 0 || outside.length === 0) continue;

          const edgeV = (cA, cB) => {
            const [ax, ay, az] = corners[cA];
            const [bx, by, bz] = corners[cB];
            return interpEdge(ix + ax, iy + ay, iz + az, vals[cA], ix + bx, iy + by, iz + bz, vals[cB]);
          };

          if (inside.length === 1) {
            const i0 = inside[0];
            emitTri(edgeV(i0, outside[0]), edgeV(i0, outside[1]), edgeV(i0, outside[2]));
          } else if (outside.length === 1) {
            const o0 = outside[0];
            emitTri(edgeV(inside[0], o0), edgeV(inside[2], o0), edgeV(inside[1], o0));
          } else {
            const p00 = edgeV(inside[0], outside[0]);
            const p01 = edgeV(inside[0], outside[1]);
            const p10 = edgeV(inside[1], outside[0]);
            const p11 = edgeV(inside[1], outside[1]);
            emitTri(p00, p01, p11);
            emitTri(p00, p11, p10);
          }
        }
      }
    }
  }

  // 2-pass Taubin-style smoothing removes Marching Tetrahedra grid faceting cleanly
  const vCount = positions.length / 3;
  const neighbors = Array.from({ length: vCount }, () => []);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    neighbors[a].push(b, c);
    neighbors[b].push(a, c);
    neighbors[c].push(a, b);
  }
  const posArr = new Float32Array(positions);
  const tmpArr = new Float32Array(positions.length);
  for (const lambda of [0.45, -0.32, 0.40, -0.28]) {
    for (let v = 0; v < vCount; v += 1) {
      const nb = neighbors[v];
      if (!nb.length) continue;
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < nb.length; k += 1) {
        const j = nb[k] * 3;
        sx += posArr[j]; sy += posArr[j + 1]; sz += posArr[j + 2];
      }
      const inv = 1 / nb.length;
      const vi = v * 3;
      tmpArr[vi] = posArr[vi] + lambda * (sx * inv - posArr[vi]);
      tmpArr[vi + 1] = posArr[vi + 1] + lambda * (sy * inv - posArr[vi + 1]);
      tmpArr[vi + 2] = posArr[vi + 2] + lambda * (sz * inv - posArr[vi + 2]);
    }
    posArr.set(tmpArr);
  }

  return {
    positions: posArr,
    uvs: new Float32Array(uvs),
    indices: vCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)
  };
}

// ============================================================================
// Scene DSL Compiler (usable directly by Codex / Claude Code / Gemini / OpenBot)
// ============================================================================

function buildGeometryForPart(part) {
  const kind = part.type || 'box';
  if (kind === 'box') {
    const [w, h, d] = part.size || [1, 1, 1];
    return makeBoxGeometry(w, h, d);
  }
  if (kind === 'sphere') {
    return makeSphereGeometry(part.radius ?? 0.5, part.segments || 28, part.rings || 18);
  }
  if (kind === 'cylinder') {
    return makeCylinderGeometry(part.radiusTop ?? part.radius ?? 0.4, part.radiusBottom ?? part.radius ?? 0.4, part.height ?? 1, part.segments || 32);
  }
  if (kind === 'cone') {
    return makeCylinderGeometry(0.001, part.radius ?? 0.5, part.height ?? 1, part.segments || 32);
  }
  if (kind === 'torus') {
    return makeTorusGeometry(part.majorRadius ?? 0.5, part.minorRadius ?? 0.14, part.segments || 36, part.tubeSegments || 18);
  }
  if (kind === 'lathe') {
    return makeLatheGeometry(part.points || [[0, -0.5], [0.4, -0.5], [0.45, 0.4], [0, 0.4]], part.segments || 36);
  }
  if (kind === 'tube') {
    return makeTubeGeometry(part.points || [[-0.8, 0, 0], [0, 0.8, 0], [0.8, 0, 0]], part.radius ?? 0.08, part.segments || 44);
  }
  if (kind === 'extrude') {
    return makePolygonExtrudeGeometry(part.polygon || [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]], part.depth ?? 0.2);
  }
  if (kind === 'sdf') {
    return makeSdfGeometry(part.sdf, { bounds: part.bounds || 1.4, resolution: part.resolution || 28 });
  }
  throw new Error(`Unsupported primitive type "${kind}".`);
}

/**
 * Compiles a declarative Scene DSL ({ parts: [...] }) into a validated GLB Buffer.
 */
function compileSceneToGlb(scene) {
  const partsInput = Array.isArray(scene?.parts) ? scene.parts : [];
  if (!partsInput.length) {
    throw new Error('Scene DSL requires a non-empty "parts" array.');
  }

  const compiledParts = partsInput.map((part, idx) => {
    const geom = buildGeometryForPart(part);
    const positions = transformVertices(geom.positions, {
      position: part.position || [0, 0, 0],
      rotation: part.rotation || [0, 0, 0],
      scale: part.scale || [1, 1, 1]
    });
    const mat = part.material || {};
    return {
      name: part.name || `Part_${idx}`,
      positions,
      uvs: geom.uvs,
      indices: geom.indices,
      material: {
        name: mat.name || `Mat_${idx}`,
        baseColorFactor: resolveColor(mat.color || part.color),
        metallicFactor: typeof mat.metallic === 'number' ? mat.metallic : (typeof part.metallic === 'number' ? part.metallic : 0.25),
        roughnessFactor: typeof mat.roughness === 'number' ? mat.roughness : (typeof part.roughness === 'number' ? part.roughness : 0.48),
        ...(mat.emissive ? { emissiveFactor: resolveColor(mat.emissive).slice(0, 3) } : {})
      }
    };
  });

  return buildGlbFromParts({ parts: compiledParts, generator: 'meshforge-mcp-procedural' });
}

// ============================================================================
// Pure-Code Semantic Prompt -> Multi-Part 3D Archetype Compiler
// ============================================================================

function detectPromptStyle(prompt) {
  const lower = String(prompt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let primaryColor = [0.78, 0.54, 0.36, 1];
  let secondaryColor = [0.16, 0.16, 0.18, 1];
  let metallic = 0.25;
  let roughness = 0.48;

  for (const [key, rgb] of Object.entries(COLOR_MAP)) {
    if (new RegExp(`\\b${key}\\b`).test(lower)) {
      primaryColor = [...rgb, 1];
      break;
    }
  }
  if (/\b(metal|metallic|metalico|aluminum|aluminio|steel|aco|chrome|cromado|copper|cobre|gold|ouro|dourado|silver|prata|titanium|titanio|iron|ferro)\b/.test(lower)) {
    metallic = 0.88;
    roughness = 0.24;
  } else if (/\b(ceramic|ceramica|porcelain|glossy|brilhante|glass|vidro)\b/.test(lower)) {
    metallic = 0.05;
    roughness = 0.18;
  } else if (/\b(wood|madeira|matte|fosco|fabric|tecido|stone|pedra)\b/.test(lower)) {
    metallic = 0.04;
    roughness = 0.82;
  }
  const lowPoly = /\b(low.?poly|voxel|pixel|blocky)\b/.test(lower);
  return { lower, primaryColor, secondaryColor, metallic, roughness, lowPoly };
}

function buildHeadphoneRecipe(style) {
  return {
    parts: [
      {
        name: 'HeadbandOuter',
        type: 'tube',
        radius: 0.085,
        segments: 56,
        points: [[-0.95, 0.15, 0], [-1.02, 0.82, 0], [-0.68, 1.44, 0], [0, 1.66, 0], [0.68, 1.44, 0], [1.02, 0.82, 0], [0.95, 0.15, 0]],
        material: { name: 'BandMetal', color: style.primaryColor, metallic: 0.86, roughness: 0.24 }
      },
      {
        name: 'HeadbandPad',
        type: 'tube',
        radius: 0.075,
        segments: 48,
        points: [[-0.85, 0.34, 0], [-0.82, 0.92, 0], [-0.55, 1.38, 0], [0, 1.54, 0], [0.55, 1.38, 0], [0.82, 0.92, 0], [0.85, 0.34, 0]],
        material: { name: 'InnerCushion', color: style.secondaryColor, metallic: 0.05, roughness: 0.86 }
      },
      { name: 'LeftShell', type: 'cylinder', radius: 0.44, height: 0.22, position: [-0.94, -0.28, 0], rotation: [0, 0, Math.PI / 2], scale: [1.14, 1, 1], material: { color: style.secondaryColor, metallic: 0.45, roughness: 0.3 } },
      { name: 'LeftTrim', type: 'torus', majorRadius: 0.44, minorRadius: 0.028, position: [-1.05, -0.28, 0], rotation: [0, 0, Math.PI / 2], scale: [1.14, 1, 1], material: { color: style.primaryColor, metallic: 0.88, roughness: 0.22 } },
      { name: 'LeftCushion', type: 'torus', majorRadius: 0.38, minorRadius: 0.11, position: [-0.82, -0.28, 0], rotation: [0, 0, Math.PI / 2], scale: [1.14, 1, 1], material: { color: [0.09, 0.09, 0.1, 1], metallic: 0.04, roughness: 0.88 } },
      { name: 'RightShell', type: 'cylinder', radius: 0.44, height: 0.22, position: [0.94, -0.28, 0], rotation: [0, 0, Math.PI / 2], scale: [1.14, 1, 1], material: { color: style.secondaryColor, metallic: 0.45, roughness: 0.3 } },
      { name: 'RightTrim', type: 'torus', majorRadius: 0.44, minorRadius: 0.028, position: [1.05, -0.28, 0], rotation: [0, 0, Math.PI / 2], scale: [1.14, 1, 1], material: { color: style.primaryColor, metallic: 0.88, roughness: 0.22 } },
      { name: 'RightCushion', type: 'torus', majorRadius: 0.38, minorRadius: 0.11, position: [0.82, -0.28, 0], rotation: [0, 0, Math.PI / 2], scale: [1.14, 1, 1], material: { color: [0.09, 0.09, 0.1, 1], metallic: 0.04, roughness: 0.88 } },
      { name: 'StandHalo', type: 'torus', majorRadius: 1.15, minorRadius: 0.015, position: [0, -1.05, 0], material: { color: style.primaryColor, metallic: 0.9, roughness: 0.25 } }
    ]
  };
}

function buildMugRecipe(style) {
  return {
    parts: [
      {
        name: 'CupBody',
        type: 'lathe',
        segments: style.lowPoly ? 12 : 40,
        points: [[0, -0.5], [0.42, -0.5], [0.46, -0.45], [0.48, 0.48], [0.46, 0.52], [0.41, 0.52], [0.39, -0.4], [0, -0.4]],
        material: { name: 'Ceramic', color: style.primaryColor, metallic: style.metallic, roughness: style.roughness }
      },
      {
        name: 'Handle',
        type: 'tube',
        radius: 0.065,
        segments: 32,
        points: [[0.43, 0.28, 0], [0.76, 0.26, 0], [0.8, 0, 0], [0.75, -0.26, 0], [0.42, -0.28, 0]],
        material: { name: 'CeramicHandle', color: style.primaryColor, metallic: style.metallic, roughness: style.roughness }
      }
    ]
  };
}

function buildVaseOrBottleRecipe(style, isBottle) {
  const points = isBottle
    ? [[0, -0.8], [0.38, -0.8], [0.42, -0.72], [0.42, 0.1], [0.16, 0.42], [0.16, 0.8], [0.19, 0.84], [0.12, 0.84], [0.12, 0.42], [0, 0.35]]
    : [[0, -0.75], [0.32, -0.75], [0.54, -0.2], [0.46, 0.35], [0.28, 0.72], [0.33, 0.78], [0.27, 0.78], [0.22, 0.68], [0, -0.62]];
  return {
    parts: [
      {
        name: isBottle ? 'BottleBody' : 'VaseBody',
        type: 'lathe',
        segments: style.lowPoly ? 12 : 44,
        points,
        material: { color: style.primaryColor, metallic: style.metallic, roughness: style.roughness }
      }
    ]
  };
}

function buildChairRecipe(style) {
  const legPos = [[-0.42, -0.45, -0.42], [0.42, -0.45, -0.42], [-0.42, -0.45, 0.42], [0.42, -0.45, 0.42]];
  return {
    parts: [
      { name: 'Seat', type: 'box', size: [1.0, 0.1, 1.0], position: [0, 0.05, 0], material: { color: style.primaryColor, metallic: style.metallic, roughness: style.roughness } },
      { name: 'Backrest', type: 'box', size: [1.0, 0.9, 0.1], position: [0, 0.55, -0.45], material: { color: style.primaryColor, metallic: style.metallic, roughness: style.roughness } },
      ...legPos.map((p, i) => ({ name: `Leg_${i}`, type: 'cylinder', radius: 0.045, height: 0.9, position: p, material: { color: style.secondaryColor, metallic: 0.6, roughness: 0.35 } }))
    ]
  };
}

function buildRocketRecipe(style) {
  const fins = [0, 1, 2, 3].map((i) => {
    const a = (i * Math.PI) / 2;
    return {
      name: `Fin_${i}`,
      type: 'box',
      size: [0.06, 0.42, 0.34],
      position: [Math.sin(a) * 0.36, -0.58, Math.cos(a) * 0.36],
      rotation: [0, a, 0],
      material: { color: [0.85, 0.32, 0.16, 1], metallic: 0.4, roughness: 0.35 }
    };
  });
  return {
    parts: [
      { name: 'Fuselage', type: 'lathe', segments: 32, points: [[0, -0.8], [0.28, -0.8], [0.36, -0.2], [0.32, 0.45], [0, 1.05]], material: { color: style.primaryColor, metallic: 0.72, roughness: 0.28 } },
      { name: 'Nozzle', type: 'cylinder', radiusTop: 0.2, radiusBottom: 0.3, height: 0.24, position: [0, -0.92, 0], material: { color: [0.18, 0.18, 0.2, 1], metallic: 0.9, roughness: 0.3 } },
      { name: 'Window', type: 'sphere', radius: 0.12, position: [0, 0.25, 0.29], material: { color: [0.2, 0.72, 0.95, 1], metallic: 0.1, roughness: 0.12, emissive: [0.1, 0.45, 0.7] } },
      ...fins
    ]
  };
}

function buildSwordRecipe(style) {
  return {
    parts: [
      { name: 'Blade', type: 'box', size: [0.12, 1.55, 0.035], position: [0, 0.55, 0], material: { color: [0.82, 0.84, 0.88, 1], metallic: 0.94, roughness: 0.16 } },
      { name: 'Tip', type: 'cone', radius: 0.085, height: 0.26, position: [0, 1.45, 0], scale: [0.75, 1, 0.25], material: { color: [0.82, 0.84, 0.88, 1], metallic: 0.94, roughness: 0.16 } },
      { name: 'Crossguard', type: 'box', size: [0.58, 0.07, 0.1], position: [0, -0.24, 0], material: { color: style.primaryColor, metallic: 0.86, roughness: 0.25 } },
      { name: 'Grip', type: 'cylinder', radius: 0.042, height: 0.44, position: [0, -0.49, 0], material: { color: [0.22, 0.14, 0.1, 1], metallic: 0.05, roughness: 0.82 } },
      { name: 'Pommel', type: 'sphere', radius: 0.075, position: [0, -0.74, 0], material: { color: style.primaryColor, metallic: 0.88, roughness: 0.22 } }
    ]
  };
}

function buildGearRecipe(style) {
  const teeth = 12;
  const pts = [];
  for (let i = 0; i < teeth * 2; i += 1) {
    const a1 = (i / (teeth * 2)) * Math.PI * 2;
    const a2 = ((i + 0.5) / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 0.85 : 0.65;
    pts.push([Math.cos(a1) * r, Math.sin(a1) * r]);
    pts.push([Math.cos(a2) * r, Math.sin(a2) * r]);
  }
  return {
    parts: [
      { name: 'GearBody', type: 'extrude', polygon: pts, depth: 0.22, material: { color: style.primaryColor, metallic: 0.88, roughness: 0.25 } },
      { name: 'CenterHub', type: 'cylinder', radius: 0.24, height: 0.28, rotation: [Math.PI / 2, 0, 0], material: { color: style.secondaryColor, metallic: 0.85, roughness: 0.3 } }
    ]
  };
}

function buildLampRecipe(style) {
  return {
    parts: [
      { name: 'Base', type: 'cylinder', radiusTop: 0.32, radiusBottom: 0.38, height: 0.1, position: [0, -0.75, 0], material: { color: style.secondaryColor, metallic: 0.8, roughness: 0.3 } },
      { name: 'Stem', type: 'cylinder', radius: 0.04, height: 1.0, position: [0, -0.22, 0], material: { color: style.primaryColor, metallic: 0.85, roughness: 0.25 } },
      { name: 'Shade', type: 'lathe', segments: 36, points: [[0.14, 0.62], [0.46, 0.16], [0.42, 0.16], [0.12, 0.58]], material: { color: style.primaryColor, metallic: style.metallic, roughness: style.roughness } },
      { name: 'Bulb', type: 'sphere', radius: 0.11, position: [0, 0.36, 0], material: { color: [1, 0.92, 0.72, 1], metallic: 0, roughness: 0.2, emissive: [0.95, 0.78, 0.42] } }
    ]
  };
}

function buildRobotRecipe(style) {
  return {
    parts: [
      { name: 'Torso', type: 'box', size: [0.74, 0.82, 0.46], position: [0, 0, 0], material: { color: style.primaryColor, metallic: 0.75, roughness: 0.3 } },
      { name: 'Head', type: 'box', size: [0.54, 0.42, 0.42], position: [0, 0.7, 0], material: { color: style.primaryColor, metallic: 0.75, roughness: 0.28 } },
      { name: 'Visor', type: 'box', size: [0.42, 0.14, 0.06], position: [0, 0.72, 0.2], material: { color: [0.15, 0.8, 0.95, 1], metallic: 0.2, roughness: 0.15, emissive: [0.1, 0.65, 0.85] } },
      { name: 'LeftArm', type: 'cylinder', radius: 0.09, height: 0.72, position: [-0.52, -0.04, 0], material: { color: style.secondaryColor, metallic: 0.7, roughness: 0.35 } },
      { name: 'RightArm', type: 'cylinder', radius: 0.09, height: 0.72, position: [0.52, -0.04, 0], material: { color: style.secondaryColor, metallic: 0.7, roughness: 0.35 } },
      { name: 'LeftLeg', type: 'cylinder', radius: 0.11, height: 0.65, position: [-0.2, -0.74, 0], material: { color: style.secondaryColor, metallic: 0.7, roughness: 0.35 } },
      { name: 'RightLeg', type: 'cylinder', radius: 0.11, height: 0.65, position: [0.2, -0.74, 0], material: { color: style.secondaryColor, metallic: 0.7, roughness: 0.35 } }
    ]
  };
}

function buildPonyRecipe(style, isUnicorn = false) {
  const coat = style.primaryColor && (style.primaryColor[0] !== 0.78 || style.primaryColor[1] !== 0.54)
    ? style.primaryColor
    : [0.48, 0.21, 0.08, 1];
  const mane = [0.05, 0.03, 0.02, 1];
  const hoof = [0.03, 0.025, 0.025, 1];
  const eye = [0.015, 0.015, 0.02, 1];
  const muzzle = [0.68, 0.44, 0.30, 1];

  const parts = [
    {
      name: 'PonyBodySdf',
      type: 'sdf',
      bounds: 1.45,
      resolution: style.lowPoly ? 20 : 40,
      sdf: {
        op: 'smoothUnion',
        k: 0.16,
        children: [
          { shape: 'sphere', radius: 0.37, position: [0, 0.12, 0.0] },
          { shape: 'sphere', radius: 0.34, position: [0, 0.14, 0.24] },
          { shape: 'sphere', radius: 0.35, position: [0, 0.14, -0.24] },
          { shape: 'sphere', radius: 0.21, position: [0, 0.41, 0.43] },
          { shape: 'sphere', radius: 0.18, position: [0, 0.62, 0.51] },
          { shape: 'sphere', radius: 0.19, position: [0, 0.80, 0.59] },
          { shape: 'sphere', radius: 0.12, position: [0, 0.73, 0.77] },
          { shape: 'sphere', radius: 0.095, position: [0, 0.69, 0.89] }
        ]
      },
      material: { name: 'PonyCoat', color: coat, metallic: 0.04, roughness: 0.58 }
    },
    { name: 'MuzzleTip', type: 'sphere', radius: 0.11, position: [0, 0.68, 0.90], scale: [1.1, 0.9, 0.95], material: { name: 'Muzzle', color: muzzle, metallic: 0.02, roughness: 0.68 } },
    { name: 'NostrilL', type: 'sphere', radius: 0.022, position: [-0.048, 0.70, 0.99], material: { color: hoof, roughness: 0.5 } },
    { name: 'NostrilR', type: 'sphere', radius: 0.022, position: [0.048, 0.70, 0.99], material: { color: hoof, roughness: 0.5 } },
    { name: 'EarLeft', type: 'cone', radius: 0.065, height: 0.21, position: [-0.115, 1.03, 0.54], rotation: [0.18, 0, 0.22], material: { color: coat, metallic: 0.04, roughness: 0.58 } },
    { name: 'EarRight', type: 'cone', radius: 0.065, height: 0.21, position: [0.115, 1.03, 0.54], rotation: [0.18, 0, -0.22], material: { color: coat, metallic: 0.04, roughness: 0.58 } },
    { name: 'EyeLeft', type: 'sphere', radius: 0.048, position: [-0.145, 0.84, 0.71], material: { name: 'EyeGloss', color: eye, metallic: 0.15, roughness: 0.08 } },
    { name: 'EyeRight', type: 'sphere', radius: 0.048, position: [0.145, 0.84, 0.71], material: { name: 'EyeGloss', color: eye, metallic: 0.15, roughness: 0.08 } },
    { name: 'EyeSparkL', type: 'sphere', radius: 0.014, position: [-0.172, 0.858, 0.742], material: { name: 'EyeCatchlight', color: [1, 1, 1, 1], roughness: 0.1, emissive: [0.9, 0.9, 0.9] } },
    { name: 'EyeSparkR', type: 'sphere', radius: 0.014, position: [0.172, 0.858, 0.742], material: { name: 'EyeCatchlight', color: [1, 1, 1, 1], roughness: 0.1, emissive: [0.9, 0.9, 0.9] } },

    // Four articulated legs + hooves
    { name: 'FrontLegL', type: 'cylinder', radiusTop: 0.102, radiusBottom: 0.072, height: 0.56, position: [-0.19, -0.37, 0.26], material: { color: coat, metallic: 0.04, roughness: 0.6 } },
    { name: 'FrontLegR', type: 'cylinder', radiusTop: 0.102, radiusBottom: 0.072, height: 0.56, position: [0.19, -0.37, 0.26], material: { color: coat, metallic: 0.04, roughness: 0.6 } },
    { name: 'BackLegUpperL', type: 'cylinder', radiusTop: 0.132, radiusBottom: 0.095, height: 0.36, position: [-0.20, -0.24, -0.26], material: { color: coat, metallic: 0.04, roughness: 0.6 } },
    { name: 'BackLegUpperR', type: 'cylinder', radiusTop: 0.132, radiusBottom: 0.095, height: 0.36, position: [0.20, -0.24, -0.26], material: { color: coat, metallic: 0.04, roughness: 0.6 } },
    { name: 'BackLegLowerL', type: 'cylinder', radiusTop: 0.088, radiusBottom: 0.072, height: 0.32, position: [-0.20, -0.50, -0.29], material: { color: coat, metallic: 0.04, roughness: 0.6 } },
    { name: 'BackLegLowerR', type: 'cylinder', radiusTop: 0.088, radiusBottom: 0.072, height: 0.32, position: [0.20, -0.50, -0.29], material: { color: coat, metallic: 0.04, roughness: 0.6 } },

    { name: 'HoofFL', type: 'cylinder', radiusTop: 0.075, radiusBottom: 0.092, height: 0.10, position: [-0.19, -0.68, 0.26], material: { color: hoof, metallic: 0.12, roughness: 0.42 } },
    { name: 'HoofFR', type: 'cylinder', radiusTop: 0.075, radiusBottom: 0.092, height: 0.10, position: [0.19, -0.68, 0.26], material: { color: hoof, metallic: 0.12, roughness: 0.42 } },
    { name: 'HoofBL', type: 'cylinder', radiusTop: 0.075, radiusBottom: 0.092, height: 0.10, position: [-0.20, -0.68, -0.29], material: { color: hoof, metallic: 0.12, roughness: 0.42 } },
    { name: 'HoofBR', type: 'cylinder', radiusTop: 0.075, radiusBottom: 0.092, height: 0.10, position: [0.20, -0.68, -0.29], material: { color: hoof, metallic: 0.12, roughness: 0.42 } },

    // Flowing mane & forelock
    {
      name: 'ManeCenter',
      type: 'tube',
      radius: 0.082,
      segments: 36,
      points: [[0, 0.97, 0.72], [0, 1.03, 0.56], [0, 0.90, 0.39], [0, 0.68, 0.28], [0, 0.44, 0.21]],
      material: { name: 'ManeHair', color: mane, metallic: 0.04, roughness: 0.72 }
    },
    {
      name: 'ManeSideL',
      type: 'tube',
      radius: 0.062,
      segments: 30,
      points: [[-0.04, 0.96, 0.56], [-0.14, 0.80, 0.42], [-0.17, 0.56, 0.33], [-0.15, 0.36, 0.25]],
      material: { color: mane, metallic: 0.04, roughness: 0.72 }
    },
    // Flowing curved tail
    {
      name: 'TailCore',
      type: 'tube',
      radius: 0.092,
      segments: 38,
      points: [[0, 0.28, -0.56], [0, 0.25, -0.79], [0.02, 0.02, -0.94], [0.04, -0.28, -0.92], [0.02, -0.54, -0.82]],
      material: { color: mane, metallic: 0.04, roughness: 0.72 }
    },
    {
      name: 'TailStrand',
      type: 'tube',
      radius: 0.062,
      segments: 32,
      points: [[0, 0.25, -0.60], [-0.08, 0.12, -0.85], [-0.10, -0.18, -0.97], [-0.05, -0.48, -0.90]],
      material: { color: mane, metallic: 0.04, roughness: 0.72 }
    },
    {
      name: 'Plinth',
      type: 'cylinder',
      radiusTop: 0.85,
      radiusBottom: 0.90,
      height: 0.07,
      position: [0, -0.765, 0],
      material: { name: 'Plinth', color: [0.04, 0.04, 0.045, 1], metallic: 0.28, roughness: 0.5 }
    }
  ];

  if (isUnicorn) {
    parts.push({
      name: 'UnicornHorn',
      type: 'cone',
      radius: 0.055,
      height: 0.36,
      position: [0, 1.08, 0.72],
      rotation: [0.42, 0, 0],
      material: { name: 'GoldHorn', color: [0.92, 0.76, 0.32, 1], metallic: 0.9, roughness: 0.18 }
    });
  }

  return { parts };
}

function buildOrganicSdfRecipe(style) {
  return {
    parts: [
      {
        name: 'SculptedSdfBody',
        type: 'sdf',
        bounds: 1.35,
        resolution: style.lowPoly ? 16 : 26,
        sdf: {
          op: 'smoothUnion',
          k: 0.24,
          children: [
            { shape: 'sphere', radius: 0.58, position: [0, 0, 0] },
            { shape: 'torus', majorRadius: 0.68, minorRadius: 0.16, position: [0, -0.1, 0] },
            { shape: 'sphere', radius: 0.34, position: [0, 0.56, 0] }
          ]
        },
        material: { color: style.primaryColor, metallic: style.metallic, roughness: style.roughness }
      }
    ]
  };
}

/**
 * Compiles a text prompt purely in code (zero API keys) into a GLB Buffer.
 */
function generateFromPromptPureCode(prompt, { scene = null } = {}) {
  if (scene && Array.isArray(scene.parts)) {
    return { glb: compileSceneToGlb(scene), archetype: 'custom-scene-dsl' };
  }

  const style = detectPromptStyle(prompt);
  const text = style.lower;
  let recipe;
  let archetype;

  if (/\b(headphones?|fones?|auricular(?:es)?|earcups?|headsets?)\b/.test(text)) {
    recipe = buildHeadphoneRecipe(style); archetype = 'headphone';
  } else if (/\b(mugs?|cups?|canecas?|xicaras?|espresso|coffee)\b/.test(text)) {
    recipe = buildMugRecipe(style); archetype = 'mug';
  } else if (/\b(bottles?|garrafas?|flasks?|cantis|cantil)\b/.test(text)) {
    recipe = buildVaseOrBottleRecipe(style, true); archetype = 'bottle';
  } else if (/\b(vases?|vasos?|pots?|jarros?|urns?)\b/.test(text)) {
    recipe = buildVaseOrBottleRecipe(style, false); archetype = 'vase';
  } else if (/\b(chairs?|cadeiras?|seats?|poltronas?)\b/.test(text)) {
    recipe = buildChairRecipe(style); archetype = 'chair';
  } else if (/\b(rockets?|foguetes?|spaceships?|naves?)\b/.test(text)) {
    recipe = buildRocketRecipe(style); archetype = 'rocket';
  } else if (/\b(swords?|espadas?|blades?|katanas?|daggers?)\b/.test(text)) {
    recipe = buildSwordRecipe(style); archetype = 'sword';
  } else if (/\b(gears?|engrenagens?|engrenagem|cogs?|sprockets?)\b/.test(text)) {
    recipe = buildGearRecipe(style); archetype = 'gear';
  } else if (/\b(lamps?|luminarias?|abajur(?:es)?|lanterns?)\b/.test(text)) {
    recipe = buildLampRecipe(style); archetype = 'lamp';
  } else if (/\b(robots?|robos?|droids?|bots?|mechas?)\b/.test(text)) {
    recipe = buildRobotRecipe(style); archetype = 'robot';
  } else if (/\b(rings?|aneis|anel|torus|donuts?)\b/.test(text)) {
    recipe = { parts: [{ name: 'Ring', type: 'torus', majorRadius: 0.62, minorRadius: 0.16, segments: 44, tubeSegments: 24, material: { color: style.primaryColor, metallic: 0.9, roughness: 0.2 } }] };
    archetype = 'ring';
  } else if (/\b(crystals?|cristais|cristal|gems?|prisms?|prismas?)\b/.test(text)) {
    recipe = {
      parts: [
        { name: 'CrystalUpper', type: 'cone', radius: 0.45, height: 1.1, position: [0, 0.35, 0], segments: 6, material: { color: style.primaryColor, metallic: 0.15, roughness: 0.12 } },
        { name: 'CrystalLower', type: 'cone', radius: 0.45, height: 0.55, position: [0, -0.47, 0], rotation: [Math.PI, 0, 0], segments: 6, material: { color: style.primaryColor, metallic: 0.15, roughness: 0.12 } }
      ]
    };
    archetype = 'crystal';
  } else if (/\b(pon(?:y|ies|ei|eis)|horses?|cavalos?|unicorns?|unicornios?)\b/.test(text)) {
    const isUnicorn = /\b(unicorns?|unicornios?)\b/.test(text);
    recipe = buildPonyRecipe(style, isUnicorn); archetype = isUnicorn ? 'unicorn' : 'pony';
  } else {
    recipe = buildOrganicSdfRecipe(style);
    archetype = 'sdf-sculpture';
  }

  return { glb: compileSceneToGlb(recipe), archetype };
}

module.exports = {
  compileSceneToGlb,
  generateFromPromptPureCode,
  makeSdfGeometry
};
