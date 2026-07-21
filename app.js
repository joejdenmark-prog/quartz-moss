import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _noiseData = (() => {
  const size = 96000;
  const data = new Float32Array(size);
  let lastOut = 0;
  for (let i = 0; i < size; i++) {
    const white = Math.random() * 2 - 1;
    lastOut = (lastOut + 0.02 * white) / 1.02;
    data[i] = lastOut * 3.5;
  }
  return data;
})();



// ── Renderer / scene / camera ───────────────────────────────────────────────

let W = window.innerWidth, H = window.innerHeight;

const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById('canvas'),
  antialias: true,
});
const isMobile = window.matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(isMobile ? Math.min(window.devicePixelRatio, 1.5) : Math.min(window.devicePixelRatio, 2));
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060e04);
scene.fog = new THREE.Fog(0x060e04, 28, 50);


const PLANE_W = 26;
const PLANE_D = 46.8;

const ORTHO_H = 10;
const camera = new THREE.OrthographicCamera(
  -(W / H) * ORTHO_H, (W / H) * ORTHO_H,
  ORTHO_H, -ORTHO_H,
  0.1, 100
);
const CAM_POS    = new THREE.Vector3(0, 14, 6.5);
const CAM_TARGET = new THREE.Vector3(0, 0, -8);
camera.position.copy(CAM_POS);
camera.lookAt(CAM_TARGET);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    W = window.innerWidth; H = window.innerHeight;
    camera.left   = -(W / H) * ORTHO_H;
    camera.right  =  (W / H) * ORTHO_H;
    camera.top    =  ORTHO_H;
    camera.bottom = -ORTHO_H;
    camera.updateProjectionMatrix();
    renderer.setSize(W, H);
  }, 250);
});

// ── Lights ───────────────────────────────────────────────────────────────────

scene.add(new THREE.HemisphereLight(0xa0b8c8, 0x141e08, 0.52));

const sun = new THREE.DirectionalLight(0xfff0d8, 1.2);
sun.position.set(-5, 18, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far  = 55;
sun.shadow.camera.left   = -22;
sun.shadow.camera.right  =  22;
sun.shadow.camera.top    =  28;
sun.shadow.camera.bottom = -16;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const fill = new THREE.DirectionalLight(0x7090b0, 0.20);
fill.position.set(8, 6, -10);
scene.add(fill);

const back = new THREE.DirectionalLight(0xffe8c0, 0.10);
back.position.set(0, 4, -22);
scene.add(back);

// Dew-catch light — cool white point light above the moss for subtle rim highlights.
const dewLight = new THREE.PointLight(0xd8f0e8, 0.45, 40, 2);
dewLight.position.set(0, 6, -8);
scene.add(dewLight);


// ── Seeded RNG (deterministic layout across reloads) ──────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng       = mulberry32(0xc0ffee);
const range     = (a, b) => a + rng() * (b - a);
const intRng    = (a, b) => Math.floor(range(a, b + 1));
const texRng    = mulberry32(0xf4c3e1); // isolated seed — texture uses this, layout uses rng
const texRange  = (a, b) => a + texRng() * (b - a);
const texIntRng = (a, b) => Math.floor(texRange(a, b + 1));

// ── Moss strand system ────────────────────────────────────────────────────────
// All visual moss texture comes from 3-D instanced ribbon geometry rather than
// a flat canvas texture. Each strand is a thin bezier ribbon that curves upward
// from y=0; thousands of instances create the carpet density and visible depth.

// Placeholder drawFiber to allow quick-access later if needed:
function drawFiber(ctx, x, y, color, alpha) {
  const len = texRange(2, 7);
  const ang = texRng() * Math.PI * 2;
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = texRange(0.5, 1.5);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
  ctx.stroke();
}

// ── Strand ribbon geometry ────────────────────────────────────────────────────
// Each strand is a 5-segment ribbon following a cubic bezier from ground (y=0)
// upward. lean = sideways drift at tip; coil = depth curl at tip. Two-sided so
// the ribbon is visible from both front and back (camera can see either face).

function makeStrandGeo(height, lean, coil) {
  const SEGS = 9;
  const BW = 0.022; // thin but visible — tapers 92% toward tip
  const P = [], UV = [], IDX = [];

  for (let i = 0; i <= SEGS; i++) {
    const t = i / SEGS, mt = 1 - t;
    // 3-D helical curl: Z has S-bend, X gets a sinusoidal bulge so the strand
    // spirals in both axes — looks coiled from any camera angle.
    const xBase = 3*mt*mt*t*(lean*0.20) + 3*mt*t*t*(lean*0.78) + t*t*t*lean;
    const x = xBase + coil * 0.42 * Math.sin(t * Math.PI);
    const y = 3*mt*mt*t*(height*0.30) + 3*mt*t*t*(height*0.75) + t*t*t*height;
    const z = 3*mt*mt*t*(-coil*0.25) + 3*mt*t*t*(coil*1.65) + t*t*t*(coil*0.65);
    const w = BW * (1 - t * 0.92);
    P.push(x-w/2, y, z,   x+w/2, y, z);
    UV.push(0, t,  1, t);
  }
  for (let i = 0; i < SEGS; i++) {
    const a=i*2, b=i*2+1, c=i*2+2, d=i*2+3;
    // Single winding (normal toward +Z = toward camera/sun side).
    // DoubleSide on the material renders the back automatically — adding
    // explicit back triangles here would make computeVertexNormals() average
    // opposing normals to zero, killing all directional lighting.
    IDX.push(a,b,c, b,d,c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(UV, 2));
  geo.setIndex(IDX);
  geo.computeVertexNormals();
  return geo;
}

// ── Organic cluster boundary ──────────────────────────────────────────────────
// Returns a signed-density function (0=outside, 1=centre) for a non-circular
// irregular moss clump whose boundary is shaped by Fourier harmonics.

function makeClusterFn(cx, cz, baseR, terms) {
  return (x, z) => {
    const dx = x-cx, dz = z-cz;
    const dist = Math.sqrt(dx*dx + dz*dz);
    if (dist > baseR * 1.9) return 0;
    const angle = Math.atan2(dz, dx);
    let r = baseR;
    for (const { amp, freq, phase } of terms) r += amp * Math.sin(angle*freq + phase);
    r = Math.max(baseR * 0.15, r);
    return dist < r ? (1 - dist/r) : 0;
  };
}

// ── Full strand instancing system ─────────────────────────────────────────────

function buildMossStrandSystem() {
  // Isolated RNG so strand placement never shifts crystals or rocks.
  const rng   = mulberry32(0x7a5c3e);
  const randf = (a, b) => a + rng() * (b-a);
  const randi = (a, b) => Math.floor(randf(a, b+1));

  // 4 shape variants — all short with heavy curl ratios for tight coiled look
  const geos = [
    makeStrandGeo(0.22, 0.032, 0.28),   // short tight spiral
    makeStrandGeo(0.28, 0.060, 0.40),   // medium heavy curl
    makeStrandGeo(0.17, 0.018, 0.52),   // very short, very tight coil
    makeStrandGeo(0.36, 0.042, 0.18),   // slightly taller, moderate curl
  ];

  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.28, metalness: 0.13, emissive: 0x000000,
    side: THREE.DoubleSide,
    normalMap: mossNormalTex,
    normalScale: new THREE.Vector2(0.75, 0.75),
  });

  const TOTAL  = isMobile ? 20000 : 37000;
  const COUNTS = [0.28, 0.28, 0.22, 0.22].map(f => Math.round(TOTAL * f));
  const meshes = geos.map((g, i) => new THREE.InstancedMesh(g, mat, COUNTS[i]));

  // ── 44 general clusters ───────────────────────────────────────────────────
  const clusters    = [];  // density functions
  const clusterMeta = [];  // {cx, cz, baseR} for forced placement passes
  for (let c = 0; c < 44; c++) {
    const cx     = (rng()*2-1) * PLANE_W * 0.46;
    const cz     = (rng()*2-1) * PLANE_D * 0.46;
    const baseR  = randf(0.70, 2.10);
    const nTerms = randi(3, 5);
    const terms  = [];
    for (let t = 0; t < nTerms; t++) {
      terms.push({ amp: randf(0.10, 0.38)*baseR, freq: randi(2,5), phase: rng()*Math.PI*2 });
    }
    clusters.push(makeClusterFn(cx, cz, baseR, terms));
    clusterMeta.push({ cx, cz, baseR });
  }

  // ── 16 extra clusters biased to the left side (negative X) ───────────────
  for (let c = 0; c < 16; c++) {
    const cx     = randf(-PLANE_W*0.46, -PLANE_W*0.08);
    const cz     = (rng()*2-1) * PLANE_D * 0.46;
    const baseR  = randf(0.80, 1.80);
    const nTerms = randi(3, 5);
    const terms  = [];
    for (let t = 0; t < nTerms; t++) {
      terms.push({ amp: randf(0.12, 0.40)*baseR, freq: randi(2,5), phase: rng()*Math.PI*2 });
    }
    clusters.push(makeClusterFn(cx, cz, baseR, terms));
    clusterMeta.push({ cx, cz, baseR });
  }

  // ── 42 more general clusters spread across entire plane for even coverage ───
  for (let c = 0; c < 42; c++) {
    const cx     = (rng()*2-1) * PLANE_W * 0.46;
    const cz     = (rng()*2-1) * PLANE_D * 0.46;
    const baseR  = randf(0.60, 1.60);
    const nTerms = randi(3, 5);
    const terms  = [];
    for (let t = 0; t < nTerms; t++) {
      terms.push({ amp: randf(0.10, 0.36)*baseR, freq: randi(2,5), phase: rng()*Math.PI*2 });
    }
    clusters.push(makeClusterFn(cx, cz, baseR, terms));
    clusterMeta.push({ cx, cz, baseR });
  }

  // ── Luscious pinned clump: hard left, vertical centre of viewport ─────────
  const LUSH_X = -7.2, LUSH_Z = -7.0, LUSH_R = 2.8;
  clusters.push(makeClusterFn(LUSH_X, LUSH_Z, LUSH_R, [
    { amp: 0.72, freq: 3, phase: 0.9 },
    { amp: 0.50, freq: 5, phase: 2.4 },
    { amp: 0.35, freq: 2, phase: 4.2 },
    { amp: 0.22, freq: 7, phase: 1.1 },
  ]));
  clusterMeta.push({ cx: LUSH_X, cz: LUSH_Z, baseR: LUSH_R });

  function clusterDensity(x, z) {
    let best = 0;
    for (const fn of clusters) { const d = fn(x, z); if (d > best) best = d; }
    return best;
  }

  // ── Per-instance placement ────────────────────────────────────────────────
  const mx    = new THREE.Matrix4();
  const pos   = new THREE.Vector3();
  const quat  = new THREE.Quaternion();
  const scl   = new THREE.Vector3();
  const euler = new THREE.Euler();
  const col   = new THREE.Color();
  const typeIdx = [0,0,0,0];

  // Background = deep dark forest green, clumps = richer mid-emerald so the
  // denser cluster patches read as distinctly brighter than the base carpet.
  const bgPalette    = [0x062804,0x073005,0x052103,0x083506,0x062c04,0x041d02,0x073205].map(h=>new THREE.Color(h));
  const clumpPalette = [0x083a0a,0x0a3f0c,0x073508,0x0c450e,0x093d0b,0x063008,0x0b420d].map(h=>new THREE.Color(h));

  function placeStrand(x, z, isClump) {
    const gi  = randi(0, 3);
    const ti  = typeIdx[gi];
    if (ti >= COUNTS[gi]) return;
    typeIdx[gi]++;

    pos.set(x, 0, z);
    const yRot    = rng() * Math.PI * 2;
    const tilt    = randf(0.10, isClump ? 0.62 : 0.58);
    const tiltDir = rng() * Math.PI * 2;
    euler.set(Math.cos(tiltDir)*tilt, yRot, Math.sin(tiltDir)*tilt, 'YXZ');
    quat.setFromEuler(euler);
    const hs = isClump ? randf(1.00, 1.60) : randf(0.65, 1.15);
    const ws = randf(0.85, 1.45) * 1.18; // wider per-strand to offset lower density
    scl.set(ws, hs, ws);
    mx.compose(pos, quat, scl);
    meshes[gi].setMatrixAt(ti, mx);

    const palette = isClump ? clumpPalette : bgPalette;
    col.copy(palette[randi(0, palette.length-1)]).multiplyScalar(randf(0.92, 1.18));
    meshes[gi].setColorAt(ti, col);
  }

  // ── Per-cluster dense forced placement ────────────────────────────────────
  // Each clump: full-radius elliptical disk. Strands at the edge progressively
  // switch to background colour so the clump blends naturally into the carpet.
  const CLUSTER_DENSITY = 60;
  let totalClumpStrands = 0;
  for (const { cx, cz, baseR } of clusterMeta) {
    const coreR = baseR * 1.3;
    const sX    = randf(0.5, 2.2);
    const sZ    = randf(0.5, 2.2);
    const rot   = rng() * Math.PI;
    const cosR  = Math.cos(rot), sinR = Math.sin(rot);
    const count = Math.round(Math.PI * coreR * coreR * CLUSTER_DENSITY);
    totalClumpStrands += count;
    for (let i = 0; i < count; i++) {
      const angle        = rng() * Math.PI * 2;
      const normR        = Math.pow(rng(), 0.55);   // 0=centre … 1=edge
      const radius       = coreR * normR;
      const lx           = Math.cos(angle) * radius * sX;
      const lz           = Math.sin(angle) * radius * sZ;
      const isClumpStrand = rng() > normR * 0.75;  // edge strands fade to bg
      const x = cx + lx*cosR - lz*sinR;
      const z = cz + lx*sinR + lz*cosR;
      const underBase = crystalBases.some(b => {
        const dx = x - b.x, dz = z - b.z;
        return dx*dx + dz*dz < (b.r + 0.45) * (b.r + 0.45);
      });
      if (underBase) continue;
      placeStrand(x, z, isClumpStrand);
    }
  }

  // Edge-blending ring around each crystal cluster base so the base
  // looks embedded in the moss carpet rather than sitting on top.
  const edgeRng = mulberry32(0xed6e01);
  const EDGE_PER_CLUSTER = 160;
  for (const { cx: ccx, cz: ccz } of CLUSTER_POSITIONS) {
    const approxR = 1.80; // matches cluster base radius (scale~2.2-2.7 * 0.76)
    for (let i = 0; i < EDGE_PER_CLUSTER; i++) {
      const angle = edgeRng() * Math.PI * 2;
      // 60-110% of base radius — overlaps onto the outer 40% of the base
      const dist  = approxR * (0.60 + edgeRng() * 0.50);
      const x = ccx + Math.cos(angle) * dist;
      const z = ccz + Math.sin(angle) * dist;
      const underBase = crystalBases.some(b => {
        const dx = x - b.x, dz = z - b.z;
        return dx*dx + dz*dz < (b.r + 0.45) * (b.r + 0.45);
      });
      if (underBase) continue;
      placeStrand(x, z, true);
    }
  }

  // Background fill with remaining capacity
  const bgBudget = Math.max(0, TOTAL - totalClumpStrands - EDGE_PER_CLUSTER * CLUSTER_POSITIONS.length);
  for (let i = 0; i < bgBudget; i++) {
    const x = (rng()*2-1)*PLANE_W*0.48;
    const z = (rng()*2-1)*PLANE_D*0.48;
    const underBase = crystalBases.some(b => {
      const dx = x - b.x, dz = z - b.z;
      return dx*dx + dz*dz < (b.r + 0.45) * (b.r + 0.45);
    });
    if (underBase) continue;
    placeStrand(x, z, false);
  }

  // ── Mobile-safe redistribution ────────────────────────────────────────────
  // iPhone portrait (aspect ≈0.462) only shows X ∈ [-4.62, 4.62] of this
  // orthographic camera's frustum on the ground plane (Z is unaffected by
  // aspect — the camera's pitch-only tilt keeps top/bottom fixed). Strands
  // placed outside that X band are invisible on a phone. Move them inward,
  // biased toward whichever safe-zone grid cell is currently sparsest, so
  // they patch bald spots instead of piling up at the new boundary.
  {
    const redistRng = mulberry32(0x6d6f62);
    const SAFE_X    = 4.62 * 0.96;          // small inward margin from the exact frustum edge
    const SAFE_Z_LO = -22.0, SAFE_Z_HI = 6.0; // matches the (aspect-independent) camera Z range

    const GRID_X = 36, GRID_Z = 56;
    const cellW = (SAFE_X * 2) / GRID_X;
    const cellH = (SAFE_Z_HI - SAFE_Z_LO) / GRID_Z;
    const grid = new Int32Array(GRID_X * GRID_Z);
    const cellIndexOf = (x, z) => {
      const gx = Math.max(0, Math.min(GRID_X - 1, Math.floor((x + SAFE_X) / cellW)));
      const gz = Math.max(0, Math.min(GRID_Z - 1, Math.floor((z - SAFE_Z_LO) / cellH)));
      return gz * GRID_X + gx;
    };

    const rPos = new THREE.Vector3(), rQuat = new THREE.Quaternion(), rScl = new THREE.Vector3();
    const rMat = new THREE.Matrix4();
    const outOfBounds = []; // { gi, idx }

    for (let gi = 0; gi < meshes.length; gi++) {
      const m = meshes[gi];
      for (let idx = 0; idx < typeIdx[gi]; idx++) {
        m.getMatrixAt(idx, rMat);
        rMat.decompose(rPos, rQuat, rScl);
        const inBounds = rPos.x >= -SAFE_X && rPos.x <= SAFE_X && rPos.z >= SAFE_Z_LO && rPos.z <= SAFE_Z_HI;
        if (inBounds) grid[cellIndexOf(rPos.x, rPos.z)]++;
        else outOfBounds.push({ gi, idx });
      }
    }

    for (const { gi, idx } of outOfBounds) {
      const m = meshes[gi];
      m.getMatrixAt(idx, rMat);
      rMat.decompose(rPos, rQuat, rScl);

      // Approximate sparsest-cell search via random sampling — a full scan
      // per relocated strand would be too slow at this instance count.
      let bestCell = 0, bestCount = Infinity;
      for (let s = 0; s < 12; s++) {
        const ci = (redistRng() * grid.length) | 0;
        if (grid[ci] < bestCount) { bestCount = grid[ci]; bestCell = ci; }
      }
      const gx = bestCell % GRID_X, gz = (bestCell / GRID_X) | 0;
      rPos.x = -SAFE_X + (gx + redistRng()) * cellW;
      rPos.z = SAFE_Z_LO + (gz + redistRng()) * cellH;
      grid[bestCell]++;

      rMat.compose(rPos, rQuat, rScl);
      m.setMatrixAt(idx, rMat);
    }
  }

  for (const m of meshes) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    scene.add(m);
  }
  return meshes;
}

