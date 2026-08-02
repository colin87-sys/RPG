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
 * 3. **Colour blocking is a hard requirement, and the discipline is the
 *    plate's, not the colour wheel's.** Every character must read as three or
 *    four *flat* zones and be identifiable at battle distance. What changed is
 *    how that separation is bought.
 *
 *    The previous cast bought it with saturation: six dominants spread round
 *    the hue wheel, every one of them above S 0.6, on the theory that a
 *    desaturated dominant lands in a beige-grey-tan band once the fog lerp has
 *    had it. The result is in `shots/mp0-cast/cast-stage.png` next to
 *    `docs/reference/bravely01.jpg`, and the comparison settles it: our party
 *    wore hot pink, candy violet, saturated orange and saturated green in front
 *    of a lavender meadow, so **the costumes competed with the flowers and lost
 *    the figures**. Sample the plate instead. Its four leads wear steel-navy
 *    plate, a black bodice under a white collar, a wine coat and a black
 *    fur-trimmed gown; measured off the image, every large costume area sits
 *    under **S 0.35**, and the only pixels above S 0.7 in the whole party are a
 *    throat ribbon, a hat pompom, a line of rose embroidery and the flowers
 *    behind them. Saturation is what the *environment* is allowed to spend.
 *
 *    So the rule is now:
 *
 *      **every base costume zone: S ≤ 0.35, V within 0.25–0.75.**
 *      **exactly one `spark` per character: S ≥ 0.7, on one small piece.**
 *
 *    Separation is carried by hue *and value* instead — dark navy, bone, mid
 *    canvas, dark wine, mid mauve, mid forest — which is how the plate's party
 *    separates and is more robust to the fog lerp than chroma was, because the
 *    lerp attacks chroma and leaves value alone.
 *
 *      `identity`  the dominant garment. Navy, bone, canvas, wine, mauve,
 *                  forest. Its *value* is what distinguishes the character in a
 *                  lineup; no two of the six are within 0.06 V of each other
 *                  unless they are also 60° apart in hue.
 *      `secondary` the second-largest zone: trousers, underlayer, skirt. Chosen
 *                  to break the trunk into two values rather than to harmonise.
 *      `trim`      collar, cuffs, piping, cape lining, boot tops. Still the
 *                  high-*contrast* zone, but the contrast is now in value.
 *      `accent`    metal or leather. Smallest area, highest value (§5).
 *      `spark`     **the one saturated colour on the character.** Consumed only
 *                  by garment specs that name it, and only by small pieces —
 *                  a ribbon, a pompom, a buckle, a sash piping, the blossom
 *                  colour inside an embroidery motif. Mirrors `bravely01`'s
 *                  green-on-black archer and wine-coat-with-red-roses mage.
 *                  Nothing that reads as an *area* may use it.
 *
 *    Everything else in the palette exists for one named consumer, and the
 *    comment says which. `glow` and `eye` are exempt from the saturation rule:
 *    the first is emissive VFX and the second is a few dozen pixels of iris
 *    that ANIME_PIPELINE §1 explicitly wants saturated.
 *
 * 4. **Costume is layered, and the layers are data.** Each character carries a
 *    `garments` array read by `characters/Garments.js` — an ordered list of
 *    `{ kind, ...params }` drawn from `GARMENT_KINDS`, innermost first. The
 *    client's largest single complaint was that our costumes were flat colour
 *    masses where `docs/reference/bravely01.jpg` and `bravely05.jpg` show
 *    richly layered garments, and the fix is here rather than in a builder:
 *    every character wears **nine to twelve separately coloured pieces**, each
 *    with its own material response and its own rolled edge, so the silhouette
 *    has internal structure instead of a single outline around one mass.
 *
 *    Two conventions make that block safe to retune. Colours are named
 *    **palette slots** (`'identity'`, `'trim'`, `'accent'`, `'leather'`) rather
 *    than hexes, so a palette change carries the whole wardrobe with it and no
 *    stale hex can drift out of a character's identity colour; the exceptions
 *    are the `pattern` blocks, whose canvas motifs need literal colours and
 *    which therefore carry a comment tying them back to the slot they track.
 *    And every length is a fraction of body height, exactly like the rest of
 *    this file.
 *
 *    A motif's **tiling lives in `pattern.repeat` and nowhere else.** Four
 *    builders used to scale UVs by their own private `patternRepeatU` on top of
 *    it, so a block asking for three tiles got nine, applied in u only; on
 *    Seren's petticoat that sheared a square weave into a magenta-and-white
 *    grating that the art review reasonably read as a missing-texture
 *    placeholder. `Garments.resolveRepeat` now owns tiling, refuses a repeat
 *    that would shear a motif past 4:1, and refuses to tile a `wrap: 'clamp'`
 *    motif at all.
 *
 *    Where a piece exists in both `accessories` and `garments`, the accessory
 *    is switched off: the two builders would otherwise both run and the
 *    character would wear two collars.
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
 * `docs/BRAVELY_REFERENCE.md` §1 puts the party at **4.0–4.5 heads** measured
 * on the silhouette (skull plus hair) and ~1.0–1.26 units tall; the spread
 * below stays inside that with Emrys (a fourteen-year-old) shortest and Yshara
 * tallest, so relative age reads in a lineup. Anything in this repo asking for
 * 3.0–3.5 is REFERENCE_TARGET §1, which BRAVELY_REFERENCE supersedes and which
 * carries a banner saying so.
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
  headScale: 1.0,   // skull diameter multiplier; 1.0 == Rig.F.headDiameter * height
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
  stance: 1.0,        // knee/ankle spread; the hip socket does not move
});

/**
 * Body-mass silhouette block, consumed by `CharacterFactory.silhouetteOf`.
 *
 * REFERENCE_TARGET §1 makes a distinct black shape at 80 px a hard requirement,
 * and the review found the party failing it on the body: "all six share an
 * identical box torso, straight untapered tube legs and the same egg head; only
 * character 5's long pale hair and character 6's spikes read as distinct
 * shapes. Costume colour, by contrast, does separate them — colour is currently
 * doing all the identification work that silhouette should share."
 *
 * That was literally true. Everything the roster could say about a body was a
 * scalar girth multiplier — `chest`, `hip`, `limb` — and a scalar changes a
 * figure's *area* while leaving its outline the same rectangle. These four
 * numbers change the outline instead:
 *
 *   `hip` / `waist` / `chest`  signed push on three bumps along the trunk, so
 *                              barrel, hourglass, bell and column are different
 *                              shapes rather than different sizes.
 *   `limbTaper`                0 keeps the old near-cylinder; 1 is the full
 *                              chibi taper, just over 2:1 from thigh to ankle.
 *
 * The six below are deliberately spread across the available shape space: no
 * two share a sign pattern, and the two most at risk of colliding (Auren and
 * Kite, both "a vertical line" in costume terms) are given opposite waists.
 */
