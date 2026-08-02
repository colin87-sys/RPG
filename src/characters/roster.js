/**
 * roster.js — the six playable characters of AETHERWIND SAGA, as pure data.
 *
 * This file is the single source of truth `CharacterFactory` reads to build a
 * body, `Rig` reads to size a skeleton, `FaceTexture` reads to paint a face,
 * `Animation` reads for per-character motion bias, and the battle layer reads
 * for stats. It contains **no logic** beyond one id lookup: everything here must
 * stay serialisable so a save file can reference it by id and a designer can
 * retune a character without touching a line of graphics code.
 *
 * Three conventions that are load-bearing across the whole system:
 *
 * 1. **Every length is a fraction of the character's own height**, except
 *    `proportions.height`, which is in world units, and the `hair` block, which
 *    is in **head diameters**. That is what lets Bramm (short, wide) and Yshara
 *    (tall, narrow) share one geometry generator: the generator never sees an
 *    absolute number it could get wrong for a body type it wasn't tuned against.
 *
 *    The hair exception is a bug fix, not a convenience. Hair is a function of
 *    the skull it grows on and of nothing else, and the head is between 0.28 and
 *    0.32 of body height across this roster — so the *same* fraction of body
 *    height produces visibly different hairstyles for no authored reason. It
 *    also produced an outright failure: Bramm's beard, at 0.50 of body height,
 *    came out three and a half head-radii long with its top edge above his eyes,
 *    and he shipped as a blank oval with no face. `backLength`, `beardLength`,
 *    `spikeLength`, `topknot`, `fringeLength` and `braidLength` are all head
 *    diameters; `capScale` is a radial multiple of the skull.
 *
 * 2. **Silhouette parameters come first.** REFERENCE_TARGET §1 requires the six
 *    to be distinguishable as flat black shapes at 80 px, so hair mass, weapon
 *    outline and cloth hem are the most detailed things here.
 *
 * 3. **Colour blocking is a hard requirement, not decoration.** ANIME_PIPELINE
 *    §5: every character must read as three or four *flat* colour zones and be
 *    identifiable "by colour alone" at battle distance. The first cast failed
 *    this outright — five of the six wore a dark desaturated coat and the party
 *    read as one navy mass. The `palette` block below is therefore organised
 *    around four named zones rather than around a costume description:
 *
 *      `identity`  the dominant garment. Saturated, mid-value, and the six are
 *                  spread around the hue wheel — cobalt, ivory, ochre, scarlet,
 *                  violet, jade — deliberately *avoiding* the 150–200° band the
 *                  environment's mist and sky already own (REFERENCE §4), so a
 *                  character never dissolves into their own backdrop.
 *      `secondary` the second-largest zone: trousers, underlayer, skirt. Chosen
 *                  to break the trunk into two values rather than to harmonise.
 *      `trim`      a small, *high-contrast* zone — cuffs, collar, cape lining,
 *                  boot tops. This is the one that survives to 80 px as a spark
 *                  of colour on an otherwise flat mass.
 *      `accent`    metal or leather. Smallest area, highest value (§5).
 *
 *    Everything else in the palette exists for one named consumer, and the
 *    comment says which.
 *
 * Palette values are authored in sRGB hex and consumed in linear light.
 * Derived tints (shade / lining) are authored rather than computed because a
 * hue-rotated shade reads muddy on a two-band cel ramp — the shadow of an amber
 * coat wants to go teal-ward, not brown-ward, and no generic darkening function
 * knows that.
 *
 * OWNED BY: characters.
 */

/**
 * Canonical proportion block. Everything is a multiplier on the chibi base
 * defined in `Rig.js` except `height`, which is world units, crown to floor.
 * REFERENCE_TARGET §1 puts the party at 3.0–3.5 heads and ~1.1–1.2 units tall;
 * the spread below stays inside that with Emrys (a fourteen-year-old) at the
 * bottom of the band and Yshara at the top, so relative age reads in a lineup.
 *
 * The face channels need a word about which of them is authoritative.
 * `FaceTexture.faceTraits` paints from the **numbers** — `eye`, `eyeSpacing`
 * and `browAngle` — and derives everything else (lash weight, corner drop, brow
 * arch, lid depth) from them. `eyeShape` and `brow` are the authoring *intent*
 * those numbers encode, written down so that a designer retuning `eye` from
 * 1.12 to 0.9 can see immediately that the character no longer matches the word
 * next to it. They are documentation with a schema, not a second input.
 *
 * Sign convention for `browAngle`, fixed by ANIME_PIPELINE §1 ("down-inner =
 * determined, up-inner = gentle") and matched by `FaceTexture`: **positive
 * raises the inner end**, i.e. positive is gentle and negative is hard.
 */