// ── Legacy canvas texture stub (unused — kept so merge references compile) ───
function buildMossTexture() {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Moderately lit base — must survive sRGB→linear conversion and still read green.
  ctx.fillStyle = '#3A5820';
  ctx.fillRect(0, 0, size, size);

  // ── Dense base fiber nap — covers EVERY part so no area reads as flat ──────
  const baseFibers = ['#1C3410', '#243C14', '#2E4A18', '#38581E', '#426428', '#4E7030'];
  for (let i = 0; i < 18000; i++) {
    drawFiber(ctx, texRng() * size, texRng() * size,
      baseFibers[texIntRng(0, baseFibers.length - 1)], texRange(0.22, 0.60));
  }

  // ── 130 small dark-emerald cushion clumps, scattered across entire surface ─
  // Small (8-32 px), numerous, and distributed everywhere — the centrepiece of
  // the carpet. Each has a slightly brighter dome crown and a dark crevice ring.
  const clumpPalette = [
    DARK_EMERALD,  // #1D5C3E  G=92
    '#1C5038',     // G=80
    '#1E5840',     // G=88
    '#1A4C32',     // G=76
    '#204838',     // G=72
  ];
  const clumpPositions = [];
  for (let i = 0; i < 130; i++) {
    const cx = texRng() * size, cy = texRng() * size;
    const r  = texRange(8, 32);
    clumpPositions.push({ cx, cy, r });
    const crown = clumpPalette[texIntRng(0, clumpPalette.length - 1)];

    const dome = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    dome.addColorStop(0,    rgba(crown, texRange(0.38, 0.56)));
    dome.addColorStop(0.50, rgba(crown, texRange(0.14, 0.28)));
    dome.addColorStop(1,    rgba(crown, 0));
    ctx.fillStyle = dome;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Dense fiber nap concentrated within each clump — gives the dome tops the
  // same velvety surface texture as the surrounding carpet.
  const clumpFibers = ['#1A3818', DARK_EMERALD, '#1C5038', '#204030', '#243C2C'];
  for (const { cx, cy, r } of clumpPositions) {
    const n = Math.round(r * 3.0);
    for (let i = 0; i < n; i++) {
      const a = texRng() * Math.PI * 2, d = r * Math.sqrt(texRng());
      drawFiber(ctx,
        cx + Math.cos(a) * d, cy + Math.sin(a) * d,
        clumpFibers[texIntRng(0, clumpFibers.length - 1)],
        texRange(0.20, 0.55) * (1 - d / r));
    }
  }

  // ── Broad subtle mounds (40-90 px) between clumps — no smooth flat gaps ───
  const midShades = ['#2A4418', '#34521E', '#3E6024', '#4A7030'];
  for (let i = 0; i < 18; i++) {
    const cx = texRng() * size, cy = texRng() * size, r = texRange(40, 90);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,   rgba(midShades[texIntRng(0, midShades.length - 1)], texRange(0.10, 0.22)));
    g.addColorStop(1,   rgba(midShades[0], 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Imperfections: dead/dry spots ─────────────────────────────────────────
  const deadTones = ['#4A3818', '#5C4825', '#3E3010'];
  for (let i = 0; i < 9; i++) {
    const cx = texRng() * size, cy = texRng() * size, r = texRange(10, 38);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,   rgba(deadTones[texIntRng(0, deadTones.length - 1)], texRange(0.08, 0.22)));
    g.addColorStop(1,   rgba(deadTones[0], 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Final blend coat: tie all layers into one continuous living surface ────
  const blendFibers = ['#243A14', '#2E4A1A', DARK_EMERALD, '#1C5038', '#244830'];
  for (let i = 0; i < 4000; i++) {
    drawFiber(ctx, texRng() * size, texRng() * size,
      blendFibers[texIntRng(0, blendFibers.length - 1)], texRange(0.14, 0.35));
  }


  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

function buildMossBumpTexture() {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);

  // ── 130 cushion dome elevations — lighter = raised, dark ring = crevice ───
  for (let i = 0; i < 130; i++) {
    const cx = texRng() * size, cy = texRng() * size, r = texRange(8, 32);

    const dome = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    dome.addColorStop(0,    `rgba(220,220,220,${texRange(0.80, 0.96)})`);
    dome.addColorStop(0.50, `rgba(185,185,185,${texRange(0.50, 0.70)})`);
    dome.addColorStop(1,    'rgba(128,128,128,0)');
    ctx.fillStyle = dome;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // No valley rings — they covered 80%+ of the canvas with dark normals
    // and caused the entire ground to render near-black. Let adjacent domes
    // cast natural shadows between mounds instead.
  }

  // ── Secondary micro-bumps for depth between the main clumps ───────────────
  for (let i = 0; i < 180; i++) {
    const cx = texRng() * size, cy = texRng() * size, r = texRange(4, 18);
    const v = Math.floor(texRange(155, 215));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,   `rgba(${v},${v},${v},${texRange(0.55, 0.82)})`);
    g.addColorStop(1,   'rgba(128,128,128,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Fine fiber surface detail — nap direction carries into bump shading ────
  for (let i = 0; i < 14000; i++) {
    const v = Math.floor(texRange(50, 210));
    drawFiber(ctx, texRng() * size, texRng() * size,
      `rgb(${v},${v},${v})`, texRange(0.18, 0.50));
  }

  ctx.globalAlpha = 1;
  return new THREE.CanvasTexture(canvas);
}

function buildMossRoughnessMap() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Near-white = roughness ≈ 0.94 — fully matte, no surface shine.
  ctx.fillStyle = '#F0F0F0';
  ctx.fillRect(0, 0, size, size);

  // Fractionally smoother at cushion dome tops: just the ghost of moisture on
  // frond crowns, not enough to look wet or reflective.
  for (let i = 0; i < 60; i++) {
    const cx = texRng() * size, cy = texRng() * size, r = texRange(8, 28);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,    `rgba(210,210,210,${texRange(0.40, 0.65)})`);
    g.addColorStop(0.55, `rgba(230,230,230,${texRange(0.20, 0.38)})`);
    g.addColorStop(1,    'rgba(240,240,240,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  return new THREE.CanvasTexture(canvas);
}

const mossNormalTex = (function() {
  const s = 256, c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,255)'; ctx.fillRect(0,0,s,s);
  const img = ctx.getImageData(0,0,s,s), d = img.data, nr = mulberry32(0x4e6f72);
  for (let i = 0; i < d.length; i += 4) {
    d[i]=128+(nr()*2-1)*35; d[i+1]=128+(nr()*2-1)*35; d[i+2]=210+nr()*45; d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
})();

function buildGround() {
  const geo = new THREE.PlaneGeometry(PLANE_W, PLANE_D, 1, 1);
  geo.rotateX(-Math.PI / 2);
  // Dark base that shows through gaps between moss strands — depth comes from
  // 3-D strand geometry, not bump maps or canvas textures.
  const mat = new THREE.MeshStandardMaterial({
    color: 0x031502, roughness: 0.98, metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ── Shared unit geometries (scaled per-instance, drawn via InstancedMesh) ─────

function makeCrystalGeometry() {
  const bodyH = 0.62, tipH = 0.38;

  const body = new THREE.CylinderGeometry(0.86, 1, bodyH, 6, 1);
  body.translate(0, bodyH / 2, 0);

  const tip = new THREE.ConeGeometry(0.86, tipH, 6);
  tip.rotateY(Math.PI / 6);
  tip.translate(0, bodyH + tipH / 2, 0);

  const merged = mergeGeometries([body, tip]);
  body.dispose(); tip.dispose();

  const flat = merged.toNonIndexed();
  flat.computeVertexNormals();
  merged.dispose();
  return flat; // base radius 1 @ y=0, apex @ y=1
}

function makeRockGeometry() {
  const rng = mulberry32(0xb4d9c3);
  const geo = new THREE.IcosahedronGeometry(1, 3); // 1280 faces — dense gritty surface
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const d = (rng() * 2 - 1) * 0.09; // ±9% — fine surface grain, not spiky
    pos.setXYZ(i, x + (x / len) * d, y + (y / len) * d, z + (z / len) * d);
  }
  geo.scale(1, 0.40, 1);
  geo.translate(0, 0.40, 0);
  const flat = geo.toNonIndexed();
  geo.dispose();
  flat.computeVertexNormals();
  return flat;
}

// ── Per-cluster rocky base geometry ──────────────────────────────────────────
// Generates a unique jagged rock formation per cluster. Uses a cylinder as the
// base, then displaces every vertex: heavy Y-noise on upper faces (creates
// craggy peaks and ledges), XZ-noise on all faces (irregular jagged silhouette).
// Converted to non-indexed with flatShading so every face has a distinct plane.
// Returns the warped open-ended cylinder sides with vertex colours (no top cap).
function makeClusterBaseGeo(radius, seed, warpBias, warpAmp) {
  const rng = mulberry32(seed >>> 0);
  const f1 = 4 + Math.floor(rng() * 2);
  const p1 = rng() * Math.PI * 2;
  const f2 = 4 + Math.floor(rng() * 2);
  const p2 = rng() * Math.PI * 2;
  const gf = 7 + Math.floor(rng() * 4);
  const gp = rng() * Math.PI * 2;

  const height = 0.59;
  const rTop   = radius * 0.90;

  const sidGeo = new THREE.CylinderGeometry(rTop, radius, height, 40, 6, true);
  const sPos   = sidGeo.attributes.position;

  for (let i = 0; i < sPos.count; i++) {
    const x = sPos.getX(i), y = sPos.getY(i), z = sPos.getZ(i);
    const angle = Math.atan2(z, x);
    const wave  = (Math.sin(f1 * angle + p1) + Math.sin(f2 * angle + p2)) * 0.5;

    if (y < -height * 0.40) {
      const xzW = warpBias + warpAmp * wave * 0.5;
      sPos.setX(i, x * xzW); sPos.setZ(i, z * xzW);
      rng(); rng();
    } else if (y > height * 0.40) {
      const xzW = 1 + (rng() - 0.5) * 0.025;
      sPos.setX(i, x * xzW); sPos.setZ(i, z * xzW);
      sPos.setY(i, y + (rng() - 0.5) * 0.006);
    } else {
      const grooveDepth = Math.max(0, Math.sin(gf * angle + gp)) ** 2;
      const xzW = 1.01 + warpAmp * wave * 0.28 - grooveDepth * 0.15 + (rng() - 0.5) * 0.04;
      sPos.setX(i, x * xzW); sPos.setZ(i, z * xzW);
      rng();
    }
  }
  sPos.needsUpdate = true;
  sidGeo.translate(0, height * 0.5, 0);
  const flat = sidGeo.toNonIndexed();
  sidGeo.dispose();
  flat.computeVertexNormals();

  const fp = flat.attributes.position;
  const vc = new Float32Array(fp.count * 3);
  const cTop    = [0.228, 0.240, 0.256];
  const cMid    = [0.090, 0.095, 0.104];
  const cSide   = [0.052, 0.055, 0.062];
  const cBottom = [0.028, 0.030, 0.034];

  for (let i = 0; i < fp.count; i += 3) {
    const cy = (fp.getY(i) + fp.getY(i + 1) + fp.getY(i + 2)) / 3;
    const t  = Math.max(0, Math.min(1, cy / height));
    let r, gb, b;
    if (t > 0.78) {
      r = cTop[0];  gb = cTop[1];  b = cTop[2];
    } else if (t > 0.38) {
      const u = (t - 0.38) / 0.40;
      r = cMid[0]  + u * (cTop[0]  - cMid[0]);
      gb = cMid[1] + u * (cTop[1]  - cMid[1]);
      b = cMid[2]  + u * (cTop[2]  - cMid[2]);
    } else if (t > 0.09) {
      const u = (t - 0.09) / 0.29;
      r = cSide[0] + u * (cMid[0]  - cSide[0]);
      gb = cSide[1] + u * (cMid[1] - cSide[1]);
      b = cSide[2] + u * (cMid[2]  - cSide[2]);
    } else {
      const u = t / 0.09;
      r = cBottom[0] + u * (cSide[0] - cBottom[0]);
      gb = cBottom[1] + u * (cSide[1] - cBottom[1]);
      b = cBottom[2] + u * (cSide[2] - cBottom[2]);
    }
    for (let j = 0; j < 3; j++) {
      vc[(i+j)*3]     = r;
      vc[(i+j)*3 + 1] = gb;
      vc[(i+j)*3 + 2] = b;
    }
  }
  flat.setAttribute('color', new THREE.Float32BufferAttribute(vc, 3));
  return flat;
}

// Ring-of-quads disc for the top cap with UV coordinates for texture mapping.
// Uses concentric rings instead of a fan so every vertex has a unique (x,z)
// position and the texture maps cleanly without radial seams.
function makeTopDiscGeo(radius) {
  const height   = 0.59;
  const rTop     = radius * 0.90;
  const SECTORS  = 48;
  const RINGS    = 7;
  const INNER_R  = rTop * 0.28;

  const positions = [];
  const uvs       = [];
  const indices   = [];

  // Outer annular region: (RINGS+1) rings × SECTORS vertices.
  for (let ri = 0; ri <= RINGS; ri++) {
    const rr = INNER_R + (rTop - INNER_R) * (ri / RINGS);
    for (let si = 0; si < SECTORS; si++) {
      const ang = (si / SECTORS) * Math.PI * 2;
      const x   = Math.cos(ang) * rr;
      const z   = Math.sin(ang) * rr;
      positions.push(x, height, z);
      uvs.push(x / rTop * 0.5 + 0.5, z / rTop * 0.5 + 0.5);
    }
  }
  // Quads — winding order chosen for outward-facing (+Y) normals.
  for (let ri = 0; ri < RINGS; ri++) {
    for (let si = 0; si < SECTORS; si++) {
      const a = ri * SECTORS + si;
      const b = ri * SECTORS + (si + 1) % SECTORS;
      const c = (ri + 1) * SECTORS + (si + 1) % SECTORS;
      const d = (ri + 1) * SECTORS + si;
      indices.push(a, c, d,  a, b, c);
    }
  }

  // Inner fan to close the centre (≤8% of disc area).
  const ctr = positions.length / 3;
  positions.push(0, height, 0);
  uvs.push(0.5, 0.5);
  for (let si = 0; si < SECTORS; si++) {
    const ang = (si / SECTORS) * Math.PI * 2;
    const x   = Math.cos(ang) * INNER_R;
    const z   = Math.sin(ang) * INNER_R;
    positions.push(x, height, z);
    uvs.push(x / rTop * 0.5 + 0.5, z / rTop * 0.5 + 0.5);
  }
  for (let si = 0; si < SECTORS; si++) {
    indices.push(ctr, ctr + 1 + (si + 1) % SECTORS, ctr + 1 + si);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Procedural granite canvas texture: base grey with fine light and dark mineral flecks.
function makeGraniteTexture() {
  const S   = 256;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = S;
  const ctx = cvs.getContext('2d');

  ctx.fillStyle = '#8e949c';
  ctx.fillRect(0, 0, S, S);

  // Light mineral flecks — #a0a8b0
  for (let i = 0; i < 1100; i++) {
    ctx.globalAlpha = 0.45 + Math.random() * 0.55;
    ctx.fillStyle   = '#a0a8b0';
    const r = 0.4 + Math.random() * 1.1;
    ctx.beginPath();
    ctx.arc(Math.random() * S, Math.random() * S, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dark mineral flecks — #6a7078
  for (let i = 0; i < 900; i++) {
    ctx.globalAlpha = 0.45 + Math.random() * 0.55;
    ctx.fillStyle   = '#6a7078';
    const r = 0.4 + Math.random() * 1.1;
    ctx.beginPath();
    ctx.arc(Math.random() * S, Math.random() * S, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A few elongated flecks for variety.
  ctx.globalAlpha = 1;
  for (let i = 0; i < 220; i++) {
    ctx.save();
    ctx.translate(Math.random() * S, Math.random() * S);
    ctx.rotate(Math.random() * Math.PI);
    ctx.globalAlpha = 0.5 + Math.random() * 0.5;
    ctx.fillStyle   = Math.random() < 0.5 ? '#a0a8b0' : '#6a7078';
    const len = 1.5 + Math.random() * 3.5;
    ctx.fillRect(-len / 2, -0.6, len, 1.2);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeTuftGeometry() {
  const geo = new THREE.ConeGeometry(1, 1, 5);
  geo.translate(0, 0.5, 0);
  return geo; // base radius 1 @ y=0, apex @ y=1
}

// ── Cluster layout ───────────────────────────────────────────────────────────
// Relative (0..1) positions across the plane; clusters spread evenly across
// the full visible width and depth of the moss wall.

// 3 large clusters in a balanced triangular arrangement across the iPhone
// portrait visible frame (X: ±4.62, Z: -22.4..6.4) — upper, middle, lower,
// each gently staggered in X for a triangular feel with generous spacing.
const CLUSTER_POSITIONS = [
  { cx: -2.5, cz:   2.0 },  // upper-left
  { cx:  2.5, cz:  -9.5 },  // center-right
  { cx: -1.5, cz: -16.0 },  // lower-left
];

const CRYSTAL_COLORS = [
  [0.600, 0.12, 0.70],   // aqua blue-grey
  [0.583, 0.16, 0.68],   // cool blue-grey, more visible hue
  [0.617, 0.09, 0.72],   // faint blue, medium grey
  [0.760, 0.14, 0.66],   // soft amethyst purple
  [0.600, 0.07, 0.73],   // near-neutral grey with faint blue
  [0.640, 0.14, 0.68],   // cooler blue-grey
].map(([h, s, l]) => new THREE.Color().setHSL(h, s, l));

const ROCK_COLOR = new THREE.Color(0xa8b3ac);
const TUFT_COLOR = new THREE.Color(0x062804);

function buildClusterLayout() {
  const crystals    = [];
  const rocks       = [];
  const tufts       = [];
  const clusterMeta = [];

  for (const { cx, cz } of CLUSTER_POSITIONS) {
    const scale = range(2.20, 2.70);
    clusterMeta.push({ cx, cz, scale });
    crystalBases.push({ x: cx, z: cz, r: scale * 0.92 });

    rocks.push({
      x: cx, z: cz, y: -2.0,
      r: range(0.40, 0.55) * scale,
      h: range(0.40, 0.55) * scale,
      ry: rng() * Math.PI * 2,
    });

    // ── 1 central crystal: tall, upright ────────────────────────────────────────
    crystals.push({
      x: cx,
      z: cz,
      h: range(1.10, 1.80) * scale,
      r: range(0.12, 0.18) * scale,
      rx: range(-0.04, 0.04),
      rz: range(-0.04, 0.04),
      ry: intRng(0, 5) * (Math.PI / 3) + range(-0.07, 0.07),
      color: CRYSTAL_COLORS[intRng(0, CRYSTAL_COLORS.length - 1)],
    });

    // ── Outer ring: ~half upright, ~half tilted outward up to 45° ──────────────
    const numOuter  = intRng(7, 10);
    const baseAngle = rng() * Math.PI * 2;
    for (let i = 0; i < numOuter; i++) {
      const sectorW = (Math.PI * 2) / numOuter;
      const angle   = baseAngle + i * sectorW + range(-0.05, 0.05) * sectorW;
      const dist    = range(0.55, 0.80) * scale;
      const tilted  = rng() > 0.5;
      const lean    = tilted ? range(0.22, 0.78) : 0;
      const sideLean = tilted ? 0 : (rng() > 0.5 ? 1 : -1) * range(0.38, 0.48);
      crystals.push({
        x: cx + Math.cos(angle) * dist,
        z: cz + Math.sin(angle) * dist,
        h: range(0.65, 1.50) * scale,
        r: range(0.12, 0.18) * scale,
        rx: tilted ?  Math.sin(angle) * lean : range(-0.04, 0.04),
        rz: tilted ? -Math.cos(angle) * lean : sideLean,
        ry: intRng(0, 5) * (Math.PI / 3) + range(-0.07, 0.07),
        color: CRYSTAL_COLORS[intRng(0, CRYSTAL_COLORS.length - 1)],
      });
    }

    // ── Small accent crystals: ~half upright, ~half tilted outward ────────────
    const numAccent = intRng(4, 6);
    const accentBase = baseAngle + (Math.PI / numOuter);
    for (let i = 0; i < numAccent; i++) {
      const angle  = accentBase + (i / numAccent) * Math.PI * 2;
      const dist   = range(0.15, 0.28) * scale;
      const tilted = rng() > 0.5;
      const lean   = tilted ? range(0.18, 0.65) : 0;
      const sideLeanA = tilted ? 0 : (rng() > 0.5 ? 1 : -1) * range(0.38, 0.48);
      crystals.push({
        x: cx + Math.cos(angle) * dist,
        z: cz + Math.sin(angle) * dist,
        h: range(0.40, 0.75) * scale,
        r: range(0.08, 0.12) * scale,
        rx: tilted ?  Math.sin(angle) * lean : range(-0.04, 0.04),
        rz: tilted ? -Math.cos(angle) * lean : sideLeanA,
        ry: rng() * Math.PI * 2,
        color: CRYSTAL_COLORS[intRng(0, CRYSTAL_COLORS.length - 1)],
      });
    }

    const tn = intRng(4, 8);
    for (let i = 0; i < tn; i++) {
      const a = rng() * Math.PI * 2;
      const d = range(0.30, 0.78) * scale;
      tufts.push({
        x: cx + Math.cos(a) * d,
        z: cz + Math.sin(a) * d * 0.85,
        h: range(0.10, 0.26),
        r: range(0.05, 0.12),
        ry: rng() * Math.PI * 2,
      });
    }
  }

  return { crystals, rocks, tufts, clusterMeta };
}

function buildInstanced(geo, material, placements, { castShadow = false, receiveShadow = false, colorize = false } = {}) {
  const mesh = new THREE.InstancedMesh(geo, material, placements.length);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  placements.forEach((d, i) => {
    p.set(d.x, d.y ?? 0, d.z);
    e.set(d.rx || 0, d.ry || 0, d.rz || 0);
    q.setFromEuler(e);
    s.set(d.r, d.h, d.r);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    if (colorize) mesh.setColorAt(i, d.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (colorize) mesh.instanceColor.needsUpdate = true;

  scene.add(mesh);
  return mesh;
}

function buildRocks(placements) {
  const geo = makeRockGeometry();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xe0e8f0, roughness: 0.48, metalness: 0.02,
    transparent: false, flatShading: true,
  });
  return buildInstanced(geo, mat, placements, { receiveShadow: true });
}

function buildTufts(placements) {
  const geo = makeTuftGeometry();
  const mat = new THREE.MeshStandardMaterial({
    color: TUFT_COLOR, roughness: 0.75, flatShading: true,
  });
  return buildInstanced(geo, mat, placements, {});
}

function buildClusterBases(clusterMeta) {
  const sideMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.65, metalness: 0.02,
    flatShading: true, vertexColors: true,
  });

  const granTex = makeGraniteTexture();
  const topMat  = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.832, 0.803, 0.776), roughness: 0.65, metalness: 0.02,
    flatShading: true, map: granTex,
  });

  for (let idx = 0; idx < clusterMeta.length; idx++) {
    const { cx, cz, scale } = clusterMeta[idx];
    const radius   = scale * 0.92;
    const seed     = ((idx + 1) * 0x9e3779b9) >>> 0;
    const warpBias = 1.025;
    const warpAmp  = idx === 2 ? 0.225 : 0.170;
    const y0       = -0.09;  // bottom buried ~9cm, top surface at ~0.50

    const sideGeo  = makeClusterBaseGeo(radius, seed, warpBias, warpAmp);
    const sideMesh = new THREE.Mesh(sideGeo, sideMat);
    sideMesh.position.set(cx, y0, cz);
    sideMesh.receiveShadow = true;
    scene.add(sideMesh);

    const topGeo  = makeTopDiscGeo(radius);
    const topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.position.set(cx, y0, cz);
    topMesh.receiveShadow = true;
    scene.add(topMesh);
  }
}

function buildClusterMoss() {}

let crystalMat;
function buildCrystals(placements) {
  const geo = makeCrystalGeometry();
  crystalMat = new THREE.MeshStandardMaterial({
    color: 0xb8c4cc,        // DO NOT MODIFY — crystal realism settings
    roughness: 0.03,        // DO NOT MODIFY — crystal realism settings
    metalness: 0.15,        // DO NOT MODIFY — crystal realism settings
    emissive: 0x1a2a3a, emissiveIntensity: 0.12,
    envMapIntensity: 1.8,   // DO NOT MODIFY — crystal realism settings (overridden after PMREMGenerator)
    transparent: false, depthWrite: true,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    flatShading: true,      // DO NOT MODIFY — crystal realism settings
  });
  return buildInstanced(geo, crystalMat, placements, { castShadow: true, colorize: true });
}

// ── Build scene ──────────────────────────────────────────────────────────────

const crystalBases = [];
buildGround();
const { crystals, rocks, tufts, clusterMeta } = buildClusterLayout();

// Size rebalancing: grow small crystals, shrink the biggest, fix tilt.
{
  const byVol = crystals
    .map((c, i) => ({ i, vol: c.h * c.r * c.r }))
    .sort((a, b) => a.vol - b.vol);
  const edgeN = Math.max(1, Math.round(crystals.length * 0.14));
  const smallest = new Set(byVol.slice(0, edgeN).map(e => e.i));
  const largest  = new Set(byVol.slice(-edgeN).map(e => e.i));
  for (let i = 0; i < crystals.length; i++) {
    const c = crystals[i];
    if (smallest.has(i))     { c.h *= 1.8; c.r *= 1.5; }
    else if (largest.has(i)) { c.h *= 0.82; c.r *= 0.88; }
    else                     { c.h *= 1.15; c.r *= 1.10; }
    const tilt = Math.abs(c.rx) > 0.08 ? c.rx : c.rz;
    c.rx = 0;
    if (Math.abs(c.rz) < 0.08) c.rz = tilt || 0;
  }
  // Straighten all crystals to max ~12° lean, subtle random direction.
  for (const c of crystals) {
    const maxLean = 0.12 + Math.abs(c.rx + c.rz) * 0.05; // 7-14° range
    const leanDir = Math.atan2(c.rz, c.rx) || (Math.random() * Math.PI * 2);
    const lean = Math.min(maxLean, Math.sqrt(c.rx * c.rx + c.rz * c.rz));
    c.rx = Math.cos(leanDir) * lean;
    c.rz = Math.sin(leanDir) * lean;
  }

  // Remove crystals that overlap (base + tip aware) — keep the taller one.
  function removeOverlaps(marginMult) {
    const remove = new Set();
    for (let i = 0; i < crystals.length; i++) {
      if (remove.has(i)) continue;
      const a = crystals[i];
      const aTipX = a.x + a.h * Math.sin(a.rz || 0);
      const aTipZ = a.z + a.h * Math.sin(a.rx || 0);
      for (let j = i + 1; j < crystals.length; j++) {
        if (remove.has(j)) continue;
        const b = crystals[j];
        const bTipX = b.x + b.h * Math.sin(b.rz || 0);
        const bTipZ = b.z + b.h * Math.sin(b.rx || 0);
        const minR = (a.r + b.r) * marginMult;
        const d = (ax,az,bx,bz) => Math.sqrt((ax-bx)**2 + (az-bz)**2);
        if (d(a.x,a.z,b.x,b.z) < minR || d(aTipX,aTipZ,bTipX,bTipZ) < minR
          || d(a.x,a.z,bTipX,bTipZ) < minR || d(b.x,b.z,aTipX,aTipZ) < minR)
          remove.add(a.h >= b.h ? j : i);
      }
    }
    if (remove.size > 0) {
      const sorted = [...remove].sort((a, b) => b - a);
      for (const idx of sorted) crystals.splice(idx, 1);
    }
  }
  removeOverlaps(1.00);

  // Push crystals apart by 15% within each cluster for breathing room,
  // but clamp any that escape the base perimeter back inside.
  for (const { cx, cz, scale } of clusterMeta) {
    // Clamp radius generous enough to cover the actual outer-ring spread
    // (placed up to 0.92*scale) — clamping to the literal small rock-base
    // footprint (0.42*scale) would crush every outer crystal onto one tight
    // ring and cause cascading false-positive overlaps.
    const clampR = scale * 0.90;
    const inCluster = crystals.filter(c => (c.x-cx)**2 + (c.z-cz)**2 < (clampR*1.5)**2);
    for (const c of inCluster) {
      const dx = c.x - cx, dz = c.z - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 0.01) { c.x = cx + dx * 1.08; c.z = cz + dz * 1.08; }
      // Clamp back inside the generous cluster radius if pushed too far out.
      const dx2 = c.x - cx, dz2 = c.z - cz;
      const d2 = Math.sqrt(dx2 * dx2 + dz2 * dz2);
      if (d2 > clampR) {
        c.x = cx + (dx2 / d2) * clampR;
        c.z = cz + (dz2 / d2) * clampR;
      }
    }
    // Scale up any crystal shorter than 30% of the tallest in this cluster.
    const maxH = Math.max(...inCluster.map(c => c.h));
    for (const c of inCluster) {
      if (c.h < maxH * 0.30) { c.h *= 1.3; c.r *= 1.2; }
    }
  }

  // Final collision pass — remove any crystals still overlapping after all adjustments.
  removeOverlaps(1.00);
}

// Precompute each crystal's base transform once so growth can recompose its
// matrix with only the Y-scale changed — position, rotation, and radius (X/Z
// scale) are reused unchanged on every update.
for (const c of crystals) {
  c.position     = new THREE.Vector3(c.x, 0, c.z);
  c.quaternion   = new THREE.Quaternion().setFromEuler(new THREE.Euler(c.rx, c.ry, c.rz));
  c.growProgress    = 0;
  c.cracks          = 0;
  c.crackMeshes     = [];
  c.shattered       = false;
  c.regrowing       = false;
  c.crackAnimating  = false;
}

const crystalMesh = buildCrystals(crystals);
const rockMesh    = buildRocks(rocks);
const tuftMesh    = buildTufts(tufts);
buildClusterBases(clusterMeta);
const strandMeshes = buildMossStrandSystem();
buildClusterMoss(clusterMeta);

// Crystal-only accent light — layer 1 so it doesn't affect moss or ground.
const crystalLight = new THREE.DirectionalLight(0xddeeff, 2.5); // DO NOT MODIFY — crystal realism settings
crystalLight.position.set(6, 10, 1);                            // DO NOT MODIFY — crystal realism settings
crystalLight.layers.set(1);
scene.add(crystalLight);

const crystalCounter = new THREE.DirectionalLight(0x0a1525, 0.8);
crystalCounter.position.set(-4, 6, -3);
crystalCounter.layers.set(1);
scene.add(crystalCounter);

// Layer 1 only — removes crystals from layer 0 so hemisphere/sun/fill/back
// no longer light them; only crystalLight + crystalCounter do.
crystalMesh.layers.set(1);
// Sun's shadow camera still needs layer 1 to keep crystals casting shadows.
sun.shadow.camera.layers.enable(1);
camera.layers.enable(1);

// Static envMap for crystal reflections — no scene dependency.
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x8899aa);
  const envTex = pmrem.fromScene(envScene, 0).texture;
  pmrem.dispose();
  crystalMat.envMap = envTex;              // DO NOT MODIFY — crystal realism settings
  crystalMat.envMapIntensity = 1.8;        // DO NOT MODIFY — crystal realism settings
  crystalMat.needsUpdate = true;
}

// ── Crystal growth on hold ───────────────────────────────────────────────────
// Press and hold a crystal: it grows taller over GROWTH_DURATION seconds, then
// stays at its final height. Only the Y-scale of its instance matrix changes —
// position, rotation, and radius (X/Z scale) are untouched, so the footprint,
// facet shape, and proportions stay exactly as designed, just extended upward.

const GROWTH_DURATION = 2.8; // seconds of holding to reach full height
const GROWTH_SCALE    = 1.8; // final height = original height × this

const smoothstep = (t) => t * t * (3 - 2 * t); // calm ease-in-out, no abrupt start/stop

const raycaster  = new THREE.Raycaster();
raycaster.layers.enable(1); // crystalMesh now lives on layer 1 only — keep it pickable
const pointer    = new THREE.Vector2();
const growMatrix = new THREE.Matrix4();
const growScale  = new THREE.Vector3();

// ── Crystal crack & shatter system ──────────────────────────────────────────

function crystalUnitRadiusAt(y) {
  return y <= 0.62
    ? 0.86 + 0.14 * (1 - y / 0.62)
    : 0.86 * (1 - (y - 0.62) / 0.38);
}

// Crack line shaders: shift each vertex 0.01 world units toward the camera so
// line segments (which pass through the crystal's inscribed-circle interior)
// are physically in front of the crystal face and pass depthTest without
// relying on polygonOffset, which is unreliable for LINE_SEGMENTS in WebGL.
const CRACK_VERT = `
  void main() {
    vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    clipPos.z -= 0.002;
    gl_Position = clipPos;
  }
`;
const CRACK_FRAG = `
  uniform vec3 lineColor;
  uniform float opacity;
  void main() {
    gl_FragColor = vec4(lineColor, opacity);
  }
`;

// crackIndex (0, 1) selects the vertical zone so successive cracks cover
// distinct regions of the crystal rather than clustering at the same height.
function buildCrackMesh(seed, crackIndex) {
  const rng = mulberry32(seed >>> 0);
  const pts = [];

  // Multiple small impact points spread across the crystal — reduced density
  // for a cleaner hairline look. Confined to one angular half of the crystal
  // (alternating by crackIndex) so two simultaneous cracks never cross.
  const numImpacts = 5 + (rng() * 2 | 0); // 5–6 separate origin points
  const halfArc    = Math.PI * 0.78;      // ~140° span, leaves a gap between halves
  const baseAngle  = (crackIndex % 2) * Math.PI + (rng() - 0.5) * 0.3;

  function traceBranch(ox, oy, oz, angle, depth) {
    const maxSteps = depth === 0 ? 8 + (rng() * 5 | 0) : 4 + (rng() * 3 | 0);
    const stepLen  = depth === 0 ? 0.042 + rng() * 0.044 : 0.030 + rng() * 0.032;
    const noise    = depth === 0 ? 0.055 : 0.040;
    const forkProb = depth === 0 ? 0.12 : 0.0;

    let x = ox, y = oy, z = oz;
    // Discrete direction state (angle + vertical slope) instead of an
    // accumulating vector — each step jumps to a new heading rather than
    // drifting smoothly, so consecutive straight segments meet at a visible
    // angle (jagged lightning-bolt look) instead of approximating a curve.
    let dirA = angle;
    let dirY = (rng() - 0.5) * 0.45;
    const angleNoise = noise * 28; // radians per step — large enough that each
    // segment visibly zigzags from the last rather than drifting smoothly

    for (let s = 0; s < maxSteps; s++) {
      dirA += (rng() - 0.5) * angleNoise;
      dirY += (rng() - 0.5) * noise * 0.45;

      if (rng() < 0.09) {
        dirA += (rng() < 0.5 ? 1 : -1) * (0.35 + rng() * 0.55);
      }

      const horiz = Math.sqrt(1 + dirY * dirY) || 1;
      let nx = x + (Math.cos(dirA) / horiz) * stepLen;
      let ny = Math.max(0.08, Math.min(0.90, y + (dirY / horiz) * stepLen));
      let nz = z + (Math.sin(dirA) / horiz) * stepLen;
      const sR = crystalUnitRadiusAt(ny);
      const d  = Math.sqrt(nx * nx + nz * nz) || 1e-8;
      // Project to hexagon face boundary, not circumscribed circle.
      // Body (y≤0.62): cylinder vertices at atan2 angles 30°,90°,… (face normals at 0°,60°,…, fo=0).
      // Tip  (y>0.62): cone rotateY(π/6) moves vertices to 0°,60°,… (face normals at 30°,90°,…, fo=π/6).
      const _a  = Math.atan2(nz, nx);
      const _fo = ny <= 0.62 ? 0 : Math.PI / 6;
      const _rel = (_a - _fo) - Math.round((_a - _fo) / (Math.PI / 3)) * (Math.PI / 3);
      const r   = sR * Math.cos(Math.PI / 6) / Math.cos(_rel);
      nx = (nx / d) * r;
      nz = (nz / d) * r;

      pts.push(x, y, z, nx, ny, nz);
      x = nx; y = ny; z = nz;

      if (depth < 1 && rng() < forkProb) {
        const forkA = angle + (rng() < 0.5 ? 1 : -1) * (0.38 + rng() * 0.70);
        traceBranch(x, y, z, forkA, depth + 1);
      }
    }
  }

  for (let imp = 0; imp < numImpacts; imp++) {
    const iy = 0.08 + ((imp + 0.5) / numImpacts) * 0.82;
    const ia = baseAngle - halfArc / 2 + (imp / Math.max(1, numImpacts - 1)) * halfArc + (rng() - 0.5) * 0.25;
    const ir = crystalUnitRadiusAt(iy) * (0.25 + rng() * 0.40);
    const ix = Math.cos(ia) * ir;
    const iz = Math.sin(ia) * ir;
    const arms = 2; // single pair of arms per impact — cleaner, less overlap
    for (let b = 0; b < arms; b++) {
      const ba = ia + (b / arms) * Math.PI * 2 + (rng() - 0.5) * 0.50;
      traceBranch(ix, iy, iz, ba, 0);
    }
  }


  const positions = new Float32Array(pts);

  // Both layers start at opacity 0 — the crack animation fades them in.

  // Subtle inner glow: muted teal at low opacity — inner light, not outer bloom.
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions.slice(), 3));
  const glowLine = new THREE.LineSegments(glowGeo, new THREE.ShaderMaterial({
    uniforms: { lineColor: { value: new THREE.Color(0x00bbcc) }, opacity: { value: 0 } },
    vertexShader: CRACK_VERT, fragmentShader: CRACK_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
  }));
  glowLine.renderOrder = 0;

  // Sharp focal line: saturated cyan, nearly opaque — the crack itself.
  const coreGeo = new THREE.BufferGeometry();
  coreGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const coreLine = new THREE.LineSegments(coreGeo, new THREE.ShaderMaterial({
    uniforms: { lineColor: { value: new THREE.Color(0x00ffff) }, opacity: { value: 0 } },
    vertexShader: CRACK_VERT, fragmentShader: CRACK_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
  }));
  coreLine.renderOrder = 0;

  const group = new THREE.Group();
  group.add(glowLine);
  group.add(coreLine);
  return group;
}

const activeShards          = [];
const SHARD_GRAVITY         = 11.0;
const SINK_DURATION         = 1.8;   // seconds for a shard to sink into the moss
const SINK_DEPTH            = 0.45;  // units below ground before vanishing
const REGROW_DURATION       = 1.6;   // seconds for crystal to grow back to full size
const pendingRegrowth       = [];    // { crystalId, progress }

// ── Moss wind-sway interaction ────────────────────────────────────────────────
const SWAY_RADIUS    = 2.6;   // world-unit influence radius per touch
const EFFECTIVE_SWAY_RADIUS = isMobile ? 1.8 : SWAY_RADIUS;
const SWAY_FREQ      = 0.90;  // Hz — slow, calming oscillation
const SWAY_MAX_ANGLE = 0.52;  // radians max tilt per strand
const SWAY_DECAY     = 2.8;   // seconds for strands to settle after touch ends
const EFFECTIVE_SWAY_DECAY = isMobile ? SWAY_DECAY * 0.5 : SWAY_DECAY;
const SWAY_EASE_IN   = 0.30;  // seconds to ramp from zero to full amplitude
const SWAY_GRID_SZ   = 1.5;   // spatial cell size for neighbour lookup

const activeSways = new Map();   // `mi:idx` → sway-state object
const swayGrid    = new Map();   // `cx,cz` → [strandData indices]
const swayStrand  = [];          // { mi, idx, x, z } — one entry per ground strand

// Reusable scratch — avoids per-frame allocation inside updateMossSway.
const _swayPos  = new THREE.Vector3();
const _swayQuat = new THREE.Quaternion();
const _swayScl  = new THREE.Vector3();
const _swayRot  = new THREE.Quaternion();
const _swayAxis = new THREE.Vector3();
const _swayMat  = new THREE.Matrix4();
const _swaySet  = new Set();

// buildSwayGrid is a hoisted function declaration — strandMeshes is already
// built above, so this runs safely here even though the body appears later.
buildSwayGrid();

// ── Crack fade-in animation ───────────────────────────────────────────────────
const activeCrackAnimations = [];
const CRACK_ANIM_DURATION   = 0.80; // seconds from invisible → full opacity

function updateCracks(dt) {
  for (let i = activeCrackAnimations.length - 1; i >= 0; i--) {
    const anim = activeCrackAnimations[i];
    // Group removed from scene (shattered during animation) — drop it cleanly.
    if (!anim.group.parent) { anim.crystal.crackAnimating = false; activeCrackAnimations.splice(i, 1); continue; }
    // Cap dt so a single large frame (tab focus resume, etc.) can't skip the fade.
    anim.progress = Math.min(1, anim.progress + Math.min(dt, 0.05) / CRACK_ANIM_DURATION);
    const t = anim.progress * anim.progress * (3 - 2 * anim.progress); // smoothstep
    anim.glowMat.uniforms.opacity.value = t * 0.12;
    anim.coreMat.uniforms.opacity.value = t * 0.90;
    if (anim.progress >= 1) { anim.crystal.crackAnimating = false; activeCrackAnimations.splice(i, 1); }
  }
}

function makeShardMesh(r, h) {
  const geo = new THREE.ConeGeometry(r, h, 3 + (Math.random() * 3 | 0), 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < h * 0.4) {
      pos.setX(i, pos.getX(i) + (Math.random() - 0.5) * r * 0.55);
      pos.setZ(i, pos.getZ(i) + (Math.random() - 0.5) * r * 0.55);
    }
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xe8f2ff, roughness: 0.09, metalness: 0.06,
    emissive: new THREE.Color(0xc8deff), emissiveIntensity: 1.0,
    transparent: true, opacity: 0.88, side: THREE.DoubleSide,
  }));
}

function updateShards(dt) {
  for (let i = activeShards.length - 1; i >= 0; i--) {
    const s = activeShards[i];

    s.sparkTimer += dt;
    if (s.sparkTimer < 0.8) {
      s.mesh.material.emissiveIntensity = 1.0 - s.sparkTimer / 0.8;
    }

    if (!s.landed) {
      const drag = 1 - dt * 1.4;  // light air resistance
      s.vel.multiplyScalar(drag);
      s.angVel.multiplyScalar(drag);
      s.vel.y -= SHARD_GRAVITY * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.angVel.x * dt;
      s.mesh.rotation.y += s.angVel.y * dt;
      s.mesh.rotation.z += s.angVel.z * dt;
      const sg  = s.shardGroup;
      const bdx = s.mesh.position.x - sg.baseCx;
      const bdz = s.mesh.position.z - sg.baseCz;
      const landY = (bdx * bdx + bdz * bdz) <= sg.baseTopR2 ? sg.baseTopY : 0;
      if (s.mesh.position.y <= landY && s.vel.y <= 0) {
        s.mesh.position.y = landY;
        s.landedY = landY;
        s.vel.set(0, 0, 0);
        s.angVel.set(0, 0, 0);
        s.landed = true;
      }
      continue;
    }

    if (!s.sinking) {
      s.sinkTimer += dt;
      if (s.sinkTimer >= s.sinkDelay) s.sinking = true;
      continue;
    }

    s.sinkProgress = Math.min(1, s.sinkProgress + dt / SINK_DURATION);
    const ease = s.sinkProgress * s.sinkProgress;
    if (s.landedY > 0) {
      // On stone platform — fade in place, no sinking
      s.mesh.material.opacity = 0.88 * (1 - s.sinkProgress);
    } else {
      // On moss/ground — sink down while fading
      const fadeEase = 1 - ease;
      s.mesh.position.y       = -ease * SINK_DEPTH;
      s.mesh.material.opacity = 0.88 * fadeEase * fadeEase;
    }

    if (s.sinkProgress >= 1) {
      scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
      activeShards.splice(i, 1);
      s.shardGroup.remaining--;
      if (s.shardGroup.remaining === 0) {
        const c    = crystals[s.shardGroup.crystalId];
        c.shattered   = false;
        c.cracks      = 0;
        c.growProgress = 0;
        c.regrowing   = true;
        pendingRegrowth.push({ crystalId: s.shardGroup.crystalId, progress: 0 });
      }
    }
  }
}

function updateRegrowth(dt) {
  for (let i = pendingRegrowth.length - 1; i >= 0; i--) {
    const r = pendingRegrowth[i];
    r.progress = Math.min(1, r.progress + dt / REGROW_DURATION);
    const c = crystals[r.crystalId];

    // Ease-out quadratic: crystal springs up quickly then settles smoothly
    const eased = 1 - (1 - r.progress) * (1 - r.progress);
    growScale.set(c.r * eased, c.h * eased, c.r * eased);
    growMatrix.compose(c.position, c.quaternion, growScale);
    crystalMesh.setMatrixAt(r.crystalId, growMatrix);
    crystalMesh.instanceMatrix.needsUpdate = true;

    if (r.progress >= 1) {
      c.regrowing = false;
      pendingRegrowth.splice(i, 1);
      renderer.shadowMap.needsUpdate = true;
    }
  }
}

function buildSwayGrid() {
  strandMeshes.forEach((mesh, mi) => {
    const arr = mesh.instanceMatrix.array;
    for (let idx = 0; idx < mesh.count; idx++) {
      const x = arr[idx * 16 + 12];
      const z = arr[idx * 16 + 14];
      const si = swayStrand.length;
      swayStrand.push({ mi, idx, x, z });
      const ck = `${Math.floor(x / SWAY_GRID_SZ)},${Math.floor(z / SWAY_GRID_SZ)}`;
      if (!swayGrid.has(ck)) swayGrid.set(ck, []);
      swayGrid.get(ck).push(si);
    }
  });
}

function activateSwayAt(wx, wz) {
  const R = EFFECTIVE_SWAY_RADIUS, R2 = R * R, t = clock.elapsedTime;
  const c0x = Math.floor((wx - R) / SWAY_GRID_SZ), c1x = Math.floor((wx + R) / SWAY_GRID_SZ);
  const c0z = Math.floor((wz - R) / SWAY_GRID_SZ), c1z = Math.floor((wz + R) / SWAY_GRID_SZ);
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cz = c0z; cz <= c1z; cz++) {
      const cell = swayGrid.get(`${cx},${cz}`);
      if (!cell) continue;
      for (const si of cell) {
        const sp = swayStrand[si];
        const dx = sp.x - wx, dz = sp.z - wz;
        if (dx * dx + dz * dz > R2) continue;
        const key = `${sp.mi}:${sp.idx}`;
        if (activeSways.has(key)) { activeSways.get(key).lastActive = t; continue; }
        const dist = Math.sqrt(dx * dx + dz * dz);
        const len  = dist || 1;
        const origMat  = new THREE.Matrix4();
        const origPos  = new THREE.Vector3();
        const origQuat = new THREE.Quaternion();
        const origScl  = new THREE.Vector3();
        strandMeshes[sp.mi].getMatrixAt(sp.idx, origMat);
        origMat.decompose(origPos, origQuat, origScl);
        let axisX = dz / len;
        let axisZ = -dx / len;
        let skipStrand = false;
        for (const b of crystalBases) {
          const bdx = sp.x - b.x, bdz = sp.z - b.z;
          const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
          if (bDist < b.r + 0.3) { skipStrand = true; break; }
          if (bDist < b.r + 1.4) {
            const blend = 1 - (bDist - b.r - 0.3) / 1.1;
            const tanX = -bdz / bDist, tanZ = bdx / bDist;
            axisX = axisX * (1 - blend) + tanX * blend;
            axisZ = axisZ * (1 - blend) + tanZ * blend;
            const aLen = Math.sqrt(axisX * axisX + axisZ * axisZ) || 1;
            axisX /= aLen; axisZ /= aLen;
          }
        }
        if (skipStrand) continue;
        activeSways.set(key, {
          mi: sp.mi, idx: sp.idx, origMat, origPos, origQuat, origScl,
          axisX,
          axisZ,
          strength: 1.0 - dist / R * 0.55,
          phase: dist * 1.6 + Math.random() * 0.8,
          startT: t, lastActive: t,
        });
      }
    }
  }
}

function updateMossSway() {
  if (activeSways.size === 0) return;
  _swaySet.clear();
  const t = clock.elapsedTime;
  for (const [key, sw] of activeSways) {
    const decay = Math.max(0, 1.0 - (t - sw.lastActive) / EFFECTIVE_SWAY_DECAY);
    if (decay === 0) {
      strandMeshes[sw.mi].setMatrixAt(sw.idx, sw.origMat);
      _swaySet.add(sw.mi);
      activeSways.delete(key);
      continue;
    }
    const elapsed   = t - sw.startT;
    const ei        = Math.min(1, elapsed / SWAY_EASE_IN);
    const easeIn    = ei * ei * (3 - 2 * ei); // smoothstep 0→1
    const angle     = Math.sin(elapsed * SWAY_FREQ * Math.PI * 2 + sw.phase)
                      * SWAY_MAX_ANGLE * sw.strength * decay * easeIn;
    _swayPos.copy(sw.origPos);
    _swayQuat.copy(sw.origQuat);
    _swayScl.copy(sw.origScl);
    _swayAxis.set(sw.axisX, 0, sw.axisZ);
    _swayRot.setFromAxisAngle(_swayAxis, angle);
    _swayQuat.premultiply(_swayRot);
    _swayMat.compose(_swayPos, _swayQuat, _swayScl);
    strandMeshes[sw.mi].setMatrixAt(sw.idx, _swayMat);
    _swaySet.add(sw.mi);
  }
  for (const mi of _swaySet) strandMeshes[mi].instanceMatrix.needsUpdate = true;
}

function shatterCrystal(instanceId) {
  playCrystalShatter();
  const c = crystals[instanceId];
  c.shattered = true;

  // Each crack mesh is now a THREE.Group — traverse to dispose children.
  for (const group of c.crackMeshes) {
    scene.remove(group);
    group.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }
  c.crackMeshes = [];

  crystalMesh.setMatrixAt(instanceId, new THREE.Matrix4().makeScale(0, 0, 0));
  crystalMesh.instanceMatrix.needsUpdate = true;

  const growH = c.h * (1 + (GROWTH_SCALE - 1) * smoothstep(c.growProgress));

  // Volume-proportional shard count: sqrt scaling keeps the range sensible
  // across debris slivers (r≈0.04, h≈0.1 → 5 shards) through large grown
  // crystals (r≈0.18, h≈2.97 → ~22 shards).
  const volume    = c.r * c.r * growH;
  const numShards = Math.max(8, Math.min(33, Math.round(Math.sqrt(volume / 0.0015) * 4.5)));

  // Identify which stone base this crystal sits on (nearest cluster centre).
  let bestCluster = clusterMeta[0], bestD2 = Infinity;
  for (const cm of clusterMeta) {
    const dx = c.position.x - cm.cx, dz = c.position.z - cm.cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestCluster = cm; }
  }
  // Base top world-Y = y0(-0.09) + height(0.59) = 0.50; top radius = scale*0.76*0.90.
  const baseTopR2 = (bestCluster.scale * 0.684) ** 2;

  const shardGroup = {
    remaining: numShards, crystalId: instanceId,
    baseCx: bestCluster.cx, baseCz: bestCluster.cz,
    baseTopY: 0.50, baseTopR2,
  };

  for (let i = 0; i < numShards; i++) {
    const angle = Math.random() * Math.PI * 2;
    const mesh  = makeShardMesh(
      c.r * 0.136 * (0.5 + Math.random() * 0.9),
      growH * 0.12 * (0.4 + Math.random() * 1.0),
    );
    mesh.position.set(
      c.position.x + Math.cos(angle) * Math.random() * c.r * 0.8,
      Math.random() * growH * 0.85,
      c.position.z + Math.sin(angle) * Math.random() * c.r * 0.8,
    );
    mesh.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );
    scene.add(mesh);
    const sp = 0.7 + Math.random() * 2.2;
    activeShards.push({
      mesh,
      vel:          new THREE.Vector3(
        Math.cos(angle) * sp + (Math.random() - 0.5) * 0.5,
        0.6 + Math.random() * 2.6,
        Math.sin(angle) * sp + (Math.random() - 0.5) * 0.5,
      ),
      angVel:       new THREE.Vector3(
        (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 7,
      ),
      landed:       false,
      landedY:      0,
      sinking:      false,
      sinkProgress: 0,
      sinkTimer:    0,
      sinkDelay:    0.28 + Math.random() * 0.55,
      sparkTimer:   0,
      shardGroup,
    });
  }
}

function handleCrystalTap(instanceId) {
  const c = crystals[instanceId];
  if (c.shattered || c.regrowing) return;
  // Gate: ignore taps until the previous crack has fully faded in, so rapid
  // tapping can't stack/skip cracks before their visuals are ever seen.
  if (c.crackAnimating) return;
  c.cracks++;
  if (c.cracks >= 3) { shatterCrystal(instanceId); return; }
  c.crackAnimating = true;
  const crack    = buildCrackMesh((instanceId * 7919 + c.cracks * 6271) >>> 0, c.cracks - 1);
  const currentH = c.h * (1 + (GROWTH_SCALE - 1) * smoothstep(c.growProgress));
  crack.position.copy(c.position);
  crack.quaternion.copy(c.quaternion);
  crack.scale.set(c.r, currentH, c.r);
  scene.add(crack);
  c.crackMeshes.push(crack);
  activeCrackAnimations.push({
    group:    crack,
    progress: 0,
    glowMat:  crack.children[0].material,
    coreMat:  crack.children[1].material,
    crystal:  c,
  });
}

let heldInstanceId  = null;
let pointerDownId   = null;
let pointerDownTime = 0;
const TAP_MAX_MS    = 220; // shorter than this = tap (crack), longer = hold (grow)

function pickCrystal(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(crystalMesh);
  return hits.length ? hits[0].instanceId : null;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  const id = pickCrystal(event);
  if (id !== null) {
    heldInstanceId  = id;
    pointerDownId   = id;
    pointerDownTime = performance.now();
  }
});