const BASE_SILHOUETTE = Object.freeze({
  hip: 0, waist: 0, chest: 0, limbTaper: 1,
});

function silhouette(overrides) {
  return Object.freeze({ ...BASE_SILHOUETTE, ...overrides });
}

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
      eye: 0.96, browAngle: -0.10, eyeShape: 'sharp', brow: 'hard', stance: 1.06,
    }),

    // Square-shouldered wedge: chest out, waist and pelvis held in. The only
    // party member whose trunk widens upward, which is what a soldier's coat
    // reads as and the exact inverse of Emrys's bell.
    silhouette: silhouette({ chest: 0.11, waist: -0.05, hip: -0.02 }),

    // **Steel over storm-navy** — the plate's knight, near enough exactly.
    //
    // `bravely01`'s first figure is the clearest single piece of colour
    // evidence in the set: blue-grey plate over a black-navy underlayer, a
    // steel belt plate, and *no* saturated colour anywhere on him. Ours was
    // cobalt #3565E0 (S 0.76) faced with gold #F0B93C (S 0.75) — two accent-
    // level colours occupying most of a figure, which is why he read as a toy
    // knight rather than as armour.
    //
    // Navy at S 0.33 / V 0.34 against steel at S 0.14 / V 0.60 keeps the value
    // break the coat-over-plate stack needs (0.34 against 0.60 is a clean stop
    // and a half) inside one hue family, which reads as tailoring rather than
    // as two garments that do not know each other. The gold survives at spark
    // size: the order device on the breastplate, the buckles, and nothing else.
    palette: Object.freeze({
      skin: 0xd9a882, skinShade: 0x9c6f56,
      hair: 0x4a3d33, hairShade: 0x241f1c,
      // Iris hues are one-per-character and saturated: at closeup the eye is
      // the largest single colour in frame (ANIME_PIPELINE §1).
      eye: 0xefc24a, eyeCore: 0xfff0c4, sclera: 0xf2ede2, lash: 0x14181f,

      identity: 0x3a4457,   // storm-navy arming coat        S 0.33  V 0.34
      secondary: 0x303342,  // charcoal-indigo trousers      S 0.27  V 0.26
      trim: 0xa6b2bd,       // pale steel facings            S 0.12  V 0.74
      accent: 0x848e99,     // plate steel                   S 0.14  V 0.60
      spark: 0xd1a221,      // Skysworn gold: device, buckles  S 0.84  V 0.82

      leather: 0x45382f,    // belt, baldric, boot body
      metal: 0x848e99,
      cape: 0x3a4457, capeLining: 0x614045,
      weaponA: 0xb0b9bf,    // pale moonglass — held to V 0.75 like every other
      weaponB: 0x707880,    // large surface, so the blade cannot out-value the
                            // brightest costume in the party (Seren's bone).
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
      // Long, deep and **narrow**: a rear spur, not a fall. `backDepth` throws
      // the tips back along -Z while `buildHair` holds the drop to 42% of the
      // reach, and `backWidth` at 0.42 keeps the tips inboard so the mass is a
      // spike behind the crown rather than a curtain beside the neck. At the
      // old 0.66 D × 0.86 wide it barely cleared the nape and occupied the same
      // region as Kite's bell — see `auditRoster`'s pair check.
      backCount: 6, backLength: 1.05, backWidth: 0.42, backDepth: 2.40, lean: 0.26,
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

    // The pauldron, the collar and the belt ring moved into `garments` below,
    // where they are built as layered pieces with thickness and rolled edges
    // rather than as a single blob, a tube and a ring. Leaving them here as
    // well would build both.
    accessories: Object.freeze({ pauldron: null, collar: 'none' }),

    /**
     * **Full plate over a storm-coat** — the party's armoured read, and the
     * character modelled most directly on `bravely01.jpg`'s knight.
     *
     * Twelve pieces. Ordered innermost first, which is how the plate's figure
     * is actually assembled: gorget and breastplate against the body, the
     * shoulder stack over them, the belt cluster over that, and the leg armour
     * hung off the fauld.
     *
     * The asymmetric pauldrons — three lames left, two right — are deliberate:
     * asymmetry is the cheapest silhouette identity there is and it survives to
     * eighty pixels, and the plate's knight carries exactly that imbalance.
     */
    garments: Object.freeze([
      // The arming coat under the plate, and the only cloth on him. Its hem
      // hangs a hand's width below the fauld so the figure ends in *cloth with
      // folds* rather than in a plate edge — the plate's knight does the same
      // thing, and it is what stops an armoured silhouette reading as a shell.
      // Eight folds because the panel is short: fold count has to rise as a
      // garment shortens or the creases stretch into lean.
      {
        kind: 'underskirt', color: 'identity', lining: 'secondary', turnColor: 'secondary',
        pipingColor: 'accent', top: 0.10, length: 0.24, flare: 1.55,
        folds: 8, foldDepth: 0.080, foldOnset: 0.06,
      },
      { kind: 'gorget', color: 'accent', rim: 'trim', lining: 'secondary', width: 1.5 },
      {
        kind: 'breastplate', color: 'accent', rim: 'trim', lining: 'secondary',
        // The Skysworn keep-and-wings device, embossed. Hexes track the palette
        // above: a darkened navy ground under the order's gold, which is the
        // one place on this character the spark is allowed an area at all.
        pattern: {
          id: 'heraldic', base: 0x333c4d, accent: 0xd1a221, ink: 0x1b1e29,
          wrap: 'clamp', size: 256,
        },
      },
      { kind: 'pauldron', side: 'L', lames: 3, color: 'accent', rim: 'trim', lining: 'secondary', spread: 2.05 },
      { kind: 'pauldron', side: 'R', lames: 2, color: 'accent', rim: 'trim', lining: 'secondary', spread: 1.78 },
      // Baldric over the breastplate: 0.055 H wide (≈7 cm) so the band has two
      // shadowed edges and a lit face at capture scale, with a gold box buckle
      // on the chest and three keeper loops down the run.
      {
        kind: 'strap', side: 'L', color: 'leather', buckle: 'spark',
        width: 0.055, loops: 3, over: 0.62, buckleAt: 0.40,
      },
      { kind: 'belt', color: 'leather', buckle: 'spark', width: 0.044, over: 0.52 },
      { kind: 'pouch', side: 'R', at: 'hip', color: 'leather', flap: 'secondary', buckle: 'spark', size: 0.044 },
      { kind: 'fauld', color: 'accent', rim: 'trim', lining: 'secondary', drop: 0.24 },
      { kind: 'cuisse', color: 'accent', rim: 'trim', lining: 'secondary' },
      { kind: 'vambrace', color: 'accent', rim: 'trim', lining: 'secondary', studs: 3, studColor: 'spark' },
      { kind: 'greave', color: 'accent', rim: 'trim', kneeColor: 'leather' },
      {
        kind: 'boot', color: 'leather', cuff: 'identity', cuffLining: 'secondary',
        sole: 'secondary', toeCap: true, toeCapColor: 'accent',
        eyelets: 4, lace: 'trim', shaft: 0.095,
      },
    ]),

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
      // The shortest frame in the party, and the one whose hair reaches
      // furthest from the skull — so `auditRoster` measures her silhouette head
      // mass, hair included, against BRAVELY §1's 4.0–4.5 band rather than the
      // skull alone. She lands at 4.32.
      height: 1.06, headScale: 1.00, shoulder: 0.87, chest: 0.92, hip: 0.96,
      limb: 0.90, foot: 0.78,
      eye: 1.12, eyeSpacing: 1.03, browAngle: 0.14, eyeShape: 'round', brow: 'gentle',
      // Feet together under a floor-length robe: a closed base is half of what
      // makes a standing oracle read as a candle flame rather than as a figure.
      stance: 0.78,
    }),

    // A narrow column that flares at the hem — the robe does the widening, not
    // the body. Her legs keep a softer taper because they are bare and the
    // hemline is where her outline actually changes.
    silhouette: silhouette({ chest: -0.07, waist: -0.01, hip: 0.13, limbTaper: 0.75 }),

    // **Bone over ink** — `bravely01`'s second figure, whose construction this
    // costume already copied and whose colour it did not.
    //
    // That figure is a *white* character: white beret, white sailor collar,
    // black bodice, a dark printed skirt, black tights, and one small scarlet
    // ribbon at the throat. Ours was hot rose #CF5077 (S 0.61) over saturated
    // teal #2FA89E (S 0.72), which is two accent colours filling the whole
    // silhouette; in `shots/mp0-cast` she is the single loudest thing in frame
    // and she is standing in front of a flower bed.
    //
    // The dominant is therefore bone and the *skirt* carries the dark mass, the
    // way the plate does it — a bright torso over a dark hem is what makes a
    // small figure read as a robe rather than as a cone. The rose survives as
    // `spark`, on the throat ribbon, the beret pompom and the blossoms inside
    // the skirt's embroidery: three small pieces, exactly the plate's budget.
    // Her element keeps a place in the underskirt's weave, at slate strength.
    palette: Object.freeze({
      skin: 0xe8d3c4, skinShade: 0xab8b83,
      hair: 0xece6da, hairShade: 0x9aa6a8,
      eye: 0x4fc8be, eyeCore: 0xd8fbf6, sclera: 0xf6f2ea, lash: 0x263038,

      identity: 0xbfbaac,   // bone robe, collar and beret   S 0.10  V 0.75
      secondary: 0x323747,  // ink-navy skirt and bodice     S 0.30  V 0.28
      trim: 0x697880,       // dove-slate piping and hem     S 0.18  V 0.50
      accent: 0xa3977f,     // old gold thread               S 0.22  V 0.64
      spark: 0xb82538,      // crimson ribbon and pompom     S 0.80  V 0.72

      leather: 0x665849,
      metal: 0xa3977f,
      cape: 0xbfbaac, capeLining: 0x323747,
      weaponA: 0xb8b1a5,
      weaponB: 0x8c7f68,
      glow: 0x5fb8b0,
    }),

    // Mass class: **low twin-tails**. The widest outline in the party at
    // mid-height and one of the emptiest above the skull.
    //
    // She used to carry a `sheet` — a fan rooted at the crown, hung down the
    // back. That is the same mass in the same place as Bramm's crop and Emrys's
    // splayed starburst, the two characters staged either side of her, and the
    // review read all three as "an identical pale grey-blue lampshade cap with
    // two flared side lobes". Distinctiveness is where the volume *is*, so hers
    // moved sideways and down: a flat crown, a short blunt nape fall, and two
    // heavy bound tails thrown out past the shoulder line.
    //
    // WORLD_BIBLE §3.2's "pale drifting mass twice the width of her body" is
    // unchanged — `backWidth` still makes this the widest hair on the stage —
    // and the tails are what the cloth solver drives (ART_BIBLE §7.9).
    hair: Object.freeze({
      style: 'twintail',
      capScale: 1.12, capDrop: 0.62,
      fringe: 3, fringeLength: 0.34, fringeSweep: 0.10, fringeSpread: 1.45, part: 0.10,
      // Four clumps per tail: enough that the tail has internal form at closeup
      // and still fuses into one mass at 80 px.
      backCount: 4, backLength: 1.05, backWidth: 1.55, backFlare: 1.20,
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

    // The wrap collar is now a `collar` garment with a broad sailor cut; the
    // bare feet and anklets stay here because they change how the *body* is
    // built (skin rather than cloth below the knee) and are not garments.
    accessories: Object.freeze({ pauldron: null, collar: 'none', barefoot: true, anklet: true }),

    /**
     * **Layered skirts under a broad flat collar** — the hat-mage's
     * construction from `bravely01.jpg`, in her palette rather than that
     * figure's.
     *
     * Nine pieces. The two skirts are the load-bearing pair: a printed rose
     * outer at the measured 0.40 H length and 2.9:1 flare, and a longer, plainer
     * iridescent teal under it. A second hem line below the first doubles the
     * number of horizontal edges at the bottom of the silhouette, which is where
     * the eye lands at battle distance and where a single cone reads as a lamp
     * shade.
     */
    garments: Object.freeze([
      {
        kind: 'underskirt', color: 'identity', lining: 'trim', turnColor: 'trim',
        pipingColor: 'trim',
        // Six folds on the petticoat against eight on the skirt over it: the
        // two layers must not share a rhythm or their hems lock into one edge.
        length: 0.48, flare: 1.72, folds: 6, foldDepth: 0.055,
        // Aurora silk: the archer's iridescent weave, run through her own hues
        // so the shift reads as dawn rather than as the plate's green.
        //
        // **This is the piece that shipped the magenta/white checkerboard**, and
        // both halves of the cause are in this block. `repeat: [3, 1]` was
        // multiplied again by `skirt`'s own private UV scale of 3, giving nine
        // tiles round the petticoat in u against one in v — a 9:1 shear that
        // turns a square weave into a fine vertical grating (see
        // `Garments.resolveRepeat`, which now makes this the only tiling
        // control there is). And the old four-stop ramp put rose straight next
        // to ivory, so the grating alternated saturated magenta with near-white
        // — the exact colour pair of an engine's missing-texture placeholder.
        //
        // Two tiles, and a five-stop ramp. The ramp was teal → ivory → rose at
        // accent saturation; it now walks ink-navy → slate → bone → dusty rose
        // and back, all inside the base band, so the shift still reads as a
        // shot silk without putting a saturated colour on a whole petticoat.
        pattern: {
          id: 'iridescent', base: 0x323747,
          ramp: [0x323747, 0x5e6c75, 0xb8b3a7, 0x855d62, 0x323747],
          size: 256, repeat: [2, 1],
        },
      },
      {
        kind: 'skirt', color: 'secondary', lining: 'trim', turnColor: 'trim',
        pipingColor: 'trim',
        length: 0.40, flare: 2.15, folds: 8, foldDepth: 0.082,
        // Rose-and-vine, banded to the lower 55% exactly as the staff-mage's
        // coat bands its embroidery.
        //
        // `floral` draws three blossom columns per tile, so four tiles is twelve
        // round the skirt and six across the panel the camera sees — which is
        // the count measured on the plate. The blossoms are the `spark`: line
        // work on a dark ground is precisely where the plate spends saturation.
        pattern: {
          id: 'floral', base: 0x323747, ink: 0x1d212b, accent: 0xb82538,
          bandV: 0.55, size: 256, repeat: [4, 1],
        },
      },
      { kind: 'sash', color: 'secondary', piping: 'spark', width: 0.080, knotSide: 'L' },
      { kind: 'hood', color: 'identity', lining: 'secondary', piping: 'trim', wrap: 0.60 },
      { kind: 'collar', cut: 'sailor', color: 'identity', lining: 'secondary', piping: 'trim', drop: 0.082, width: 1.06 },
      // The one saturated object on her, and the plate puts it in exactly this
      // place: a small scarlet tie at the throat of a white collar.
      { kind: 'ribbon', color: 'spark', tail: 0.060 },
      { kind: 'cuff', color: 'identity', lining: 'secondary', rolls: 1, flare: 0.30 },
      {
        kind: 'hatSoft', color: 'identity', band: 'trim', lining: 'secondary',
        // 2.05 head widths — the beret measured off the plate is 2.1.
        width: 2.05, rise: 0.55, pompomColor: 'spark',
      },
      // Book satchel across the bodice. Narrower than a fighter's baldric but
      // still a band rather than a thread, so the white torso is broken.
      { kind: 'strap', side: 'R', color: 'secondary', buckle: 'accent', width: 0.038, loops: 3, over: 0.58 },
    ]),

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
      height: 1.13, headScale: 1.04, legLength: 0.84, shoulder: 1.26, chest: 1.34,
      hip: 1.28, limb: 1.26, arm: 0.94, hand: 1.18, foot: 1.20,
      eye: 0.84, browAngle: -0.26, eyeShape: 'narrow', brow: 'hard',
      // "bowed legs", made literal: the hips stay put and the ankles swing wide,
      // so the gap between his legs is a shape nobody else in the party has.
      stance: 1.34,
    }),

    // The keg. The only trunk whose *waist* is its widest ring — everyone else
    // pinches there — so his outline is a barrel rather than a figure, which is
    // the strongest single silhouette in the party and costs one number.
    silhouette: silhouette({ chest: 0.12, waist: 0.21, hip: 0.15, limbTaper: 1.15 }),

    // **Waxed canvas over iron.** The warmest large mass in the party, and the
    // only *mid-value* dominant — he is the value rung between Auren's dark
    // navy and Seren's bone, which is how a lineup of six low-saturation
    // costumes stays legible.
    //
    // `identity` was #B87020 (S 0.89): a saturated orange apron on a barrel of
    // a man, and in `shots/mp0-cast` he is the second loudest figure on stage.
    // A smith's apron is oiled canvas — warm, dull, and lighter than everything
    // around it — so it drops to S 0.34 / V 0.52 and the heat moves to `spark`,
    // where it belongs: the brass scrollwork chased into the hanging tabs, the
    // buckle tongues and the tool rivets. Forge orange is the right colour for
    // three square centimetres of a costume and the wrong one for half of it.
    //
    // The hair stays dark iron: Seren and Emrys are staged either side of him
    // and the trio needs a value ladder rather than three pale hairpieces.
    palette: Object.freeze({
      skin: 0xc08a63, skinShade: 0x855239,
      hair: 0x4f4a45, hairShade: 0x241f1c,
      eye: 0x86b23c, eyeCore: 0xdff0a8, sclera: 0xeee7dc, lash: 0x1b1f24,

      identity: 0x857258,   // waxed canvas apron            S 0.34  V 0.52
      secondary: 0x333b45,  // iron work clothes             S 0.26  V 0.27
      trim: 0x573b3a,       // oxblood straps and cuffs      S 0.33  V 0.34
      accent: 0x948562,     // dull brass and the prosthetic S 0.34  V 0.58
      spark: 0xdb611a,      // forge ember: chasing, rivets  S 0.88  V 0.86

      leather: 0x4a3d34,
      metal: 0x948562,
      cape: 0x857258, capeLining: 0x573b3a,
      weaponA: 0x8c8062,
      weaponB: 0x4e5661,
      glow: 0xff6b2b,
    }),

    // Mass class: **beard**. Almost nothing above the chin; the volume is below
    // it. Inverting where the head mass sits relative to everyone else is the
    // strongest silhouette trick available at this size, and it costs nothing.
    hair: Object.freeze({
      // `capScale` cut from 1.16 to 1.12 — the tightest crown in the party.
      // A hair shell is a radial offset of the skull, so `capScale` *is* crown
      // height, and at 1.16 his was the tallest of anyone without a style mass
      // on top: a dome. The crop clumps now bed flat against it for their whole
      // length and stop on the hairline, so nothing above his chin projects at
      // all and the contrast against Emrys's raked spikes two slots along is a
      // full head-radius.
      style: 'beard',
      capScale: 1.12, capDrop: 0.28,
      fringe: 3, fringeLength: 0.20, fringeSweep: 0.30, fringeSpread: 0.95, part: 0.14,
      backLength: 0.34, backWidth: 0.8,
      // Head diameters, like every other hair length. At the old 0.50 of *body*
      // height this was three and a half head-radii of mass whose top edge
      // closed over his eyes — the review's "blank oval with a single dot".
      //
      // Longer and **narrower** than it was: a converging wedge on the
      // centreline. A wide beard occupies the jaw ring, which is where Kite's
      // bell closes, and the two scored 0.44 against each other; a narrow one
      // is a shape only he has. It reaches the middle of the chest, the read
      // WORLD_BIBLE §3.3 asks for and the one that inverts his head mass
      // against everyone else's.
      beardLength: 1.40, beardWidth: 1.05, beardFork: 0.20,
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

    accessories: Object.freeze({ pauldron: null, collar: 'none', bareShoulder: 'L', prosthetic: 'R' }),

    /**
     * **A forge apron over work iron, hung with tools.**
     *
     * Eleven pieces, and the one costume in the party whose layering is *heavy*
     * rather than tailored: a stiff bib apron, a fan of five hanging leather
     * tabs off the belt, a buckle a third wider than anyone else's, and two
     * pouches at different heights so the hip line is broken twice.
     *
     * The bare left shoulder is why the single pauldron is on the right — it is
     * a brace over the prosthetic arm, not a matched pair, and the imbalance is
     * the same silhouette trick Auren's lame count uses.
     */
    garments: Object.freeze([
      {
        kind: 'apron', color: 'identity', lining: 'leather', binding: 'trim',
        bib: 0.30, skirt: 0.66, drop: 0.24, top: 0.72, strapColor: 'leather',
        // Four deep folds, and they start below the belt: the bib is pulled
        // flat by the neck strap and only the skirt of an apron gathers.
        folds: 4, foldDepth: 0.075, foldOnset: 0.44,
        turnColor: 'leather',
        // A forge sett: warm bands crossed over iron, coarse enough to read.
        pattern: {
          id: 'tartan', base: 0x857258, ink: 0x332922, accent: 0x948562,
          size: 256, repeat: [2, 3],
        },
      },
      {
        kind: 'fauld', tabs: 5, color: 'trim', rim: 'accent', lining: 'leather',
        drop: 0.20, wrap: 0.80, material: 'leather',
        // Brass scrollwork chased into the oxblood tabs — the ninja's gold
        // filigree harness, at a smith's scale. Line work, so it takes the
        // spark: this is the one place his ember colour has any area at all.
        pattern: { id: 'arabesque', base: 0x573b3a, accent: 0xdb611a, size: 256, repeat: [1, 2] },
      },
      { kind: 'belt', color: 'leather', buckle: 'spark', width: 0.050, buckleWidth: 0.098, buckleHeight: 0.062, over: 0.55 },
      { kind: 'pouch', side: 'L', at: 'hip', size: 0.052, color: 'leather', flap: 'trim', buckle: 'accent' },
      { kind: 'pouch', side: 'R', at: 'hip', size: 0.038, angle: 0.66, drop: 0.070, color: 'leather', flap: 'trim', buckle: 'accent' },
      // Tool bandolier over the bib, in oxblood against the pale canvas: the
      // strongest value break available on this character, so it is the piece
      // doing the work of saying "assembled" that his colour used to do.
      {
        kind: 'strap', side: 'R', color: 'trim', buckle: 'spark',
        width: 0.058, loops: 3, over: 0.66, buckleAt: 0.38,
      },
      { kind: 'pauldron', side: 'R', lames: 2, color: 'accent', rim: 'trim', lining: 'leather', spread: 1.95 },
      { kind: 'vambrace', side: 'L', material: 'leather', color: 'leather', rim: 'accent', lining: 'secondary', studs: 4, studColor: 'spark' },
      { kind: 'greave', color: 'secondary', rim: 'accent', kneeColor: 'trim' },
      {
        kind: 'boot', color: 'leather', cuff: 'trim', cuffLining: 'secondary', sole: 'secondary',
        toeCap: true, toeCapColor: 'accent', eyelets: 5, lace: 'accent', shaft: 0.085, cuffFlare: 0.26,
      },
      { kind: 'scarf', color: 'trim', tail: 0.18, side: 'R' },
    ]),

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
      eye: 1.0, browAngle: -0.16, eyeShape: 'sharp', brow: 'hard', stance: 1.14,
    }),

    // Hourglass, cut hard at the waist: the deepest pinch in the party against
    // a flared belt line. Auren is the figure she is most likely to collide
    // with as a black shape, and his waist is held straight — so the two
    // separate on the one contour they share.
    silhouette: silhouette({ chest: 0.01, waist: -0.14, hip: 0.08, limbTaper: 1.1 }),

    // **Wine over slate**, with the sister's red kept as a signal.
    //
    // The coat was #D93A28 — a fire-engine red covering most of a figure — on
    // the argument that the fastest character should carry the loudest colour.
    // The plate's third figure is the counter-example and it is the closest
    // analogue in the set: a full-length coat in a deep, dull wine, whose only
    // saturated pixels are the rose embroidery on its lower panels. Dulled to
    // S 0.34 / V 0.37 the coat is still unmistakably *the red character* in a
    // party of navy, bone, canvas, mauve and forest — the hue does that work,
    // and hue survives the fog lerp better on a dark ground than chroma does.
    //
    // The sister's scarlet is now the `spark`: the sash piping, the boot laces
    // and the buckles. Four pixels wide, which is what it was to begin with.
    palette: Object.freeze({
      skin: 0x8a5a44, skinShade: 0x53321f,
      hair: 0x1f2830, hairShade: 0x0e151b,
      eye: 0x3fa9f5, eyeCore: 0xa8e4ff, sclera: 0xf0ece2, lash: 0x0d1116,

      identity: 0x5e3e43,   // wine stormcoat                S 0.34  V 0.37
      secondary: 0x37434f,  // sea-slate trousers            S 0.30  V 0.31
      trim: 0xb3aa9a,       // bleached rope                 S 0.14  V 0.70
      accent: 0x828c94,     // steel                         S 0.12  V 0.58
      spark: 0xc73a24,      // the sister's red              S 0.82  V 0.78

      leather: 0x373640,    // near-black tarred hide and the fur ruff
      metal: 0x828c94,
      cape: 0x5e3e43, capeLining: 0xb3aa9a,
      weaponA: 0x87a8a8,    // keel-glass chakram
      weaponB: 0x999284,
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
      //
      // Wider and shorter than it was. The bob's identity is mass *at the jaw*,
      // and length past that point is mass behind the neck, which is where
      // Auren's wedge and Bramm's beard live. `backWidth` at 2.05 is read
      // against the head's equator (see `buildHair`), so it builds a bell
      // genuinely wider than the skull rather than scaling a narrow root ring.
      backCount: 8, backLength: 0.50, backWidth: 2.05, braidWidth: 0.50,
      lean: 0.46, cutAngle: 0.80,
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

    accessories: Object.freeze({ pauldron: null, collar: 'none', bootBlade: 'L' }),

    /**
     * **A cut-down stormcoat over a net-hung hip.**
     *
     * Twelve pieces. The coat here is deliberately the *fitted* half only — hem
     * at 0.30 H, so it stops at mid-thigh — because her `cape` block already
     * hands the swinging tails to the cloth solver, and a stiff shell and a
     * simulated panel occupying the same volume fight. That division of labour
     * is the pattern for every coat in this roster: `garments` builds what is
     * tailored to the body, `Cloth` builds what moves.
     *
     * The net over her right hip is the one garment in the party that adds
     * *holes* to a silhouette, which is why she is the character who gets it —
     * she is the one who has to be findable while crossing the stage.
     */
    garments: Object.freeze([
      {
        kind: 'longcoat', color: 'identity', lining: 'trim', piping: 'trim',
        top: 0.55, hem: 0.30, flare: 2.0, gap: 0.24, buttons: 5,
        // A short coat over a fitted hip: eight shallow folds rather than the
        // seven a full-length panel takes, because the drape has less length to
        // develop in and the creases have to be closer together to read.
        folds: 8, foldDepth: 0.058, foldOnset: 0.26, turnColor: 'trim',
        // Wave damask in a darker wine with bleached-rope highlights.
        pattern: { id: 'damask', base: 0x5e3e43, ink: 0x342326, accent: 0xb3aa9a, size: 256, repeat: [3, 1] },
      },
      { kind: 'lapel', color: 'trim', lining: 'identity', width: 0.40, fold: 0.20 },
      { kind: 'collar', cut: 'popped', color: 'identity', lining: 'trim', piping: 'trim', height: 1.3 },
      // **The fur ruff**, and the reason she is the character who gets one: she
      // is staged in near-profile and a broken outline at the shoulder is the
      // only thing that reads as costume from that angle. Twenty-six clumps in
      // two interleaved rows, tarred-hide black shading to rope — the archer's
      // black ruff in `bravely01` and the ninja's collar in `bravely05`.
      {
        kind: 'furCollar', color: 'leather', shade: 'secondary',
        tufts: 26, rows: 2, length: 0.068, clump: 0.032,
        radius: 1.62, liftBack: 0.60, liftFront: -0.22,
      },
      {
        kind: 'sash', color: 'secondary', piping: 'spark', width: 0.070, knotSide: 'R',
        // Key-fret woven into the wrap, bone on sea-slate. Three tiles, not six:
        // `sash` used to multiply by a further four, so this was twenty-four
        // tiles of a five-cell fret — a hundred and twenty cells round a band
        // 0.07 H tall, which resolves to noise at any capture distance.
        pattern: { id: 'lattice', base: 0x37434f, ink: 0xb3aa9a, size: 256, repeat: [3, 1] },
      },
      { kind: 'belt', at: 'hip', color: 'leather', buckle: 'spark', width: 0.042, tailSide: 'R', over: 0.52 },
      {
        kind: 'strap', side: 'L', color: 'leather', buckle: 'spark',
        width: 0.050, loops: 3, over: 0.62, buckleAt: 0.44,
      },
      { kind: 'pouch', side: 'L', at: 'hip', size: 0.042, color: 'leather', flap: 'trim', buckle: 'accent' },
      {
        // Four cells rather than five: the net is the most triangle-hungry
        // piece per pixel in the wardrobe and the fold and fur geometry added
        // to this character has to be paid for somewhere.
        kind: 'fishnet', color: 'trim', top: 0.02, length: 0.30, flare: 1.9,
        wrap: 0.42, turn: -1.15, cells: 4, scallops: 3, scallopDepth: 0.26,
      },
      { kind: 'cuff', side: 'R', color: 'trim', lining: 'identity', rolls: 2, flare: 0.30 },
      { kind: 'vambrace', side: 'L', color: 'accent', rim: 'trim', lining: 'leather' },
      {
        kind: 'hatBrim', side: 'L', color: 'leather', band: 'identity', buckle: 'accent',
        tilt: 0.40, brim: 1.60, crown: 0.90, height: 0.50,
      },
      {
        kind: 'boot', color: 'leather', cuff: 'trim', cuffLining: 'secondary', sole: 'secondary',
        eyelets: 5, lace: 'spark', shaft: 0.120, cuffFlare: 0.30,
      },
    ]),

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
      // Head at 0.94 rather than 1.00. BRAVELY §1 measures the head *mass* —
      // hair shell and style included — against its 4.0–4.5 heads band, so the
      // crown budget every character has above the bare skull is only about a
      // third of a head radius. A starburst is the one style that wants to
      // spend it, and shrinking the skull under it is what buys the room: he
      // lands at 4.29 with the tallest crown in the party. The child read is
      // carried by the 1.16 eye multiplier and by the coat that swamps him,
      // which are the two channels that survive to 80 px anyway.
      height: 1.00, headScale: 0.94, legLength: 0.94, shoulder: 0.83, chest: 0.88,
      hip: 0.90, limb: 0.85, arm: 0.92, hand: 0.92, foot: 0.94,
      eye: 1.16, eyeSpacing: 1.05, browAngle: 0.06, eyeShape: 'round', brow: 'gentle',
      stance: 0.86,
    }),

    // A bell with a child on top: narrow at the shoulders, widening all the way
    // to the hem. The coat is an adult's and does not fit, and that is a *body*
    // outline decision as much as a costume one.
    silhouette: silhouette({ chest: -0.11, waist: 0.05, hip: 0.19, limbTaper: 0.9 }),

    // **Faded mauve with an ember thread.** The coat is an adult's and swamps
    // him, so it is nearly his whole silhouette — which makes it the one
    // costume in the party that has to carry identity on its own.
    //
    // #7440CC (S 0.69) did that by shouting, and the ember trim at #FF6B2B
    // (S 0.83) lined the cuffs, collar, lapels and scarf, so a fourteen-year-old
    // in a hand-me-down was wearing the two most saturated colours on stage.
    // A hand-me-down is *faded*: S 0.30 / V 0.48 keeps it unambiguously violet
    // — it is 65° off Auren's navy and a full value stop lighter — while
    // reading as cloth that has been through three owners, which is the
    // character note the hue was never carrying anyway.
    //
    // The ember goes where the plate's wine-coat mage puts his red: into the
    // rose-and-vine embroidery banded across the bottom third of the panels,
    // as line work. The lining and cuffs take a dusty ember instead, which is
    // the same colour after the same three owners.
    //
    // The hair stays auburn but drops to S 0.55 — a natural chestnut rather
    // than a dyed one — because at S 0.70 it was competing with the coat.
    palette: Object.freeze({
      skin: 0xe0b394, skinShade: 0xa06f56,
      hair: 0x805139, hairShade: 0x3d2519,
      eye: 0xff6b2b, eyeCore: 0xffd08a, sclera: 0xf4efe4, lash: 0x191418,

      identity: 0x71567a,   // inherited mauve scholar's coat S 0.30  V 0.48
      secondary: 0x413345,  // deep plum under-tunic          S 0.26  V 0.27
      trim: 0x8f7661,       // dusty-ember lining and cuffs   S 0.32  V 0.56
      accent: 0x85765a,     // worn brass buckles             S 0.32  V 0.52
      spark: 0xe6581c,      // live ember: embroidery, laces  S 0.88  V 0.90

      leather: 0x423a31,
      metal: 0x85765a,
      cape: 0x71567a, capeLining: 0x8f7661,
      weaponA: 0x706453,
      weaponB: 0xa89f8a,
      glow: 0xff6b2b,
    }),

    // Mass class: **forward-raked spikes** — the tallest crown in the party.
    //
    // The starburst used to be splayed (`spikeSpread` 1.55 against a vertical
    // component scaled to 0.30), which builds a *disc* of spikes at ear height.
    // From the fixed side-view stage a disc has the outline of a cap with two
    // side lobes, which is why this landed in the same bucket as Bramm's crop
    // and Seren's curtain. Narrowing the splay and raking the whole crown
    // forward trades that width for height and for a wedge pointing over the
    // brow — the one silhouette a low wide shape cannot be confused with, and
    // it stays inside REFERENCE §1's heads-tall band because `buildHair`
    // clamps every spine against the crown ceiling.
    hair: Object.freeze({
      style: 'spike',
      capScale: 1.12, capDrop: 0.42,
      fringe: 3, fringeLength: 0.30, fringeSweep: 0.20, fringeSpread: 1.2, part: 0.12,
      spikes: 9, spikeLength: 0.92, spikeSpread: 0.78, spikeRake: 0.90, spikeRise: 0.30, spikeJitter: 0.35,
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
    // `rolledSleeves` and `satchel` are now `cuff` and `pouch` garments — the
    // accessory versions were a stack of plain rings and a leather lozenge with
    // no edge on either.
    accessories: Object.freeze({ pauldron: null, collar: 'none' }),

    /**
     * **An adult's coat on a fourteen-year-old**, and the closest thing in this
     * roster to `bravely01.jpg`'s staff-mage, which is the best coat evidence
     * in the plate set.
     *
     * Nine pieces, and the coat is most of the silhouette: ankle length, notched
     * lapels lined in ember, six buttons down the placket, a triple-turned cuff
     * because the sleeves are far too long, and rose-and-vine embroidery banded
     * to the bottom third of the panels — the plate's proportion, measured at
     * 32%.
     */
    garments: Object.freeze([
      {
        kind: 'longcoat', color: 'identity', lining: 'trim', piping: 'trim',
        top: 0.60, hem: 0.055, flare: 2.5, gap: 0.19, buttons: 6, hang: 1.05,
        buttonSpan: 0.40,
        // The deepest drape in the party, and it should be: this is the longest
        // panel on the smallest frame, so it has the most length to gather in.
        // Seven folds is the count measured across the staff-mage's coat in
        // `bravely01`, and the field starts high — under the arm, where a coat
        // that does not fit its wearer actually breaks.
        folds: 7, foldDepth: 0.078, foldOnset: 0.16, turnColor: 'secondary',
        pattern: {
          id: 'floral', base: 0x71567a, ink: 0x302333, accent: 0xe6581c,
          bandV: 0.34, size: 256, repeat: [2, 1],
        },
      },
      { kind: 'lapel', color: 'trim', lining: 'identity', width: 0.46, fold: 0.22, top: 0.95, bottom: -0.70 },
      { kind: 'collar', cut: 'oversized', color: 'identity', lining: 'trim', piping: 'trim' },
      // Fur trim round the collar of the too-big coat, exactly as `bravely05`
      // trims the ninja's cape: one row of eighteen short clumps, dusty ember
      // shading into the leather, so the neckline of a garment three sizes too
      // large has a broken edge instead of a clean one.
      {
        kind: 'furCollar', color: 'trim', shade: 'leather',
        tufts: 18, rows: 1, length: 0.050, clump: 0.026,
        radius: 1.48, liftBack: 0.48, liftFront: -0.20,
      },
      // Rolled three times, each turn a fifth of the forearm apart. The roster
      // used to ask for six rolls of nothing; three that each have a lip and a
      // flare read as more than six that do not.
      { kind: 'cuff', color: 'trim', lining: 'identity', rolls: 3, flare: 0.34, at: 0.80, pitch: 0.18 },
      { kind: 'belt', color: 'leather', buckle: 'accent', width: 0.040, raise: 0.010, over: 0.50 },
      { kind: 'pouch', side: 'L', at: 'hip', size: 0.055, color: 'leather', flap: 'secondary', buckle: 'accent' },
      // Grimoire strap. Narrow for a strap because he is the smallest frame in
      // the party, but still a band — 0.042 H is about 4.9 cm on him.
      {
        kind: 'strap', side: 'R', color: 'leather', buckle: 'accent',
        width: 0.042, loops: 2, over: 0.60, buckleAt: 0.46,
      },
      { kind: 'scarf', color: 'trim', tail: 0.20, side: 'L' },
      {
        kind: 'boot', color: 'leather', cuff: 'trim', cuffLining: 'secondary', sole: 'secondary',
        eyelets: 4, lace: 'spark', shaft: 0.085, cuffFlare: 0.28,
      },
    ]),

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
      eye: 0.98, browAngle: 0.0, eyeShape: 'almond', brow: 'level', stance: 0.94,
    }),

    // A long lean column with almost no shaping at all — the tallest frame in
    // the party reading as a single vertical, which is what a dragoon standing
    // beside a spear should be. Deliberately the *flattest* silhouette block in
    // the roster: with five shaped trunks around her, "unshaped" is itself a
    // distinguishable shape, and her legs carry the hardest taper because they
    // are bare below a short mantle and are most of her outline.
    silhouette: silhouette({ chest: -0.05, waist: -0.03, hip: -0.05, limbTaper: 1.2 }),

    // **Forest and bone.** The party's only green and the only cool costume
    // that is not blue, sitting a clean 70° off Auren on the wheel. Bone plate
    // on a dark forest wrap is the highest-*value*-contrast pairing in the
    // roster, which is what a mostly-bare-legged silhouette needs.
    //
    // The previous note argued saturation up to 0.67 on the grounds that a
    // desaturated mid-green fogs to tan. It does — but the answer is value, not
    // chroma: at S 0.34 / V 0.40 the mantle is *darker* than the meadow behind
    // it rather than greener than it, and dark-against-light survives a fog
    // lerp that eats chroma for a living. A saturated green party member
    // standing in a green meadow was the worst version of this problem, and
    // that is what `shots/mp0-cast/cast-stage.png` shows.
    palette: Object.freeze({
      skin: 0x9c6a55, skinShade: 0x5d3a2f,
      hair: 0x3a2f3f, hairShade: 0x1d1823,
      eye: 0x8fe6a0, eyeCore: 0xe6ffee, sclera: 0xefe9e0, lash: 0x14121a,

      identity: 0x436655,   // forest feather-mantle and wrap S 0.34  V 0.40
      secondary: 0x2e423a,  // deep moss underwrap            S 0.30  V 0.26
      trim: 0xb8b2a2,       // bone plate                     S 0.12  V 0.72
      accent: 0x704f4a,     // dulled ember-fleck bindings    S 0.34  V 0.44
      spark: 0xbd291e,      // live ember: binding ties       S 0.84  V 0.74

      leather: 0x4a3e38,
      metal: 0xb8b2a2,
      cape: 0x436655, capeLining: 0xb8b2a2,
      weaponA: 0xb3ada1,    // rib-bone lance
      weaponB: 0x7a7569,
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
      //
      // `topknot` is long — 0.95 head diameters — because the column spends it
      // going **backwards**, not upwards. Vertical extent is the one thing on a
      // head that BRAVELY §1's 4.0–4.5 band charges for; horizontal projection
      // is free, and a long backward diagonal off a high bind is a shape no
      // other style in the roster owns.
      backCount: 6, topknot: 0.95, topknotWidth: 0.34,
      braidLength: 2.40, braidWidth: 0.11, braidSegments: 6,
      backLength: 0.40, backWidth: 0.85, backDepth: 0.55,
      boneCount: 5, boneStiffness: 0.5,
    }),

    // "a spear standing in a cloak", raked across the body on a hard diagonal.
    //
    // `tilt` is a rotation about **X**, so the old 1.42 rad laid the shaft along
    // +Z — straight down the barrel of the fixed side-view camera, where a 1.3 m
    // lance foreshortens to a stub and the one horizontal in the party
    // disappears. `roll` is the rotation about Z, which is the axis that swings
    // the shaft across the frame, so the diagonal has to be authored there.
    //
    // 0.45 rad rather than a full 90°: a truly horizontal yoke spans ±0.65 m,
    // and the staged party sits 0.49 m apart, so a horizontal lance drives its
    // blade through a neighbour's head. A 26° rake holds the lateral span inside
    // ±0.29 m — comfortably within the gap — while still cutting a diagonal
    // through her whole silhouette, and nobody else in the party owns one.
    weapon: Object.freeze({
      kind: 'lance', mount: 'handR',
      length: 1.05, width: 0.030, thickness: 0.030,
      headLength: 0.24, headWidth: 0.085, ribs: 5,
      tilt: 0.20, roll: 0.45,
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
      // Six broad plates, not eleven quills. `buildAccessories` halves this
      // count and more than doubles the width, because silhouette value at 80 px
      // is carried by mass and a row of thin blades reads as cutlery — see the
      // rebuild note there.
      feathers: 11, featherLength: 0.22,
    }),

    // The feather collar moved to a `furCollar` garment in `feather` mode: the
    // accessory version fanned flat plates off the chest ring, and what the
    // plates actually show is a ruff with a *broken* outline at every scale.
    accessories: Object.freeze({ pauldron: null, collar: 'none', tattoo: true }),

    /**
     * **Bone plate and feathers over a short wrap** — the only costume in the
     * party built around bare legs, and therefore the only one whose lower half
     * has to be carried by bindings rather than by cloth.
     *
     * Ten pieces. The feather ruff is the one that matters most: `furCollar` in
     * `feather` mode gives it the irregular tufted silhouette the archer's and
     * the ninja's fur carry in the plates, which is the read the old fan of
     * eleven identical quills could not reach at any count.
     */
    garments: Object.freeze([
      {
        kind: 'furCollar', mode: 'feather', color: 'trim', shade: 'identity',
        tufts: 16, rows: 1, length: 0.070, radius: 1.70, arc: 0.86, liftBack: 0.45, liftFront: -0.25,
      },
      {
        kind: 'breastplate', color: 'trim', rim: 'identity', lining: 'secondary',
        top: 0.80, bottom: 0.10, wrap: 0.58, thickness: 0.013,
        // A rib-plate scored with quill rows — her lance is rib-bone and so is
        // this, and the motif is what tells you so at closeup.
        pattern: {
          id: 'feather', base: 0xb8b2a2, ink: 0x706c5e, accent: 0x436655,
          wrap: 'clamp', size: 256,
        },
      },
      { kind: 'pauldron', side: 'L', lames: 2, color: 'trim', rim: 'identity', lining: 'secondary', spread: 1.75 },
      // A short wrap over a longer underwrap: the two hems are close together,
      // so they are given different fold counts and depths or they read as one
      // thick edge. Nine folds on a 0.26 H skirt is tight, which is what a wrap
      // gathered at the hip actually does.
      {
        kind: 'skirt', color: 'identity', lining: 'secondary', turnColor: 'secondary',
        pipingColor: 'trim', length: 0.26, flare: 1.90, top: 0.10,
        folds: 9, foldDepth: 0.078, foldOnset: 0.06,
      },
      {
        kind: 'underskirt', color: 'secondary', turnColor: 'leather', pipingColor: 'trim',
        length: 0.32, flare: 1.55, top: 0.06, folds: 6, foldDepth: 0.050,
      },
      { kind: 'belt', at: 'hip', color: 'leather', buckle: 'trim', width: 0.038, tailSide: 'L', over: 0.52 },
      {
        kind: 'strap', side: 'R', color: 'leather', buckle: 'spark',
        width: 0.044, loops: 3, over: 0.60, buckleAt: 0.40,
      },
      { kind: 'vambrace', material: 'leather', color: 'trim', rim: 'accent', lining: 'secondary', studs: 3, studColor: 'spark' },
      { kind: 'legwrap', color: 'secondary', tie: 'spark', turns: 5, from: 0.18, to: 0.88 },
      {
        kind: 'boot', color: 'leather', cuff: 'trim', cuffLining: 'secondary', sole: 'secondary',
        eyelets: 3, lace: 'accent', shaft: 0.055, cuffFlare: 0.18,
      },
    ]),

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
