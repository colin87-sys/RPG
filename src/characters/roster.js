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
 *      **every base costume zone: S ≤ 0.35, V within 0.20–0.76.**
 *      **exactly one `spark` per character: S ≥ 0.7, under a tenth of the
 *      figure's area, and never on a piece measured in centimetres.**
 *
 *    **And the rule is necessary, not sufficient, in the other direction too.**
 *    `shots/gar-base/cast-stage.png` passes it on all four staged characters and
 *    an art review still found "all four wear near-identical navy", which is
 *    what the frame shows: a S 0.33 navy, a S 0.30 ink-navy, a S 0.09 charcoal
 *    and a S 0.34 wine are, at battle distance and after the fog lerp, four dark
 *    cool neutrals. Low saturation buys *harmony*; it does not buy *identity*,
 *    and identity is what a four-figure line needs.
 *
 *    So the roster now carries a **colour script** on top of the rule — one
 *    family per party member, assigned by construction match against the four
 *    figures in `bravely01.jpg`, so the character built like a plate figure
 *    wears that figure's palette:
 *
 *      Auren  ← the knight     **steel-silver plate over storm-navy**
 *      Seren  ← the hat-mage   **cream over black, printed skirt**
 *      Emrys  ← the coat-mage  **deep oxblood over charcoal**
 *      Kite   ← the archer     **moss-green over black**
 *
 *    The four are separated on *hue family and value at once*, which is what the
 *    plate does and what survives minification: measured across the four,
 *    dominant values run 0.77 / 0.90 / 0.35 / 0.36 and no two dominants inside
 *    0.15 V share a hue family. Bramm's canvas and Yshara's forest sit off the
 *    staged line and are held clear of all four.
 *
 *    Emrys's oxblood at S 0.40 is a **single documented exception** to the S
 *    ≤ 0.35 ceiling, taken once and argued in his palette block: the plate
 *    allows exactly one saturated dominant in a four-figure party, and its
 *    coat-mage is where it spends it.
 *
 *    Separation is carried by hue *and value* instead — dark navy, bone, undyed
 *    canvas, dark wine, charcoal, mid forest — which is how the plate's party
 *    separates and is more robust to the fog lerp than chroma was, because the
 *    lerp attacks chroma and leaves value alone.
 *
 *    **The saturation rule is necessary and not sufficient**, which the round
 *    that produced `shots/gar-before/cast-lineup.png` proved twice. Bramm's
 *    apron passed at S 0.34 and was still mustard; Emrys's coat passed at S
 *    0.30 and was still violet, with a complementary ember lining the cuffs,
 *    collar and lapels. A desaturated version of a hue nobody else is near is
 *    still that hue, and hues the plate does not contain — violet, mustard,
 *    candy orange — read as off-style at any saturation. The families in the
 *    plate are steel-blue, off-white, charcoal, wine and black-green, and the
 *    roster is now inside them.
 *
 *    The `spark` budget is enforced by *area*, not just by colour. Buckle
 *    plates, device fields and pattern accents are all large enough to break it
 *    and all three did: a 0.083 H buckle frame in gold on the front centre line
 *    is a hundred saturated pixels on a character's navel. Sparks live on
 *    rivets, studs, laces, ribbon and the centre of an embroidered blossom.
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
 *    Three garment conventions were added by the layering round and are worth
 *    stating because each one replaces something that failed in a capture:
 *
 *      `sleeve`  every clothed arm carries one. Between pauldron and vambrace
 *                the roster used to leave bare body loft, which is most of why
 *                the review read the party's arms as stubs.
 *      `bands`   skirts terminate in layered trim bands rather than in a print.
 *                A repeating blossom motif over the lower half of a skirt
 *                resolves at battle distance into evenly spaced discs — the
 *                "polka-dot skirt" — and banding is what the plate's skirts
 *                actually carry there.
 *      `folds`   eight to twelve, not four to eight. Fold count is now also a
 *                *shading* control: `Garments.foldSamples` breaks the panel's
 *                vertex colour at every ridge and trough, so the count sets how
 *                many hard light/dark pairs the cloth carries.
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

    // **Steel-silver plate over a storm-navy underlayer** — slot 1 of the four-
    // way colour script, and the plate's knight.
    //
    // The script exists because `shots/gar-base/cast-stage.png` has no colour
    // identity in it at all: staged next to `bravely01.jpg`, all four of our
    // party members read as the same dark blue-grey, and an art review scored
    // the frame on exactly that. The plate's four leads are steel, cream-and-
    // black, wine and green-and-black — four *families*, one per figure — and
    // the roster now assigns those four families by construction match, so the
    // character built like the plate's knight gets the knight's palette, the one
    // built like its coat-mage gets the coat-mage's, and so on.
    //
    // His half of the fix is which zone carries the silver. The armour was
    // #848E99 — a mid grey at linear luminance 0.28, barely a stop above the
    // navy under it — so the largest, most detailed, most highlight-bearing
    // surface on the character was also its dullest, and the whole figure fell
    // into the party's undifferentiated navy. Plate steel goes to **#B4BCC4**
    // (S 0.08, V 0.77, linear luminance 0.49) with the rolled lips and bevels
    // at **#DFE4E8**, which is the brightest thing in the party and the reason
    // he is identifiable from his armour alone at 200 px. The navy stays where
    // the plate's knight keeps it: the arming coat and its hem, the trousers,
    // the shoulder mantle — an underlayer, not the character.
    //
    // The gold survives at spark size and nowhere else: the gorget rivets, the
    // vambrace studs. Nothing on him with an *area* is saturated.
    palette: Object.freeze({
      skin: 0xd9a882, skinShade: 0x9c6f56,
      hair: 0x4a3d33, hairShade: 0x241f1c,
      // Iris hues are one-per-character and saturated: at closeup the eye is
      // the largest single colour in frame (ANIME_PIPELINE §1).
      eye: 0xefc24a, eyeCore: 0xfff0c4, sclera: 0xf2ede2, lash: 0x14181f,

      identity: 0x363f52,   // storm-navy arming coat        S 0.34  V 0.32
      secondary: 0x272c3a,  // charcoal-indigo trousers      S 0.32  V 0.23
      trim: 0xdfe4e8,       // polished lips, bevels, facings S 0.04  V 0.91
      accent: 0xb4bcc4,     // plate steel — the identity     S 0.08  V 0.77
      spark: 0xd1a221,      // Skysworn gold: rivets, studs   S 0.84  V 0.82

      leather: 0x45382f,    // belt, baldric, boot body
      metal: 0xb4bcc4,
      // Consumed by the `cape` garment below. The mantle is the navy, so the
      // silver stays a property of the armour and the two zones cannot merge.
      cape: 0x363f52, capeLining: 0xb4bcc4,
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

    /**
     * **No simulated panel.** The `cape` block feeds `Cloth.addPanel`, and every
     * party member that carried one shipped a flat slab standing clear of their
     * back — `shots/gar-base/cast-stage.png` shows three of the four staged
     * figures that way, and on this character the two split tails read as a
     * single dark rectangle wider than he is.
     *
     * The cause is structural rather than a tuning miss. `addPanel` lays a
     * curved sheet out at a fixed `offsetZ` behind the spine and anchors it to
     * one bone; it has no knowledge of where the shoulders are, so nothing holds
     * its top edge down onto them and no amount of `curve` or `stiffness` puts
     * it back on the body. Every cloak in this roster is now a `cape` *garment*
     * instead — a shoulder-conforming catenary surface fitted to the solved
     * deltoid span, with a bound neckline, a clasp cord and a hem that hangs
     * longest down the spine. See the rebuild note in `Garments.cape`.
     *
     * What is given up is per-frame motion on the cloak. That is a real loss and
     * it is the right trade twice over: a piece that hangs correctly and moves
     * with the skeleton beats a piece that flaps in the wrong place, and the five
     * panels removed across the roster are the most expensive CPU objects in the
     * frame — six verlet iterations over 130-odd particles each, every step,
     * which is what pays for the extra hem and plate density added here. Hair
     * chains still simulate; nothing else on the character was bone-driven.
     */
    cape: null,

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
      // The sleeves of that coat, under every plate on the arm. Fuller than the
      // arm inside them and gathered into four wrinkle rings, so the limb's
      // outline between pauldron and vambrace is cloth rather than skin.
      { kind: 'sleeve', color: 'identity', lining: 'secondary', piping: 'trim', fit: 1.26, puff: 0.22 },
      // The knight's mantle, replacing the two simulated tails. Short, because
      // it is worn over pauldrons and has to end above the fauld or the two
      // hems merge into one edge; `lift 0.40` climbs it hard at the fastenings
      // so the shoulder stack stays visible through it, and the steel lining is
      // what the hem band turns outward.
      {
        kind: 'cape', color: 'identity', lining: 'accent', piping: 'trim',
        turnColor: 'accent', length: 0.26, wrap: 0.68, spread: 0.11,
        lift: 0.46, bow: 0.46, flare: 1.34, folds: 9, foldDepth: 0.084,
        claspColor: 'spark',
      },
      {
        kind: 'underskirt', color: 'identity', lining: 'secondary', turnColor: 'secondary',
        pipingColor: 'accent', beadColor: 'trim', top: 0.10, length: 0.24, flare: 1.55,
        // Eleven folds on a short panel. Fold count has to rise as a garment
        // shortens or the creases stretch into lean, and this hem is the only
        // cloth on an otherwise armoured figure — it has to carry the whole
        // "there is a person inside this" read on its own.
        folds: 11, foldDepth: 0.088, foldOnset: 0.06,
      },
      {
        kind: 'gorget', color: 'accent', rim: 'trim', lining: 'secondary', width: 1.5,
        // The one saturated thing on him, and it is eight domes the size of a
        // shirt button sitting directly under the closeup camera: the Skysworn
        // gold, spent exactly where the plate spends saturation.
        rivets: 8, rivetColor: 'spark', rivetSize: 0.0058,
      },
      {
        kind: 'breastplate', color: 'accent', rim: 'trim', lining: 'secondary',
        // The Skysworn keep-and-wings device, embossed on the raised face of
        // the cuirass and nowhere else. Hexes track the palette above. The
        // device is struck in *pale steel*, not gold: it is a third of the
        // largest plate on the figure, which is far past the area a saturated
        // colour is allowed, and the last capture shipped it as a mustard slab
        // across his chest.
        //
        // `base` has to be the plate's own steel and not the coat's navy. The
        // canvas covers the *raised face* of the cuirass while the recessed
        // border round it is flat vertex colour, so a base that disagrees with
        // `color` prints the middle of his chest as a different garment from
        // its own edge.
        // Hexes track `accent` above and moved with it to steel-silver; a base
        // left at the old #818B96 would print the raised face of the cuirass a
        // full stop darker than its own recessed border.
        pattern: {
          id: 'heraldic', base: 0xb0b8c0, accent: 0xc9d0d6, ink: 0x5b636b,
          wrap: 'clamp', size: 256,
        },
      },
      { kind: 'pauldron', side: 'L', lames: 3, color: 'accent', rim: 'trim', lining: 'secondary', spread: 2.05 },
      { kind: 'pauldron', side: 'R', lames: 2, color: 'accent', rim: 'trim', lining: 'secondary', spread: 1.78 },
      // Baldric over the breastplate: 0.055 H wide (≈7 cm) so the band has two
      // shadowed edges and a lit face at capture scale, with a steel box buckle
      // on the chest and three keeper loops down the run.
      {
        kind: 'strap', side: 'L', color: 'leather', buckle: 'accent',
        width: 0.055, loops: 3, over: 0.62, buckleAt: 0.40,
      },
      // **Buckle down from 0.083 × 0.055 H to 0.052 × 0.038, and out of the
      // spark.** The measurement was right and the *application* was wrong: at
      // the battle camera a gold frame that size on the front centre line is a
      // hundred square pixels of the most saturated colour in the party sitting
      // on the character's navel, and `shots/gar-before/cast-lineup.png` shows
      // it out-reading his face. Hardware is steel on this roster; the spark
      // stays on pieces measured in millimetres.
      {
        kind: 'belt', color: 'leather', buckle: 'accent', width: 0.040, over: 0.52,
        buckleWidth: 0.052, buckleHeight: 0.038,
      },
      { kind: 'pouch', side: 'R', at: 'hip', color: 'leather', flap: 'secondary', buckle: 'accent', size: 0.044 },
      { kind: 'fauld', color: 'accent', rim: 'trim', lining: 'secondary', drop: 0.24, rivetColor: 'trim' },
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
    // **Cream over black** — slot 2 of the colour script, and the plate's
    // hat-mage almost line for line.
    //
    // Two corrections against the last capture. The bone dominant was #BFBAAC,
    // a grey-green off-white that lands within 0.05 V of Bramm's canvas and
    // reads as the same undyed cloth; it goes **warm** to #E6DDC9, which is the
    // cream the plate actually paints and which no other character is near. And
    // the skirt's ink-navy went to a true near-black — #23242C at S 0.11 — because
    // navy was the single colour every party member was wearing, and the plate's
    // figure wears black there, not blue.
    //
    // Her one saturated object stays the throat ribbon and the beret pompom, at
    // the crimson the plate puts in exactly those two places.
    palette: Object.freeze({
      skin: 0xe8d3c4, skinShade: 0xab8b83,
      hair: 0xece6da, hairShade: 0x9aa6a8,
      eye: 0x4fc8be, eyeCore: 0xd8fbf6, sclera: 0xf6f2ea, lash: 0x263038,

      identity: 0xe6ddc9,   // cream robe, collar and beret  S 0.14  V 0.90
      secondary: 0x23242c,  // black bodice, skirt, tights   S 0.11  V 0.17
      trim: 0x8d8578,       // warm grey piping and hem      S 0.15  V 0.55
      accent: 0xa3977f,     // old gold thread               S 0.22  V 0.64
      spark: 0xb82538,      // crimson ribbon and pompom     S 0.80  V 0.72

      leather: 0x665849,
      metal: 0xa3977f,
      cape: 0xe6ddc9, capeLining: 0x23242c,
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

    /**
     * **The chime ring, halved and dimmed.** The staff head is mounted at head
     * height and the review found what it prints as: "a floating teal squiggle"
     * beside her hat. Both causes are here. `ringRadius 0.10` is a fifth of a
     * metre of hoop next to a 30 cm skull, so the ring crosses her hat brim
     * rather than sitting under it; and at `emissive 0.9` it is unlit, so it
     * carries no shading, no rim and no relation to the key — which is precisely
     * the description of a squiggle rather than an object.
     *
     * 0.055 puts the hoop inside the staff's own silhouette and 0.24 lets the
     * toon ramp back onto it, so it reads as a metal ring with bells on it. Her
     * element still glows: `glow` drives the VFX, which is where emissive
     * belongs (ANIME_PIPELINE §4).
     */
    weapon: Object.freeze({
      kind: 'chimestaff', mount: 'handL',
      length: 0.95, width: 0.026, thickness: 0.026,
      ringRadius: 0.055, bells: 5, bellRadius: 0.016,
      tilt: 0.06, roll: 0.0,
      emissive: 0.24,
    }),

    // No simulated panel — see the note on Auren's `cape`. Her shawl and the
    // wrapping under-skirt tube were the two panels `Cloth` built here, and both
    // are now real garments: the shawl as a `cape`, the tube as the `underskirt`
    // that was already in the stack below it.
    cape: null,

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
        pipingColor: 'trim', beadColor: 'trim',
        bands: 1, bandColor: 'trim', bandHeight: 0.045,
        // Eight folds on the petticoat against eleven on the skirt over it: the
        // two layers must not share a rhythm or their hems lock into one edge.
        // Now that both hems undulate that constraint is stricter, not looser —
        // two waves at the same period beat into a single thicker edge.
        length: 0.48, flare: 1.72, folds: 8, foldDepth: 0.070, hemWave: 0.055,
        // **Plain cream, and the print moved up to the skirt over it.**
        //
        // The petticoat used to carry the iridescent weave — the piece that once
        // shipped the magenta/white checkerboard, fixed by cutting its tiling to
        // two and walking its ramp inside the base band. It is off it now for a
        // compositional reason rather than a technical one: `bravely01`'s
        // hat-mage wears the *pattern on the outer skirt* and a plain white
        // underlayer showing at the hem, and a print seen through the gaps of a
        // second print is noise at any tile count. So the multicolour print goes
        // where the plate puts it, this layer goes back to flat cream, and the
        // pale ring it draws under the dark skirt is the character's second and
        // brightest hem line.
      },
      {
        kind: 'skirt', color: 'secondary', lining: 'trim', turnColor: 'trim',
        pipingColor: 'trim', beadColor: 'identity',
        length: 0.40, flare: 2.15, folds: 11, foldDepth: 0.090,
        /**
         * **The multicolour printed skirt — the one place in the party where
         * more than two hues meet, and the plate says exactly where it is.**
         *
         * Zoom into `bravely01`'s second figure at 4×. Her skirt is not navy and
         * it is not one colour: it is a shot cloth carrying teal, indigo, plum,
         * rust and a warm gold, laid in soft diagonal bands, with the whole thing
         * held at a *low value* so it still reads as the dark half of a
         * bright-torso-over-dark-hem figure. It is the only large multicolour
         * area in the plate's entire party and it works because none of those
         * hues is bright: measured, every band sits under V 0.45.
         *
         * `iridescent` is the right generator for it — diagonal bands sheared 1:1
         * across the canvas with a fine weave over them — and the correction is
         * entirely in the ramp. It used to walk one hue family, which is a shot
         * silk and not a print. Five stops across the wheel, all inside the value
         * band, and the near-black base showing through the weave is what keeps
         * the piece dark enough to sit under a cream bodice.
         *
         * Two tiles, not four: `resolveRepeat` refuses a shear past 4:1, and the
         * diagonal bands need the length of a whole tile to read as a wash rather
         * than as stripes.
         */
        pattern: {
          id: 'iridescent', base: 0x23242c,
          ramp: [0x23242c, 0x2c5459, 0x3b3560, 0x6d3444, 0x8a6b34, 0x23242c],
          size: 256, repeat: [2, 1],
        },
        // Two trim bands framing the bottom of the print — the plate's skirt
        // ends in a warm band and a cream one, not in the print running off the
        // edge. They are swept on the skirt's own surface function, so they
        // inherit both the fold field and the new hem undulation and cannot
        // separate into flat hoops.
        bands: 2, bandColor: 'trim', bandAlt: 'identity', bandHeight: 0.05, bandGap: 0.05,
      },
      // Bodice sleeves, gathered at the elbow and above the cuff.
      { kind: 'sleeve', color: 'secondary', lining: 'trim', piping: 'trim', fit: 1.24, puff: 0.30 },
      { kind: 'sash', color: 'secondary', piping: 'spark', width: 0.080, knotSide: 'L' },
      // The shawl, replacing both the simulated panel and the cowl that used to
      // sit in the same volume. A `hood` is a bag hanging off the nape and a
      // `cape` is a surface lying on the shoulders; with the cape fitted to the
      // deltoid line the two now intersect, and the plate's hat-mage wears the
      // shawl, not a hood. Cut short and lifted hard at the fastenings so the
      // broad sailor collar over it stays the read at the neck.
      {
        kind: 'cape', color: 'identity', lining: 'secondary', piping: 'trim',
        turnColor: 'secondary', length: 0.24, wrap: 0.74, spread: 0.13,
        lift: 0.44, bow: 0.34, flare: 1.26, folds: 8, foldDepth: 0.076,
        claspColor: 'spark',
      },
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

    // **Undyed canvas over iron.** The mid-value rung in the party's ladder —
    // he sits between Auren's dark navy and Seren's bone, which is how a lineup
    // of six low-saturation costumes stays legible.
    //
    // Two rounds of correction, and the second is the one that matters. The
    // apron was #B87020 (S 0.89), then #857258 — a *desaturated* orange, which
    // is mustard, and mustard is what `shots/gar-before/cast-lineup.png` shows
    // filling the middle of the frame. The saturation rule was satisfied and
    // the costume still fought the meadow, because the meadow is warm too and
    // a large warm-neutral mass in front of warm-neutral ground has nothing but
    // value left to separate on.
    //
    // Undyed heavy canvas is the honest colour for a smith's apron and it is
    // the party's **off-white** family: S 0.12 / V 0.61, a full stop and a half
    // above his iron work clothes and a stop below Seren's bone. The warmth
    // that was in the apron survives at spark size — the brass scrollwork
    // chased into the hanging tabs, the buckle tongues and the tool rivets.
    // Forge orange is the right colour for three square centimetres of a
    // costume and the wrong one for half of it.
    //
    // The hair stays dark iron: Seren and Emrys are staged either side of him
    // and the trio needs a value ladder rather than three pale hairpieces.
    palette: Object.freeze({
      skin: 0xc08a63, skinShade: 0x855239,
      hair: 0x4f4a45, hairShade: 0x241f1c,
      eye: 0x86b23c, eyeCore: 0xdff0a8, sclera: 0xeee7dc, lash: 0x1b1f24,

      identity: 0x9c968a,   // undyed canvas apron           S 0.12  V 0.61
      secondary: 0x2f3338,  // iron work clothes             S 0.16  V 0.22
      trim: 0x5f5850,       // dark stone straps and cuffs   S 0.16  V 0.37
      accent: 0x8f8b80,     // dull steel and the prosthetic S 0.11  V 0.56
      spark: 0xdb611a,      // forge ember: chasing, rivets  S 0.88  V 0.86

      leather: 0x453f39,
      metal: 0x8f8b80,
      cape: 0x9c968a, capeLining: 0x5f5850,
      weaponA: 0x8a867b,
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

    // No simulated panel — see the note on Auren's `cape`. His was the one that
    // hung in *front*, at `offsetZ +0.92` of chest depth, so the slab stood off
    // his bib rather than his back; the `apron` garment below is the same
    // garment built against the body, with folds, a bound edge and a neck strap.
    cape: null,

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
        // Six deep folds, and they start below the belt: the bib is pulled
        // flat by the neck strap and only the skirt of an apron gathers. Heavy
        // canvas gathers into fewer, wider creases than tailored cloth, which
        // is why this is six against the eleven on a skirt.
        folds: 6, foldDepth: 0.092, foldOnset: 0.44,
        turnColor: 'leather',
        // A forge sett: dark bands crossed over undyed canvas, coarse enough to
        // read as a weave and quiet enough not to become the character.
        pattern: {
          id: 'tartan', base: 0x9c968a, ink: 0x2f3338, accent: 0x5f5850,
          size: 256, repeat: [2, 3],
        },
      },
      {
        kind: 'fauld', tabs: 5, color: 'trim', rim: 'accent', lining: 'leather',
        drop: 0.20, wrap: 0.80, material: 'leather',
        // Brass scrollwork chased into the dark tabs — the ninja's gold
        // filigree harness, at a smith's scale. Line work, so it takes the
        // spark: this is the one place his ember colour has any area at all.
        pattern: { id: 'arabesque', base: 0x5f5850, accent: 0xdb611a, size: 256, repeat: [1, 2] },
      },
      // A forgemaster's buckle is the largest on the roster and it is still
      // steel, not ember: 0.062 × 0.044 H is a hand's breadth of hardware at
      // this scale, half what it was, and the ember stays on the chasing.
      { kind: 'belt', color: 'leather', buckle: 'accent', width: 0.046, buckleWidth: 0.062, buckleHeight: 0.044, over: 0.55 },
      { kind: 'pouch', side: 'L', at: 'hip', size: 0.052, color: 'leather', flap: 'trim', buckle: 'accent' },
      { kind: 'pouch', side: 'R', at: 'hip', size: 0.038, angle: 0.66, drop: 0.070, color: 'leather', flap: 'trim', buckle: 'accent' },
      // Tool bandolier over the bib, in oxblood against the pale canvas: the
      // strongest value break available on this character, so it is the piece
      // doing the work of saying "assembled" that his colour used to do.
      {
        kind: 'strap', side: 'R', color: 'trim', buckle: 'accent',
        width: 0.058, loops: 3, over: 0.66, buckleAt: 0.38,
      },
      // Shirt sleeves under the apron. The left shoulder is bare (see
      // `accessories`), so only the right arm is sleeved and the asymmetry is
      // free silhouette identity.
      { kind: 'sleeve', side: 'R', color: 'secondary', lining: 'trim', piping: 'trim', fit: 1.26, puff: 0.30 },
      {
        kind: 'pauldron', side: 'R', lames: 2, color: 'accent', rim: 'trim', lining: 'leather',
        spread: 1.95, rivetColor: 'spark', rivetSize: 0.0068,
      },
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

    // **Moss-green over black** — slot 4 of the colour script, and the plate's
    // archer, whose construction this costume already copied piece for piece:
    // fur ruff, brimmed hat worn tilted, net over the hip.
    //
    // The wine coat went to Emrys, and it had to. Wine is the plate's *coat-mage*
    // colour and Emrys is the character wearing the coat; Kite is the one wearing
    // the archer's fur-and-net stack, and the archer is green. Holding both
    // characters in the red family was also what put three of our four staged
    // figures inside the same dark cool band — the review's "all four wear
    // near-identical navy" — because a S 0.34 wine at V 0.37 and a S 0.09
    // charcoal at V 0.24 are two dark neutrals once the fog lerp has had them.
    //
    // Olive rather than a true green, and that is a hard constraint rather than
    // a preference: Yshara's forest is a blue-green at hue 155°, and two greens
    // inside 40° of each other in a six-strong lineup are one green. This sits
    // at **hue 75°**, 80° off hers.
    //
    // Its *value* is set against Emrys rather than picked. `ALBEDO_BAND.cloth`
    // floors every garment at linear luminance 0.09, so every "near-black" on
    // this roster grades up to the same lightness and only hue survives — which
    // means two dark dominants are one dark dominant however different their
    // hexes look in an editor. #63734D lands at linear 0.155 against his 0.09:
    // most of a stop, measured after grading rather than before it, so the two
    // characters staged either side of Seren separate on value as well as hue.
    // Against her own near-black net and trousers it is also the highest value
    // contrast in the party, which is what a figure who is mostly mesh and fur
    // needs to stay legible.
    palette: Object.freeze({
      skin: 0x8a5a44, skinShade: 0x53321f,
      hair: 0x1f2830, hairShade: 0x0e151b,
      eye: 0x3fa9f5, eyeCore: 0xa8e4ff, sclera: 0xf0ece2, lash: 0x0d1116,

      identity: 0x63734d,   // moss stormcoat, hue 75°       S 0.33  V 0.45
      secondary: 0x212328,  // black trousers and net        S 0.15  V 0.16
      trim: 0xb3aa9a,       // bleached rope                 S 0.14  V 0.70
      accent: 0x828c94,     // steel                         S 0.12  V 0.58
      spark: 0xc73a24,      // the sister's red              S 0.82  V 0.78

      leather: 0x24232a,    // tarred hide and the black fur ruff
      metal: 0x828c94,
      cape: 0x63734d, capeLining: 0x212328,
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

    // No simulated panel — see the note on Auren's `cape`. Two split tails and a
    // hanging sash, all three of them planks: the sash in particular was a
    // 0.075 × 0.44 H flat rectangle at a fixed offset off her hip, which is the
    // "debug ribbon" read the review picked out. The storm cape below carries
    // the same silhouette mass and is fitted to her shoulders.
    cape: null,

    accessories: Object.freeze({ pauldron: null, collar: 'none', bootBlade: 'L' }),

    /**
     * **A cut-down stormcoat over a net-hung hip.**
     *
     * Thirteen pieces. The coat is still the *fitted* half only — hem at 0.30 H,
     * so it stops at mid-thigh — but the reason has changed: the swinging tails
     * used to be the cloth solver's, and they are now the `cape` below, which
     * has to have somewhere to hang from. A stiff shell and a hanging one
     * occupying the same volume fight whichever module builds them.
     *
     * The net over her right hip is the one garment in the party that adds
     * *holes* to a silhouette, which is why she is the character who gets it —
     * she is the one who has to be findable while crossing the stage.
     */
    garments: Object.freeze([
      {
        // Lined and piped in steel rather than bleached rope. The lining is
        // seen edge-on down both front panels and turned out along the whole
        // hem, so at V 0.70 it drew a pale frame round the entire coat and the
        // wine that identifies her was left as an infill.
        kind: 'longcoat', color: 'identity', lining: 'accent', piping: 'accent',
        top: 0.55, hem: 0.30, flare: 2.0, gap: 0.24, buttons: 5,
        // A short coat over a fitted hip: eleven folds rather than the ten a
        // full-length panel takes, because the drape has less length to develop
        // in and the creases have to be closer together to read.
        folds: 11, foldDepth: 0.082, foldOnset: 0.26, turnColor: 'accent',
        // Wave damask in a darker wine with bleached-rope line work. Five tiles
        // rather than three: at three the wave was a hand's-width motif and the
        // last capture printed it as a row of pale blocks across her chest.
        // Hexes track `identity` and moved with it to moss; `base` left at the
        // old wine would print the coat body a different garment from its own
        // collar and hem.
        pattern: { id: 'damask', base: 0x63734d, ink: 0x414c31, accent: 0x8d8577, size: 256, repeat: [5, 2] },
      },
      // **The storm cape**, replacing two simulated tails and a flat sash.
      //
      // Length is set by the coat under it rather than by taste. The coat flares
      // to 2.0 below the hip, so a cape reaching past the hip would need a flare
      // above 2.0 to stay outside it — which is a crinoline — and anything less
      // ends up *inside* the coat, invisible from the side and interpenetrating
      // at the back where the bow pushes it out. 0.30 H from the shoulder stops
      // it at the hip line, where the coat is still fitted and a flare of 1.5
      // clears it everywhere. `bow 0.55` is the deepest in the party so it
      // stands genuinely clear of the fishnet rather than laminating onto it.
      {
        kind: 'cape', color: 'identity', lining: 'secondary', piping: 'trim',
        turnColor: 'secondary', length: 0.30, wrap: 0.66, spread: 0.14,
        lift: 0.32, bow: 0.55, flare: 1.50, folds: 10, foldDepth: 0.086,
        claspColor: 'spark',
      },
      // Coat sleeves. Wider at the shoulder than anyone else's and hard-gathered
      // at the wrist, which is the corsair cut and the one place her costume
      // says "cut down from something bigger".
      { kind: 'sleeve', color: 'identity', lining: 'trim', piping: 'trim', fit: 1.26, puff: 0.32 },
      // Steel-faced lapels, not bone. In `shots/gar-after/cast-lineup.png` a
      // bleached-rope facing at V 0.70 is the brightest area on the character
      // and it sits across her chest, which pulls the read off the wine coat
      // that is supposed to identify her.
      { kind: 'lapel', color: 'accent', lining: 'identity', width: 0.40, fold: 0.20 },
      { kind: 'collar', cut: 'popped', color: 'identity', lining: 'trim', piping: 'trim', height: 1.3 },
      // **The fur ruff**, and the reason she is the character who gets one: she
      // is staged in near-profile and a broken outline at the shoulder is the
      // only thing that reads as costume from that angle. Twenty-six clumps in
      // two interleaved rows, tarred-hide black shading to rope — the archer's
      // black ruff in `bravely01` and the ninja's collar in `bravely05`.
      {
        kind: 'furCollar', color: 'leather', shade: 'secondary',
        // Three shell fins carry the mass and a short clump ring breaks it
        // toward the camera — see the rebuild note in `Garments.furCollar`.
        // The previous twenty-six-cone version is invisible on her in
        // `shots/gar-before/cast-lineup.png`, which is what a sparse ring of
        // two-pixel spines resolves to at battle distance.
        fins: 3, tufts: 26, rows: 1, length: 0.072, clump: 0.034,
        radius: 1.62, liftBack: 0.60, liftFront: -0.22,
      },
      {
        kind: 'sash', color: 'secondary', piping: 'spark', width: 0.070, knotSide: 'R',
        // Key-fret woven into the wrap, bone on sea-slate. Three tiles, not six:
        // `sash` used to multiply by a further four, so this was twenty-four
        // tiles of a five-cell fret — a hundred and twenty cells round a band
        // 0.07 H tall, which resolves to noise at any capture distance.
        // Base tracks `secondary`, which is now the near-black her net is cut in.
        pattern: { id: 'lattice', base: 0x212328, ink: 0x8d8577, size: 256, repeat: [3, 1] },
      },
      {
        kind: 'belt', at: 'hip', color: 'leather', buckle: 'accent', width: 0.040,
        buckleWidth: 0.050, buckleHeight: 0.036, tailSide: 'R', over: 0.52,
      },
      {
        kind: 'strap', side: 'L', color: 'leather', buckle: 'accent',
        width: 0.050, loops: 3, over: 0.62, buckleAt: 0.44,
      },
      { kind: 'pouch', side: 'L', at: 'hip', size: 0.042, color: 'leather', flap: 'trim', buckle: 'accent' },
      {
        // Four cells rather than five: the net is the most triangle-hungry
        // piece per pixel in the wardrobe and the fold and fur geometry added
        // to this character has to be paid for somewhere.
        // Tarred net, not bleached rope: at V 0.70 against a V 0.37 coat the
        // net was reading as the loudest thing on her and swallowing the fold
        // and fur work under it. Dark cord over a dark coat is what the plate's
        // archer wears and it keeps the holes as the read rather than the cord.
        kind: 'fishnet', color: 'secondary', top: 0.02, length: 0.30, flare: 1.9,
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

    // **Deep oxblood over charcoal** — slot 3 of the colour script, and the
    // plate's coat-mage, whose garment this costume is already built from.
    //
    // Two failed attempts are on record and both are worth keeping, because the
    // second one passed the roster's own rule and still failed the frame.
    // #7440CC (S 0.69) shouted; #71567A was pulled to S 0.30 and stayed
    // *violet*. Desaturating a hue nobody else in the party is near does not
    // stop it being that hue. So the coat went charcoal — #373A3E, S 0.09 —
    // and that is the version in `shots/gar-base/cast-stage.png`, where it
    // fails a third way: three of the four staged figures are now dark cool
    // neutrals and none of them owns a hue at all.
    //
    // `bravely01`'s third figure settles it. He wears an ankle-length coat in a
    // **deep, unmistakable wine**, with grey trousers, a grey fur mantle and rose
    // embroidery on the lower panels — and it is the most legible costume in the
    // plate's party precisely because the hue is allowed to be a hue. Measured
    // off the plate that coat sits near S 0.45 / V 0.36.
    //
    // #59353A is that colour, and it is a **deliberate, documented exception to
    // the S ≤ 0.35 rule at the top of this file**, taken once, on one character,
    // for the reason the plate demonstrates: with four costumes in the frame at
    // most one may carry a saturated dominant, or the party is a colour wheel
    // again. It is bought back on value — V 0.35 keeps him the second-darkest
    // figure in the line — and everything else on him is neutral: charcoal
    // under-tunic, cool grey mantle and lining, bone collar and cuffs.
    //
    // The ember survives as `spark` and only as `spark`: the boot laces and the
    // blossom centres inside the hem embroidery. It is now a warm accent on a
    // warm coat rather than a complementary one on a violet coat, which is the
    // difference between rose embroidery and a hazard stripe.
    palette: Object.freeze({
      skin: 0xe0b394, skinShade: 0xa06f56,
      hair: 0x805139, hairShade: 0x3d2519,
      eye: 0xff6b2b, eyeCore: 0xffd08a, sclera: 0xf4efe4, lash: 0x191418,

      identity: 0x59353a,   // inherited oxblood scholar's coat  S 0.40 V 0.35
      secondary: 0x2b2d33,  // charcoal under-tunic              S 0.16 V 0.20
      trim: 0xb6b2a6,       // bone collar, cuffs and piping     S 0.09 V 0.71
      accent: 0x76797e,     // cool grey mantle, lining, buckles S 0.06 V 0.49

      spark: 0xe6581c,      // live ember: laces, blossom centres S 0.88 V 0.90

      leather: 0x3b3631,
      metal: 0x8d939a,
      cape: 0x59353a, capeLining: 0x76797e,
      weaponA: 0x6e6f6a,
      weaponB: 0xa3a49e,
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
      // **0.085, not 0.30.** `orreryRadius` is a fraction of *body height*, not
      // of the book, and `CharacterFactory` grows the three rings from it as
      // `radius · H · (0.6 + 0.26 i)` — so 0.30 on a 1.00 m character put the
      // outer ring at 34 cm, a 67 cm hoop around a 24 cm book on a figure whose
      // whole torso is 40 cm. Shipped emissive, it read as a glowing orange
      // hula-hoop swallowing his chest and was the loudest defect in the battle
      // frame. At 0.085 the rings run 5.1–9.5 cm: a halo standing off the covers
      // by half a book width, which is what an orrery on a grimoire is.
      //
      // **And the rings are gone.** 0.085 fixed the *scale* and left the read:
      // `shots/gar-base/cast-stage.png` prints an orange open loop hanging on
      // this character's chest with nothing visibly holding it, and the art
      // review filed it as a floating debug squiggle, which is a fair
      // description of an unlit emissive torus at `emissive 1.1` seen edge-on
      // against a dark coat. The problem is not the radius. A ring is a shape
      // with no interior, so at battle distance it has no mass, no shading and
      // no attachment — the three things that make an object read as held.
      // There is nothing like it in any of the five plates.
      //
      // What remains is a book: the grimoire itself, with its emissive pulled to
      // the level the other weapons in the roster carry so the toon ramp shades
      // its covers instead of blowing them out. His fire still shows — `glow`
      // drives the VFX, which is where ANIME_PIPELINE §4 puts emissive.
      orreryRings: 0, orreryRadius: 0.085,
      tilt: 0.18, roll: -0.22,
      emissive: 0.30,
    }),

    // No simulated panel — see the note on Auren's `cape`. His was the worst of
    // the five: 0.62 H of split tails at `offsetZ -0.72` of chest depth on the
    // smallest frame in the party, which is where the review's "flat rectangular
    // slab floating behind" came from. The `longcoat` garment below is the same
    // coat, ankle length, built against the body with twelve fold pairs and a
    // hem that now undulates.
    cape: null,

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
        kind: 'longcoat', color: 'identity', lining: 'accent', piping: 'trim',
        top: 0.60, hem: 0.055, flare: 2.5, gap: 0.19, buttons: 6, hang: 1.05,
        buttonSpan: 0.40, buttonColor: 'trim', beadColor: 'accent',
        // The deepest drape in the party, and it should be: this is the longest
        // panel on the smallest frame, so it has the most length to gather in.
        // Twelve creases across a panel that reaches his ankles is the density
        // measured on the staff-mage's coat in `bravely01` once the count is
        // taken all the way round rather than across the visible face, and the
        // field starts high — under the arm, where a coat that does not fit its
        // wearer actually breaks.
        folds: 12, foldDepth: 0.088, foldOnset: 0.16, turnColor: 'secondary',
        // **No print on this coat.** It carried rose-and-vine banded to the
        // bottom third of the panels, which is the plate's proportion, and it
        // could not be made to work here at any tile count. A coat's v runs its
        // whole 0.64 H height against a u that runs a quarter of its hem arc,
        // so a square-authored motif is stretched close to two to one before it
        // is drawn: the rose stems come out as vertical streaks a tenth of the
        // figure's height long, which is what `shots/gar-after` printed even
        // after the accent was pulled from ember to terracotta. Correcting the
        // aspect means repeating in v, which repeats the *band* and scatters
        // embroidery up to his shoulders.
        //
        // The structure the print was there to supply now comes from
        // construction instead — twelve hard fold pairs, a bone collar and
        // lapels, a steel-blue lining turned out at the hem — which is how the
        // plate's own coats are built. Seren's skirt keeps the motif because a
        // skirt's u and v are within a factor of 1.3 of each other and it tiles
        // honestly there.
      },
      // Narrowed from 0.46. A bone facing is the right colour here — it is the
      // only value break on a charcoal coat — but at 0.46 the two wings meet
      // over the sternum and read as one pale bib rather than as lapels.
      { kind: 'lapel', color: 'trim', lining: 'accent', width: 0.34, fold: 0.22, top: 0.95, bottom: -0.70 },
      { kind: 'collar', cut: 'oversized', color: 'trim', lining: 'accent', piping: 'trim' },
      // The sleeves of a coat three sizes too large: the fullest on the roster,
      // gathered into four rings before they reach the triple-turned cuff.
      { kind: 'sleeve', color: 'identity', lining: 'accent', piping: 'trim', fit: 1.32, puff: 0.36 },
      // Fur trim round the collar of the too-big coat, exactly as `bravely05`
      // trims the ninja's cape: one row of eighteen short clumps, dusty ember
      // shading into the leather, so the neckline of a garment three sizes too
      // large has a broken edge instead of a clean one.
      // Cool grey rather than bone: `bravely01`'s coat-mage wears a *grey* fur
      // mantle over a wine coat, and the bone on this character is already spent
      // on the lapels and the collar directly under it — two pale masses on the
      // same centre line merge into one slab.
      {
        kind: 'furCollar', color: 'accent', shade: 'secondary',
        fins: 3, tufts: 18, rows: 1, length: 0.054, clump: 0.028,
        radius: 1.48, liftBack: 0.48, liftFront: -0.20,
      },
      // Rolled three times, each turn a fifth of the forearm apart. The roster
      // used to ask for six rolls of nothing; three that each have a lip and a
      // flare read as more than six that do not.
      { kind: 'cuff', color: 'trim', lining: 'accent', rolls: 3, flare: 0.34, at: 0.80, pitch: 0.18 },
      {
        kind: 'belt', color: 'leather', buckle: 'accent', width: 0.038, raise: 0.010, over: 0.50,
        buckleWidth: 0.046, buckleHeight: 0.034,
      },
      { kind: 'pouch', side: 'L', at: 'hip', size: 0.055, color: 'leather', flap: 'accent', buckle: 'accent' },
      // Grimoire strap. Narrow for a strap because he is the smallest frame in
      // the party, but still a band — 0.042 H is about 4.9 cm on him.
      {
        kind: 'strap', side: 'R', color: 'leather', buckle: 'accent',
        width: 0.042, loops: 2, over: 0.60, buckleAt: 0.46,
      },
      // Steel-blue, not bone: the lapels already own the pale on this figure
      // and a second bone mass hanging down the same centre line merges with
      // them into one slab.
      // Tail cut from 0.20 H to 0.15. The scarf now follows the wearer's own
      // chest section rather than a fixed z (see `Garments.scarf`), so a long
      // tail runs *down the body* instead of standing off it — which is legible
      // where the old one was a detached squiggle, but only if it stops above
      // the belt cluster rather than crossing it.
      { kind: 'scarf', color: 'accent', tail: 0.15, side: 'L' },
      {
        kind: 'boot', color: 'leather', cuff: 'accent', cuffLining: 'secondary', sole: 'secondary',
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
    // No simulated panel — see the note on Auren's `cape`. Hers was bone-driven
    // rather than free, which made it the least wrong of the five and still a
    // sheet at a fixed offset behind the spine. The `cape` garment in her stack
    // is the mantle, fitted to her shoulders, with the feather ruff over it.
    // (`feathers` fed `buildAccessories`' fan, which only runs when
    // `accessories.collar === 'feather'`; hers is `'none'` and has been since
    // the ruff moved to a `furCollar` garment, so nothing else read this block.)
    cape: null,

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
      // The feather-mantle, replacing the simulated panel. Short and wide with a
      // shallow bow, because it has to end above the wrap skirt's waist — she is
      // the one party member whose lower silhouette is legs, and a cape that
      // reaches the hip would take that away.
      {
        kind: 'cape', color: 'identity', lining: 'trim', piping: 'trim',
        turnColor: 'secondary', length: 0.26, wrap: 0.72, spread: 0.12,
        lift: 0.42, bow: 0.38, flare: 1.22, folds: 8, foldDepth: 0.074,
        claspColor: 'spark',
      },
      {
        kind: 'furCollar', mode: 'feather', color: 'trim', shade: 'identity',
        fins: 3, tufts: 16, rows: 1, length: 0.074, radius: 1.70, arc: 0.86,
        liftBack: 0.45, liftFront: -0.25,
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
        pipingColor: 'trim', beadColor: 'trim', length: 0.26, flare: 1.90, top: 0.10,
        // Twelve folds on a 0.26 H wrap is tight, which is what a short wrap
        // gathered at the hip actually does, and one bone trim band above the
        // hem gives the shortest skirt in the party a second horizontal edge.
        folds: 12, foldDepth: 0.086, foldOnset: 0.06,
        bands: 1, bandColor: 'trim', bandHeight: 0.045,
      },
      {
        kind: 'underskirt', color: 'secondary', turnColor: 'leather', pipingColor: 'trim',
        length: 0.32, flare: 1.55, top: 0.06, folds: 8, foldDepth: 0.070,
      },
      {
        kind: 'belt', at: 'hip', color: 'leather', buckle: 'trim', width: 0.038,
        buckleWidth: 0.048, buckleHeight: 0.034, tailSide: 'L', over: 0.52,
      },
      {
        kind: 'strap', side: 'R', color: 'leather', buckle: 'trim',
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