function onPointerRelease() {
  if (pointerDownId !== null && performance.now() - pointerDownTime < TAP_MAX_MS) {
    playCrystalTap();
    handleCrystalTap(pointerDownId);
  }
  heldInstanceId = null;
  pointerDownId  = null;
}

window.addEventListener('pointerup',     onPointerRelease);
window.addEventListener('pointercancel', () => { heldInstanceId = null; pointerDownId = null; });

// ── Moss wind-sway pointer events ─────────────────────────────────────────────
const mossPointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const groundPt    = new THREE.Vector3();
let   swayDragging = false;

function getMossGroundPt(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  mossPointer.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mossPointer.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(mossPointer, camera);
  return raycaster.ray.intersectPlane(groundPlane, groundPt) ? groundPt : null;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (pointerDownId !== null) return;
  playRustle();
  swayDragging = true;
  const pt = getMossGroundPt(e);
  if (pt) activateSwayAt(pt.x, pt.z);
});

// ── Rustle Audio ──────────────────────────────────────────────────────────────
let _rCtx = null, _rGain = null;
let _growBuffer  = null;
let _growSource  = null;
let _growGain    = null;
let _growPlaying = false;

function _buildAudio() {
  _rCtx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = _rCtx.createBuffer(1, _noiseData.length, _rCtx.sampleRate);
  buffer.getChannelData(0).set(_noiseData);
  const source = _rCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const filter = _rCtx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 900;
  filter.Q.value = 0.4;
  const shaper = _rCtx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i * 2) / 256 - 1;
    curve[i] = (Math.PI + 120) * x / (Math.PI + 120 * Math.abs(x));
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  _rGain = _rCtx.createGain();
  _rGain.gain.value = 0;
  source.connect(filter);
  filter.connect(shaper);
  shaper.connect(_rGain);
  _rGain.connect(_rCtx.destination);
  source.start(0);
}

