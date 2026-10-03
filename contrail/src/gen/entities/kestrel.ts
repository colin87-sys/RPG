/**
 * KESTREL: the player craft (original design). Pure function of (params, seed).
 *
 * Layout: nose -> -Z, up +Y, origin at centre of mass. Angular faceted fuselage
 * (12-sided loft with a knife-edge chine that flares into the wing root), faceted
 * bubble canopy, cranked delta wing with a forward-swept trailing edge and
 * outboard elevons, canted angular wingtip fins (upper + ventral, "fletching"),
 * raked cheek intakes, twin petal nozzles with hot cores, spine vent housings
 * carrying the orange emissive grilles, emblem discs projected on the wings.
 *
 * Draw calls: hull (1) + inverted-hull outline (1, optional) + exhaust (1).
 * Control surfaces move in the vertex shader (uPart matrices), so they cost nothing.
 */
import * as THREE from 'three';
import { palette, scale, type PaletteKey } from '../../style/tokens';
import { Rng } from '../../core/rng';
import { HullBuilder, SURF, createHullMaterials, type FaceStyle } from './hullMaterial';
import { buildExhaust, ExhaustSpring, type ExhaustParams } from './exhaust';

export interface KestrelLivery {
  primary: PaletteKey; // large panels (wing tops, spine)
  secondary: PaletteKey; // mid panels (sides, leading edges, nozzles)
  under: PaletteKey; // underside, intakes, rear face
  accent: PaletteKey; // emissive inserts and trim
  glass: PaletteKey;
}

export interface KestrelParams {
  name: string;
  note: string;
  /** multiplies the nose length ahead of the windscreen */
  noseStretch: number;
  /** multiplies fuselage half-widths */
  bodyWidth: number;
  /** leading-edge sweep, degrees */
  wingSweep: number;
  /** wingtip x (m); fins add ~0.5 m of span */
  wingTipX: number;
  tipChord: number;
  /** root trailing-edge z (m) */
  rootTE: number;
  dihedral: number;
  finHeight: number;
  finCant: number;
  ventralHeight: number;
  ventralCant: number;
  livery: KestrelLivery;
  /** 0..1: how much orange (0.5 = grilles + fin bands + chine; 1 adds wing-root vents, intake lips, nose band) */
  accentAmount: number;
  insertGlow: number;
  panelJitter: number;
  seamWidth: number;
  seamDarkness: number;
  rim: number;
  specular: number;
  outline: boolean;
  outlineWidth: number;
  exhaust: Partial<ExhaustParams>;
}

export interface KestrelState {
  time: number;
  /** radians, positive = rolled right (starboard wing down) */
  bank: number;
  /** radians, positive = nose up */
  pitch: number;
  /** 0..1.6 (1 = cruise, 1.6 = boost, 0.5 = brake) */
  throttle: number;
  boost: boolean;
  drift: boolean;
  /** 0..1 (1 = full white) */
  hitFlash: number;
}

export interface KestrelStats {
  hullTriangles: number;
  outlineTriangles: number;
  exhaustTriangles: number;
  /** triangles actually drawn per frame (hull + outline if on + exhaust) */
  triangles: number;
  drawCalls: number;
  bounds: [number, number, number];
}

export interface Kestrel {
  /** place/yaw this in the world; do NOT roll it: pass bank/pitch to update() */
  root: THREE.Group;
  /** inner group carrying bank/pitch and the meshes */
  body: THREE.Group;
  update(dt: number, s: KestrelState): void;
  /** jump all springs to the given state (menus, boards, respawn) */
  snap(s: KestrelState): void;
  /** root-local positions, refreshed by update()/snap() (include bank/pitch) */
  exhaustPorts: THREE.Vector3[];
  wingtips: THREE.Vector3[];
  missilePorts: THREE.Vector3[];
  muzzles: THREE.Vector3[];
  /** bounding-sphere radius about the origin (m) */
  radius: number;
  /** suggested gameplay hit radius (m) */
  hitRadius: number;
  stats: KestrelStats;
  setSilhouette(on: boolean): void;
  setOutline(on: boolean): void;
  dispose(): void;
}

const BASE: Omit<KestrelParams, 'name' | 'note' | 'livery' | 'accentAmount' | 'outline'> = {
  noseStretch: 1,
  bodyWidth: 1,
  wingSweep: 52,
  wingTipX: 4.05,
  tipChord: 1.0,
  rootTE: 4.35,
  dihedral: -3,
  finHeight: 1.25,
  finCant: 22,
  ventralHeight: 0.55,
  ventralCant: 32,
  insertGlow: 1.0,
  panelJitter: 0.05,
  seamWidth: 0.012,
  seamDarkness: 0.55,
  rim: 1.0,
  specular: 0.35,
  outlineWidth: 0.035,
  exhaust: {},
};

export const KESTREL_VARIANTS: Record<'A' | 'B' | 'C', KestrelParams> = {
  A: {
    ...BASE,
    name: 'A Gull',
    note: 'light armour dominant, steel sides, orange grilles + fin bands, outline on',
    livery: { primary: 'armourLight', secondary: 'armourSteel', under: 'armourDark', accent: 'accentOrange', glass: 'canopyBlue' },
    accentAmount: 0.5,
    outline: true,
  },
  B: {
    ...BASE,
    name: 'B Ember',
    note: 'steel dominant, light trim, extra orange (wing vents, intake lips, nose band), hotter glow',
    livery: { primary: 'armourSteel', secondary: 'armourLight', under: 'armourDark', accent: 'accentOrange', glass: 'canopyBlue' },
    accentAmount: 1,
    insertGlow: 1.25,
    rim: 1.15,
    outline: true,
    exhaust: { length: 2.9, glow: 1.2 },
  },
  C: {
    ...BASE,
    name: 'C Longbow',
    note: 'longer nose, wider delta (less sweep), shorter fins canted wider, flat wings, no outline',
    livery: { primary: 'armourLight', secondary: 'armourSteel', under: 'armourDark', accent: 'accentOrange', glass: 'canopyBlue' },
    accentAmount: 0.5,
    noseStretch: 1.3,
    wingSweep: 44,
    wingTipX: 4.25,
    tipChord: 1.2,
    rootTE: 4.2,
    dihedral: 0,
    finHeight: 1.0,
    finCant: 30,
    ventralHeight: 0.45,
    seamDarkness: 0.65,
    rim: 1.2,
    outline: false,
  },
};

