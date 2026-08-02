/**
 * colorGrades.js — the named grades, and the CPU baker that turns them into a
 * 3D colour cube stored as a horizontally tiled strip.
 *
 * Why a baked cube rather than evaluating the grade maths in the shader: the
 * grade is eight chained non-linear operations (contrast pivot, lift/gamma/gain,
 * two luminance-preserving split tones, a channel-crosstalk matrix, saturation
 * and a tinted black floor). Evaluating that per pixel is ~40 ALU including
 * three `pow`s; evaluating it into a 32³ cube costs 32768 iterations *once per
 * grade change* and reduces the per-pixel cost to two texture fetches and a
 * lerp. It also means a colourist could later swap in an authored .cube file
 * without touching a line of GLSL.
 *
 * Every grade is expressed as pure numbers — no hex strings, no colour objects —
 * precisely so that `PostFX.setGrade` can linearly interpolate two grades and
 * bake the intermediate, which is what makes the cross-fade continuous even if
 * a second `setGrade` interrupts the first mid-flight.
 *
 * All maths here happens in *display-referred* space (post tone map, post sRGB
 * encode), which is where lift/gamma/gain was defined and where it behaves.
 */

/** sRGB midtone pivot: srgbEncode(0.18) ≈ 0.433. Contrast rotates about this. */
const PIVOT = 0.435;

const REC709 = [0.2126, 0.7152, 0.0722];

function lum(c) {
  return c[0] * REC709[0] + c[1] * REC709[1] + c[2] * REC709[2];
}

/**
 * Base grade every preset is a delta from. Values come straight out of
 * ART_BIBLE §6: split-tone shadows toward SHADOW_TINT at 0.6, highlights toward
 * KEY_SUN at 0.45, saturation 1.05, contrast 1.06, floor lifted to teal-black.
 */
function base(overrides) {
  return Object.assign(
    {
      lift: [0, 0, 0],
      gamma: [1, 1, 1],
      gain: [1, 1, 1],
      contrast: 1.06,
      saturation: 1.05,
      // r<-g, r<-b, g<-r, g<-b, b<-r, b<-g
      crosstalk: [0, 0, 0, 0, 0, 0],
      shadowTint: [0.18, 0.29, 0.373], // #2E4A5F
      shadowMix: 0.6,
      highTint: [1.0, 0.851, 0.639], // #FFD9A3
      highMix: 0.45,
      // Tinted black floor. ART_BIBLE §2.3: input 0.0 must land near 0.02
      // output, tinted #0A1218 — never a true black across large areas.
      // #0A1218 has a display luminance of 0.066, so 0.30 of it lands the floor
      // at 0.02 while leaving white untouched (the blend is a lerp, not an add).
      floor: [0.039, 0.071, 0.094],
      floorAmount: 0.3,
      // Uniform-only channels: cross-faded alongside the cube but never baked
      // into it, because they drive stages that are not a colour lookup.
      grain: 0.035,
      vignette: 0.28,
      // Total R<->B separation at the frame corner as a fraction of frame
      // width — the same unit ART_BIBLE §6 quotes its `void` and impact figures
      // in, so these numbers are resolution-independent and directly auditable
      // against the document.
      //
      // Every steady-state figure in this file is the bible's value divided by
      // four. The art review found visible fringing on high-contrast edges at
      // the bible's 0.0012, and it is right: 0.0012 is 2.3 px of separation on
      // a 1920-wide frame, which is wider than the ink outline the cast is
      // supposed to be read by. At 0.0003 the corner separation is 0.58 px —
      // below the threshold at which three channels can resolve as colour, so
      // the steady state is a lens characteristic you cannot name rather than
      // an artefact you can see. The *impact* spike is deliberately not scaled
      // (see PostFX.ABERRATION_IMPACT_SPIKE): a crit is a transient and is
      // supposed to be seen.
      aberration: 0.0003,
      exposure: 1.0, // multiplicative trim on renderer.toneMappingExposure
    },
    overrides,
  );
}

/**
 * The eight contracted grades plus the five ART_BIBLE mood grades. Names are
 * the public API of `setGrade`; unknown names fall back to 'neutral' with a
 * console warning rather than throwing, because a grade typo in a cutscene
 * script must not take the frame down.
 */