function playRustle() {
  if (!_rGain) return;
  _rGain.gain.cancelScheduledValues(_rCtx.currentTime);
  _rGain.gain.setTargetAtTime(0.018, _rCtx.currentTime, 0.35);
}

function stopRustle() {
  if (!_rGain) return;
  _rGain.gain.cancelScheduledValues(_rCtx.currentTime);
  _rGain.gain.setTargetAtTime(0, _rCtx.currentTime, 1.2);
}

async function buildGrowBuffer() {
  if (!_rCtx || _growBuffer) return;
  const totalDur = GROWTH_DURATION + 2.0;
  const sr       = _rCtx.sampleRate;
  const offCtx   = new OfflineAudioContext(1, Math.ceil(sr * totalDur), sr);

  function offNoise(dur) {
    const buf  = offCtx.createBuffer(1, Math.ceil(sr * dur), sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src  = offCtx.createBufferSource(); src.buffer = buf; return src;
  }

  const rev  = offCtx.createDelay(1.0); rev.delayTime.value  = 0.26;
  const rfb  = offCtx.createGain();     rfb.gain.value        = 0.36;
  const rwet = offCtx.createGain();     rwet.gain.value       = 0.40;
  const rdry = offCtx.createGain();     rdry.gain.value       = 1.0;
  const mix  = offCtx.createGain();     mix.gain.value        = 1.0;
  mix.connect(rdry); mix.connect(rev);
  rev.connect(rfb); rfb.connect(rev); rev.connect(rwet);
  rdry.connect(offCtx.destination); rwet.connect(offCtx.destination);

  const fadeInDur = 0.40 * GROWTH_DURATION * 0.6;

  // high crackles
  const hiCount = 19, hiInterval = 0.073, hiCDur = 0.06;
  for (let i = 0; i < hiCount; i++) {
    const t       = i * hiInterval + Math.random() * hiInterval;
    if (t > GROWTH_DURATION) continue;
    const fadePos = Math.min(1, t / (fadeInDur + 0.001));
    const peak    = 0.06 * fadePos * (1 - i / (hiCount * 1.8));
    if (peak <= 0) continue;
    const n = offNoise(hiCDur + 0.01);
    const f = offCtx.createBiquadFilter(); f.type = 'highpass';
    f.frequency.value = 6300 + Math.random() * 5000;
    const g = offCtx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + hiCDur);
    n.connect(f); f.connect(g); g.connect(mix);
    n.start(t); n.stop(t + hiCDur + 0.02);
  }

  // low crackles
  const loCount = 12, loInterval = 0.12, loCDur = 0.12;
  for (let i = 0; i < loCount; i++) {
    const t       = i * loInterval + Math.random() * loInterval;
    if (t > GROWTH_DURATION) continue;
    const fadePos = Math.min(1, t / (fadeInDur + 0.001));
    const peak    = 0.05 * fadePos * (1 - i / (loCount * 1.8));
    if (peak <= 0) continue;
    const n = offNoise(loCDur + 0.01);
    const f = offCtx.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = 850 + Math.random() * 600;
    const g = offCtx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + loCDur);
    n.connect(f); f.connect(g); g.connect(mix);
    n.start(t); n.stop(t + loCDur + 0.02);
  }

  _growBuffer = await offCtx.startRendering();
}