const BASE_PROPORTIONS = Object.freeze({
  height: 1.16,
  headScale: 1.0,   // head diameter multiplier; 1.0 == 0.295 * height
  legLength: 1.0,   // shifts the hips, crown stays pinned to `height`
  shoulder: 1.0,
  chest: 1.0,
  hip: 1.0,
  limb: 1.0,        // limb girth
  arm: 1.0,         // arm segment length
  hand: 1.0,
  foot: 1.0,
  eye: 1.0,         // painted eye size multiplier — the dominant facial channel
  eyeSpacing: 1.0,
  browAngle: 0.0,   // radians; positive raises the inner end (gentle)
  eyeShape: 'almond', // 'narrow' | 'sharp' | 'almond' | 'round'
  brow: 'level',      // 'hard' | 'level' | 'gentle'
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

    proportions: proportions({
      height: 1.19, shoulder: 1.07, chest: 1.04, legLength: 1.02,
      eye: 0.96, browAngle: -0.10, eyeShape: 'sharp', brow: 'hard',
    }),

    // **Cobalt and bone.** The party's only blue, and it is a *bright* one:
    // the failed cast's slate #3D4A5C sat at linear luminance 0.06, which is
    // where every other costume also sat. Pale trousers under a saturated coat
    // give him a value break at the belt that survives being 80 px tall.
    palette: Object.freeze({
      skin: 0xd9a882, skinShade: 0x9c6f56,
      hair: 0x4a3d33, hairShade: 0x241f1c,
      // Iris hues are one-per-character and saturated: at closeup the eye is
      // the largest single colour in frame (ANIME_PIPELINE §1).
      eye: 0xefc24a, eyeCore: 0xfff0c4, sclera: 0xf2ede2, lash: 0x14181f,

      identity: 0x3e6fd6,   // cobalt storm-coat
      secondary: 0xd6c9a6,  // bone canvas trousers
      trim: 0xf0b93c,       // gold facing, cuffs and cape lining
      accent: 0xc6ced8,     // steel

      leather: 0x3a2e26,    // belt, boot body
      metal: 0xc6ced8,
      cape: 0x3e6fd6, capeLining: 0xf0b93c,
      weaponA: 0xd6e4ee,    // pale moonglass
      weaponB: 0x8f9ba8,
      glow: 0xfff0b8,
    }),

    // Mass class: **swept wedge**. Narrowest crown in the party with the volume
    // thrown backwards and down the -Z axis, so the head silhouettes as an
    // arrowhead pointing forward — the exact inverse of Emrys's outward
    // starburst, which is the pair most at risk of colliding at 80 px.
    //
    // `part` is the hard side parting: it shifts the whole fringe fan off centre
    // so no clump hangs down the middle of the face, and `lean` biases the back
    // clumps to the same side so the parting reads from the front too.
    // `backCount` is how many chunky clumps the mass is carved from — six is the
    // count at which neighbours fuse into one form at the crown while still
    // separating into points at the nape.
    hair: Object.freeze({
      style: 'swept',
      capScale: 1.12, capDrop: 0.55,
      fringe: 4, fringeLength: 0.40, fringeSweep: 0.95, fringeSpread: 1.0, part: 0.20,
      backCount: 6, backLength: 0.66, backWidth: 0.86, backDepth: 1.10, lean: 0.26,
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

    proportions: proportions({
      // Head at 1.00 rather than 1.05: she is the shortest frame in the party
      // and the hair shell that sits over her skull is the widest, so the
      // *silhouette* head mass REFERENCE §1 measures came out at 2.94 heads —
      // outside the 3.0–3.5 band even though the skull alone was inside it.
      height: 1.06, headScale: 1.00, shoulder: 0.87, chest: 0.92, hip: 0.96,
      limb: 0.90, foot: 0.78,
      eye: 1.12, eyeSpacing: 1.03, browAngle: 0.14, eyeShape: 'round', brow: 'gentle',
    }),

    // **Ivory.** Her separation is by *value* rather than hue: she is the only
    // near-white costume in the party and the brightest thing on the stage that
    // is not a spell, which is the read a healer wants. The teal underlayer is
    // her element and is the one place the party is allowed into the mist's own
    // hue band, because it sits against white.
    palette: Object.freeze({
      skin: 0xe8d3c4, skinShade: 0xab8b83,
      hair: 0xece6da, hairShade: 0x9aa6a8,
      eye: 0x4fc8be, eyeCore: 0xd8fbf6, sclera: 0xf6f2ea, lash: 0x263038,

      identity: 0xf2ead8,   // ivory robe
      secondary: 0x2fa89e,  // teal underlayer and skirt
      trim: 0xffc24d,       // gold thread
      accent: 0xffc24d,

      leather: 0xc0a87c,
      metal: 0xffc24d,
      cape: 0xf2ead8, capeLining: 0x2fa89e,
      weaponA: 0xd9cfc0,
      weaponB: 0xffc24d,
      glow: 0x5fb8b0,
    }),

    // Mass class: **long straight sheet**. Widest and longest hair in the party
    // by a margin — 1.35 head-widths of solid slab against Auren's 0.82, past
    // the 25% divergence the lineup test demands — and the only one bone-driven
    // along its full length so it never stops moving (ART_BIBLE §7.9).
    hair: Object.freeze({
      style: 'sheet',
      capScale: 1.14, capDrop: 0.66,
      fringe: 3, fringeLength: 0.34, fringeSweep: 0.10, fringeSpread: 1.45, part: 0.10,
      // Seven broad clumps side by side, overlapping heavily at the crown and
      // fanning to a blunt hem — a curtain, not a slab. `backWidth` spreads
      // where the tips land; it no longer fattens the clumps themselves.
      backCount: 7, backLength: 1.45, backWidth: 1.55, backFlare: 1.20,
      braidWidth: 0.70,
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
    proportions: proportions({
      height: 1.13, headScale: 0.95, legLength: 0.84, shoulder: 1.26, chest: 1.34,
      hip: 1.28, limb: 1.26, arm: 0.94, hand: 1.18, foot: 1.20,
      eye: 0.84, browAngle: -0.26, eyeShape: 'narrow', brow: 'hard',
    }),

    // **Ochre and oxblood.** A forge apron in hot brass over iron work clothes:
    // the warmest large mass in the party and the only ochre, which is what
    // keeps him off Kite's scarlet at distance even though both are warm.
    palette: Object.freeze({
      skin: 0xc08a63, skinShade: 0x855239,
      hair: 0xa9a49a, hairShade: 0x5e5a54,
      eye: 0x86b23c, eyeCore: 0xdff0a8, sclera: 0xeee7dc, lash: 0x1b1f24,

      identity: 0xc0862e,   // brass-ochre apron
      secondary: 0x4e5462,  // iron work clothes
      trim: 0x8a3427,       // oxblood straps and cuffs
      accent: 0xd9a03c,     // polished brass

      leather: 0x53372c,
      metal: 0xd9a03c,
      cape: 0xc0862e, capeLining: 0x8a3427,
      weaponA: 0xd9a03c,
      weaponB: 0x4e5462,
      glow: 0xff6b2b,
    }),

    // Mass class: **beard**. Almost nothing above the chin; the volume is below
    // it. Inverting where the head mass sits relative to everyone else is the
    // strongest silhouette trick available at this size, and it costs nothing.
    hair: Object.freeze({
      style: 'beard',
      capScale: 1.16, capDrop: 0.28,
      // Two short clumps rather than none. With a bare shell his crown rendered
      // as one smooth unbroken dome — a helmet, not hair — and the clumps are
      // what break the outline without giving him a hairstyle he is not
      // supposed to have.
      fringe: 3, fringeLength: 0.20, fringeSweep: 0.30, fringeSpread: 0.95, part: 0.14,
      backLength: 0.34, backWidth: 0.8,
      // Head diameters, like every other hair length. At the old 0.50 of *body*
      // height this was three and a half head-radii of mass whose top edge
      // closed over his eyes — the review's "blank oval with a single dot".
      // 1.05 head-diameters is a beard to the middle of the chest, which is the
      // read WORLD_BIBLE §3.3 asks for and the one that inverts his head mass
      // against everyone else's.
      beardLength: 1.05, beardWidth: 1.30, beardFork: 0.30,
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

    proportions: proportions({
      height: 1.15, headScale: 0.98, legLength: 1.08, shoulder: 0.97, chest: 0.95,
      hip: 1.0, limb: 0.93, arm: 1.05, foot: 1.06,
      eye: 1.0, browAngle: -0.16, eyeShape: 'sharp', brow: 'hard',
    }),

    // **Scarlet.** The sister's sash was the only red in the party and it was
    // four pixels wide; promoting it to the whole coat gives the fastest
    // character the loudest colour, which is how the eye finds her when she
    // crosses the stage. Sea-blue trousers keep her element in the block.
    palette: Object.freeze({
      skin: 0x8a5a44, skinShade: 0x53321f,
      hair: 0x1f2830, hairShade: 0x0e151b,
      eye: 0x3fa9f5, eyeCore: 0xa8e4ff, sclera: 0xf0ece2, lash: 0x0d1116,

      identity: 0xd2402f,   // her sister's red, worn as a stormcoat
      secondary: 0x235d8a,  // sea-blue trousers
      trim: 0xe3d3a8,       // bleached rope
      accent: 0xb8bfc7,     // steel

      leather: 0x2a2a30,
      metal: 0xb8bfc7,
      cape: 0xd2402f, capeLining: 0xe3d3a8,
      weaponA: 0x9fd8cf,    // keel-glass chakram
      weaponB: 0xe3d3a8,
      glow: 0x7de3ff,
    }),

    // Mass class: **bob with side flare**. A bell that is widest at the jaw —
    // nobody else in the party carries mass at ear level — cut on a hard
    // diagonal with the outboard flares kicking past the shoulder line, which
    // is WORLD_BIBLE §3.4's "everything about her is diagonals" made outline.
    hair: Object.freeze({
      style: 'bob',
      capScale: 1.11, capDrop: 0.44,
      fringe: 3, fringeLength: 0.30, fringeSweep: 0.55, fringeSpread: 1.1, part: 0.24,
      // Eight clumps wrapping past both ears onto the cheeks: the bell has to
      // close in front of the ear or it reads as a hood seen from the side.
      backCount: 8, backLength: 0.62, backWidth: 1.46, braidWidth: 0.50,
      lean: 0.40, cutAngle: 0.62,
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
    proportions: proportions({
      // Head at 1.00 rather than 1.08. REFERENCE §1 measures the head *mass* —
      // hair shell and style included — against its 3.0–3.5 heads band, and on
      // the shortest frame in the party a 1.08 skull under a starburst measured
      // 2.6 heads. The child read survives without it: it is carried by the
      // 1.16 eye multiplier and by the coat that swamps him, which are the two
      // channels that actually survive to 80 px.
      height: 1.00, headScale: 1.00, legLength: 0.94, shoulder: 0.83, chest: 0.88,
      hip: 0.90, limb: 0.85, arm: 0.92, hand: 0.92, foot: 0.94,
      eye: 1.16, eyeSpacing: 1.05, browAngle: 0.06, eyeShape: 'round', brow: 'gentle',
    }),

    // **Violet with an ember lining.** The coat is an adult's and swamps him,
    // so it is nearly his whole silhouette — which makes it the one costume in
    // the party that has to carry identity on its own. Charcoal was the wrong
    // answer twice over: it hid the child inside it and it matched four other
    // party members. The ember trim is his element and the only warm note.
    palette: Object.freeze({
      skin: 0xe0b394, skinShade: 0xa06f56,
      hair: 0xe4e0d6, hairShade: 0x8d8c8a,
      eye: 0xff6b2b, eyeCore: 0xffd08a, sclera: 0xf4efe4, lash: 0x191418,

      identity: 0x6b4aa8,   // inherited violet scholar's coat
      secondary: 0x35313c,  // charcoal under-tunic
      trim: 0xff6b2b,       // ember lining, cuffs and collar
      accent: 0xc08a3a,     // worn brass buckles

      leather: 0x2f2822,
      metal: 0xc08a3a,
      cape: 0x6b4aa8, capeLining: 0xff6b2b,
      weaponA: 0x6b5a45,
      weaponB: 0xd9cba6,
      glow: 0xff6b2b,
    }),

    // Mass class: **spiked crown**. Splayed outward rather than upward: a
    // vertical starburst adds head height, and REFERENCE_TARGET §1's 3.0–3.5
    // heads charges for every millimetre of it. Wide costs nothing in the ratio
    // and the outline is just as unmistakable. Eight fat spikes rather than
    // ten thin ones — ANIME_PIPELINE §3's "chunky clumps with a clear point".
    hair: Object.freeze({
      style: 'spike',
      capScale: 1.12, capDrop: 0.42,
      fringe: 3, fringeLength: 0.30, fringeSweep: 0.20, fringeSpread: 1.2, part: 0.12,
      spikes: 8, spikeLength: 0.52, spikeSpread: 1.55, spikeJitter: 0.35,
      backLength: 0.48, backWidth: 0.95,
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

    // The belt ring is his only metal: §5 asks every character for a small,
    // higher-value metal or leather accent, and without it he is violet, ember
    // and charcoal with nothing to catch a specular.
    accessories: Object.freeze({ pauldron: null, collar: 'oversized', rolledSleeves: 6, satchel: 'L', beltRing: true }),

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

    proportions: proportions({
      height: 1.26, headScale: 0.96, legLength: 1.10, shoulder: 1.02, chest: 0.98,
      hip: 0.98, limb: 0.94, arm: 1.08, foot: 1.02,
      eye: 0.98, browAngle: 0.0, eyeShape: 'almond', brow: 'level',
    }),

    // **Jade and bone.** The party's only green and the only cool costume that
    // is not blue, sitting a clean 70° off Auren on the wheel. Bone trim on a
    // saturated mid-green is the highest-contrast trim pairing in the roster,
    // which is what a mostly-bare-legged silhouette needs to stay readable.
    palette: Object.freeze({
      skin: 0x9c6a55, skinShade: 0x5d3a2f,
      hair: 0x3a2f3f, hairShade: 0x1d1823,
      eye: 0x8fe6a0, eyeCore: 0xe6ffee, sclera: 0xefe9e0, lash: 0x14121a,

      identity: 0x35915f,   // jade feather-mantle and wrap
      secondary: 0x1e4a38,  // deep moss underwrap
      trim: 0xe3dcc8,       // bone
      accent: 0xc9403a,     // ember-fleck bindings

      leather: 0x4a3d3a,
      metal: 0xe3dcc8,
      cape: 0x35915f, capeLining: 0xe3dcc8,
      weaponA: 0xd9d2c4,    // rib-bone lance
      weaponB: 0x8a8073,
      glow: 0x8fe6a0,       // tattoo lines that light when an Esper answers
    }),

    // Mass class: **top-knot with trailing tie**. The only vertical mass in the
    // party, on the tallest frame, plus a long braid that the cloth solver keeps
    // in motion. Kept to 0.09 H above the binding ring: taller reads better in
    // isolation and immediately puts her outside the heads-tall band.
    hair: Object.freeze({
      style: 'topknot',
      capScale: 1.10, capDrop: 0.48,
      fringe: 3, fringeLength: 0.28, fringeSweep: 0.45, fringeSpread: 1.05, part: 0.12,
      // Six clumps combed *up* from the hairline into the binding ring: the
      // gather is what makes a topknot read as bound hair rather than as a hat.
      backCount: 6, topknot: 0.42, topknotWidth: 0.50,
      braidLength: 2.40, braidWidth: 0.11, braidSegments: 6,
      backLength: 0.40, backWidth: 0.85, backDepth: 0.55,
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