// ---------------------------------------------------------------------------
// geometry helpers

type V3 = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function newell(p: V3[]): V3 {
  const n = new THREE.Vector3();
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n;
}

/** quad with its winding chosen so the normal faces `dir` */
function oq(b: HullBuilder, a: V3, c1: V3, c2: V3, d: V3, s: FaceStyle, seams: [boolean, boolean, boolean, boolean], dir: V3) {
  if (newell([a, c1, c2, d]).dot(dir) >= 0) b.quad(a, c1, c2, d, s, seams);
  else b.quad(a, d, c2, c1, s, [seams[3], seams[2], seams[1], seams[0]]);
}

function opoly(b: HullBuilder, p: V3[], s: FaceStyle, dir: V3, seams?: boolean[]) {
  if (newell(p).dot(dir) >= 0) b.poly(p, s, seams);
  else {
    const r = [...p].reverse();
    // edge i of reversed = edge (n-2-i) of original
    const n = p.length;
    b.poly(r, s, seams ? r.map((_, i) => seams[(n - 2 - i + n) % n]) : undefined);
  }
}

const styleKey = (s: FaceStyle | null) => (s ? `${s.color}|${s.kind ?? 0}|${s.decal ?? 0}` : 'x');

/**
 * Loft between rings (front to back). grid[i][j] = style of strip i, face j (null = skip).
 * Seams at style changes, at seamRing stations and seamSide columns.
 * orient(center) returns the desired outward direction (default: away from ring centroid).
 */
function loft(
  b: HullBuilder,
  rings: V3[][],
  grid: (FaceStyle | null)[][],
  o: { closed?: boolean; seamRing?: (i: number) => boolean; seamSide?: (j: number) => boolean; orient?: (c: V3, cen: V3) => V3; ends?: boolean } = {},
) {
  const closed = o.closed ?? true;
  const nS = rings.length, nP = rings[0].length;
  const nF = closed ? nP : nP - 1;
  const st = (i: number, j: number) => (i < 0 || i >= nS - 1 ? null : grid[i][closed ? (j + nF) % nF : j] ?? null);
  for (let i = 0; i < nS - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    const cen = new THREE.Vector3();
    for (const p of r0) cen.add(p);
    for (const p of r1) cen.add(p);
    cen.multiplyScalar(1 / (2 * nP));
    for (let j = 0; j < nF; j++) {
      const s = grid[i][j];
      if (!s) continue;
      const k = styleKey(s);
      const a = r0[j], bb = r1[j], c = r1[(j + 1) % nP], d = r0[(j + 1) % nP];
      const jp = j - 1, jn = j + 1;
      const e0 = (o.seamSide?.(j) ?? false) || (!closed && jp < 0) || styleKey(st(i, jp)) !== k;
      const e2 = (o.seamSide?.(j + 1) ?? false) || (!closed && jn >= nF) || styleKey(st(i, jn)) !== k;
      const e1 = (o.seamRing?.(i + 1) ?? false) || ((o.ends ?? true) && i + 1 >= nS - 1) || styleKey(st(i + 1, j)) !== k;
      const e3 = (o.seamRing?.(i) ?? false) || ((o.ends ?? true) && i === 0) || styleKey(st(i - 1, j)) !== k;
      const center = new THREE.Vector3().add(a).add(bb).add(c).add(d).multiplyScalar(0.25);
      const dir = o.orient ? o.orient(center, cen) : center.clone().sub(cen);
      oq(b, a, bb, c, d, s, [e0, e1, e2, e3], dir);
    }
  }
}

interface Station {
  z: number; yT: number; xSp: number; dSp: number; xSh: number; ySh: number;
  xC: number; yCt: number; yCb: number; xB: number; yB: number; yK: number;
}
const ST = (z: number, yT: number, xSp: number, dSp: number, xSh: number, ySh: number, xC: number, yCt: number, yCb: number, xB: number, yB: number, yK: number): Station =>
  ({ z, yT, xSp, dSp, xSh, ySh, xC, yCt, yCb, xB, yB, yK });