function playGrowAudio(offset) {
  if (!_rCtx || !_growBuffer) return;
  if (_growSource) { try { _growSource.stop(); } catch(e) {} _growSource = null; }
  if (!_growGain) {
    _growGain = _rCtx.createGain();
    _growGain.gain.value = 0.41 * 0.9;
    _growGain.connect(_rCtx.destination);
  }
  _growSource = _rCtx.createBufferSource();
  _growSource.buffer = _growBuffer;
  _growSource.connect(_growGain);
  _growSource.start(0, Math.min(offset, _growBuffer.duration - 0.05));
  _growPlaying = true;
}

function pauseGrowAudio() {
  if (_growSource) { try { _growSource.stop(); } catch(e) {} _growSource = null; }
  _growPlaying = false;
}

function playCrystalTap() {
  if (!_rCtx) return;
  const ctx        = _rCtx;
  const now        = ctx.currentTime;
  const sharpVal   = 0.88;
  const brightVal  = 0.0;
  const ringAmt    = 0.52;
  const ringPitch  = 0.85;
  const ringDecay  = 0.55;
  const countVal   = 0.21;
  const durVal     = 0.05 + 0.06 * 0.6;
  const speedVal   = 1.0;
  const fadeVal    = 0.0;
  const randVal    = 1.0;
  const driftVal   = 0.61;
  const echoAmt    = 0.19;
  const volAmt     = 0.55;

  const master = ctx.createGain(); master.gain.value = volAmt * 0.9;
  if (echoAmt > 0.05) {
    const rev = ctx.createDelay(0.4); rev.delayTime.value = 0.06 + echoAmt * 0.12;
    const rfb = ctx.createGain(); rfb.gain.value = echoAmt * 0.3;
    const rwet= ctx.createGain(); rwet.gain.value = echoAmt * 0.35;
    const rdry= ctx.createGain(); rdry.gain.value = 1.0;
    master.connect(rdry); master.connect(rev);
    rev.connect(rfb); rfb.connect(rev); rev.connect(rwet);
    rdry.connect(ctx.destination); rwet.connect(ctx.destination);
  } else { master.connect(ctx.destination); }

  const baseFreq     = 2000 + brightVal * 4000;
  const baseDur      = 0.006 + (1 - sharpVal) * 0.012;
  const tailDur      = 0.012 + (1 - sharpVal) * 0.02;
  const numSnaps     = 1 + Math.round(countVal * 5);
  const baseInterval = numSnaps > 1 ? durVal / (numSnaps - 1) : 0;
  const speedInt     = baseInterval * (0.3 + (1 - speedVal) * 1.4);
  const glassFreqs   = [800 + ringPitch * 2400, 1600 + ringPitch * 3200, 2800 + ringPitch * 2000];
  const glassDecay   = 0.08 + ringDecay * 0.55;

  for (let i = 0; i < numSnaps; i++) {
    const t       = now + i * speedInt + Math.random() * randVal * speedInt * 0.5;
    const fadeOff = Math.pow(1 - (i / numSnaps) * fadeVal, 1.5);
    const gain    = (i === 0 ? 0.55 : 0.35) * fadeOff;
    const freq    = baseFreq * (1 - i * driftVal * 0.08 + (Math.random() - 0.5) * randVal * 0.15);
    const dur     = baseDur * (1 + i * 0.1);

    const n  = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const nd = n.getChannelData(0);
    for (let j = 0; j < nd.length; j++) nd[j] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = n;
    const nf  = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = Math.max(freq, 200);
    const ng  = ctx.createGain(); ng.gain.setValueAtTime(gain, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(nf); nf.connect(ng); ng.connect(master); src.start(t); src.stop(t + dur + 0.005);

    if (ringAmt > 0.02) {
      glassFreqs.forEach((gFreq, gi) => {
        const ringFreq = gFreq * (1 + (Math.random() - 0.5) * randVal * 0.1);
        const osc = ctx.createOscillator(); const og = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(ringFreq, t);
        osc.frequency.linearRampToValueAtTime(ringFreq * 0.97, t + glassDecay);
        const ringGain = ringAmt * (0.05 - gi * 0.012) * fadeOff * (i === 0 ? 1.4 : 1.0);
        if (ringGain <= 0) return;
        og.gain.setValueAtTime(0, t);
        og.gain.linearRampToValueAtTime(ringGain, t + 0.003);
        og.gain.exponentialRampToValueAtTime(0.0001, t + glassDecay * (1 - gi * 0.15));
        osc.connect(og); og.connect(master);
        osc.start(t); osc.stop(t + glassDecay + 0.05);
      });
    }

    if (i === 0) {
      const n2  = ctx.createBuffer(1, Math.floor(ctx.sampleRate * tailDur), ctx.sampleRate);
      const nd2 = n2.getChannelData(0);
      for (let j = 0; j < nd2.length; j++) nd2[j] = Math.random() * 2 - 1;
      const src2 = ctx.createBufferSource(); src2.buffer = n2;
      const nf2  = ctx.createBiquadFilter(); nf2.type = 'bandpass'; nf2.frequency.value = Math.max(freq, 200) * 0.5; nf2.Q.value = 0.8;
      const ng2  = ctx.createGain(); ng2.gain.setValueAtTime(gain * 0.22, t + dur * 0.5); ng2.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.5 + tailDur);
      src2.connect(nf2); nf2.connect(ng2); ng2.connect(master); src2.start(t + dur * 0.5); src2.stop(t + dur * 0.5 + tailDur + 0.005);
    }
  }
}

