/**
 * roster.js — the six playable characters of AETHERWIND SAGA, as pure data.
 *
 * This file is the single source of truth `CharacterFactory` reads to build a
 * body, `Rig` reads to size a skeleton, `Animation` reads for per-character
 * motion bias, and the battle layer reads for stats. It contains **no logic**
 * beyond one id lookup: everything here must stay serialisable so a save file
 * can reference it by id and a designer can retune a character without
 * touching a line of graphics code.
 *
 * Two conventions that are load-bearing across the whole system:
 *
 * 1. **Every length is a fraction of the character's own height**, except
 *    `proportions.height`, which is in world units. That is what lets Bramm
 *    (short, wide) and Yshara (tall, narrow) share one geometry generator: the
 *    generator never sees an absolute number it could get wrong for a body
 *    type it wasn't tuned against.
 *
 * 2. **Silhouette parameters come first.** REFERENCE_TARGET §1 requires the six
 *    to be distinguishable as flat black shapes at 80 px. At that size the face
 *    is roughly four pixels, so the only channels that actually carry identity
 *    are hair mass, weapon outline, and the cloth outline below the waist —
 *    which is why those three sub-objects are the most detailed things here and
 *    the facial parameters are three numbers.
 *
 * Palettes are contractual with WORLD_BIBLE §3; the hex values there appear
 * verbatim below. Derived tints (shade/highlight) are authored rather than
 * computed because a hue-rotated shade reads muddy on the low-band toon ramp —
 * the shadow of an amber coat wants to go teal-ward, not brown-ward, and no
 * generic darkening function knows that.
 *
 * OWNED BY: characters.
 */

/**
 * Canonical proportion block. Everything is a multiplier on the chibi base
 * defined in `Rig.js` except `height`, which is world units, crown to floor.
 * REFERENCE_TARGET §1 puts the party at 3.0–3.5 heads and ~1.1–1.2 units tall;
 * the spread below stays inside that with Emrys (a fourteen-year-old) at the
 * bottom of the band and Yshara at the top, so relative age reads in a lineup.
 */
const BASE_PROPORTIONS = Object.freeze({
  height: 1.16,
  headScale: 1.0,   // head diameter multiplier; 1.0 == 0.32 * height
  legLength: 1.0,   // shifts the hips, crown stays pinned to `height`
  shoulder: 1.0,
  chest: 1.0,
  hip: 1.0,
  limb: 1.0,        // limb girth
  arm: 1.0,         // arm segment length
  hand: 1.0,
  foot: 1.0,
  eye: 1.0,         // eye size multiplier — the dominant facial channel
  eyeSpacing: 1.0,
  browAngle: 0.0,   // radians; positive = outer end lifted (open/kind)
});

function proportions(overrides) {
  return Object.freeze({ ...BASE_PROPORTIONS, ...overrides });
}