const FUSELAGE: Station[] = [
  ST(-6.7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
  ST(-5.9, 0.13, 0.05, 0.02, 0.16, 0.07, 0.25, -0.02, -0.05, 0.14, -0.14, -0.17),
  ST(-4.9, 0.3, 0.1, 0.03, 0.32, 0.2, 0.47, 0.0, -0.07, 0.3, -0.3, -0.36),
  ST(-3.9, 0.5, 0.14, 0.04, 0.44, 0.34, 0.66, 0.02, -0.08, 0.42, -0.44, -0.52),
  ST(-2.6, 0.62, 0.16, 0.04, 0.52, 0.44, 0.86, 0.04, -0.07, 0.52, -0.54, -0.62),
  ST(-1.2, 0.7, 0.18, 0.05, 0.6, 0.48, 1.02, 0.05, -0.06, 0.62, -0.58, -0.66),
  ST(0.4, 0.66, 0.22, 0.06, 0.74, 0.46, 1.08, 0.05, -0.06, 0.8, -0.56, -0.64),
  ST(2.0, 0.58, 0.26, 0.06, 0.9, 0.42, 1.14, 0.04, -0.06, 0.98, -0.52, -0.6),
  ST(3.6, 0.5, 0.28, 0.05, 1.0, 0.36, 1.16, 0.03, -0.07, 1.04, -0.48, -0.56),
  ST(4.7, 0.44, 0.26, 0.05, 0.98, 0.32, 1.12, 0.02, -0.08, 1.02, -0.44, -0.52),
];

function stationsFor(p: KestrelParams): Station[] {
  return FUSELAGE.map((s) => {
    const z = s.z < -3.9 ? -3.9 + (s.z + 3.9) * p.noseStretch : s.z;
    const w = p.bodyWidth;
    return { ...s, z, xSp: s.xSp * w, xSh: s.xSh * w, xC: s.xC * w, xB: s.xB * w };
  });
}

function stationAt(S: Station[], z: number): Station {
  let i = 0;
  while (i < S.length - 2 && S[i + 1].z < z) i++;
  const a = S[i], b = S[i + 1];
  const t = THREE.MathUtils.clamp((z - a.z) / (b.z - a.z), 0, 1);
  const out = { ...a };
  for (const k of Object.keys(a) as (keyof Station)[]) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

function ring12(s: Station): V3[] {
  const half: [number, number][] = [[s.xSp, s.yT - s.dSp], [s.xSh, s.ySh], [s.xC, s.yCt], [s.xC - 0.03, s.yCb], [s.xB, s.yB]];
  const r: V3[] = [v(0, s.yT, s.z)];
  for (const [x, y] of half) r.push(v(Math.max(x, 0), y, s.z));
  r.push(v(0, s.yK, s.z));
  for (let i = half.length - 1; i >= 0; i--) r.push(v(-Math.max(half[i][0], 0), half[i][1], s.z));
  return r;
}

/** y of the fuselage upper face (spine -> shoulder) at x */
function upperY(s: Station, x: number): number {
  const t = THREE.MathUtils.clamp((x - s.xSp) / Math.max(1e-3, s.xSh - s.xSp), 0, 1);
  return s.yT - s.dSp + (s.ySh - (s.yT - s.dSp)) * t;
}

interface Layout {
  exhaustPorts: V3[];
  wingtips: V3[];
  missilePorts: V3[];
  muzzles: V3[];
  parts: { id: number; pivot: V3; axis: V3 }[];
  decals: { x: number; z: number; r: number }[];
}

function buildGeometry(b: HullBuilder, p: KestrelParams, rng: Rng): Layout {
  const L = p.livery;
  const col = (k: PaletteKey) => palette[k];
  const jit = () => 1 + rng.signed() * p.panelJitter;
  const acc = p.accentAmount;
  const primary = (extra: Partial<FaceStyle> = {}): FaceStyle => ({ color: col(L.primary), jitter: jit(), ...extra });
  const secondary = (extra: Partial<FaceStyle> = {}): FaceStyle => ({ color: col(L.secondary), ...extra });
  const under = (extra: Partial<FaceStyle> = {}): FaceStyle => ({ color: col(L.under), ...extra });
  const trim = (e = 0.25): FaceStyle => ({ color: col(L.accent), kind: SURF.trim, emissive: e });
  const insert = (e = 1): FaceStyle => ({ color: col(L.accent), kind: SURF.insert, emissive: e, seamScale: 1 });
  const matte: FaceStyle = { color: col(L.under), kind: SURF.matte, outline: false };

  // ---------------- fuselage ----------------
  const S = stationsFor(p);
  b.newComponent();
  const CLS = ['top', 'upper', 'side', 'chine', 'lower', 'belly', 'belly', 'lower', 'chine', 'side', 'upper', 'top'];
  const fgrid: FaceStyle[][] = [];
  for (let i = 0; i < S.length - 1; i++) {
    const jr = [primary(), primary()]; // per strip: top / upper jitter (symmetric)
    const row: FaceStyle[] = [];
    for (let j = 0; j < 12; j++) {
      const c = CLS[j];
      let s: FaceStyle;
      if (i === 0) s = c === 'belly' || c === 'lower' ? under() : secondary({ jitter: 0.85 });
      else if (c === 'top') s = acc > 0.7 && i === 2 ? trim(0.3) : jr[0];
      else if (c === 'upper') s = jr[1];
      else if (c === 'side') s = secondary();
      else if (c === 'chine') s = i >= 2 ? trim(0.2 + 0.3 * acc) : secondary();
      else s = under();
      row.push(s);
    }
    fgrid.push(row);
  }
  const frings = S.map(ring12);
  loft(b, frings, fgrid, { seamRing: (i) => i === 3 || i === 5 || i === 7 });
  // rear bulkhead
  opoly(b, frings[frings.length - 1], under(), v(0, 0, 1));

  // ---------------- canopy ----------------
  b.newComponent();
  const CAN: [number, number, number, number, number][] = [
    [-3.95, 0.1, 0.5, 0.51, 0.52],
    [-3.25, 0.36, 0.42, 0.66, 0.8],
    [-2.45, 0.44, 0.44, 0.78, 0.98],
    [-1.65, 0.44, 0.47, 0.78, 0.96],
    [-0.95, 0.3, 0.54, 0.7, 0.8],
    [-0.35, 0.12, 0.62, 0.65, 0.67],
  ];
  const crings = CAN.map(([z, hw, by, sy, ty]) => {
    const w = hw * p.bodyWidth;
    return [v(w, by, z), v(w * 0.93, sy, z), v(w * 0.55, ty - 0.04, z), v(0, ty, z), v(-w * 0.55, ty - 0.04, z), v(-w * 0.93, sy, z), v(-w, by, z)];
  });
  const glass: FaceStyle = { color: col(L.glass), kind: SURF.glass, seamScale: 3 };
  const fair = primary();
  const cgrid = CAN.slice(0, -1).map((_, i) => Array.from({ length: 6 }, () => (i < 4 ? glass : fair)));
  loft(b, crings, cgrid, { closed: false, seamRing: (i) => i === 1 || i === 3, ends: false });
  opoly(b, crings[crings.length - 1], fair, v(0, 0.3, 1));

  // ---------------- nose band / muzzles ----------------
  const muzzles: V3[] = [];
  {
    const zm = -3.9 - 0.5 * p.noseStretch;
    const s = stationAt(S, zm);
    const x = s.xC * 0.8, y = (s.yCt + s.yCb) * 0.5 - 0.05;
    b.mirror = true;
    b.newComponent();
    const r = 0.05, z0 = zm + 0.3, z1 = zm - 0.55;
    const r0: V3[] = [], r1: V3[] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      r0.push(v(x + Math.cos(a) * r, y + Math.sin(a) * r, z0));
      r1.push(v(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, z1));
    }
    const mstyle = under({ outline: false });
    loft(b, [r0, r1], [Array.from({ length: 6 }, () => mstyle)]);
    opoly(b, r1, { color: col(L.under), kind: SURF.matte, outline: false }, v(0, 0, -1));
    b.mirror = false;
    muzzles.push(v(x, y, z1 - 0.05), v(-x, y, z1 - 0.05));
  }

  // ---------------- intakes ----------------
  {
    b.mirror = true;
    b.newComponent();
    const W = p.bodyWidth;
    const sec = (z: number, rake: number, k: number) => {
      const xi = 0.5 * W, xo = (0.5 + 0.48 * k) * W;
      const yt = -0.1, ym = -0.1 - 0.18 * k - 0.02, yb = -0.1 - 0.4 * k;
      return [v(xi, yt, z), v(xo, yt, z), v(xo + 0.04 * k, ym, z + rake * 0.4), v(xo - 0.06 * k, yb, z + rake), v(xi, yb - 0.02, z + rake)];
    };
    const iz = -2.5;
    const R = [sec(iz, 0.35, 1), sec(-1.7, 0, 1), sec(0.2, 0, 0.95), sec(1.6, 0, 0.5)];
    const skin = acc > 0.7 ? secondary() : under();
    const ig = R.slice(0, -1).map(() => [secondary(), skin, skin, under()]);
    loft(b, R, ig, { closed: false, ends: false, seamRing: (i) => i === 1 });
    // lip + tunnel + back plate
    const O = R[0];
    const cen = O.reduce((a, q) => a.add(q), new THREE.Vector3()).multiplyScalar(1 / O.length);
    const I = O.map((q) => q.clone().lerp(cen, 0.28).add(v(0, 0, 0.04)));
    const Bk = I.map((q) => q.clone().add(v(0, 0, 0.55)));
    const lip = acc > 0.7 ? trim(0.35) : secondary();
    const lipGrid = [Array.from({ length: 5 }, () => lip)];
    loft(b, [O, I], lipGrid, { orient: () => v(0, 0, -1) });
    const tun = [Array.from({ length: 5 }, () => matte)];
    loft(b, [I, Bk], tun, { orient: (c, ce) => ce.clone().sub(c) });
    opoly(b, Bk, matte, v(0, 0, -1));
    b.mirror = false;
  }

  // ---------------- nozzles ----------------
  const exhaustPorts: V3[] = [];
  {
    const xN = 0.6 * p.bodyWidth, yN = -0.04, SEG = 12;
    const ringAt = (z: number, r: number) => Array.from({ length: SEG }, (_, k) => {
      const a = (k / SEG) * Math.PI * 2;
      return v(xN + Math.cos(a) * r, yN + Math.sin(a) * r, z);
    });
    b.mirror = true;
    b.newComponent();
    const A = ringAt(4.5, 0.44), Bq = ringAt(5.0, 0.44), C = ringAt(5.35, 0.38), D = ringAt(5.35, 0.31), E = ringAt(4.98, 0.29);
    const petal = secondary({ jitter: 0.9 });
    loft(b, [A, Bq, C], [Array(SEG).fill(petal), Array(SEG).fill(petal)], { seamSide: (j) => j % 2 === 0, seamRing: (i) => i === 1 });
    loft(b, [C, D], [Array(SEG).fill(under())], { orient: () => v(0, 0, 1) });
    loft(b, [D, E], [Array(SEG).fill({ ...matte })], { orient: (c) => v(xN - c.x, yN - c.y, 0) });
    b.radialFan(v(xN, yN, 4.98), E, { color: col(L.accent), kind: SURF.hot, emissive: 1, outline: false });
    b.mirror = false;
    exhaustPorts.push(v(xN, yN, 5.35), v(-xN, yN, 5.35));
  }

  // ---------------- wing ----------------
  const xRoot = 0.95 * p.bodyWidth, xTip = p.wingTipX;
  const zRootLE = -1.9;
  const zTipLE = zRootLE + (xTip - xRoot) * Math.tan(THREE.MathUtils.degToRad(p.wingSweep));
  const zTipTE = zTipLE + p.tipChord;
  const dih = Math.tan(THREE.MathUtils.degToRad(p.dihedral));
  const TOP: [number, number][] = [[0, 0], [0.1, 0.55], [0.4, 1], [0.8, 0.6], [1, 0.12]];
  const BOT: [number, number][] = [[0, 0], [0.1, 0.3], [0.4, 0.5], [0.8, 0.35], [1, 0.08]];
  const prof = (tab: [number, number][], t: number) => {
    for (let i = 0; i < tab.length - 1; i++)
      if (t <= tab[i + 1][0]) return tab[i][1] + ((tab[i + 1][1] - tab[i][1]) * (t - tab[i][0])) / (tab[i + 1][0] - tab[i][0]);
    return tab[tab.length - 1][1];
  };
  const chord = (u: number) => (p.rootTE - zRootLE) + ((zTipTE - zTipLE) - (p.rootTE - zRootLE)) * u;
  const yMid = (u: number) => -0.01 + (u * (xTip - xRoot)) * dih;
  const W = (u: number, t: number, side: 1 | -1 | 0): V3 => {
    const x = xRoot + (xTip - xRoot) * u;
    const le = zRootLE + (zTipLE - zRootLE) * u;
    const c = chord(u);
    const th = 0.042 * c;
    const y = yMid(u) + (side === 1 ? th * prof(TOP, t) : side === -1 ? -th * prof(BOT, t) : 0);
    return v(x, y, le + c * t);
  };
  const us = [0, 0.16, 0.34, 0.55, 0.75, 0.94, 1];
  const vs = [0, 0.1, 0.4, 0.8, 1];
  const isElev = (iu: number, iv: number) => iv === 3 && iu >= 2 && iu <= 4;
  const decals = [{ x: 0, z: 0, r: 0.52 }];
  {
    const ud = 0.62, vd = 0.47;
    const pd = W(ud, vd, 0);
    decals[0] = { x: pd.x, z: pd.z, r: 0.52 };
  }
  const topGrid: (FaceStyle | null)[][] = [];
  const botGrid: (FaceStyle | null)[][] = [];
  for (let iu = 0; iu < us.length - 1; iu++) {
    const tr: (FaceStyle | null)[] = [], br: (FaceStyle | null)[] = [];
    for (let iv = 0; iv < vs.length - 1; iv++) {
      if (isElev(iu, iv)) { tr.push(null); br.push(null); continue; }
      let t: FaceStyle;
      if (iv === 0) t = secondary();
      else if (acc > 0.7 && iu === 0 && iv === 2) t = insert(1);
      else t = primary({ decal: iu >= 2 && iu <= 4 && iv <= 2 ? 1 : 0 });
      tr.push(t);
      br.push(under({ jitter: 0.9 + 0.2 * rng.next() }));
    }
    topGrid.push(tr);
    botGrid.push(br);
  }
  b.mirror = true;
  b.newComponent();
  const seamU = new Set([2, 3, 4, rng.chance(0.5) ? 1 : 5]);
  const wingSurf = (grid: (FaceStyle | null)[][], side: 1 | -1) => {
    for (let iu = 0; iu < us.length - 1; iu++)
      for (let iv = 0; iv < vs.length - 1; iv++) {
        const s = grid[iu][iv];
        if (!s) continue;
        const k = styleKey(s);
        const nb = (a: number, c: number) => (a < 0 || a >= us.length - 1 || c < 0 || c >= vs.length - 1 ? 'x' : styleKey(grid[a][c]));
        const a0 = W(us[iu], vs[iv], side), a1 = W(us[iu + 1], vs[iv], side), a2 = W(us[iu + 1], vs[iv + 1], side), a3 = W(us[iu], vs[iv + 1], side);
        // edges: a0a1 (v=const, front), a1a2 (u=const, outer), a2a3 (back), a3a0 (inner)
        const sFront = iv === 1 || (iv > 0 && nb(iu, iv - 1) !== k);
        const sOuter = seamU.has(iu + 1) || nb(iu + 1, iv) !== k;
        const sBack = nb(iu, iv + 1) !== k;
        const sInner = seamU.has(iu) || (iu > 0 && nb(iu - 1, iv) !== k);
        oq(b, a0, a1, a2, a3, s, [sFront, sOuter, sBack, sInner], v(0, side, 0));
      }
  };
  wingSurf(topGrid, 1);
  wingSurf(botGrid, -1);
  // trailing edge strips (fixed parts)
  for (const iu of [0, 1, 5]) {
    oq(b, W(us[iu], 1, 1), W(us[iu + 1], 1, 1), W(us[iu + 1], 1, -1), W(us[iu], 1, -1), secondary(), [true, true, true, true], v(0, 0, 1));
  }
  // tip face
  for (let iv = 0; iv < vs.length - 1; iv++) {
    oq(b, W(1, vs[iv], 1), W(1, vs[iv + 1], 1), W(1, vs[iv + 1], -1), W(1, vs[iv], -1), secondary(), [false, false, false, false], v(1, 0, 0));
  }
  // elevon cove
  for (let iu = 2; iu <= 4; iu++) oq(b, W(us[iu], 0.8, 1), W(us[iu + 1], 0.8, 1), W(us[iu + 1], 0.8, -1), W(us[iu], 0.8, -1), matte, [true, true, true, true], v(0, 0, 1));
  oq(b, W(us[2], 0.8, 1), W(us[2], 1, 1), W(us[2], 1, -1), W(us[2], 0.8, -1), matte, [true, true, true, true], v(1, 0, 0));
  oq(b, W(us[5], 0.8, 1), W(us[5], 1, 1), W(us[5], 1, -1), W(us[5], 0.8, -1), matte, [true, true, true, true], v(-1, 0, 0));

  // missile hatches (2 per side) on the inboard wing top
  const missilePorts: V3[] = [];
  const hatch = (uc: number, vc: number) => {
    const du = 0.045, dv = 0.035;
    const lift = 0.03;
    const q = [W(uc - du, vc - dv, 1), W(uc + du, vc - dv, 1), W(uc + du, vc + dv, 1), W(uc - du, vc + dv, 1)];
    const top = q.map((x) => x.clone().add(v(0, lift, 0)));
    const bot = q.map((x) => x.clone().add(v(0, -0.02, 0)));
    const hs: FaceStyle = { color: col(L.under), seamScale: 2.5, outline: false };
    opoly(b, top, hs, v(0, 1, 0));
    const side = acc > 0.7 ? trim(0.3) : secondary({ outline: false });
    for (let k = 0; k < 4; k++) {
      const n = k + 1 < 4 ? k + 1 : 0;
      const mid = top[k].clone().add(top[n]).multiplyScalar(0.5);
      const cen = top[0].clone().add(top[2]).multiplyScalar(0.5);
      oq(b, bot[k], bot[n], top[n], top[k], { ...side, outline: false }, [false, false, false, false], mid.sub(cen));
    }
    const c = W(uc, vc, 1).add(v(0, lift + 0.08, 0));
    missilePorts.push(c, v(-c.x, c.y, c.z));
  };
  b.newComponent();
  hatch(0.24, 0.5);
  hatch(0.24, 0.66);

  // elevon (part 1 / mirrored 2)
  b.newComponent();
  {
    const e0 = us[2] + 0.008, e1 = us[5] - 0.008;
    const eu = [e0, us[3], us[4], e1];
    const EV: [number, number] = [0.805, 1];
    const topS = primary({ part: 1 }), botS = under({ part: 1 }), edgeS = secondary({ part: 1 });
    for (let k = 0; k < 3; k++) {
      const u0 = eu[k], u1 = eu[k + 1];
      oq(b, W(u0, EV[0], 1), W(u1, EV[0], 1), W(u1, EV[1], 1), W(u0, EV[1], 1), topS, [true, k === 2, true, k === 0], v(0, 1, 0));
      oq(b, W(u0, EV[0], -1), W(u1, EV[0], -1), W(u1, EV[1], -1), W(u0, EV[1], -1), botS, [true, true, true, true], v(0, -1, 0));
      oq(b, W(u0, EV[1], 1), W(u1, EV[1], 1), W(u1, EV[1], -1), W(u0, EV[1], -1), edgeS, [true, true, true, true], v(0, 0, 1));
      oq(b, W(u0, EV[0], 1), W(u1, EV[0], 1), W(u1, EV[0], -1), W(u0, EV[0], -1), { ...botS, kind: SURF.matte }, [true, true, true, true], v(0, 0, -1));
    }
    oq(b, W(e0, EV[0], 1), W(e0, EV[1], 1), W(e0, EV[1], -1), W(e0, EV[0], -1), edgeS, [true, true, true, true], v(-1, 0, 0));
    oq(b, W(e1, EV[0], 1), W(e1, EV[1], 1), W(e1, EV[1], -1), W(e1, EV[0], -1), edgeS, [true, true, true, true], v(1, 0, 0));
  }
  const hingeA = W(us[2], 0.8, 0), hingeB = W(us[5], 0.8, 0);

  // ---------------- wingtip fins ----------------
  const tipY = yMid(1);
  const finParts: { id: number; pivot: V3; axis: V3 }[] = [];
  {
    const c = THREE.MathUtils.degToRad(p.finCant);
    const up = v(Math.sin(c), Math.cos(c), 0);
    const thd = v(Math.cos(c), -Math.sin(c), 0);
    const H = p.finHeight;
    const z0 = zTipLE - 0.1, z1 = zTipTE + 0.35;
    const leAt = (h: number) => z0 + h * Math.tan(THREE.MathUtils.degToRad(50));
    const teTop = leAt(H) + 0.42;
    const teAt = (h: number) => z1 + (teTop - z1) * (h / H);
    const hs = [0, 0.5 * H, 0.64 * H, H];
    const base = v(xTip, tipY, 0);
    const rows = hs.map((h) => {
      const le = leAt(h), te = teAt(h);
      const t = 0.09 * (1 - (0.5 * h) / H);
      const o = base.clone().addScaledVector(up, h);
      const mz = le + (te - le) * 0.4;
      return [
        o.clone().setZ(le),
        o.clone().addScaledVector(thd, t / 2).setZ(mz),
        o.clone().setZ(te),
        o.clone().addScaledVector(thd, -t / 2).setZ(mz),
      ];
    });
    const band = acc > 0.7 ? trim(0.5) : trim(0.35);
    const fp = primary({ part: 3 });
    const grid = [Array(4).fill(fp), Array(4).fill({ ...band, part: 3 }), Array(4).fill(primary({ part: 3 }))];
    b.mirror = true;
    b.newComponent();
    loft(b, rows, grid, { ends: false });
    opoly(b, rows[rows.length - 1], acc > 0.7 ? { ...trim(0.4), part: 3 } : secondary({ part: 3 }), up);
    finParts.push({ id: 3, pivot: v(xTip, tipY, (z0 + z1) / 2), axis: up.clone() });

    // ventral fin
    const cl = THREE.MathUtils.degToRad(p.ventralCant);
    const dn = v(Math.sin(cl), -Math.cos(cl), 0);
    const th2 = v(Math.cos(cl), Math.sin(cl), 0);
    const Hl = p.ventralHeight;
    const lz0 = zTipLE + 0.3, lz1 = zTipTE + 0.2;
    const lrows = [0, Hl].map((h) => {
      const le = lz0 + h * Math.tan(THREE.MathUtils.degToRad(45)), te = lz1 + h * Math.tan(THREE.MathUtils.degToRad(22));
      const t = 0.07 * (1 - (0.4 * h) / Hl);
      const o = base.clone().addScaledVector(dn, h);
      const mz = le + (te - le) * 0.4;
      return [o.clone().setZ(le), o.clone().addScaledVector(th2, t / 2).setZ(mz), o.clone().setZ(te), o.clone().addScaledVector(th2, -t / 2).setZ(mz)];
    });
    b.newComponent();
    loft(b, lrows, [Array(4).fill(secondary({ part: 5 }))], { ends: false });
    opoly(b, lrows[1], under({ part: 5 }), dn);
    b.mirror = false;
    finParts.push({ id: 5, pivot: v(xTip, tipY, (lz0 + lz1) / 2), axis: dn.clone() });
  }

  // ---------------- spine vent housings (orange grilles) ----------------
  {
    b.mirror = true;
    b.newComponent();
    const z0 = -0.2, z1 = 1.35, zt0 = 0.0, zt1 = 1.15;
    const xi = 0.27 * p.bodyWidth, xo = 0.66 * p.bodyWidth;
    const yAt = (x: number, z: number) => upperY(stationAt(S, z), x);
    const b0 = v(xi, yAt(xi, z0) - 0.03, z0), b1 = v(xo, yAt(xo, z0) - 0.03, z0), b2 = v(xo, yAt(xo, z1) - 0.03, z1), b3 = v(xi, yAt(xi, z1) - 0.03, z1);
    const t0 = v(xi, yAt(xi, zt0) + 0.15, zt0), t1 = v(xo, yAt(xo, zt0) + 0.05, zt0), t2 = v(xo, yAt(xo, zt1) + 0.05, zt1), t3 = v(xi, yAt(xi, zt1) + 0.15, zt1);
    const ins = insert(1);
    oq(b, t0, t1, t2, t3, ins, [true, true, true, true], v(0.3, 1, 0));
    const hs = secondary();
    oq(b, b0, b1, t1, t0, hs, [true, true, true, true], v(0, 0.4, -1));
    oq(b, b3, b2, t2, t3, under(), [true, true, true, true], v(0, 0.4, 1));
    oq(b, b0, t0, t3, b3, hs, [true, true, true, true], v(-1, 0.2, 0));
    oq(b, b1, b2, t2, t1, hs, [true, true, true, true], v(1, 0.4, 0));
    b.mirror = false;
  }

  const wingtips = [v(xTip, tipY, zTipTE), v(-xTip, tipY, zTipTE)];
  const hingeAxis = hingeB.clone().sub(hingeA).normalize();
  const parts = [{ id: 1, pivot: hingeA, axis: hingeAxis }, ...finParts];
  return { exhaustPorts, wingtips, missilePorts, muzzles, parts, decals };
}

// ---------------------------------------------------------------------------

class Spring2 {
  x = 0;
  v = 0;
  constructor(public w: number, public zeta: number) {}
  step(target: number, dt: number): number {
    // semi-implicit substeps (stable for w * h < 1)
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = this.w * this.w * (target - this.x) - 2 * this.zeta * this.w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  set(x: number) {
    this.x = x;
    this.v = 0;
  }
}

function upd(src: V3[], dst: V3[], M: THREE.Matrix4) {
  for (let i = 0; i < src.length; i++) dst[i].copy(src[i]).applyMatrix4(M);
}

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();

function setHinge(out: THREE.Matrix4, pivot: V3, axis: V3, angle: number) {
  _q.setFromAxisAngle(axis, angle);
  out.makeRotationFromQuaternion(_q);
  _p.copy(pivot).applyMatrix4(out);
  out.setPosition(pivot.x - _p.x, pivot.y - _p.y, pivot.z - _p.z);
}

export function buildKestrel(params: KestrelParams, seed = 1): Kestrel {
  const rng = new Rng(seed).fork('kestrel');
  const b = new HullBuilder();
  const lay = buildGeometry(b, params, rng);
  const { geometry, outline: outlineGeo } = b.build();
  const mats = createHullMaterials({
    seamWidth: params.seamWidth,
    seamDarkness: params.seamDarkness,
    rim: params.rim,
    specular: params.specular,
    insertGlow: params.insertGlow,
    glass: palette[params.livery.glass],
    insert: palette[params.livery.accent],
    outlineWidth: params.outlineWidth,
  });
  for (const d of lay.decals) mats.decals[0].set(d.x, d.z, d.r, 1);
  mats.decals[1].set(-lay.decals[0].x, lay.decals[0].z, lay.decals[0].r, 1);

  const hull = new THREE.Mesh(geometry, mats.hull);
  hull.name = 'kestrelHull';
  const outline = new THREE.Mesh(outlineGeo, mats.outline);
  outline.name = 'kestrelOutline';
  outline.visible = params.outline;
  const exhaust = buildExhaust(lay.exhaustPorts, params.exhaust, seed);
  const body = new THREE.Group();
  body.name = 'kestrelBody';
  body.rotation.order = 'YXZ';
  body.add(hull, outline, exhaust.mesh);
  const root = new THREE.Group();
  root.name = 'kestrel';
  root.add(body);

  // parts: rest pivots/axes for starboard (odd ids) and mirrored port (even ids)
  const mirrorV = (q: V3) => v(-q.x, q.y, q.z);
  const hinges = lay.parts.flatMap((pt) => [
    { id: pt.id, pivot: pt.pivot, axis: pt.axis, sign: 1 },
    { id: pt.id + 1, pivot: mirrorV(pt.pivot), axis: v(-pt.axis.x, pt.axis.y, pt.axis.z), sign: -1 },
  ]);
  const springs = {
    elevR: new Spring2(18, 0.55),
    elevL: new Spring2(18, 0.55),
    rudder: new Spring2(14, 0.5),
    cant: new Spring2(10, 0.6),
    rate: new Spring2(10, 1),
    bob: new Spring2(3, 0.7),
  };
  let prevBank = 0;
  let prevTime = -1;
  const box = geometry.boundingBox!;
  const bounds: [number, number, number] = [
    +(box.max.x - box.min.x).toFixed(2),
    +(box.max.y - box.min.y).toFixed(2),
    +(box.max.z - box.min.z).toFixed(2),
  ];
  let radius = 0;
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) radius = Math.max(radius, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));

  const rest = {
    exhaustPorts: lay.exhaustPorts.map((q) => q.clone()),
    wingtips: lay.wingtips.map((q) => q.clone()),
    missilePorts: lay.missilePorts.map((q) => q.clone()),
    muzzles: lay.muzzles.map((q) => q.clone()),
  };
  const live = {
    exhaustPorts: rest.exhaustPorts.map((q) => q.clone()),
    wingtips: rest.wingtips.map((q) => q.clone()),
    missilePorts: rest.missilePorts.map((q) => q.clone()),
    muzzles: rest.muzzles.map((q) => q.clone()),
  };

  const stats: KestrelStats = {
    hullTriangles: pos.count / 3,
    outlineTriangles: (outlineGeo.index?.count ?? 0) / 3,
    exhaustTriangles: exhaust.triangles,
    triangles: 0,
    drawCalls: 0,
    bounds,
  };
  const refreshStats = () => {
    stats.triangles = stats.hullTriangles + (outline.visible ? stats.outlineTriangles : 0) + (exhaust.mesh.visible ? stats.exhaustTriangles : 0);
    stats.drawCalls = 1 + (outline.visible ? 1 : 0) + (exhaust.mesh.visible ? 1 : 0);
  };
  refreshStats();

  const apply = (s: KestrelState) => {
    const k = springs;
    const eR = k.elevR.x, eL = k.elevL.x;
    for (const h of hinges) {
      let ang = 0;
      if (h.id === 1) ang = eR;
      else if (h.id === 2) ang = -eL;
      else if (h.id === 3 || h.id === 5) ang = k.rudder.x * (h.id === 5 ? 0.6 : 1);
      else if (h.id === 4 || h.id === 6) ang = -k.rudder.x * (h.id === 6 ? 0.6 : 1);
      setHinge(mats.parts[h.id], h.pivot, h.axis, ang);
    }
    body.rotation.set(s.pitch, 0, -s.bank + 0.015 * Math.sin(s.time * 1.7));
    body.position.set(0, k.bob.x + 0.04 * Math.sin(s.time * 1.3), 0);
    body.updateMatrix();
    const M = body.matrix;
    upd(rest.exhaustPorts, live.exhaustPorts, M);
    upd(rest.wingtips, live.wingtips, M);
    upd(rest.missilePorts, live.missilePorts, M);
    upd(rest.muzzles, live.muzzles, M);
    mats.setHitFlash(s.hitFlash);
    const glow = 0.85 + 0.15 * Math.min(s.throttle, 1.6) + (s.boost ? 0.25 : 0) + 0.04 * Math.sin(s.time * 9.0);
    mats.setGlow(glow);
    mats.setHeat(0.6 + 0.4 * Math.min(s.throttle, 1.6) + (s.boost ? 0.3 : 0));
  };
  const tgt = { eR: 0, eL: 0, rud: 0 };
  const targets = (s: KestrelState, rate: number) => {
    // roll right (bank rate > 0): starboard elevon up, port down; pitch adds symmetric
    const r = THREE.MathUtils.clamp(rate * 0.18, -0.35, 0.35);
    const pch = THREE.MathUtils.clamp(-s.pitch * 0.5, -0.3, 0.3);
    tgt.eR = THREE.MathUtils.clamp(-r + pch, -0.45, 0.45);
    tgt.eL = THREE.MathUtils.clamp(r + pch, -0.45, 0.45);
    tgt.rud = THREE.MathUtils.clamp(rate * 0.1, -0.2, 0.2) + (s.drift ? 0.12 * Math.sign(s.bank || 1) : 0);
    return tgt;
  };

  const k: Kestrel = {
    root,
    body,
    exhaustPorts: live.exhaustPorts,
    wingtips: live.wingtips,
    missilePorts: live.missilePorts,
    muzzles: live.muzzles,
    radius: +radius.toFixed(2),
    hitRadius: 1.6,
    stats,
    update(dt, s) {
      const d = Math.min(Math.max(dt, 0), 0.1);
      const rawRate = d > 0 && prevTime >= 0 ? (s.bank - prevBank) / d : 0;
      prevBank = s.bank;
      prevTime = s.time;
      const rate = springs.rate.step(rawRate, d);
      const t = targets(s, rate);
      springs.elevR.step(t.eR, d);
      springs.elevL.step(t.eL, d);
      springs.rudder.step(t.rud, d);
      springs.bob.step(s.hitFlash > 0.5 ? -0.08 : 0, d);
      apply(s);
      exhaust.update(d, s);
    },
    snap(s) {
      prevBank = s.bank;
      prevTime = s.time;
      springs.rate.set(0);
      const t = targets(s, 0);
      springs.elevR.set(t.eR);
      springs.elevL.set(t.eL);
      springs.rudder.set(t.rud);
      springs.bob.set(0);
      apply(s);
      exhaust.snap(s);
    },
    setSilhouette(on) {
      mats.setSilhouette(on);
      exhaust.mesh.visible = !on;
      refreshStats();
    },
    setOutline(on) {
      outline.visible = on;
      refreshStats();
    },
    dispose() {
      geometry.dispose();
      outlineGeo.dispose();
      mats.dispose();
      exhaust.dispose();
    },
  };
  k.snap({ time: 0, bank: 0, pitch: 0, throttle: 1, boost: false, drift: false, hitFlash: 0 });
  return k;
}

/** Design reference sizes (tokens) for manifests/boards. */
export const KESTREL_SCALE = { length: scale.kestrelLength, span: scale.kestrelSpan };
export { ExhaustSpring };