function playCrystalShatter() {
  if (!_rCtx) return;
  const ctx         = _rCtx;
  const now         = ctx.currentTime;
  const impactForce = 0.25;
  const impactPitch = 1.0;
  const impactLen   = 1.0;
  const shardCount  = 0.65;
  const shardPitch  = 1.0;
  const spreadAmt   = 1.0;
  const randAmt     = 1.0;
  const decayAmt    = 0.65;
  const echoAmt     = 0.27;
  const shimmerAmt  = 1.0;
  const volAmt      = 0.60;

  const master = ctx.createGain();
  master.gain.value = volAmt * 0.9;

  if (echoAmt > 0.05) {
    const delay   = ctx.createDelay(1.0);
    delay.delayTime.value = 0.06 + echoAmt * 0.15;
    const fbGain  = ctx.createGain(); fbGain.gain.value  = echoAmt * 0.3;
    const dryGain = ctx.createGain(); dryGain.gain.value = 1.0;
    const wetGain = ctx.createGain(); wetGain.gain.value = echoAmt * 0.45;
    master.connect(dryGain); master.connect(delay);
    delay.connect(fbGain); fbGain.connect(delay); delay.connect(wetGain);
    dryGain.connect(ctx.destination); wetGain.connect(ctx.destination);
  } else {
    master.connect(ctx.destination);
  }

  // impact noise burst
  const impactDur = 0.05 + impactLen * 0.15;
  const nBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * (impactDur + 0.02)), ctx.sampleRate);
  const nd   = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const nSrc = ctx.createBufferSource(); nSrc.buffer = nBuf;
  const nF   = ctx.createBiquadFilter(); nF.type = 'bandpass';
  nF.frequency.value = 1500 + impactPitch * 6000; nF.Q.value = 0.4;
  const nG   = ctx.createGain();
  nG.gain.setValueAtTime(impactForce * 0.45, now);
  nG.gain.exponentialRampToValueAtTime(0.0001, now + impactDur);
  nSrc.connect(nF); nF.connect(nG); nG.connect(master);
  nSrc.start(now); nSrc.stop(now + impactDur + 0.02);

  // shard chimes
  const numShards = 3 + Math.round(shardCount * 9);
  for (let i = 0; i < numShards; i++) {
    const t        = now + 0.04 + i * (0.04 + spreadAmt * 0.06) + Math.random() * randAmt * 0.06;
    const baseFreq = 800 + shardPitch * 4500;
    const freq     = baseFreq * (0.6 + Math.random() * 1.4);
    const osc      = ctx.createOscillator();
    const og       = ctx.createGain();
    osc.type       = 'sine';
    if (shimmerAmt > 0.05) {
      osc.frequency.setValueAtTime(freq * (1 + shimmerAmt * 0.03), t);
      osc.frequency.linearRampToValueAtTime(freq, t + 0.04);
    } else {
      osc.frequency.value = freq;
    }
    const peak      = (0.08 - i * 0.005) * (1 - i / (numShards * 1.5));
    if (peak <= 0) continue;
    const decayTime = 0.12 + decayAmt * 0.5 + Math.random() * randAmt * 0.2;
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(Math.max(peak, 0.001), t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + decayTime);
    osc.connect(og); og.connect(master);
    osc.start(t); osc.stop(t + decayTime + 0.1);
  }
}