export const ROSTER = Object.freeze([
  Object.freeze({
    id: 'auren',
    name: 'Auren Vael',
    className: 'Skysworn Blade',
    role: 'vanguard',
    element: 'light',
    limit: { id: 'daybreak-chain', name: 'Daybreak Chain' },

    proportions: proportions({ height: 1.19, shoulder: 1.07, chest: 1.04, legLength: 1.02, eye: 0.96, browAngle: -0.10 }),

    palette: Object.freeze({
      skin: 0xd9a882, skinShade: 0x9c6f56,
      hair: 0x4a3d33, hairShade: 0x241f1c, hairLight: 0x8a705a,
      eye: 0xc9924a, eyeCore: 0xffe0a8, sclera: 0xf2ede2, lash: 0x14181f,
      primary: 0x3d4a5c,    // slate coat
      secondary: 0x1e262e,  // undercoat
      trim: 0xc9924a,       // worn amber
      metal: 0xb8bfc7,      // steel
      leather: 0x2b2320,
      accent: 0xc9924a,
      cape: 0x3d4a5c, capeLining: 0x1e262e,
      weaponA: 0xd6e4ee,    // pale moonglass
      weaponB: 0x8f9ba8,
      glow: 0xfff0b8,
    }),

    // Mass class: **swept wedge**. Narrowest crown in the party (0.82 heads
    // wide) with the volume thrown backwards and down the -Z axis, so the head silhouettes as an
    // arrowhead pointing forward — the exact inverse of Emrys's outward
    // starburst, which is the pair most at risk of colliding at 80 px.
    hair: Object.freeze({
      style: 'swept',
      capScale: 1.05, capDrop: 0.55,
      fringe: 5, fringeLength: 0.32, fringeSweep: 0.95, fringeSpread: 1.0,
      backLength: 0.30, backWidth: 0.82, backDepth: 1.15,
      highlightBand: 0.62, highlightWidth: 0.14,
      boneCount: 0,
    }),

    // Reads as a vertical line broken at the hip by the sheathed sword
    // (WORLD_BIBLE §3.1) — so the blade is carried low and angled, not raised.
    weapon: Object.freeze({
      kind: 'sword', mount: 'handR',
      length: 0.78, width: 0.085, thickness: 0.022,
      guard: 0.26, gripLength: 0.20, pommel: 0.07,
      tilt: -0.34, roll: 0.15,
      emissive: 0.22,
    }),

    // Asymmetric split coat: the right tail is long, the left is cut away for
    // the draw. Asymmetry is cheap silhouette identity and survives to 80 px.
    cape: Object.freeze({
      kind: 'coat', anchor: 'chest',
      length: 0.46, width: 0.40, split: 0.62, asymmetry: 0.34,
      stiffness: 0.55, mass: 1.1, drag: 0.030, boneCount: 0,
    }),

    accessories: Object.freeze({ pauldron: 'L', collar: 'high', beltRing: true }),

    stats: Object.freeze({
      hp: 780, mp: 90, atk: 84, mag: 42, def: 74, spr: 58, spd: 62, luck: 40,
      growth: { hp: 62, mp: 5, atk: 6.2, mag: 2.4, def: 5.4, spr: 3.8, spd: 2.6, luck: 1.4 },
    }),
  }),

  Object.freeze({
    id: 'seren',
    name: 'Seren Lys',
    className: 'Oracle',
    role: 'healer',
    element: 'light',
    limit: { id: 'aubade', name: 'Aubade' },

    proportions: proportions({ height: 1.08, headScale: 1.05, shoulder: 0.87, chest: 0.92, hip: 0.96, limb: 0.90, foot: 0.78, eye: 1.12, eyeSpacing: 1.03, browAngle: 0.14 }),

    palette: Object.freeze({
      skin: 0xe8d3c4, skinShade: 0xab8b83,
      hair: 0xece6da, hairShade: 0x9aa6a8, hairLight: 0xffffff,
      eye: 0x5fb8b0, eyeCore: 0xd8fbf6, sclera: 0xf6f2ea, lash: 0x263038,
      primary: 0xeae2d4,    // ivory robe
      secondary: 0x5fb8b0,  // teal underlayer
      trim: 0xffc24d,       // gold thread
      metal: 0xffc24d,
      leather: 0xc9b79a,
      accent: 0x5fb8b0,
      cape: 0xeae2d4, capeLining: 0x5fb8b0,
      weaponA: 0xd9cfc0,
      weaponB: 0xffc24d,
      glow: 0x5fb8b0,
    }),

    // Mass class: **long straight sheet**. Widest and longest hair in the party
    // by a margin — 1.35 head-widths of solid slab against Auren's 0.82, past the
    // 25% divergence the lineup test demands — and the only one bone-driven
    // along its full length so it never stops moving (ART_BIBLE §7.9).
    hair: Object.freeze({
      style: 'sheet',
      capScale: 1.12, capDrop: 0.66,
      fringe: 7, fringeLength: 0.26, fringeSweep: 0.10, fringeSpread: 1.45,
      backLength: 0.44, backWidth: 1.35, backFlare: 1.15,
      braidWidth: 0.80,
      highlightBand: 0.58, highlightWidth: 0.18,
      boneCount: 4, boneStiffness: 0.34,
    }),

    weapon: Object.freeze({
      kind: 'chimestaff', mount: 'handL',
      length: 0.95, width: 0.026, thickness: 0.026,
      ringRadius: 0.10, bells: 7, bellRadius: 0.022,
      tilt: 0.06, roll: 0.0,
      emissive: 0.9,
    }),

    // Layered shawl over a long robe: two panels, the shawl short and wide, the
    // robe long and narrow. Two overlapping silhouettes at different phase read
    // as "candle flame" from the side, which is her brief.
    cape: Object.freeze({
      kind: 'shawl', anchor: 'chest',
      length: 0.28, width: 0.34, split: 0.0, asymmetry: 0.08,
      stiffness: 0.26, mass: 0.7, drag: 0.055, boneCount: 0,
      skirt: { length: 0.34, width: 0.34, flare: 1.45, stiffness: 0.22, drag: 0.050 },
    }),

    accessories: Object.freeze({ pauldron: null, collar: 'wrap', barefoot: true, anklet: true }),

    stats: Object.freeze({
      hp: 560, mp: 190, atk: 34, mag: 88, def: 46, spr: 92, spd: 58, luck: 62,
      growth: { hp: 40, mp: 13, atk: 2.0, mag: 7.0, def: 3.2, spr: 6.8, spd: 2.4, luck: 2.2 },
    }),
  }),

  Object.freeze({
    id: 'bramm',
    name: 'Bramm Okkonen',
    className: 'Forgemaster',
    role: 'tank',
    element: 'earth',
    limit: { id: 'second-regret', name: 'Second Regret' },

    // "a keg on bowed legs" — the only party member whose girth multipliers
    // exceed 1.2, and the only one with legLength below 0.9. Together those two
    // numbers do all the work; the costume just decorates the result.
    proportions: proportions({ height: 1.13, headScale: 0.95, legLength: 0.84, shoulder: 1.26, chest: 1.34, hip: 1.28, limb: 1.26, arm: 0.94, hand: 1.18, foot: 1.20, eye: 0.84, browAngle: -0.26 }),

    palette: Object.freeze({
      skin: 0xc08a63, skinShade: 0x855239,
      hair: 0xa9a49a, hairShade: 0x5e5a54, hairLight: 0xe0dcd2,
      // Iris = the element accent (ART_BIBLE §2.2 `LOAM`). Six characters, six
      // saturated iris hues: the cheapest thing in the whole pipeline that makes
      // a closeup instantly identifiable, and the reason this is not the
      // desaturated blue-grey it used to be.
      eye: 0xc98f3f, eyeCore: 0xf2d9a6, sclera: 0xeee7dc, lash: 0x1b1f24,
      primary: 0x4a4440,    // iron
      secondary: 0x6b3328,  // oxblood apron
      trim: 0xb8863b,       // brass
      metal: 0xb8863b,
      leather: 0x6b3328,
      accent: 0xb8863b,
      cape: 0x6b3328, capeLining: 0x3a2420,
      weaponA: 0xb8863b,
      weaponB: 0x4a4440,
      glow: 0xff6b2b,
    }),

    // Mass class: **beard**. Almost nothing above the chin; the volume is below
    // it. Inverting where the head mass sits relative to everyone else is the
    // strongest silhouette trick available at this size, and it costs nothing.
    hair: Object.freeze({
      style: 'beard',
      capScale: 1.16, capDrop: 0.28,
      fringe: 0, fringeLength: 0.0, fringeSweep: 0.0, fringeSpread: 1.0,
      backLength: 0.10, backWidth: 0.8,
      beardLength: 0.50, beardWidth: 1.30, beardFork: 0.30,
      highlightBand: 0.70, highlightWidth: 0.10,
      boneCount: 2, boneStiffness: 0.62,
    }),

    weapon: Object.freeze({
      kind: 'piston', mount: 'forearmR',
      length: 0.40, width: 0.115, thickness: 0.115,
      barrels: 3, ventCount: 5,
      tilt: 0.0, roll: 0.0,
      emissive: 0.35,
    }),

    cape: Object.freeze({
      kind: 'apron', anchor: 'chest',
      length: 0.40, width: 0.34, split: 0.0, asymmetry: 0.0,
      stiffness: 0.78, mass: 1.9, drag: 0.020, boneCount: 0,
    }),

    accessories: Object.freeze({ pauldron: null, collar: 'none', bareShoulder: 'L', prosthetic: 'R', beltRing: true }),

    stats: Object.freeze({
      hp: 1120, mp: 70, atk: 92, mag: 28, def: 108, spr: 62, spd: 34, luck: 30,
      growth: { hp: 96, mp: 3.4, atk: 6.8, mag: 1.4, def: 8.2, spr: 4.0, spd: 1.2, luck: 1.0 },
    }),
  }),

  Object.freeze({
    id: 'kite',
    name: 'Kirella Marrow',
    className: 'Corsair',
    role: 'striker',
    element: 'water',
    limit: { id: 'ricochet-storm', name: 'Ricochet Storm' },

    proportions: proportions({ height: 1.15, headScale: 0.98, legLength: 1.08, shoulder: 0.97, chest: 0.95, hip: 1.0, limb: 0.93, arm: 1.05, foot: 1.06, eye: 1.0, browAngle: -0.16 }),

    palette: Object.freeze({
      skin: 0x8a5a44, skinShade: 0x53321f,
      hair: 0x1f2830, hairShade: 0x0e151b, hairLight: 0x5d7688,
      // Iris = `TIDE`, her element. A cream iris on a cream sclera has no
      // contrast at all and the eye reads as blank at any distance.
      eye: 0x3fa9f5, eyeCore: 0xa8e4ff, sclera: 0xf0ece2, lash: 0x0d1116,
      primary: 0x2e4a5f,    // storm-blue coat
      secondary: 0x1a2c39,
      trim: 0xd9cba6,       // bleached rope
      metal: 0xb8bfc7,
      leather: 0x24333d,
      accent: 0xc9403a,     // the party's only red — her sister's sash
      cape: 0x2e4a5f, capeLining: 0xc9403a,
      weaponA: 0x9fd8cf,    // keel-glass chakram
      weaponB: 0xd9cba6,
      glow: 0x7de3ff,
    }),

    // Mass class: **bob with side flare**. A bell that is widest at the jaw —
    // nobody else in the party carries mass at ear level — cut on a hard
    // diagonal with the outboard flares kicking past the shoulder line, which is
    // WORLD_BIBLE §3.4's "everything about her is diagonals" made into outline.
    hair: Object.freeze({
      style: 'bob',
      capScale: 1.07, capDrop: 0.44,
      fringe: 6, fringeLength: 0.24, fringeSweep: 0.55, fringeSpread: 1.1,
      backLength: 0.24, backWidth: 1.38, braidWidth: 0.50,
      lean: 0.40, cutAngle: 0.50,
      highlightBand: 0.60, highlightWidth: 0.12,
      boneCount: 1, boneStiffness: 0.5,
    }),

    // Worn across the back like a halo knocked askew — a hard ring outline that
    // no other party member owns, readable even when she is fully backlit.
    weapon: Object.freeze({
      kind: 'chakram', mount: 'back',
      radius: 0.20, width: 0.05, thickness: 0.018, gap: 0.55,
      blades: 3,
      tilt: 0.30, roll: 0.42,
      emissive: 0.45,
    }),

    cape: Object.freeze({
      kind: 'stormcoat', anchor: 'chest',
      length: 0.30, width: 0.42, split: 0.5, asymmetry: 0.22,
      stiffness: 0.40, mass: 0.85, drag: 0.024, boneCount: 0,
      sash: { length: 0.44, width: 0.075, side: 'R', stiffness: 0.16, drag: 0.06 },
    }),

    accessories: Object.freeze({ pauldron: null, collar: 'popped', bootBlade: 'L', beltRing: true }),

    stats: Object.freeze({
      hp: 640, mp: 84, atk: 78, mag: 46, def: 52, spr: 50, spd: 104, luck: 88,
      growth: { hp: 46, mp: 4.4, atk: 5.6, mag: 2.8, def: 3.4, spr: 3.2, spd: 5.4, luck: 3.6 },
    }),
  }),

  Object.freeze({
    id: 'emrys',
    name: 'Emrys Tal',
    className: 'Ashwright',
    role: 'mage',
    element: 'fire',
    limit: { id: 'everything-i-have', name: 'Everything I Have' },

    // Fourteen, and drawn as a child: the largest head ratio and the smallest
    // frame in the party. `eye` at 1.16 is the top of the band — at 80 px the
    // eye block is the only thing that says "kid".
    proportions: proportions({ height: 1.02, headScale: 1.08, legLength: 0.94, shoulder: 0.83, chest: 0.88, hip: 0.90, limb: 0.85, arm: 0.92, hand: 0.92, foot: 0.94, eye: 1.16, eyeSpacing: 1.05, browAngle: 0.06 }),

    palette: Object.freeze({
      skin: 0xe0b394, skinShade: 0xa06f56,
      hair: 0xe4e0d6, hairShade: 0x8d8c8a, hairLight: 0xffffff,
      eye: 0xff6b2b, eyeCore: 0xffd08a, sclera: 0xf4efe4, lash: 0x191418,
      primary: 0x26221e,    // charcoal scholar's coat
      secondary: 0x39322a,
      trim: 0xff6b2b,       // ember lining
      metal: 0xb8863b,
      leather: 0x2f2822,
      accent: 0xff6b2b,
      cape: 0x26221e, capeLining: 0xff6b2b,
      weaponA: 0x6b5a45,
      weaponB: 0xd9cba6,
      glow: 0xff6b2b,
    }),

    // Mass class: **spiked crown**. Splayed outward rather than upward: a
    // vertical starburst adds head height, and REFERENCE_TARGET §1's 3.0–3.5
    // heads charges for every millimetre of it. Wide costs nothing in the ratio
    // and the outline is just as unmistakable.
    hair: Object.freeze({
      style: 'spike',
      capScale: 1.08, capDrop: 0.42,
      fringe: 4, fringeLength: 0.22, fringeSweep: 0.20, fringeSpread: 1.2,
      spikes: 10, spikeLength: 0.155, spikeSpread: 1.45, spikeJitter: 0.35,
      backLength: 0.14, backWidth: 0.95,
      highlightBand: 0.56, highlightWidth: 0.16,
      boneCount: 0,
    }),

    weapon: Object.freeze({
      kind: 'grimoire', mount: 'handL',
      width: 0.19, height: 0.24, thickness: 0.055,
      orreryRings: 3, orreryRadius: 0.30,
      tilt: 0.18, roll: -0.22,
      emissive: 1.1,
    }),

    // The coat is an adult's and does not fit: it reaches his ankles and the
    // sleeves are rolled six times (WORLD_BIBLE §3.5). Longest cloth in the
    // party relative to body height — a bell of fabric with a child on top.
    cape: Object.freeze({
      kind: 'longcoat', anchor: 'chest',
      length: 0.62, width: 0.46, split: 0.72, asymmetry: 0.10,
      stiffness: 0.34, mass: 1.25, drag: 0.034, boneCount: 0,
    }),

    accessories: Object.freeze({ pauldron: null, collar: 'oversized', rolledSleeves: 6, satchel: 'L' }),

    stats: Object.freeze({
      hp: 470, mp: 210, atk: 30, mag: 112, def: 38, spr: 60, spd: 66, luck: 54,
      growth: { hp: 32, mp: 15, atk: 1.6, mag: 8.8, def: 2.6, spr: 4.2, spd: 3.0, luck: 2.0 },
    }),
  }),

  Object.freeze({
    id: 'yshara',
    name: 'Yshara Vhek',
    className: 'Wyldcaller',
    role: 'dragoon',
    element: 'wind',
    limit: { id: 'skyfall', name: 'Skyfall' },

    proportions: proportions({ height: 1.22, headScale: 0.96, legLength: 1.10, shoulder: 1.02, chest: 0.98, hip: 0.98, limb: 0.94, arm: 1.08, foot: 1.02, eye: 0.94, browAngle: -0.06 }),

    palette: Object.freeze({
      skin: 0x9c6a55, skinShade: 0x5d3a2f,
      hair: 0x3a2f3f, hairShade: 0x1d1823, hairLight: 0x8f7fa0,
      eye: 0x8fe6a0, eyeCore: 0xe6ffee, sclera: 0xefe9e0, lash: 0x14121a,
      primary: 0x5c4a66,    // ash-violet
      secondary: 0x3a2f42,
      trim: 0xd9d2c4,       // bone
      metal: 0xd9d2c4,
      leather: 0x4a3d3a,
      accent: 0xc9403a,     // ember-fleck in the mantle
      cape: 0x5c4a66, capeLining: 0x3a2f42,
      weaponA: 0xd9d2c4,    // rib-bone lance
      weaponB: 0x8a8073,
      glow: 0x8fe6a0,       // tattoo lines that light when an Esper answers
    }),

    // Mass class: **top-knot with trailing tie**. The only vertical mass in the
    // party, on the tallest frame, plus a long braid that the cloth solver keeps
    // in motion. Kept to 0.10 H above the binding ring: taller reads better in
    // isolation and immediately puts her outside the heads-tall band.
    hair: Object.freeze({
      style: 'topknot',
      capScale: 1.02, capDrop: 0.48,
      fringe: 5, fringeLength: 0.20, fringeSweep: 0.45, fringeSpread: 1.15,
      topknot: 0.09, topknotWidth: 0.52,
      braidLength: 0.70, braidWidth: 0.11, braidSegments: 6,
      backLength: 0.12, backWidth: 0.85, backDepth: 0.55,
      highlightBand: 0.64, highlightWidth: 0.11,
      boneCount: 5, boneStiffness: 0.5,
    }),

    // "a spear standing in a cloak" — carried across the shoulders like a yoke,
    // which puts a long horizontal bar through her silhouette. Nobody else in
    // the party has a horizontal, so this alone identifies her.
    weapon: Object.freeze({
      kind: 'lance', mount: 'handR',
      length: 1.05, width: 0.030, thickness: 0.030,
      headLength: 0.24, headWidth: 0.085, ribs: 5,
      tilt: 1.42, roll: 0.0,
      emissive: 0.30,
    }),

    // Feather-mantle: wide at the shoulder, cut short, with a heavy fringe.
    // High drag so it settles slowly — feathers do not snap back like cloth.
    // Lower-body outline: **bare legs under a short mantle**. Cut to 0.28 H so
    // the legs clear it — she is the only party member reading as legs-and-spear
    // rather than as a body inside cloth, and that is her half of the six-way
    // lower-outline split the lineup test needs.
    cape: Object.freeze({
      kind: 'mantle', anchor: 'chest',
      length: 0.28, width: 0.44, split: 0.0, asymmetry: 0.0,
      hem: 'round',
      stiffness: 0.30, mass: 0.95, drag: 0.070, boneCount: 3,
      feathers: 11, featherLength: 0.20,
    }),

    accessories: Object.freeze({ pauldron: null, collar: 'feather', tattoo: true, beltRing: true }),

    stats: Object.freeze({
      hp: 820, mp: 120, atk: 88, mag: 64, def: 68, spr: 72, spd: 76, luck: 46,
      growth: { hp: 58, mp: 6.6, atk: 6.4, mag: 4.2, def: 4.6, spr: 5.0, spd: 3.4, luck: 1.6 },
    }),
  }),
]);

/** Id-keyed view of {@link ROSTER}. */
export const ROSTER_BY_ID = Object.freeze(
  ROSTER.reduce((acc, c) => {
    acc[c.id] = c;
    return acc;
  }, {}),
);

/** Story order — also the default battle formation, front to back. */
export const DEFAULT_PARTY = Object.freeze(['auren', 'seren', 'emrys', 'kite']);

/** The one piece of behaviour in this file: id -> definition, or null. */
export function characterDef(id) {
  return ROSTER_BY_ID[id] ?? null;
}