export const GRADES = {
  // Contract-mandated set -------------------------------------------------
  neutral: base({}),

  dawn: base({
    // Low warm key, long shadows, air still cold. Warmth lives in the gain,
    // coolness in the shadow tone — the two must not fight in the same channel.
    gain: [1.04, 1.0, 0.97],
    lift: [0.006, 0.004, 0.012],
    contrast: 1.04,
    saturation: 1.06,
    shadowTint: [0.227, 0.306, 0.42], // #3A4E6B
    shadowMix: 0.58,
    highTint: [1.0, 0.702, 0.494], // #FFB37E
    highMix: 0.5,
    crosstalk: [0.0, 0.0, 0.02, 0.0, 0.0, 0.03],
    exposure: 1.05,
  }),

  dusk: base({
    // The hero key. Everything the art bible calls "the single image" lands
    // here: amber highlight, violet-teal shadow, one stop more contrast.
    gain: [1.05, 0.995, 0.965],
    contrast: 1.09,
    saturation: 1.08,
    shadowTint: [0.208, 0.153, 0.369], // #35275E
    shadowMix: 0.55,
    highTint: [1.0, 0.62, 0.42], // #FF9E6B
    highMix: 0.5,
    crosstalk: [0.0, 0.02, 0.0, 0.0, 0.04, 0.0],
    vignette: 0.3,
    exposure: 1.15,
  }),

  night: base({
    // Crushed and cold, but never neutral black: the floor stays teal so the
    // "no grey shadows" rule survives even at 2% output.
    gain: [0.95, 0.985, 1.05],
    gamma: [1.0, 1.0, 0.97],
    contrast: 1.12,
    saturation: 0.92,
    shadowTint: [0.086, 0.157, 0.235], // #16283C
    shadowMix: 0.7,
    highTint: [0.659, 0.784, 0.91], // #A8C8E8
    highMix: 0.35,
    // Night crushes hardest, so it needs the most floor lift to stay off pure
    // black — a flat black night sky is the fastest way to look cheap.
    floorAmount: 0.42,
    grain: 0.042,
    vignette: 0.32,
    exposure: 1.25,
  }),

  battle: base({
    // Punchier than field but the same family — a battle must not look like a
    // different game. Extra contrast, extra chroma, slightly tighter vignette.
    contrast: 1.14,
    saturation: 1.12,
    gain: [1.02, 1.0, 1.0],
    shadowTint: [0.133, 0.22, 0.29], // #22384A
    shadowMix: 0.55,
    highMix: 0.4,
    vignette: 0.3,
    // A hair over steady state; a battle frame should read fractionally more
    // 'lensed' than a field frame without the difference being nameable.
    aberration: 0.00034,
  }),

  boss: base({
    // Menace = violet shadows plus a magenta highlight fringe, and enough
    // red-into-blue crosstalk that skin reads faintly bruised.
    contrast: 1.18,
    saturation: 1.06,
    gain: [1.03, 0.97, 1.02],
    shadowTint: [0.169, 0.071, 0.271], // #2B1245
    shadowMix: 0.66,
    highTint: [0.851, 0.302, 0.549], // #D94D8C
    highMix: 0.32,
    crosstalk: [0.0, 0.05, 0.0, 0.0, 0.06, 0.0],
    vignette: 0.36,
    aberration: 0.00038,
    exposure: 0.98,
  }),

  memory: base({
    // Flashbacks: milky lifted blacks, low chroma, low contrast — the frame
    // reads as a faded print rather than as a colour-timed shot.
    // The milky lift has to stay measurably cool. A neutral-grey lifted black
    // would break the shadow rule outright, and a faded print reads as
    // *aged*, not as *desaturated*, only if the black still carries a hue.
    lift: [0.04, 0.05, 0.066],
    gamma: [1.05, 1.04, 1.02],
    contrast: 0.9,
    saturation: 0.68,
    shadowTint: [0.29, 0.369, 0.42], // #4A5E6B
    shadowMix: 0.5,
    highTint: [1.0, 0.914, 0.816], // #FFE9D0
    highMix: 0.55,
    floorAmount: 0.2,
    grain: 0.052,
    vignette: 0.34,
    // Half steady state: a faded print has soft optics, not dispersive ones.
    aberration: 0.00015,
    exposure: 0.95,
  }),

  victory: base({
    // Bright, warm, generous. The only grade allowed to lift midtones.
    gain: [1.06, 1.04, 1.0],
    lift: [0.012, 0.012, 0.008],
    contrast: 1.02,
    saturation: 1.16,
    shadowMix: 0.4,
    highTint: [1.0, 0.941, 0.722], // #FFF0B8
    highMix: 0.55,
    grain: 0.028,
    vignette: 0.22,
    exposure: 1.08,
  }),

  // ART_BIBLE §6 mood grades ---------------------------------------------
  sorrow: base({
    saturation: 0.85,
    contrast: 1.02,
    shadowTint: [0.133, 0.22, 0.29], // #22384A
    shadowMix: 0.66,
    grain: 0.05,
    vignette: 0.3,
  }),

  ember: base({
    gain: [1.06, 0.99, 0.94],
    contrast: 1.1,
    saturation: 1.1,
    highTint: [1.0, 0.702, 0.42], // #FFB36B
    highMix: 0.5,
    crosstalk: [0.0, 0.0, 0.03, 0.0, 0.0, 0.0],
    vignette: 0.34,
  }),

  void: base({
    contrast: 1.14,
    saturation: 0.96,
    shadowTint: [0.169, 0.071, 0.271], // #2B1245
    shadowMix: 0.68,
    highMix: 0.35,
    // ART_BIBLE §6 names 0.002 for `void`; quartered with every other steady
    // state above, so `void` keeps its 1.67x lead over `neutral`.
    aberration: 0.0005,
    vignette: 0.34,
  }),

  verdant: base({
    gain: [0.98, 1.03, 0.98],
    saturation: 1.08,
    shadowTint: [0.478, 0.62, 0.42], // #7A9E6B, bounce-tinted
    shadowMix: 0.45,
    crosstalk: [0.0, 0.0, 0.0, 0.03, 0.0, 0.0],
  }),
};