const _gate = document.getElementById('audio-gate');
function _handleGate() {
  _buildAudio();
  _rCtx.resume();
  buildGrowBuffer();
  _gate.style.opacity = '0';
  setTimeout(() => _gate.style.display = 'none', 800);
}
_gate.addEventListener('touchend', _handleGate, { once: true });
_gate.addEventListener('click', _handleGate, { once: true });

let _lastSwayMs = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!swayDragging || heldInstanceId !== null) return;
  if (isMobile) {
    const now = performance.now();
    if (now - _lastSwayMs < 33) return;
    _lastSwayMs = now;
  }
  const pt = getMossGroundPt(e);
  if (pt) activateSwayAt(pt.x, pt.z);
});

window.addEventListener('pointerup', () => {
  pauseGrowAudio();
  swayDragging = false;
  stopRustle();
});
window.addEventListener('pointercancel', () => {
  pauseGrowAudio();
  swayDragging = false;
  stopRustle();
});

function updateGrowth(dt) {
  if (heldInstanceId === null) return;
  // Don't start growing until the hold has outlasted the tap window — a quick
  // tap should never trigger growth, only the sustained hold beyond TAP_MAX_MS.
  if (performance.now() - pointerDownTime < TAP_MAX_MS) return;
  const c = crystals[heldInstanceId];
  if (c.shattered || c.regrowing || c.growProgress >= 1) {
    if (_growPlaying) pauseGrowAudio();
    return;
  }
  if (!_growPlaying) playGrowAudio(c.growProgress * GROWTH_DURATION);
  c.growProgress = Math.min(1, c.growProgress + dt / GROWTH_DURATION);
  const h = c.h * (1 + (GROWTH_SCALE - 1) * smoothstep(c.growProgress));

  growScale.set(c.r, h, c.r);
  growMatrix.compose(c.position, c.quaternion, growScale);
  crystalMesh.setMatrixAt(heldInstanceId, growMatrix);
  crystalMesh.instanceMatrix.needsUpdate = true;

  for (const crack of c.crackMeshes) {
    crack.scale.set(c.r, h, c.r);
  }
}

// ── Reset ────────────────────────────────────────────────────────────────────
// Restores the camera framing and shrinks every grown crystal back to its
// original height — a full return to the scene's starting state.

document.getElementById('reset-btn').addEventListener('click', () => {
  camera.position.copy(CAM_POS);
  camera.lookAt(CAM_TARGET);

  heldInstanceId = null;
  pointerDownId  = null;

  // Remove all landed and in-flight shards.
  for (const s of activeShards) {
    scene.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mesh.material.dispose();
  }
  activeShards.length = 0;
  activeCrackAnimations.length = 0;
  pendingRegrowth.length = 0;

  for (let i = 0; i < crystals.length; i++) {
    const c = crystals[i];

    // Remove crack groups.
    for (const group of c.crackMeshes) {
      scene.remove(group);
      group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }
    c.crackMeshes    = [];
    c.cracks         = 0;
    c.crackAnimating = false;

    const wasModified = c.growProgress > 0 || c.shattered || c.regrowing;
    c.growProgress = 0;
    c.shattered    = false;
    c.regrowing    = false;

    if (!wasModified) continue;

    growScale.set(c.r, c.h, c.r);
    growMatrix.compose(c.position, c.quaternion, growScale);
    crystalMesh.setMatrixAt(i, growMatrix);
  }
  crystalMesh.instanceMatrix.needsUpdate = true;
  renderer.shadowMap.needsUpdate = true;
});

// ── TEMP: on-screen FPS readout for mobile perf testing — remove when done ───
const fpsEl = document.createElement('div');
fpsEl.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;' +
  'font:12px/1.4 monospace;color:#9f9;background:rgba(0,0,0,0.55);' +
  'padding:4px 8px;border-radius:4px;pointer-events:none;white-space:pre;';
document.body.appendChild(fpsEl);
let fpsFrames = 0, fpsAccum = 0;

if (isMobile) {
  renderer.shadowMap.enabled = false;
  scene.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = false;
      obj.receiveShadow = false;
    }
  });
}

// ── Render loop ──────────────────────────────────────────────────────────────
// `dt` and `clock.elapsedTime` are ready here for future per-frame animation.

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  updateGrowth(dt);
  updateShards(dt);
  updateCracks(dt);
  updateRegrowth(dt);
  updateMossSway();
  renderer.render(scene, camera);

  // TEMP FPS readout — updates ~2x/sec so the number is readable, not jittery.
  fpsFrames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    const fps = fpsFrames / fpsAccum;
    fpsEl.textContent = `${fps.toFixed(1)} fps`;
    fpsFrames = 0;
    fpsAccum = 0;
  }
});

// ── Console handles for future animation work ─────────────────────────────────

window.__qmw = { THREE, scene, camera, renderer, clock, crystalMesh, rockMesh, tuftMesh, strandMeshes, crystals, rocks, tufts, GROWTH_DURATION, GROWTH_SCALE };