/** `default` is the ARCHITECTURE spelling of `neutral`; keep both alive. */
GRADES.default = GRADES.neutral;

/** Scalars carried by a grade that drive uniforms instead of the cube. */
export const GRADE_SCALARS = ['grain', 'vignette', 'aberration', 'exposure'];

/** Component-wise lerp of two grade descriptors. Used to bake the frozen
 *  midpoint when a cross-fade is interrupted by another `setGrade`. */
export function lerpGrade(a, b, t) {
  const out = {};
  for (const key of Object.keys(a)) {
    const va = a[key];
    const vb = b[key];
    if (Array.isArray(va)) {
      out[key] = va.map((v, i) => v + (vb[i] - v) * t);
    } else {
      out[key] = va + (vb - va) * t;
    }
  }
  return out;
}

/** Luminance-preserving recolour: pushes hue toward `tint` without changing
 *  how bright the pixel reads, which is what keeps a split tone from turning
 *  into a milky wash. */
function tintToward(c, tint, amount) {
  if (amount <= 0) return;
  const l = lum(c);
  const tl = Math.max(1e-3, lum(tint));
  const k = l / tl;
  c[0] += (tint[0] * k - c[0]) * amount;
  c[1] += (tint[1] * k - c[1]) * amount;
  c[2] += (tint[2] * k - c[2]) * amount;
}

/**
 * Evaluate one grade for one display-referred colour, in place.
 * Order is fixed and matters: contrast before lift/gamma/gain (so the pivot is
 * meaningful), tone before crosstalk (so the bleed picks up the toned hue),
 * saturation last but one, floor last so nothing can push a black below it.
 */
function evalGrade(c, p) {
  for (let i = 0; i < 3; i++) {
    c[i] = PIVOT + (c[i] - PIVOT) * p.contrast;
    c[i] = p.gain[i] * (c[i] + p.lift[i] * (1 - c[i]));
    c[i] = Math.pow(Math.max(0, c[i]), 1 / p.gamma[i]);
  }

  const l = lum(c);
  const wShadow = (1 - l) * (1 - l);
  const wHigh = l * l;
  tintToward(c, p.shadowTint, wShadow * p.shadowMix * 0.5);
  tintToward(c, p.highTint, wHigh * p.highMix * 0.5);

  const x = p.crosstalk;
  const r = c[0] + x[0] * c[1] + x[1] * c[2];
  const g = c[1] + x[2] * c[0] + x[3] * c[2];
  const b = c[2] + x[4] * c[0] + x[5] * c[1];
  c[0] = r / (1 + x[0] + x[1]);
  c[1] = g / (1 + x[2] + x[3]);
  c[2] = b / (1 + x[4] + x[5]);

  const l2 = lum(c);
  c[0] = l2 + (c[0] - l2) * p.saturation;
  c[1] = l2 + (c[1] - l2) * p.saturation;
  c[2] = l2 + (c[2] - l2) * p.saturation;

  const fa = p.floorAmount;
  if (fa > 0) {
    for (let i = 0; i < 3; i++) {
      c[i] = p.floor[i] * fa + c[i] * (1 - p.floor[i] * fa);
    }
  }

  for (let i = 0; i < 3; i++) c[i] = Math.min(1, Math.max(0, c[i]));
}

/**
 * Bake a grade into an RGBA8 strip of `size` slices, laid out left to right by
 * blue. Writes into `target` (a Uint8Array of size*size*size*4) so the caller
 * can reuse one allocation for the life of the process — this runs on the main
 * thread during a cross-fade and must not generate garbage.
 *
 * @param {object} params - a grade descriptor from GRADES (or a lerp of two)
 * @param {number} size - cube edge, 32 in practice
 * @param {Uint8Array} target - destination, length size^3 * 4
 */
export function bakeGradeStrip(params, size, target) {
  const width = size * size;
  const inv = 1 / (size - 1);
  const c = [0, 0, 0];
  for (let bi = 0; bi < size; bi++) {
    const bv = bi * inv;
    const xBase = bi * size;
    for (let gi = 0; gi < size; gi++) {
      const gv = gi * inv;
      const rowBase = (gi * width + xBase) * 4;
      for (let ri = 0; ri < size; ri++) {
        c[0] = ri * inv;
        c[1] = gv;
        c[2] = bv;
        evalGrade(c, params);
        const o = rowBase + ri * 4;
        target[o] = (c[0] * 255 + 0.5) | 0;
        target[o + 1] = (c[1] * 255 + 0.5) | 0;
        target[o + 2] = (c[2] * 255 + 0.5) | 0;
        target[o + 3] = 255;
      }
    }
  }
  return target;
}
