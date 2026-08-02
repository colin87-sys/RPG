/**
 * Lighting — the three-point rig, the cascaded shadow solver and the dynamic
 * light budget.
 *
 * REFERENCE_TARGET section 1 is unambiguous about what this module exists to
 * deliver: a chibi character, roughly eighty pixels tall, must separate from a
 * misty desaturated background in every single frame. That is a *lighting*
 * problem before it is a shading problem, and it decomposes into exactly three
 * jobs:
 *
 *  1. **KEY** — one directional light, colour and *azimuth* taken verbatim from
 *     `Sky` so the shadow direction and the sun disc in frame can never point
 *     to two different places. Its elevation is held inside a staging band; see
 *     `KEY_STAGE_ELEVATION_MAX_DEG`, which is the one axis this rig overrules
 *     `Sky` on and the reason it does. Its relative intensity through the day is
 *     the ART_BIBLE section 3 table, which `Sky` already interpolates;
 *     re-deriving it here would give the game two disagreeing opinions about
 *     noon.
 *
 *  2. **FILL** — one ambient budget spent across two terms rather than two terms
 *     each spending whatever they like. A hemisphere light, never an
 *     `AmbientLight` (a constant term kills form entirely), and the PMREM probe,
 *     which this module owns per the ARCHITECTURE service table. The
 *     hemisphere's sky colour is the *actual* rendered sky zenith pushed halfway
 *     to `SHADOW_TINT`, which is the literal formula in section 2.1's shadow
 *     rule; its ground colour is `BOUNCE_GROUND`. Both are run through a
 *     saturation floor and a hue window so the rule ("a white surface in full
 *     shadow must not eyedrop to zero saturation") is enforced by construction,
 *     and both are then **normalised to a fixed luminance** so that those rules
 *     govern hue alone and the *level* is decided in exactly one place. That
 *     split is not cosmetic — before it, the fill's real contribution was its
 *     intensity times a 0.088-luminance navy, i.e. an order of magnitude under
 *     what the budget believed it was spending, and every shadow side in the
 *     game sat at 13% of its lit side. How much the budget is, why it is a share
 *     of the key rather than an absolute, and what it is solved against, is
 *     `AMBIENT_KEY_SHARE`.
 *
 *  3. **RIM** — a second directional light opposite the key in azimuth, low over
 *     the horizon, tinted toward `RING_GLOW`. ART_BIBLE section 3's dusk note
 *     names its source precisely: the moon-ring, which hangs on the opposite
 *     side of the sky from the sun, at intensity 0.8. In this art style the rim
 *     is not garnish; it is the entire reason the silhouette survives against
 *     fog of a similar value. It does not cast shadows — a shadowing back light
 *     fights the key for the same surfaces and costs a second full shadow pass
 *     for no visual gain.
 *
 * **The chroma contract.** A lighting rig does not only decide how bright a
 * frame is; it decides what hue every non-emissive surface in it can possibly
 * be. Painted albedo is desaturated by contract (ART_BIBLE section 4 caps every
 * surface inside a narrow luminance band and section 2.2 reserves full chroma
 * for magic), so the dominant chroma bucket of a rendered frame is whatever
 * colour the key light and the in-scattered fog are. `Sky` derives both
 * *radiometrically* — the sun disc reddens through a long air mass at low
 * elevation and the fog is sampled from the horizon the dome is painting — and
 * a radiometric answer is not an art-directed one: at the hero dusk key that
 * pipeline lands the key near hue 0 and the fog on the mauve `#8A5E7A`, which
 * is how a frame ends up with its largest chroma bucket at pure red and half
 * its chroma inside the red-magenta wedge that section 2.2 reserves for enemies
 * and dark magic. So the rig projects both terms onto the section 2.1 gamut
 * (`_conformChroma`) before they reach a light: luminance and the time-of-day
 * warmth trend survive untouched, only out-of-contract chroma is pulled back.
 * The projection is a *clamp*, not an override — an already-legal colour comes
 * through bit-identical, so a zone or weather tint that respects the palette is
 * never fought, and fixing the upstream table would silently make this a no-op.
 *
 * **Why the rim is directional, and why it is no longer pinned in HDR.** An
 * earlier revision solved the character rim's strength every frame so its
 * hottest sliver landed on a fixed pre-tonemap radiance just past the bloom
 * threshold, on the theory that ART_BIBLE section 2.3 permits rims past 1.0 and
 * asks for ~10% of pixels above 0.75. That reasoning is sound only if the rim is
 * actually a *rim*. It was not: the toon rim's directional weight carried a
 * floor (`uToonRimFloor`, 0.20–0.40 across the presets), so the fresnel band
 * wrapped the entire silhouette at near-constant width, and normalising its
 * peak channel past 1.0 blew that band to white through bloom. The result was a
 * uniform cyan-white halo of constant width on every edge in frame — undersides,
 * shadow flanks, background treeline — which reads as die-cut and pasted on and
 * cancels exactly the integration the mist and DOF are buying. It is the single
 * defect a reviewer named first.
 *
 * The rim is therefore rebuilt as light rather than as ink, in three parts that
 * have to agree. The direction, colour and intensity were always the rig's to
 * own; the shape has to be too, or the parts disagree and one wins by accident.
 *
 *  - **Shape.** The rig publishes the rim's *whole* falloff to the materials
 *    that consume it (`_applyRimContract`) — floor, focus, exponent, width and
 *    window — not just the parts the presets happened to leave alone. The
 *    directional term is floored at zero so the rim dies across the whole
 *    key-facing side, and the profile is authored geometrically, in `N·V`, so
 *    "the band occupies the outer ~7% of a silhouette's projected radius" is a
 *    statement the code makes rather than an emergent property of three coupled
 *    knobs owned by two modules. See `RIM_REACH_NV`. Its direction is the
 *    anti-key, so the mask the materials evaluate is `saturate(N · -L_key)` in
 *    all but name — one vector for the whole cast, restated every sweep so a
 *    per-material art default cannot quietly reintroduce a per-character one.
 *
 *  - **Colour.** The character rim is split from the analytic rim light and both
 *    are teal, per REFERENCE_TARGET section 4's "teal across mist, sky, UI and
 *    rim light". An earlier revision made the character rim warm amber on the
 *    argument that a teal rim on a teal mist has no hue contrast. The premise is
 *    right; the conclusion is not, because hue is not the only axis. The mist is
 *    held under `HAZE_CHROMA_CEILING` and the rim is allowed
 *    `CHAR_RIM_CHROMA_CEILING`, better than 1.7× as much, and the radiance solve
 *    puts it a stop and a half above the mist in value — so the edge separates
 *    on chroma and value while the frame keeps its cool cast. A warm sliver on a
 *    lit shoulder, by contrast, is the first thing in frame to reach white.
 *
 *  - **Radiance.** The rim is solved against the background it separates from
 *    rather than against a constant. In an atmospheric frame the fog *is* the
 *    value the cast reads against, so the target is a fixed contrast ratio over
 *    the conformed fog luminance, bounded by a cap authored on *screen* and
 *    inverted through the tone curve and the live exposure (`RIM_DISPLAY_CAP`).
 *    A pre-tonemap constant cannot promise "does not blow out" when the rig is
 *    itself moving exposure across the day, and `_applyRimBound` turns the same
 *    cap into an algebraic guarantee inside the shader's own headroom term. The
 *    solve also has to know what gain the materials it lights actually carry,
 *    which it measures rather than assumes; see `_rimGainPeak`.
 *
 * **Cascades.** Shadow texel density is what makes a 1.2 m chibi read as a solid
 * object rather than a smudge, and a single ortho frustum stretched over a 120 m
 * field cannot deliver it. We drive `three/examples/jsm/csm/CSM.js` (verified
 * present in three 0.185; the WebGPU-only `CSMShadowNode` is the one to avoid),
 * with a custom split so cascade 0 lands around 9 m — the distance the fixed
 * side-view battle camera actually stands at. CSM's own `practical` mode hard-
 * codes lambda 0.5, which spends far too much of the near cascade on empty air.
 *
 * CSM requires every lit material to be registered so its shader can select a
 * cascade instead of summing all of them. In a codebase where a dozen authors
 * build materials in parallel, "remember to call `setupMaterial`" is a bug
 * waiting to happen, so this module scans the active scene on a low-frequency
 * cadence and registers what it finds. Registration chains rather than replaces
 * `onBeforeCompile`, and `dispose()` unpatches everything — `AssetForge` caches
 * materials across scene swaps, so a stale closure holding a dead CSM instance
 * would otherwise survive into the next scene.
 *
 * **Light budget.** Adding or removing a light changes `NUM_POINT_LIGHTS`, which
 * invalidates every program in the scene. Doing that on a spell cast is a
 * guaranteed multi-frame hitch in the middle of combat. So the pool is allocated
 * once, at a size fixed by quality, and its lights are *always present and
 * always visible* — idle ones simply sit at intensity 0. Acquire never fails; if
 * the pool is saturated it evicts the lowest-priority, oldest light, because a
 * missing light on a Firaga is far more visible than a dimmed torch.
 *
 * **Where the numbers come from.** The elevation band, the fill share, the
 * shadow depth, the haze colour, the haze density and the exposure calibration
 * are all fitted to `docs/reference/bravely01.jpg` and each states its
 * measurement at its own definition. Where the plate and the prose specs
 * disagree the plate wins — `docs/reference/README.md` says so, and on the two
 * points where it mattered here (the exposure of the frame and the depth of the
 * shadow band) the specs were not slightly off, they were the wrong side of the
 * target.
 *
 * OWNED BY: render/Lighting.js.
 */
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { bus } from '../core/EventBus.js';
import { gameState, rng } from '../core/GameState.js';
import {
  LIGHT,
  MIN_SHADOW_SATURATION,
  SURFACE_TINT,
  HERO_TIME_OF_DAY,
  sampleTimeOfDay,
} from '../art/Palette.js';

/* -------------------------------------------------------------------------- */
/* Tuning constants — every one of these is a decision, not a magic number.    */
/* -------------------------------------------------------------------------- */

/**
 * Quality tiers.
 *
 * `cascades` never drops below 3 even on `low`: two cascades over a 120 m range
 * puts the split at ~25 m, and the far cascade's texels become coarse enough
 * that a character's contact shadow detaches. `shadowMapSize` never drops below
 * 1024 because ART_BIBLE section 7.6 lists sub-1024 key shadows as a failed
 * review. `pointLights` is the hard budget the pool allocates up front.
 */
const QUALITY = {
  low: { cascades: 3, shadowMapSize: 1024, pointLights: 3, shadowPoint: false },
  medium: { cascades: 3, shadowMapSize: 2048, pointLights: 4, shadowPoint: false },
  high: { cascades: 4, shadowMapSize: 2048, pointLights: 6, shadowPoint: true },
  ultra: { cascades: 4, shadowMapSize: 3072, pointLights: 8, shadowPoint: true },
};

/**
 * Split blend between a uniform and a logarithmic cascade distribution.
 *
 * 0 is uniform (wastes the near cascade), 1 is logarithmic (starves the far
 * one). 0.72 puts the first break at ~9 m for a 0.1–120 m range over four
 * cascades, which brackets the fixed side-view battle stage: the whole party
 * and the enemy line sit inside cascade 0 at roughly 1 cm texels.
 */
const SPLIT_LAMBDA = 0.72;

/** Default shadow range in metres. Beyond this, fog has eaten the contrast
 *  anyway (ART_BIBLE section 5.5 wants layers separated by 25–40 m), so shadows
 *  there would cost texels to render something the grade throws away. */
const DEFAULT_SHADOW_DISTANCE = 120;

/**
 * Distance the cascade light is pulled back along its own direction, and the
 * tallest caster the rig promises to capture above a cascade slice.
 *
 * These two numbers together define each cascade's shadow-camera depth range,
 * and that range is not a free parameter under VSM. three stores VSM's two
 * moments in the shadow camera's *normalised* depth, so a range far larger than
 * the geometry in it spends all of its precision on empty air: a 0.3 m
 * occluder-to-receiver gap — precisely the gap a contact shadow is made of —
 * lands inside a couple of ULPs of the blurred mean, the variance term swamps
 * it, and `VSMShadow`'s light-bleed reconstruction returns "lit". The visible
 * symptom is exactly the review's: long shadows survive, but the darkening
 * *under* a character's feet does not, and every figure reads pasted onto the
 * terrain.
 *
 * The old rig ran every cascade at near 0.5 / far `shadowDistance * 2.5 + 45`,
 * i.e. a ~195 m range to shadow a 4.6 m near cascade. `_applyCascadeBias` now
 * derives near and far per cascade from these two constants and the cascade's
 * own extent, which is an order of magnitude tighter. The margin still has to
 * clear the tallest caster standing above a slice (a boss occupying 60% of
 * frame height is under 10 m; the treeline is the real driver), and the near
 * plane sits `MAX_CASTER_HEIGHT` short of it so those casters are still inside
 * the frustum rather than clipped out of their own shadow.
 */
const LIGHT_MARGIN = 28;
const MAX_CASTER_HEIGHT = 14;
/** Padding on the far plane so a cascade's light-space depth extent — bounded
 *  above by its own diagonal, which is what `_updateShadowBounds` writes into
 *  the ortho width — can never clip its own back face. */
const SHADOW_DEPTH_SLACK = 2;

/**
 * The staging band the key's elevation is held inside, in degrees.
 *
 * This is the one quantity the rig takes off `Sky` and does not use as given,
 * and the reason is the same one that already governs `RIM_ELEVATION_MIN_DEG`:
 * a chibi is a *vertical* silhouette standing on a *horizontal* stage, and a
 * high light serves neither. `LookdevScene` stages its meadow near midday, which
 * puts the sun at 55 degrees, and at 55 degrees three things go wrong at once
 * and all three were named in review. A 1.2 m figure throws a 0.83 m shadow that
 * lands entirely behind its own feet, so the frame has no visible cast shadow
 * and the cast reads as pasted on. The key's horizontal component is only 0.57,
 * so a torso — which faces outward, not upward — is lit at little better than
 * half strength while the tops of heads and shoulders take the peak, which
 * flattens every form and leaves the terminator up in the hair where it does no
 * modelling. And the ground plane, which faces the light square on, takes the
 * *full* key, so the field is the brightest thing in frame and the party is not.
 *
 * Clamping the elevation fixes all three geometrically rather than by grading:
 * the shadow grows and fans out either side of the figure, the horizontal
 * component rises so the key rakes across the body and writes a real warm/cool
 * split, and the ground's own N·L drops — so the field darkens while the
 * characters brighten, which is exactly the "lift the subject relative to the
 * field" the value note asks for, bought without touching a single exposure.
 *
 * The ceiling is **40 degrees**, measured off `bravely01.jpg` rather than
 * argued down from the geometry alone. The plate's cast shadows run short and
 * forward-left of each figure and its terminators sit low on the torso rather
 * than up in the hair, which is a mid-morning sun — not the 55-62 degrees the
 * section 3 table puts overhead at the stage hour, and not the 34 an earlier
 * revision of this file dramatised it down to either. Thirty-four raked the key
 * so far across the body that the lit side became a narrow band on one flank;
 * forty keeps the terminator on the chest where the plate has it while still
 * throwing a shadow the fixed 9-degree-down battle camera can see.
 *
 * **Azimuth is untouched, and that is what keeps this honest.** The review's
 * test for a committed key is "you can point at the sun", and that is a
 * statement about *where in plan* the shadows run — which still agrees with the
 * dome exactly. Only the elevation is dramatised, and only downward, so the disc
 * can never end up on the opposite side of the sky from the shadows it casts.
 * The floor is the same idea at the other end: at the hero dusk key the sun sits
 * at 6 degrees, where the ground's N·L is 0.10 and the whole stage falls into a
 * near-black grazing light with the fill carrying the entire frame. Twelve
 * degrees is still unmistakably a low sun and still leaves the terminator low on
 * the body; it just keeps a floor under the stage.
 */
const KEY_STAGE_ELEVATION_MIN_DEG = 12;
const KEY_STAGE_ELEVATION_MAX_DEG = 40;

/**
 * The daylight white balance the meadow key is held at, and the sun height band
 * over which that hold fades in.
 *
 * Measured off `docs/reference/bravely01.jpg` rather than transcribed: the
 * plate's lit surfaces carry a gentle warm cast — the white hat's sunlit crown
 * eyedrops to (185, 195, 206) against an underside of (132, 141, 143), so the
 * *lit* side is barely warm at all and the frame's warmth lives in the grass
 * and skin rather than in a hot amber key. Sampling the section 3 table at the
 * stage hour and mixing it in linear light gives (255, 222, 195), which is a
 * ~4900 K blackbody: the table is already almost exactly right for this hour,
 * and the point of this band is not to *change* it but to stop it drifting out
 * of the late-morning look as the clock moves either side of noon.
 *
 * The band is therefore a clamp with a floor and a ceiling, applied only while
 * the sun is genuinely high. `dayness` is the wrong gate for it — that term is
 * still 0.86 at the hero dusk key, where the sun is a 1900 K disc and clamping
 * it to 4400 K would delete the one hour the art direction is composed around.
 * `KEY_DAYLIGHT_HEIGHT_*` is a *sun height* window instead: full authority with
 * the sun above ~46 degrees, none below ~27, so the meadow hours are guaranteed
 * and every low-sun hour keeps the table's colour untouched.
 */
const KEY_WHITE_MIN_K = 4400;
const KEY_WHITE_MAX_K = 5600;
const KEY_DAYLIGHT_HEIGHT_LOW = 0.45;
const KEY_DAYLIGHT_HEIGHT_HIGH = 0.72;

/**
 * The ambient budget, as a target share *of the key*, plus an absolute floor.
 *
 * This is the number the art director's "character shadow sides are grey-black"
 * note is actually about, and the arithmetic the previous revision was doing had
 * gone badly wrong in a way no amount of tuning the share would have reached.
 *
 * The hemisphere carries a *colour* as well as a level, and that colour was
 * `mix(skyZenith, SHADOW_TINT, 0.5)` — the section 2.1 shadow recipe, which is a
 * dark navy-teal measuring **0.088 relative luminance**. three multiplies colour
 * by intensity, so the fill's real contribution was `fillIntensity × 0.088`. At
 * the stage hour the budget solved to 0.33, the probe took 0.125 of it and the
 * hemisphere was left with 0.205 — i.e. **0.018** of actual radiance against a
 * key delivering 1.69 to a lit ground plane. That is a fill/key ratio of about
 * 1%, not the 11% the constant claimed, and it puts a shadow side at roughly
 * 13% of its lit side on screen. Thirteen percent is not a cool shadow, it is a
 * hole, and it is exactly what the review measured.
 *
 * Two changes make the number mean what it says. `_normaliseFill` rescales both
 * hemisphere colours to unit luminance so the *level* lives entirely in the
 * intensity and the *hue* entirely in the colour (which is what the shadow rule
 * is a statement about — it constrains hue and saturation, never brightness).
 * And the share becomes a target rather than a ceiling clamped under the section
 * 3 `ambient` column: that column is written against a fill colour this rig no
 * longer uses, so as an upper bound it was silently deciding the whole budget.
 * It survives as a *floor*, which is the job it is genuinely good at — section 3
 * raises it at night precisely when the key falls away.
 *
 * 0.30 is solved from the plate, not chosen. `bravely01.jpg` measures a fully
 * unlit surface against a fully lit one twice — the white hat's underside at
 * 0.545 display against its crown at 0.758, and the cast shadow under Gloria at
 * 0.276 against open ground at 0.411 — i.e. **67–72% on screen**, which through
 * the sRGB encode is a linear ratio near 0.41. Solving `φ/(1 + φ) = 0.29` for a
 * key of 2.91 raking a ground plane at 40 degrees puts the hemisphere at 0.71
 * with the probe taking 0.28 alongside it, and lands a torso's shadow side near
 * 55% of its lit side on screen — the bottom of the 55–60% band this workstream
 * was given, and a little firmer than the plate so a chibi keeps its form at the
 * 80 px the battle camera gives it.
 */
const AMBIENT_KEY_SHARE = 0.34;
const AMBIENT_MIN = 0.34;

/**
 * The ground bounce's luminance, as a share of the sky fill's.
 *
 * Once both hemisphere colours carry hue only, *something* has to say which of
 * the two is brighter, and equal is the one answer that is definitely wrong: it
 * would light a chibi's chin as hard as the top of its head and flatten exactly
 * the form the fill is being raised to reveal. Half is the meadow's own
 * radiometry — the field is a ~0.25-albedo diffuser seeing a bright sky and a
 * raking sun, so it returns roughly half of what the sky above delivers — and it
 * is what the plate shows: undersides that are warm and clearly readable
 * (the white hat's brim at 0.545 display) but never as bright as the crown.
 */
const BOUNCE_SKY_SHARE = 0.5;

/**
 * The PMREM probe's share of that budget, and why the rig clamps it at all.
 *
 * The previous rig did not divide the budget. It handed the whole section 3
 * figure to the hemisphere and then took a flat 62% of it back on the theory
 * that a probe was carrying the rest — a guess, and a wrong one, because
 * `scene.environmentIntensity` is an independent number the scene sets and it
 * measured 0.28 against an assumed 0.196. The rig was better than 20% over its
 * own ambient budget and had no way to find out, and the probe is the *least*
 * forgiving place to be over: it is a constant, unoccluded, direction-blind lift
 * on every surface in frame, which is exactly the term that makes an image
 * chalky.
 *
 * ARCHITECTURE's service table already assigns the env probe to this module, so
 * the fix is to spend it from the same budget as everything else rather than
 * beside it. The share is high — over a third — because the probe is not only
 * ambient diffuse: it is also the environment *specular* that BRAVELY section 4
 * requires for armour to read as metal, and three drives both from one scalar.
 * Starving it to make the shadows deeper would trade one review note for
 * another.
 *
 * The clamp is one-directional. A scene that authors *less* probe than its share
 * keeps what it authored and the hemisphere absorbs the remainder; only an
 * over-budget probe is pulled back.
 */
const AMBIENT_PROBE_SHARE = 0.38;

/**
 * Why there is no fourth, downward, shadow-casting ambient light here.
 *
 * The obvious answer to "nothing darkens the ground under a character's boots"
 * is to give the sky term a shadow map: a near-vertical directional light
 * carrying part of the ambient, occluded by everything that casts, putting a
 * soft pool under every figure and prop from any light direction at any hour.
 * It is the right technique and it is the one thing this rig cannot have, for a
 * reason worth recording so it is not attempted twice.
 *
 * `three/examples/jsm/csm/CSMShader.js` replaces `lights_fragment_begin`
 * globally, and its directional loop assumes **every shadow-casting directional
 * light in the scene is a cascade**: it indexes `CSM_cascades[ i ]` for every
 * `i < NUM_DIR_LIGHT_SHADOWS` while the array is declared at length
 * `CSM_CASCADES`. Adding a fifth caster to a four-cascade rig therefore does not
 * merely misbehave, it fails to compile — `'[]' : array index out of range` on
 * every lit material in the scene, verified. Working around it means rewriting
 * the addon's uniform layout from outside (a longer `CSM_cascades`, a raised
 * `CSM_CASCADES` define, a hand-extended far cascade so geometry past the shadow
 * range keeps its key light, and a dependency on three's light sort being stable
 * so the extra caster lands last), on a chunk every other author's materials
 * compile through. That is a landmine, not a feature.
 *
 * So the contact floor is left to the layer that already owns it — characters
 * carry their own contact decals and the stage projects its own occlusion — and
 * the rig's contribution is to make the key's own shadow land where the camera
 * can see it (`KEY_STAGE_ELEVATION_MAX_DEG`) and to stop the ambient filling it
 * back in (`AMBIENT_KEY_SHARE`).
 */

/**
 * The aerial-perspective floor: the fraction of a surface's radiance the haze
 * must have replaced by the far end of the rig's own shadow range.
 *
 * Stated as an extinction at `shadowDistance` rather than as a density, because
 * density is a per-scene quantity with no meaning on its own — the same number
 * is imperceptible on a 20 m arena and opaque on a 300 m vista, and the rig
 * already knows how deep each scene's stage is because the scene told it.
 * Applied as a **floor**: a scene asking for more haze keeps it, so a night
 * battlefield or a storm is never fought.
 *
 * 0.52 is fitted to `bravely01.jpg`, which turns out to be a remarkably clean
 * measurement because the plate contains the same material at two depths. Its
 * near rock mass eyedrops to (41, 66, 93) and the receding rocks behind the
 * right-hand tree to (72, 89, 110), against a sky of (181, 202, 214). Solving
 * `far = mix(near, sky, f)` on luminance gives f = 0.178, and that single
 * fraction then predicts all three channels to within three levels — so the
 * plate's distance cue is a plain mix toward its own sky colour, not a
 * desaturation and a lift applied separately.
 *
 * The stage sets `shadowDistance` to 60 m and stands its treeline at ~30 m, so
 * 0.52 at 60 m is a density of 0.0144: 17% of the way to the haze at the tree
 * belt, which is the plate's number at the plate's equivalent depth, 34% on the
 * boulders behind it, and 1.7% on the party at 9 m — where the composite's
 * `uDehaze` removes even that. The previous 0.30 put 8.5% on the treeline, which
 * is under the threshold at which an eye reads depth at all, and left the
 * background to be faked afterwards by a flat lift in the grade.
 */
const AERIAL_EXTINCTION_AT_RANGE = 0.52;
const AERIAL_DENSITY_K = Math.sqrt(-Math.log(1 - AERIAL_EXTINCTION_AT_RANGE));

/**
 * The colour and the on-screen value the haze converges to in daylight.
 *
 * `FogExp2` carries one colour for every depth, so that colour *is* the frame's
 * horizon, its distance cue and — through the scene's fully-fogged skirt — the
 * band where the ground meets the sky. Getting it wrong is not a subtle error.
 *
 * The previous anchor was the palette's `FOG_NEAR` (#6E93A6), pulled to at least
 * 55% in chromaticity and then capped at 0.125. Measured against
 * the plate that is nearly twice as chromatic as it should be: `FOG_NEAR` sits
 * 0.150 from equal energy and the plate's sky sits **0.069**, at essentially the
 * same hue (205 against 200). A haze that saturated reads as a coloured scrim
 * rather than as air, and because `mixChroma` preserves the incoming luminance
 * it also inherited whatever value `Sky` happened to be painting the horizon —
 * which on the shipped frame left the background *darker* than the sky above it,
 * the one arrangement that cannot read as distance.
 *
 * So the anchor is the plate's own sky, and the value is authored where it is
 * meaningful: on screen. `HAZE_DISPLAY_LUMA` is inverted through the same ACES
 * fit and sRGB encode the composite grades with, and divided by the live
 * exposure at use, exactly as `RIM_DISPLAY_CAP` is — a pre-tonemap constant
 * cannot promise a display value while the clock is moving exposure. It is a
 * floor rather than an assignment, and it fades out with `dayness`, so a night
 * or storm frame keeps the dark haze its hour calls for.
 */
const HAZE_SKY = 0xb5cad6;
const HAZE_CHROMA_CEILING = 0.075;
const HAZE_DISPLAY_LUMA = 0.72;

/**
 * Rim azimuth offset from the key.
 *
 * ART_BIBLE section 3's dusk note is explicit that the rim comes "from the
 * ring's sky direction (opposite the sun azimuth)", and the ring is a fixed
 * feature of the sky rather than a light an artist placed for flattery, so 180
 * is not a stylistic choice here — it is where the source is. The previous 150
 * was chosen to keep one edge dominant, but that job belongs to the rim's
 * *directional falloff*, not to a fudged azimuth: with the falloff floored at
 * zero (see `RIM_CONTRACT`) an opposite-key rim already dies across the whole
 * key-facing side and narrows toward the terminator on its own.
 */
const RIM_AZIMUTH_DEG = 180;

/**
 * Rim elevation is derived from the key's, but clamped into this band.
 *
 * The band used to sit at 14–40 degrees, and that was measurably wrong: a
 * standing chibi is a vertical silhouette, so a back light at 19 degrees puts
 * its strongest N·L on the *up-facing* surfaces — the top of the oversized
 * cranium — and leaves the torso, cape and legs, which face outward rather than
 * upward, with almost none of it. Review frames showed exactly that: a hotspot
 * on each head and the lower 60% of every character dissolving into dark
 * ground. Pulling the band down to near-horizontal puts the peak on the
 * outward-facing back of the body, which is where the silhouette actually needs
 * separating. The floor is not zero because a perfectly horizontal rim carries
 * no vertical information at all and reads as a flat sticker edge; the ceiling
 * keeps a high noon rim from becoming a second key and flattening the form.
 *
 * The coupling to the key is *negative*, and that is the correction. The rim's
 * assigned mask is `saturate(N · -L_key)`, so the honest direction for it is the
 * anti-key — whose elevation is the key's, negated. A rim genuinely below the
 * horizon is a horror key and cannot be used literally, but the sign of the
 * relationship survives the clamp: a high sun puts its back light *low*, and
 * tracking that keeps the published rim direction as close to `-L_key` as a
 * usable light can get. The previous positive coupling did the reverse, and at
 * noon it aimed the rim 32 degrees up — the one place where "opposite the key"
 * and "where the rim actually points" disagreed most.
 */
const RIM_ELEVATION_MIN_DEG = 7;
const RIM_ELEVATION_MAX_DEG = 32;
const RIM_ELEVATION_FROM_KEY = -0.14;
const RIM_ELEVATION_BASE_DEG = 18;

/**
 * The *analytic* back light's level, expressed as a share of the key.
 *
 * This light is a `DirectionalLight` in the scene, which means every lit
 * material integrates it as ordinary diffuse radiance — including the toon
 * surfaces, whose `RE_Direct_Toon` accumulates `directLight.color` unramped and
 * weights each light's ramp by `share = max3(light.color) / max3(uKeyColor)`.
 * Two consequences follow, and the previous absolute pair (0.80 / 0.95) got both
 * of them wrong.
 *
 * First, a fixed intensity is only ever a fixed *ratio* against a fixed key, and
 * the key is not fixed: section 3 runs it from 3.0 at noon down toward the ring
 * at night. At the hero dusk key the old constants put the back light within a
 * few percent of the key's own level, so `share` went to ~1 and the rim stopped
 * being a rim — it became a co-dominant second key, adding a broad unramped
 * diffuse lift across every back-facing surface. That is exactly the defect the
 * review measured: a soft airbrush spread over the whole shoulder mass at ~250
 * luma, and a wash across hair that turned flat colour into translucent white.
 * A fresnel term cannot produce that shape; only a diffuse light can.
 *
 * Second, the fix cannot be "turn it down and hope", because the character rim
 * used to be *premultiplied by this same intensity* on its way to the shader —
 * so dimming the wash would have dimmed the edge that replaces it. That coupling
 * is cut in `_applyState`; the two rims are now independent, and this number is
 * free to be what a back light should be.
 *
 * A share of 0.16 keeps the analytic light firmly in the fill class at every
 * hour: it can never out-shade the key, so it lifts the environment's back
 * contours without ever writing a second terminator. The floor keeps a night
 * frame — where the key is the dim ring — from losing the environment's back
 * separation entirely; the ceiling stops a 3.0 noon key from promoting it.
 */
const RIM_KEY_SHARE = 0.19;
const RIM_INTENSITY_MIN = 0.12;
const RIM_INTENSITY_MAX = 0.45;

/**
 * The character rim's radiance target, expressed against the haze rather than
 * as a constant.
 *
 * Solving for **luminance** rather than for peak channel is one half of the
 * correction and it is not new: normalising the peak *channel* past 1.0 drives
 * one primary to the target and leaves the other two near zero, which is a white
 * line with a colourful name, and it is why every rim in every frame used to
 * read as an outline pass.
 *
 * The other half is what the target is measured against. It used to be a fixed
 * 0.80 pre-tonemap luminance, chosen once and then left to fend for itself while
 * `_conformAtmosphere` was independently deciding how bright the mist is. Those
 * two numbers have to be related or the rim has no defined contrast: the review
 * measured the party at L 80 against a mist band at L 149 and correctly reported
 * that nothing separates the cast from the background, which is what happens
 * when the separation device is *dimmer than what it separates from*.
 *
 * So the target is a ratio over the haze the characters are standing in.
 * `RIM_OVER_HAZE` is a value-contrast step of just under a stop and a half —
 * enough that the edge reads instantly at the 80 px the battle camera gives a
 * chibi, and, combined with the amber-against-teal hue contrast, more than
 * enough at a glance. The floor keeps a rim on a night frame where the haze goes
 * nearly black (the rim is mandatory, not adaptive exposure), and is a share of
 * the ceiling rather than an absolute, so the two can never cross when exposure
 * moves.
 *
 * The ceiling is no longer a constant at all — see `RIM_DISPLAY_CAP`. A
 * pre-tonemap number cannot state "does not blow out" on its own, because what
 * a given radiance *displays* as depends on the exposure the clock is driving.
 *
 * Section 2.3's "~10% of pixels above 0.75" is not paid from here. A directional
 * rim is a narrow sliver; that budget is the sky, the sun disc and spell cores,
 * which is where it was always meant to come from.
 */
const RIM_OVER_HAZE = 2.6;
const RIM_PEAK_LUMA_FLOOR_SHARE = 0.62;

/**
 * The rim's absolute ceiling, stated where it is meaningful: on screen.
 *
 * The review's measurement is a display value — "~250 luma on the pauldron" —
 * and the correction it asks for is a display value too: the rim must never push
 * a surface past ~0.85 of the exposure range. Neither can be enforced by a
 * pre-tonemap constant, because the chain between the two is `ACES(radiance ×
 * toneMappingExposure)` and this rig drives that exposure from 1.0 to 1.25
 * across the day. A rim solved to a fixed 0.92 scene radiance therefore displays
 * differently at every hour, and at the bright end it displays as the blowout.
 *
 * So the cap is authored at the display end and inverted through the transfer
 * chain once, at module load: sRGB 0.85 → linear → the ACES input that produces
 * it. `_rimSceneCap()` then divides by the live exposure to get the scene-space
 * radiance the shader may be told to bound against. `PostFX` applies the same
 * ACES curve the renderer would (`postCommon.js` reproduces it deliberately), so
 * inverting three's own fitted approximation is inverting the curve the frame is
 * actually graded through.
 */
const RIM_DISPLAY_CAP = 0.85;

/**
 * A single scalar on the section 3 exposure column, calibrated against
 * `docs/reference/bravely01.jpg`.
 *
 * Everything else in this file is a *ratio* — fill against key, shadow against
 * lit, haze against distance — and ratios say nothing about where the whole
 * histogram sits. Measured side by side against the plate, ours sat most of a
 * stop hot: median display 0.427 against 0.316, p95 0.754 against 0.631, and
 * 5.2% of the frame above 0.75 against the plate's 1.5%. An image that bright
 * cannot carry the plate's chroma either, because ACES pulls everything toward
 * white as it climbs the shoulder — which is most of why our saturation measured
 * 0.388 against 0.503 while our *albedo* is, if anything, louder than the
 * plate's.
 *
 * 0.61 is solved on the histogram rather than dialled: inverting the ACES fit on
 * our p95 and the plate's gives 0.62 and on the medians 0.58, with the small
 * remaining difference being the plate's lifted black point, which `SHADOW_FLOOR`
 * in `PostFX` supplies. Measured across the change the frame lands at median
 * 0.316 against the plate's 0.316, p95 0.628 against 0.631, and 1.1% of pixels
 * above 0.75 against 1.5% — i.e. nothing broad in the frame blooms any more. Applied to the *target* exposure so it eases with every
 * other time-of-day term, and applied here rather than in the composite so that
 * `_rimSceneCap` — which is authored on screen and inverted through this same
 * exposure — stays true, and so a frame rendered without the post chain grades
 * the same way.
 */
const EXPOSURE_CALIBRATION = 0.61;

/**
 * The rim's *shape*, published to every toon material the rig lights.
 *
 * `render/shaders/toonCommon.js` evaluates
 * `smoothstep(shape, pow(1 - N·V, power)) * mix(floor, 1, smoothstep(focus, N·L_rim))`,
 * and ships per-preset floors between 0.20 and 0.40. A non-zero floor is what
 * turns the term from a rim into a halo: it guarantees a fresnel band on every
 * silhouette edge in the frame regardless of where the light is, including the
 * undersides and the shadow flanks, at a width that barely varies. That is an
 * outline, drawn by a lighting term, and it is not what the rim is for.
 *
 * The contract below is the assigned formula — `pow(1 - saturate(N·V), 3) *
 * saturate(N·L_rim)` — expressed in this material's parameterisation:
 *
 *  - `floor: 0` so the rim reaches zero across the whole key-facing side. This
 *    is the term that makes the mask `saturate(N · L_rim)` rather than a halo.
 *  - `focus` opens at zero, which is where `saturate` opens, so the rim covers
 *    exactly the hemisphere the rim light can reach and nothing else. It closes
 *    early, at 0.30, so the mask is effectively a threshold: the band is at full
 *    strength across the back-lit contour and absent elsewhere, with the
 *    transition short enough to read as an edge. An earlier revision opened it
 *    below zero to avoid terminating the rim "halfway round a cylinder"; that is
 *    a real effect and it is also the definition of a back light, and softening
 *    it is what turned the rim into the omnidirectional wash the review could
 *    not attribute to any light direction.
 *  - `width`, `power` and `shape` together decide *how far in from the
 *    silhouette the band reaches*, and that is the term the review is actually
 *    describing. They were the one part of the rim still owned by per-preset art
 *    defaults, and those defaults disagree with each other by a factor of two
 *    (`skin` 0.50, `cloth` 0.66, `leather` 0.72, `generic` 0.75). Six characters
 *    built from different mixes of those classes therefore carried six different
 *    rim widths off one shared back-key vector — which is precisely the "rim
 *    placement is inconsistent between characters" the note reports, and it is
 *    not a placement bug at all. Width is a property of the *light*, so the rig
 *    states it, once, for every class it solves the radiance of. See
 *    `RIM_REACH_NV` for how the three are derived from one geometric intent.
 *
 * `rimGain` is deliberately not touched — it is the per-character variation the
 * roster tunes, and it scales brightness, not width. The rig measures it instead
 * (`_rimGainPeak`) so the radiance solve stays true to what is on screen.
 */

/**
 * Where the band lives, stated in `N·V` — the only frame in which "a few pixels
 * of edge" is expressible without a screen-space derivative the shader does not
 * take.
 *
 * `toonCommon.js` evaluates `smoothstep(shapeIn, shapeOut, ((span - N·V)/span)^p)`.
 * Three coupled knobs, none of which is the quantity anyone reasons about: move
 * `p` and the band's reach moves with it, so the previous constants (a `shape`
 * window of 0.26–0.44 against an exponent floored at 3) could not be read as a
 * width at all, and the number that actually decided the width — `span` — was
 * left to the preset table.
 *
 * So the intent is authored geometrically and the parameterisation is solved
 * for. On a sphere the projected radius is `sin θ` and `N·V` is `cos θ`, so a
 * reach of 0.36 puts the band's foot at 93.3% of a silhouette's projected radius
 * and full strength by 97.6% — the outer ~7%, ramping across the outer ~4%. At
 * the ~20 px shoulder the battle camera gives a chibi that is a hair under two
 * pixels; at closeup it grows with the subject, which is the correct behaviour
 * for a light and the only one available without `fwidth`.
 *
 * `RIM_EDGE_POWER` sits mid-band of the 4–6 the note asks for. Inside the
 * remapped span the exponent is no longer fighting the window for control of the
 * reach — the window is derived *from* it — so it does what an exponent should:
 * biases the ramp toward the silhouette, giving the hard-ish inner threshold and
 * a solid outer sliver rather than a linear wedge.
 *
 * `RIM_SPAN_NV` is the remap the other two are solved inside. It has to sit
 * outside `RIM_REACH_NV` (at the span the fresnel is exactly zero, so a reach on
 * the span would need an infinite window) and is otherwise free.
 */
const RIM_SPAN_NV = 0.55;
const RIM_EDGE_POWER = 4.5;
const RIM_REACH_NV = 0.36;
const RIM_FULL_NV = 0.22;

/** The shader's fresnel term at a given `N·V`, i.e. the inverse of the window
 *  above. Exported into `RIM_CONTRACT` so the published `shape` pair means
 *  `RIM_REACH_NV`/`RIM_FULL_NV` by construction rather than by a comment. */
function rimFresnelAt(nv) {
  return Math.pow(Math.max(0, 1 - nv / RIM_SPAN_NV), RIM_EDGE_POWER);
}

const RIM_CONTRACT = Object.freeze({
  floor: 0.0,
  focusIn: 0.0,
  focusOut: 0.30,
  width: RIM_SPAN_NV,
  power: RIM_EDGE_POWER,
  shapeIn: rimFresnelAt(RIM_REACH_NV),
  shapeOut: rimFresnelAt(RIM_FULL_NV),
});

/**
 * The toon surface classes the character rim's radiance is solved for, and the
 * gain assumed until the first scene scan has measured one.
 *
 * The rig cannot publish a per-material strength — `uRimStrength` is one shared
 * uniform, which is the whole reason it is cheap — so the solve has to pick a
 * reference gain, and it used to hard-code a nominal 1.7 copied out of
 * `ToonMaterial`. Copied constants across a module boundary do not stay true:
 * that table has since been retuned to 0.60–0.90 for every character class, and
 * the stale 1.7 silently scaled the entire cast's rim to roughly 40% of its
 * target. A rim solved to sit under the mist is not a rim, and it is precisely
 * the "no genuine rim light" the review reported.
 *
 * So the rig measures instead, on the scan it is already running, and normalises
 * against the *largest* gain among the character classes. Max rather than mean is
 * the semantics the solve wants: the target is where the hottest sliver in the
 * frame lands, so every other class comes out as its own documented fraction of
 * it and nothing can exceed it. Classes outside this set — `crystal`, `eye`,
 * glass — deliberately ride their own `rimCeiling` instead; they are props and
 * accents, and letting a glowing crystal set the cast's exposure is backwards.
 */
const RIM_SOLVE_CLASSES = Object.freeze(new Set([
  'skin', 'hair', 'cloth', 'leather', 'metal', 'generic',
]));
const RIM_GAIN_FALLBACK = 0.9;

/** Bounds on the solved rim strength. The floor stops a bright noon rim from
 *  being solved away to nothing (the rim is mandatory, not adaptive exposure);
 *  the ceiling stops a near-black rim colour at the bottom of the night curve
 *  from being amplified into a white ink line. */
const RIM_STRENGTH_MIN = 0.75;
const RIM_STRENGTH_MAX = 2.9;

/** How far the rim's chroma is allowed to drift from `RING_GLOW` toward the key
 *  in full daylight. A dusk rim wants a trace of the sun's amber in it; letting
 *  it go further than this loses the cool separation the palette depends on.
 *  This is the *analytic* rim — the one lighting grass and stone. The character
 *  rim has its own anchor; see `CHAR_RIM_GAMUT`. */
const RIM_KEY_TINT = 0.2;

/**
 * The character rim's anchor: `RING_GLOW`, the palette's named rim teal.
 *
 * The previous revision anchored it on the warm practical and argued that a teal
 * rim on a teal mist carries no separation. The premise is right and the
 * conclusion does not follow, because hue is not the only axis available and it
 * is the *wrong* one to spend here. REFERENCE_TARGET section 4 makes teal
 * dominant "across mist, sky, UI **and rim light**", so an amber rim is the one
 * warm element in a cool frame — which does not read as a back light at all, it
 * reads as a second warm key with no source, and a warm sliver on a lit shoulder
 * is exactly the thing that goes to white first through the bloom knee.
 *
 * The separation the mist demands is bought on *chroma and value* instead, and
 * both are already guaranteed by numbers this file owns. `_conformAtmosphere`
 * holds the haze under `HAZE_CHROMA_CEILING` (0.075 from equal-energy) while
 * `CHAR_RIM_CHROMA_CEILING` lets the rim sit at 0.28; `RING_GLOW` measures
 * 0.259, so the rim carries better than 1.7× the mist's chroma at the same hue
 * family — a saturated cyan edge against a desaturated grey-teal band. On top of
 * that `RIM_OVER_HAZE` puts it a stop and a half above the mist in value. Two
 * axes of contrast, neither of which costs the frame its cool cast.
 *
 * No fraction of the key is folded in. Amber-to-teal is precisely the mix this
 * file documents as passing through neutral at its midpoint (see
 * `BOUNCE_NIGHT_CHROMA` and `FOG_COOL_BIAS_LOW_SUN`), and a rim that greys out
 * at dusk is a rim that has stopped separating on the one frame the game is
 * composed around.
 */
const CHAR_RIM_ANCHOR = LIGHT.RING_GLOW;

/**
 * ART_BIBLE section 2.1's shadow rule has two clauses, and at some times of day
 * they disagree with the recipe printed beside them. `mix(skyZenith,
 * SHADOW_TINT, 0.5)` at dusk — where the zenith key is the violet `#35275E` —
 * lands on hue 227, which is 21 degrees outside the "+/-8 degrees of hue 206"
 * window the same paragraph calls mandatory and testable. The mix sets value
 * and saturation from the sky the player can actually see; this window then
 * pins the hue, so both clauses hold instead of one silently losing.
 */
const SHADOW_HUE_DEG = 206;
const SHADOW_HUE_WINDOW_DEG = 8;

/**
 * How much of the ground bounce's chroma survives at night.
 *
 * The bounce must stay *warmer* than the key (section 2.1) even when the key is
 * the cold ring, so its hue is never touched — only its saturation is pulled
 * back, because at night there is no warm sun to bounce and a full-strength
 * amber floor would be light with no source. Drifting the hue toward the fill
 * instead was the obvious move and the wrong one: an amber-to-teal chroma mix
 * passes straight through neutral at its midpoint, which is exactly the grey
 * shadow the rule exists to forbid.
 */
const BOUNCE_NIGHT_CHROMA = 0.55;

/**
 * Target penumbra width in metres.
 *
 * three 0.185 deprecates `PCFSoftShadowMap` and silently downgrades it to
 * `PCFShadowMap`, whose kernel *is* driven by `shadow.radius` — measured in
 * texels. Texel size differs by an order of magnitude between the near and far
 * cascade, so a single radius would give a mushy far shadow and a hard near
 * one. Solving the radius per cascade from this world-space target instead
 * keeps the penumbra visually constant, which is what "soft shadows" has to
 * mean when the subject can be anywhere in the frustum.
 */
const PENUMBRA_METRES = 0.035;
const PENUMBRA_RADIUS_MIN = 1;
/** Above ~3 the fixed 9-tap PCF kernel starts to show as banding, not blur. */
const PENUMBRA_RADIUS_MAX = 3;

/**
 * VSM's penumbra target, and why it is roughly half the PCF one.
 *
 * VSM does not filter a comparison, it filters the *moments* and reconstructs
 * an occlusion probability from them. The reconstruction's error term scales
 * with the variance inside the kernel, and the variance inside a kernel that
 * straddles a silhouette is enormous — so a wide VSM blur does not merely
 * soften a shadow edge, it makes the shadow *disappear* wherever an occluder
 * sits close to its receiver. That is the light-bleeding case, and a character's
 * feet are the worst instance of it in the whole frame: occluder and receiver
 * are millimetres apart, so the bled result is "lit" and the cast loses its
 * ground contact entirely, which is precisely the defect the review reports.
 *
 * At the previous 0.035 m target the near cascade solved to the 6-texel ceiling
 * and bled every contact away. Halving the target keeps a visibly soft edge at
 * the distances that matter (the fixed battle camera stands at ~9 m) while
 * bringing the kernel back inside the range where the moment reconstruction is
 * still telling the truth near an occluder.
 */
const VSM_PENUMBRA_METRES = 0.018;
const VSM_RADIUS_MIN = 1.0;
const VSM_RADIUS_MAX = 3;
/** Enough taps that the widest kernel above does not band on flat ground. */
const VSM_BLUR_SAMPLES = 12;

/**
 * How much of the key a cascade shadow removes.
 *
 * Paired with `AMBIENT_KEY_SHARE` and solved against the same measurement, so
 * the two cannot drift: with the fill at φ ≈ 0.29 of the key, a cast shadow
 * reaching the plate's measured 0.67 display (0.41 linear) needs to leave
 * `0.41(1 + φ) − φ ≈ 0.17` of the key behind. Raising the fill without lowering
 * this number would have overshot — a brighter fill lifts the shadow *and* the
 * lit side, so the occlusion has to bite harder to keep the same ratio, which is
 * the opposite of the intuition and the reason both constants are stated here
 * with their shared solve rather than tuned one at a time.
 */
const SHADOW_INTENSITY = 0.83;

/** Exponential-smoothing time constants, in seconds. All comfortably above the
 *  150 ms floor ART_BIBLE section 7.8 puts on any visible state change. */
const TAU_COLOR = 0.45;
const TAU_DIRECTION = 0.6;
const TAU_EXPOSURE = 0.5;

/**
 * Chroma-contract tolerances, in CIE-style chromaticity units (see `chromaXY`).
 *
 * A colour inside `*_TOLERANCE` of its gamut is passed through untouched, and
 * correction ramps to full over the next `*_RANGE`. The tolerance is not
 * slop — it is what makes the contract a clamp rather than a grade: the
 * ART_BIBLE section 3 dawn key, the section 3 noon key and `Sky`'s `storm` and
 * `ash` weather tints all measure inside it and come through bit-identical,
 * while the dusk key (0.197 away) and the dusk fog (0.148 away) are fully
 * corrected. Ramping rather than snapping matters because the key colour is
 * continuous in time: a hard boundary would put a visible hue step in the
 * middle of a time-of-day scrub.
 */
const KEY_CHROMA_TOLERANCE = 0.030;
const KEY_CHROMA_RANGE = 0.100;
const FOG_CHROMA_TOLERANCE = 0.035;
const FOG_CHROMA_RANGE = 0.100;

/**
 * The key's chroma ceilings, as distance from the equal-energy point.
 *
 * The key's ceiling is ~1.6x `KEY_SUN`'s own chroma. Section 2.2 allows only
 * elemental magic to reach full chroma, and the key is the term that paints
 * every non-magic surface in frame: an unclamped dusk sun (`#FF6B3D`, 0.546
 * from neutral) put a fully saturated orange-red edge on every foreground grass
 * blade, making a foreground occluder the most chromatic thing in a frame whose
 * magic accents are supposed to be the only saturated element. Capping at 0.24
 * takes better than half that chroma out and lands the light on `KEY_SUN`'s own
 * hue family, which is the colour section 2.1 named for it in the first place.
 *
 * The haze's own ceiling lives with `HAZE_SKY`; it is
 * deliberately *below* both section 2.1 fog keys (`FOG_NEAR` is 0.146 from
 * neutral, `FOG_FAR` 0.082) because fog is the single largest area of chroma in
 * an atmospheric frame and `bravely01.jpg` measures its sky at 0.069. A
 * character's albedo has nothing to compete with if the haze it stands in is as
 * saturated as its skin.
 */
const KEY_CHROMA_CEILING = 0.24;
const RING_CHROMA_CEILING = 0.26;

/**
 * The character rim's ceiling, and the only one in this file that is deliberately
 * the *highest* of the set.
 *
 * The ordering is the brief's, stated as numbers: haze 0.075 < key 0.24 <
 * character rim 0.28 < magic, which alone is unbounded (section 2.2).
 * REFERENCE_TARGET section 3 requires environment saturation to sit below
 * character saturation, and the review's blind comparison put the failure in
 * exactly those terms — the cast measured *less* saturated than the pine trees
 * behind it. The rim is the rig's only lever on character chroma, so it is the
 * one term allowed above the key.
 */
const CHAR_RIM_CHROMA_CEILING = 0.28;

/**
 * How far the conformed fog is pulled onto the haze anchor after projection.
 *
 * The gamut projection guarantees the fog lands *somewhere* on section 2.1's
 * cool-to-warm axis, and for the mauve dusk key the nearest legal point is the
 * warm end — `FOG_FAR`, parchment. That is legal and it is also wrong for this
 * frame: `FogExp2` carries one colour for both ends of the journey, and with the
 * battle stage 10–40 m deep the colour the player actually sees integrated along
 * every ray is the near one.
 *
 * The bias is near-total in daylight and stays high at low sun. That is not
 * enthusiasm, it is geometry: a partial mix between two anchors on *opposite*
 * sides of the neutral point passes within 0.02 of equal energy at its midpoint,
 * so a half-way bias measures out as a dead grey — the same neutral-crossing
 * trap `BOUNCE_NIGHT_CHROMA` documents for the ground bounce. Landing on the
 * anchor itself is the only way to keep the frame's largest area a *colour*.
 * `HAZE_SKY` is inside `HAZE_CHROMA_CEILING` by construction, so the re-conform
 * that follows is inert on this path and only bites on the dark, heavily
 * chromatic fogs the night table produces.
 */
const FOG_COOL_BIAS_LOW_SUN = 0.80;
const FOG_COOL_BIAS_DAY = 0.92;

/** How often the scene is rescanned for materials that still need CSM wiring.
 *  Meshes stream in during a mount and props spawn during play; 5 Hz is
 *  imperceptible as latency and costs one `traverse` of a few thousand nodes. */
const MATERIAL_SCAN_INTERVAL = 0.2;

/* -------------------------------------------------------------------------- */
/* Maths helpers — all allocation-free.                                        */
/* -------------------------------------------------------------------------- */

/** Smoothstep that tolerates a descending edge pair (`THREE.MathUtils.smoothstep`
 *  early-returns 0 when min > max, silently killing descending fades). */
function sstep(x, a, b) {
  if (a === b) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach. Lerping by a constant per frame
 * makes the glide speed a function of the display refresh rate, which shows up
 * as a different time-of-day transition on a 144 Hz monitor than in a 60 fps
 * capture — and the capture is what gets reviewed.
 */
function approach(dt, tau) {
  return 1 - Math.exp(-dt / Math.max(1e-4, tau));
}

/** Shortest-arc interpolation between unit vectors, stable at both degenerate
 *  ends. Lerping directions instead would swing the key through the origin when
 *  the sun crosses the horizon at night. */
function slerpDir(a, b, w, out) {
  if (w <= 1e-4) return out.copy(a);
  if (w >= 1 - 1e-4) return out.copy(b);
  const d = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  if (s < 1e-3) return out.copy(a).lerp(b, w).normalize();
  return out.copy(a).multiplyScalar(Math.sin((1 - w) * theta) / s)
    .addScaledVector(b, Math.sin(w * theta) / s).normalize();
}

const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

function lumOf(c) {
  return LR * c.r + LG * c.g + LB * c.b;
}

/** Rescale a colour to a target relative luminance, keeping its chromaticity.
 *  A near-black colour has no chromaticity to keep, so it is left alone rather
 *  than amplified into whatever rounding noise it happens to carry. */
function normaliseLuminance(c, target = 1) {
  const y = lumOf(c);
  if (y <= 1e-4) return c;
  return c.multiplyScalar(target / y);
}

/**
 * three's `ACESFilmicToneMapping`, and its inverse.
 *
 * The forward curve is Narkowicz's fit, which is what `WebGLRenderer` compiles
 * and what `postCommon.js` reproduces so the composite grades through the same
 * transfer as an un-composited frame would. It is monotone on [0, ∞), so a
 * bisection inverts it exactly to float precision with no closed form needed and
 * no risk of picking the wrong branch of the quadratic.
 *
 * The inverse runs once, at module load, to turn `RIM_DISPLAY_CAP` from an
 * intention into the scene radiance that produces it at exposure 1. Doing it
 * here rather than writing the answer down is the point: if the renderer's tone
 * curve is ever changed, this follows it instead of silently meaning something
 * else.
 */
function acesFilmic(x) {
  return THREE.MathUtils.clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1);
}

function acesFilmicInverse(target) {
  let lo = 0;
  let hi = 16;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) * 0.5;
    if (acesFilmic(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** The sRGB EOTF. `THREE.SRGBToLinear` is not part of the public `three` entry
 *  point in 0.185 — only `ColorManagement`'s internal transfer table is — so the
 *  piecewise curve is spelled out rather than reached for through a private. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Scene radiance that displays at `RIM_DISPLAY_CAP` once ACES and the sRGB
 *  encode have run, at unit exposure. ~0.64 for the authored 0.85. */
const RIM_SCENE_CAP_AT_UNIT_EXPOSURE = acesFilmicInverse(srgbToLinear(RIM_DISPLAY_CAP));

/** Scene radiance the daylight haze must reach so it *displays* at
 *  `HAZE_DISPLAY_LUMA` once ACES and the sRGB encode have run, at unit exposure.
 *  Divided by the live exposure at use; see `HAZE_SKY`. */
const HAZE_SCENE_LUMA_AT_UNIT_EXPOSURE = acesFilmicInverse(srgbToLinear(HAZE_DISPLAY_LUMA));

/**
 * Planckian radiator as an sRGB colour, using Helland's fit to the CIE locus.
 *
 * Accurate to a couple of levels over 1000–15000 K, which is far inside what a
 * key-light white balance can be judged to, and it means `KEY_WHITE_MIN_K` and
 * `KEY_WHITE_MAX_K` can be written as the temperatures an art director actually
 * says out loud instead of as two hex colours nobody can check. Only ever called
 * at module load — the two band edges are constants — so the `log` calls cost
 * nothing per frame.
 */
function blackbodyColor(kelvin, out) {
  const t = THREE.MathUtils.clamp(kelvin, 1000, 15000) / 100;
  let r;
  let g;
  let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return out.setRGB(
    THREE.MathUtils.clamp(r, 0, 255) / 255,
    THREE.MathUtils.clamp(g, 0, 255) / 255,
    THREE.MathUtils.clamp(b, 0, 255) / 255,
    THREE.SRGBColorSpace,
  );
}

/** The two edges of the daylight white-balance band, resolved once. */
const KEY_WHITE_WARM = blackbodyColor(KEY_WHITE_MIN_K, new THREE.Color());
const KEY_WHITE_COOL = blackbodyColor(KEY_WHITE_MAX_K, new THREE.Color());

/**
 * Mix two colours' *chromaticities* while keeping `out`'s luminance equal to
 * `a`'s.
 *
 * A plain linear lerp between a bright key and a dim tint is dominated by
 * whichever has the larger magnitude, so `RING_GLOW.lerp(sunColor, 0.2)` at
 * noon produces near-white rather than a cool rim with a hint of sun in it.
 * Normalising both to unit luminance first mixes hue and saturation only; the
 * value is then restored explicitly. `Palette.toonRamp` makes the same move for
 * the same reason, and the two must agree or the character's rim band and the
 * rim light will disagree about colour.
 */
function mixChroma(a, b, t, out) {
  const ya = lumOf(a) || 1e-6;
  const yb = lumOf(b) || 1e-6;
  out.setRGB(
    (a.r / ya) * (1 - t) + (b.r / yb) * t,
    (a.g / ya) * (1 - t) + (b.g / yb) * t,
    (a.b / ya) * (1 - t) + (b.b / yb) * t,
    THREE.LinearSRGBColorSpace,
  );
  const y = lumOf(out) || 1e-6;
  return out.multiplyScalar(ya / y);
}

/* ----------------------------------------------------- the chroma contract */

/**
 * Chromaticity of a linear colour: `(R, G) / (R + G + B)`.
 *
 * This is the CIE rg-chromaticity construction applied to the renderer's
 * working primaries, and it is the right space for a palette constraint for two
 * reasons. It is *luminance-free*, so a rule expressed in it can never change
 * how bright a frame is — only what colour it is — and unlike HSL hue it is a
 * plane rather than a circle, so "the legal region" is an ordinary convex
 * polygon and "how far outside is this" is an ordinary distance. Both matter:
 * HSL hue has no meaning near neutral (a near-grey fog has a random hue that a
 * hue clamp would happily swing across the wheel) and HSL saturation is not
 * comparable between a dark colour and a bright one, so neither can express
 * "the environment must be less chromatic than the characters".
 */
function chromaXY(c, out) {
  const s = c.r + c.g + c.b;
  if (s <= 1e-6) return out.set(1 / 3, 1 / 3);
  return out.set(c.r / s, c.g / s);
}

/** Build a gamut: a convex polygon in chromaticity, from sRGB hexes. Listing
 *  the neutral point as a vertex is what makes every desaturated version of a
 *  legal hue legal too — the region is the whole wedge from neutral out to the
 *  palette colours, not just the line between them. */
function gamutFromHex(hexes, ceiling) {
  const c = new THREE.Color();
  const v = new THREE.Vector2();
  const points = [];
  for (const hex of hexes) {
    c.setHex(hex, THREE.SRGBColorSpace);
    chromaXY(c, v);
    points.push(v.x, v.y);
  }
  return { points, ceiling };
}

/** Nearest point on segment AB to P, written into `out`. */
function nearestOnSegment(px, py, ax, ay, bx, by, out) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 < 1e-12
    ? 0
    : THREE.MathUtils.clamp(((px - ax) * vx + (py - ay) * vy) / len2, 0, 1);
  return out.set(ax + vx * t, ay + vy * t);
}

const _segA = new THREE.Vector2();

/**
 * Distance from P to a convex gamut, with the nearest legal point in `out`.
 * Returns 0 (and leaves `out` at P) when P is already inside, which is what
 * makes the whole contract idempotent — conforming a conformed colour is a
 * no-op, so this can run every frame on a value another module also writes
 * without the two of them ratcheting each other.
 */
function nearestInGamut(px, py, gamut, out) {
  const p = gamut.points;
  const n = p.length / 2;
  let inside = true;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const ax = p[i * 2];
    const ay = p[i * 2 + 1];
    const bx = p[((i + 1) % n) * 2];
    const by = p[((i + 1) % n) * 2 + 1];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    // Colinear vertices contribute no constraint; treating a zero cross as a
    // sign flip would report every point on an edge as outside.
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) { inside = false; break; }
  }
  if (inside) {
    out.set(px, py);
    return 0;
  }
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    nearestOnSegment(px, py, p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], _segA);
    const d = Math.hypot(px - _segA.x, py - _segA.y);
    if (d < best) {
      best = d;
      out.copy(_segA);
    }
  }
  return best;
}

const _chromaP = new THREE.Vector2();
const _chromaN = new THREE.Vector2();

/**
 * Project a colour onto a palette gamut in place, preserving its luminance
 * exactly.
 *
 * Two corrections, in order: pull an out-of-gamut chromaticity back toward the
 * nearest legal one by a smoothstepped amount (so the correction is continuous
 * as a light's colour animates), then cap the remaining distance from neutral
 * at the gamut's chroma ceiling. The cap is applied along the line through the
 * neutral point, i.e. it desaturates without rotating hue — a hue rotation here
 * would be the rig second-guessing the time of day, which is `Sky`'s call.
 */
function conformChroma(color, gamut, tolerance, range) {
  const y = lumOf(color);
  if (y <= 1e-6) return color;

  chromaXY(color, _chromaP);
  let x = _chromaP.x;
  let g = _chromaP.y;

  const d = nearestInGamut(x, g, gamut, _chromaN);
  if (d > tolerance) {
    const k = sstep(d, tolerance, tolerance + range);
    x += (_chromaN.x - x) * k;
    g += (_chromaN.y - g) * k;
  }

  const dx = x - 1 / 3;
  const dy = g - 1 / 3;
  const dw = Math.hypot(dx, dy);
  if (dw > gamut.ceiling) {
    const s = gamut.ceiling / dw;
    x = 1 / 3 + dx * s;
    g = 1 / 3 + dy * s;
  }

  return setChromaXY(color, x, g, y);
}

/**
 * Rebuild a linear colour from a chromaticity and a target luminance — the
 * inverse of `chromaXY`, and the step every chroma correction in this file
 * finishes with. Factored out so "the correction never changes how bright the
 * frame is" is one piece of arithmetic rather than a promise repeated at each
 * call site.
 */
function setChromaXY(color, x, g, y) {
  const b = 1 - x - g;
  const denom = LR * x + LG * g + LB * b;
  if (denom <= 1e-6) return color;
  const k = y / denom;
  return color.setRGB(
    Math.max(0, x * k),
    Math.max(0, g * k),
    Math.max(0, b * k),
    THREE.LinearSRGBColorSpace,
  );
}

/** The daylight white-balance band, as chromaticities, resolved once. */
const _keyWarmXY = chromaXY(KEY_WHITE_WARM, new THREE.Vector2());
const _keyCoolXY = chromaXY(KEY_WHITE_COOL, new THREE.Vector2());

/**
 * Hold a key colour inside the daylight white-balance band, in place.
 *
 * The band is the *segment* of the Planckian locus between `KEY_WHITE_MIN_K` and
 * `KEY_WHITE_MAX_K`, so a key already inside it comes through untouched and one
 * outside is pulled onto its nearest end — a 3000 K key lands on 4400 K, a
 * 9000 K one on 5600 K, and neither is rotated off the locus in the process.
 * Luminance is preserved exactly, so this can never change the exposure of a
 * shot; `weight` fades the whole correction out as the sun drops, which is what
 * keeps the hero dusk key the colour the art direction wrote for it.
 */
function conformTemperature(color, weight) {
  if (weight <= 1e-3) return color;
  const y = lumOf(color);
  if (y <= 1e-6) return color;
  chromaXY(color, _chromaP);
  nearestOnSegment(
    _chromaP.x, _chromaP.y,
    _keyWarmXY.x, _keyWarmXY.y, _keyCoolXY.x, _keyCoolXY.y,
    _chromaN,
  );
  return setChromaXY(
    color,
    _chromaP.x + (_chromaN.x - _chromaP.x) * weight,
    _chromaP.y + (_chromaN.y - _chromaP.y) * weight,
    y,
  );
}

/**
 * The two legal key gamuts.
 *
 * Warm covers every sunlit hour: neutral, `KEY_SUN`, and the section 3 dusk
 * horizon `#FF9E6B` — the warm end of the amber band, and the hue the reference
 * frames actually show a low sun casting. Cool covers the night key, which is
 * the moon-ring and not a sun at all: neutral, `RING_GLOW`, and the section 3
 * night key `#A8C8E8`. The rig picks whichever gamut the incoming key is
 * already nearer rather than selecting on sun height, because a selector driven
 * by elevation would drag the dusk key a third of the way toward teal at the
 * exact hour the art direction calls its hero key warm.
 */
const KEY_GAMUT_WARM = gamutFromHex([0xffffff, LIGHT.KEY_SUN, 0xff9e6b], KEY_CHROMA_CEILING);
const KEY_GAMUT_COOL = gamutFromHex([0xffffff, LIGHT.RING_GLOW, 0xa8c8e8], RING_CHROMA_CEILING);

/** The legal atmosphere region: neutral, the plate's own sky `HAZE_SKY`, and
 *  section 2.1's cool teal `FOG_NEAR` and warm parchment `FOG_FAR`. `FogExp2`
 *  carries one colour, so the near/far *journey* is produced by distance rather
 *  than by the colour; what the rig guarantees is that the single colour
 *  available lands on that axis instead of off it in the magenta wedge, and that
 *  it stays under `HAZE_CHROMA_CEILING` — which is the plate's measurement, and
 *  tighter than either section 2.1 anchor. */
const FOG_GAMUT = gamutFromHex(
  [0xffffff, HAZE_SKY, LIGHT.FOG_NEAR, LIGHT.FOG_FAR], HAZE_CHROMA_CEILING,
);

/** The character rim's gamut: neutral out along the palette's cool axis, from
 *  the rim teal `RING_GLOW` to the near haze `FOG_NEAR`. The anchor is one of
 *  those two, so the projection is inert on hue and the gamut is here for its
 *  ceiling — which is what stops the rim drifting into the pure chroma section
 *  2.2 reserves for elemental magic while still letting it sit well above the
 *  environment ceiling the mist is held under. */
const CHAR_RIM_GAMUT = gamutFromHex(
  [0xffffff, LIGHT.RING_GLOW, LIGHT.FOG_NEAR], CHAR_RIM_CHROMA_CEILING,
);

/** Whichever key gamut the incoming colour is already closer to. Safe to share
 *  the module scratch with `conformChroma`: the pick completes before the
 *  projection starts and neither holds a reference past its own call. */
function pickKeyGamut(color) {
  chromaXY(color, _chromaP);
  const x = _chromaP.x;
  const y = _chromaP.y;
  const warm = nearestInGamut(x, y, KEY_GAMUT_WARM, _chromaN);
  const cool = nearestInGamut(x, y, KEY_GAMUT_COOL, _chromaN);
  return warm <= cool ? KEY_GAMUT_WARM : KEY_GAMUT_COOL;
}

/* -------------------------------------------------------------------------- */

/**
 * One slot in the dynamic point-light pool. The light itself is permanent; only
 * its envelope state is recycled.
 */
class LightSlot {
  constructor(index, canCastShadow) {
    this.index = index;
    this.serial = 0;
    this.active = false;
    this.priority = 0;
    this.age = 0;

    // Envelope, in seconds. `hold = Infinity` marks a persistent light that
    // only starts its release ramp when the owner calls `release()`.
    this.t = 0;
    this.attack = 0.06;
    this.hold = Infinity;
    this.release = 0.35;

    this.peak = 0;
    this.flicker = 0;
    this.phase = 0;
    /** Last envelope value, pre-flicker. Released lights ramp down from this
     *  rather than from 1.0, so cancelling a light mid-attack fades from where
     *  it actually was instead of jumping to full brightness first. */
    this.env = 0;
    this.releaseFrom = 1;

    const light = new THREE.PointLight(0xffffff, 0, 10, 2);
    light.castShadow = false;
    // Never toggled. `visible = false` removes the light from the render state
    // and changes NUM_POINT_LIGHTS, which is precisely the recompile the pool
    // exists to prevent.
    light.visible = true;
    if (canCastShadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.near = 0.15;
      light.shadow.camera.far = 24;
      light.shadow.bias = -0.0008;
      light.shadow.normalBias = 0.03;
      light.shadow.radius = 2;
      light.shadow.intensity = SHADOW_INTENSITY;
      // Rendering six cube faces for a light at zero intensity is pure waste,
      // but the shadow map must exist before the first frame samples it — so it
      // is baked once at startup and then frozen until something acquires the
      // slot. `_warmFrames` counts those first renders down.
      this._warmFrames = 2;
    }
    this.light = light;
    this.canCastShadow = canCastShadow;
  }

  dispose() {
    this.light.shadow?.map?.dispose();
    this.light.parent?.remove(this.light);
  }
}

/**
 * The token handed back by `acquire`. Holding the slot itself would let a stale
 * caller release a light that has since been recycled under it, which produces
 * a spell whose glow vanishes because a torch three seconds ago called
 * `release()` late. The serial check makes that impossible.
 */
class LightHandle {
  constructor(pool, slot) {
    this._pool = pool;
    this._slot = slot;
    this._serial = slot.serial;
    this.light = slot.light;
  }

  get alive() {
    return this._slot.active && this._slot.serial === this._serial;
  }

  setPosition(x, y, z) {
    if (this.alive) {
      if (x && typeof x === 'object') this._slot.light.position.copy(x);
      else this._slot.light.position.set(x, y, z);
    }
    return this;
  }

  setColor(c) {
    if (this.alive) this._slot.light.color.set(c);
    return this;
  }

  /** Retarget the envelope peak without restarting the envelope. */
  setIntensity(v) {
    if (this.alive) this._slot.peak = Math.max(0, v);
    return this;
  }

  /** Begin the release ramp. Persistent lights fade rather than snap off —
   *  ART_BIBLE section 7.8 forbids an un-eased visible state change. */
  release() {
    if (this.alive) this._pool._beginRelease(this._slot);
    return this;
  }
}

/* -------------------------------------------------------------------------- */

export class Lighting {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {import('./Sky.js').Sky|null} sky Outdoor scenes pass their dome;
   *   interiors may pass null, in which case the rig drives itself from the
   *   ART_BIBLE time-of-day table directly.
   */
  constructor(engine, sky = null) {
    this.engine = engine;
    this.sky = sky ?? engine?.get?.('sky') ?? null;
    this.scene = null;

    this.group = new THREE.Group();
    this.group.name = 'LightingRig';
    // The rig is analytic: its lights are positioned in world space every frame
    // and nothing is ever parented under it, so culling it would be a no-op cost.
    this.group.frustumCulled = false;

    /** Multiplier scenes may push to make the rim hotter for a shot. */
    this.rimBoost = 1;
    /** Furthest distance that receives cascaded shadows, in metres. */
    this.shadowDistance = DEFAULT_SHADOW_DISTANCE;
    /** Fallback clock for scenes with no sky dome. */
    this.timeOfDay = gameState.state.timeOfDay ?? HERO_TIME_OF_DAY;

    // ---- fill ------------------------------------------------------------
    // Colours are placeholders; `_sampleTarget` overwrites them before the
    // first frame. Position is the hemisphere axis and stays world-up.
    this.fill = new THREE.HemisphereLight(LIGHT.FOG_NEAR, LIGHT.BOUNCE_GROUND, 0.55);
    this.fill.position.set(0, 1, 0);
    this.group.add(this.fill);

    // ---- rim -------------------------------------------------------------
    this.rim = new THREE.DirectionalLight(LIGHT.RING_GLOW, RIM_INTENSITY_MAX);
    this.rim.castShadow = false;
    this.rim.name = 'RimLight';
    this.group.add(this.rim, this.rim.target);

    /**
     * Shared uniform block for hand-written toon materials.
     *
     * The character shader cannot read three's `directionalLights` array and
     * know which entry is the rim — the renderer sorts shadow casters first and
     * the cascade count changes with quality. So the rim term is published here
     * as stable object identities: a `ShaderMaterial` that splices these
     * straight into its `uniforms` gets them updated every frame for free, with
     * no per-frame lookup and no chance of reading a cascade by mistake.
     *
     * `uKeyColor` is premultiplied by the key's intensity so the shader does not
     * need to know the rig's intensity convention. `uRimColor` deliberately is
     * **not**: the character rim's level is solved into `uRimStrength` against
     * the haze, so premultiplying by `this.rim`'s intensity as well only for the
     * solve to divide it straight back out coupled the two rims to no purpose —
     * and made the coupling load-bearing at the edges, where `RIM_STRENGTH_MAX`
     * clamps. Splitting them is what lets the analytic back light drop to a fill
     * level (`RIM_KEY_SHARE`) without dimming the character edge by a single
     * step.
     */
    this.uniforms = {
      uKeyDirection: { value: new THREE.Vector3(0, 1, 0) },
      uKeyColor: { value: new THREE.Color(1, 1, 1) },
      uRimDirection: { value: new THREE.Vector3(0, 1, 0) },
      uRimColor: { value: new THREE.Color(1, 1, 1) },
      uRimPower: { value: 2.6 },
      uRimStrength: { value: 1.0 },
      uFillSky: { value: new THREE.Color() },
      uFillGround: { value: new THREE.Color() },
      uShadowTint: { value: new THREE.Color(LIGHT.SHADOW_TINT) },
    };

    // ---- eased rig state -------------------------------------------------
    this._target = Lighting._makeRigState();
    this._current = Lighting._makeRigState();

    // ---- scratch ---------------------------------------------------------
    this._vecA = new THREE.Vector3();
    this._vecB = new THREE.Vector3();
    this._zenith = new THREE.Color(0x33628f);
    this._shadowTint = new THREE.Color(LIGHT.SHADOW_TINT);
    this._bounce = new THREE.Color(LIGHT.BOUNCE_GROUND);
    this._ringGlow = new THREE.Color(LIGHT.RING_GLOW);
    this._charRimAnchor = new THREE.Color(CHAR_RIM_ANCHOR);
    this._hazeAnchor = new THREE.Color(HAZE_SKY);
    this._fogScratch = new THREE.Color();
    this._hsl = { h: 0, s: 0, l: 0 };
    /** Largest `uToonRimGain` seen on a character surface in the active scene.
     *  Measured by `refreshMaterials`; see `RIM_SOLVE_CLASSES` for why the rig
     *  measures this rather than assuming it. */
    this._rimGainPeak = RIM_GAIN_FALLBACK;
    /**
     * Toon surfaces whose rim bound the rig re-states every frame, paired with
     * the art-authored caps they were built with.
     *
     * The bound is exposure-relative (`_rimSceneCap`) and exposure eases on its
     * own clock, so publishing it on the 5 Hz material scan alone would let a
     * time-of-day scrub run up to 200 ms of frames with a stale ceiling — which
     * on the way *up* is a visible blowout, the one thing this bound exists to
     * make impossible. The scan discovers; this list is what the per-frame pass
     * walks, so the cost is a couple of float writes per character material and
     * no `traverse`.
     *
     * @type {Array<{uniforms: object, ceiling: number, max: number}>}
     */
    this._rimBounded = [];
    /** Smoothed "is this a sunlit frame" term, written by `_sampleTarget` and
     *  read by the atmosphere conform. 1 until the first sample lands. */
    this._dayness = 1;
    this._lensKey = '';
    this._lastFrame = -1;
    this._scanTimer = 0;
    /** The probe level the *scene* authored, latched when `scene.environment`
     *  changes identity. The rig writes `environmentIntensity` every frame, so
     *  reading it back as the authored value would ratchet the probe toward the
     *  budget cap and never let it recover when the budget widens again. */
    this._probeSource = null;
    this._probeAuthoredLevel = 0;

    // ---- CSM + point pool -------------------------------------------------
    /** @type {Map<THREE.Material, Function|null>} material -> prior onBeforeCompile */
    this._patched = new Map();
    /** @type {LightSlot[]} */
    this._slots = [];
    this.csm = null;

    this.quality = gameState.state.settings?.quality ?? 'high';
    this._build(this.quality);

    // Quality is a global setting; main.js only forwards it to PostFX, so the
    // rig subscribes for itself rather than requiring a second forwarder.
    this._unsubscribe = bus.on('settings:changed', ({ key, value }) => {
      if (key === 'quality') this.setQuality(value);
    });

    this.sync();
  }

  /** The eased state the rig is actually driving lights from. */
  static _makeRigState() {
    return {
      keyDir: new THREE.Vector3(0.3, 0.85, 0.43).normalize(),
      keyColor: new THREE.Color(0xffead0),
      keyIntensity: 3,
      fillSky: new THREE.Color(0x2e4a5f),
      fillGround: new THREE.Color(LIGHT.BOUNCE_GROUND),
      fillIntensity: 0.55,
      /** The PMREM probe's level. Eased on the same clock as the hemisphere it
       *  was divided from, so the total ambient cannot wander mid-scrub. */
      probeIntensity: 0,
      rimDir: new THREE.Vector3(-0.5, 0.5, -0.7).normalize(),
      rimColor: new THREE.Color(LIGHT.RING_GLOW),
      // The rim the *characters* get. Anchored rather than derived, and eased
      // separately from `rimColor` so the day's warm drift on the analytic light
      // can never leak into the cast's edge. See `CHAR_RIM_ANCHOR`.
      charRimColor: new THREE.Color(CHAR_RIM_ANCHOR),
      rimIntensity: RIM_INTENSITY_MAX,
      exposure: 1,
    };
  }

  /* ------------------------------------------------------------------ setup */

  /**
   * Build (or rebuild) everything whose *count* is fixed by quality: the
   * cascade lights and the point-light pool. Anything that changes an array
   * length in the shader belongs here and nowhere else, so recompiles happen
   * exactly at a quality change and never during play.
   */
  _build(level) {
    const q = QUALITY[level] ?? QUALITY.high;
    this._q = q;

    const camera = this._activeCamera();
    this.csm = new CSM({
      camera,
      parent: this.group,
      cascades: q.cascades,
      maxFar: this.shadowDistance,
      mode: 'custom',
      customSplitsCallback: Lighting._splitCallback,
      shadowMapSize: q.shadowMapSize,
      lightIntensity: this._current.keyIntensity,
      lightDirection: this._vecA.copy(this._current.keyDir).negate().normalize().clone(),
      // Nominal bounds only. CSM writes these to every cascade at construction,
      // and `_applyCascadeBias` immediately replaces them with a per-cascade
      // range fitted to that cascade's own extent — see LIGHT_MARGIN for why a
      // shared, generous range is a shadow-quality bug rather than a safety net.
      lightNear: Math.max(0.5, LIGHT_MARGIN - MAX_CASTER_HEIGHT),
      lightFar: LIGHT_MARGIN + this.shadowDistance + SHADOW_DEPTH_SLACK,
      lightMargin: LIGHT_MARGIN,
    });
    // Blended seams. Set before `updateFrustums` so the per-cascade bounds are
    // expanded by the fade margin, and before any material is registered so the
    // CSM_FADE define is baked into the first compile rather than causing a
    // second one.
    this.csm.fade = true;
    this.csm.updateFrustums();
    this._applyCascadeBias();

    for (let i = 0; i < q.pointLights; i++) {
      // Exactly one slot is allowed to cast: ART_BIBLE section 7.6 forbids a
      // shadowless point light on a hero subject, but a cube shadow per spell
      // would blow the frame budget, so the rig offers one and prioritises it.
      const slot = new LightSlot(i, q.shadowPoint && i === 0 && this._pointShadowsSupported());
      this.group.add(slot.light);
      this._slots.push(slot);
    }
  }

  /**
   * Cascade split. CSM's built-in `practical` mode is a fixed 50/50 blend of
   * uniform and logarithmic; we want a heavier logarithmic bias so the first
   * cascade hugs the subject. Returns normalised distances ending at 1.
   */
  static _splitCallback(amount, near, far, target) {
    for (let i = 1; i < amount; i++) {
      const uniform = (near + ((far - near) * i) / amount) / far;
      const logarithmic = (near * (far / near) ** (i / amount)) / far;
      target.push(THREE.MathUtils.lerp(uniform, logarithmic, SPLIT_LAMBDA));
    }
    target.push(1);
  }

  /**
   * Per-cascade depth and normal bias, derived from each cascade's own world-
   * space texel size rather than hand-tuned.
   *
   * Normal bias does the real work: it displaces the shadow lookup along the
   * surface normal by a little over one texel, which is exactly the geometric
   * cause of slope-dependent acne, and because the offset is proportional to
   * texel size the near cascade gets a 2 cm nudge (invisible on a 1.2 m chibi)
   * while the far cascade gets the larger offset it actually needs. A constant
   * bias tuned for the far cascade would peter-pan the near one; a constant
   * tuned for the near cascade would leave the far one crawling with acne.
   *
   * The depth bias is the small residual, expressed in the shadow camera's
   * normalised depth so it stays a fixed *world* distance regardless of how the
   * light's near/far range is configured.
   */
  _applyCascadeBias() {
    const size = this._q.shadowMapSize;
    const lights = this.csm.lights;
    const vsm = this._shadowType() === THREE.VSMShadowMap;
    const near = Math.max(0.5, LIGHT_MARGIN - MAX_CASTER_HEIGHT);
    for (let i = 0; i < lights.length; i++) {
      const shadow = lights[i].shadow;
      const cam = shadow.camera;
      const span = cam.right - cam.left;

      // Fit the depth range to this cascade before anything is derived from it.
      // CSM parks the light `lightMargin` beyond the cascade's far extent along
      // the light axis, so everything the cascade can legitimately shadow lies
      // between `LIGHT_MARGIN - MAX_CASTER_HEIGHT` and `LIGHT_MARGIN + extent`.
      // The extent along the light axis is bounded above by the cascade's own
      // diagonal, which is exactly the ortho width `_updateShadowBounds` just
      // wrote — so `span` is a correct upper bound and needs no second solve.
      cam.near = near;
      cam.far = LIGHT_MARGIN + span + SHADOW_DEPTH_SLACK;
      cam.updateProjectionMatrix();

      const texel = span / size;
      const depthRange = Math.max(1e-3, cam.far - cam.near);
      shadow.normalBias = texel * 1.35 + 0.004;
      if (vsm) {
        // VSM compares moments, not depths: acne comes from variance
        // underestimation, not from the depth-slope error a PCF bias corrects,
        // and a negative bias here would simply pull the whole occluder
        // distribution forward and bleed light through solid geometry. The
        // normal bias above still earns its keep — it is a *geometric* offset,
        // independent of the comparison. Softness is the blur kernel: `radius`
        // is the separable blur's texel reach, so a penumbra target converts
        // directly — but it converts to a *tighter* one than PCF wants, because
        // widening a VSM kernel trades softness for light bleeding rather than
        // for cost (see VSM_PENUMBRA_METRES). `blurSamples` is what stops that
        // blur banding on the far cascade where the kernel is widest in world
        // terms.
        shadow.bias = 0;
        shadow.radius = THREE.MathUtils.clamp(
          VSM_PENUMBRA_METRES / Math.max(1e-5, texel),
          VSM_RADIUS_MIN, VSM_RADIUS_MAX,
        );
        shadow.blurSamples = VSM_BLUR_SAMPLES;
      } else {
        shadow.bias = -(texel * 0.5 + 0.02) / depthRange;
        shadow.radius = THREE.MathUtils.clamp(
          PENUMBRA_METRES / Math.max(1e-5, texel),
          PENUMBRA_RADIUS_MIN, PENUMBRA_RADIUS_MAX,
        );
      }
      shadow.intensity = SHADOW_INTENSITY;
    }
  }

  /** The renderer's shadow filter. Core owns it and may change it. */
  _shadowType() {
    return this.engine?.renderer?.shadowMap?.type ?? THREE.PCFShadowMap;
  }

  /**
   * Whether a `PointLight` in the pool may cast.
   *
   * three does not implement VSM for cube shadow maps: `WebGLShadowMap` warns
   * and skips the render, but the *program* is still generated with the point
   * shadow branch while `shadowmap_pars_fragment` omits the sampler array under
   * VSM — so every lit material in the scene fails to compile with
   * "'pointShadowMap' : undeclared identifier" and the frame goes black. The
   * pool therefore drops its one shadow-capable slot when core selects VSM,
   * which costs a cube shadow nobody can see and saves the whole renderer.
   */
  _pointShadowsSupported() {
    return this._shadowType() !== THREE.VSMShadowMap;
  }

  addTo(scene) {
    this.scene = scene;
    scene.add(this.group);
    this.refreshMaterials();
    this.sync();
    return this;
  }

  /** The camera the cascades must be fitted to — a scene may override the
   *  engine's, and BattleScene does exactly that for the fixed side view. */
  _activeCamera() {
    return this.engine?.scene?.camera ?? this.engine?.camera ?? null;
  }

  /* --------------------------------------------------------------- quality */

  /**
   * Rescale the rig. Cascade count and shadow resolution both change program
   * defines or texture allocations, so this tears the CSM down and rebuilds it;
   * every registered material is unpatched first and re-registered after, which
   * is what keeps a material from carrying a closure into a dead CSM instance.
   */
  setQuality(level) {
    if (!QUALITY[level] || level === this.quality) return this;
    this.quality = level;

    this._detachAll();
    this._teardown();
    this._build(level);
    this.refreshMaterials();
    this.sync();
    return this;
  }

  /** Change the cascaded shadow range. Cheap — no reallocation, just a refit. */
  setShadowDistance(metres) {
    this.shadowDistance = Math.max(20, metres);
    if (this.csm) {
      this.csm.maxFar = this.shadowDistance;
      this.csm.lightFar = LIGHT_MARGIN + this.shadowDistance + SHADOW_DEPTH_SLACK;
      // The per-cascade near/far are not written here on purpose: refitting the
      // frustums changes every cascade's extent, and `_applyCascadeBias` solves
      // the depth range from that extent. Writing a shared far plane first would
      // simply be overwritten a line later — and, when it was not, was how every
      // cascade ended up sharing one 195 m range.
      this.csm.updateFrustums();
      this._applyCascadeBias();
    }
    return this;
  }

  /* ------------------------------------------------------- material wiring */

  /**
   * Register one material with the cascade shader.
   *
   * `CSM.setupMaterial` overwrites `onBeforeCompile`; a character or water
   * material that installed its own hook would silently lose it, so the prior
   * hook is captured and chained. `hasOwnProperty` is the test that matters —
   * `Material.prototype.onBeforeCompile` is a no-op that every material
   * inherits, and treating that as a custom hook would chain a useless call on
   * every compile.
   */
  registerMaterial(material) {
    if (!material || !this.csm) return false;

    // Ahead of the cascade check and ahead of the already-patched early return:
    // a toon material may be handed to the rig long before it is first drawn,
    // and the rim contract must be true of it from its first frame.
    //
    // Re-stated on every sweep rather than latched behind a `userData` flag. The
    // flag was a real defect, not an optimisation: `CharacterFactory` builds
    // every body material with `BODY_RIM = { rimPower: 3.0, rimFloor: 0.55 }`,
    // and `updateToonUniforms` lets any caller reassert an art default at any
    // later moment. A one-shot contract loses that race silently and leaves the
    // material carrying a 0.55 floor — a rim at better than half strength on
    // *every* silhouette edge irrespective of light direction, which is both the
    // "broad soft airbrush" and the "inconsistent between characters, implying
    // it is not driven by a single scene key" in the same defect. A contract the
    // rig owns has to hold continuously; the write is four floats on a material
    // the sweep has already visited.
    this._applyRimContract(material);

    if (this._patched.has(material)) return false;
    if (!Lighting._isLitMaterial(material)) return false;

    const own = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile');
    const prior = own ? material.onBeforeCompile : null;

    this.csm.setupMaterial(material);
    const csmHook = material.onBeforeCompile;
    material.onBeforeCompile = function chainedCsmHook(shader, renderer) {
      csmHook.call(this, shader, renderer);
      if (prior) prior.call(this, shader, renderer);
    };
    material.needsUpdate = true;
    this._patched.set(material, prior);
    return true;
  }

  /**
   * Anything that walks three's lighting chunks. `ShaderMaterial` counts only
   * when it opted into lights; if such a shader does not `#include
   * <lights_fragment_begin>` the defines are inert, which is harmless — but if
   * it does, it gets correct cascade selection for free.
   */
  static _isLitMaterial(m) {
    return !!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial
      || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial
      || (m.isShaderMaterial && m.lights === true));
  }

  /**
   * Publish the rim's *shape* to one toon material.
   *
   * The rig already owns the rim's direction, colour and intensity, and
   * `ToonMaterial` aliases those uniform objects straight out of this module so
   * the two can never disagree. Its falloff was the one part of the same light
   * left to per-material art defaults, and those defaults both floored it — a
   * constant-width halo on every silhouette in the frame — and sized it, at
   * widths that disagree by a factor of two between the classes one character is
   * assembled from. A light's falloff is not an art control on the surface it
   * strikes, so the rig states it here for everything it lights.
   *
   * The split between what is stated for *everything* and what is stated only
   * for `RIM_SOLVE_CLASSES` is the same split the radiance solve already makes.
   * Floor and focus are statements about *where the light is*, and are true of
   * any surface. Width, exponent and window are statements about how a surface's
   * silhouette curves away, and for `crystal` and `glass` the fresnel *is* the
   * material rather than a rim on it — those classes are props and magic, which
   * section 2.2 exempts, and they ride their own profile and their own ceiling.
   *
   * Written through `userData.toon.uniforms`, which is `ToonMaterial`'s public
   * handle on its own uniform objects and the same objects it splices into the
   * compiled program — so this is a value write on a live uniform, not a
   * recompile, and it is idempotent. Materials that carry no rim (the outline
   * hull, anything not built by `ToonMaterial`) are skipped by the guard.
   *
   * @returns {boolean} whether this material carried a rim to conform.
   */
  _applyRimContract(material) {
    const toon = material?.userData?.toon;
    if (!toon || toon.kind !== 'surface') return false;
    const u = toon.uniforms;
    if (!u?.uToonRimFloor) return false;

    u.uToonRimFloor.value = RIM_CONTRACT.floor;
    u.uToonRimFocus?.value.set(RIM_CONTRACT.focusIn, RIM_CONTRACT.focusOut);
    if (!RIM_SOLVE_CLASSES.has(toon.preset)) return true;

    u.uToonRimPower.value = RIM_CONTRACT.power;
    u.uToonRimShape?.value.set(RIM_CONTRACT.shapeIn, RIM_CONTRACT.shapeOut);
    if (u.uToonRimWidth) u.uToonRimWidth.value = RIM_CONTRACT.width;

    // The art-authored caps are latched on the material the first time it is
    // seen, because `_applyRimBound` overwrites the live uniforms every frame
    // and reading them back as the authored value would ratchet the bound down
    // toward zero. Stored on the material so it travels with it across scene
    // swaps — `AssetForge` caches materials, and a second latch after a swap
    // would capture the previous scene's already-bounded values.
    if (material.userData.awRimCaps === undefined) {
      material.userData.awRimCaps = {
        ceiling: u.uToonRimCeiling?.value ?? Infinity,
        max: u.uToonRimMax?.value ?? Infinity,
      };
    }
    return true;
  }

  /**
   * The scene radiance that displays at `RIM_DISPLAY_CAP` *this* frame.
   *
   * `renderer.toneMappingExposure` scales radiance before the ACES curve, so the
   * pre-tonemap value that lands on a given screen value moves inversely with
   * it. The rig drives that exposure from the section 3 table (1.0 at noon,
   * 1.25 at dusk), which is why a fixed pre-tonemap ceiling cannot state a
   * screen-space promise — and why the previous fixed 0.92 displayed as a
   * blowout at exactly the hour the game is composed around.
   */
  _rimSceneCap() {
    const exposure = Math.max(1e-3, this._current.exposure);
    return RIM_SCENE_CAP_AT_UNIT_EXPOSURE / exposure;
  }

  /**
   * Bound the rim so it provably cannot push a surface past `RIM_DISPLAY_CAP`.
   *
   * `toonSurface` spends the rim against the headroom below `uToonRimCeiling`
   * and then clamps its own radiance to `uToonRimMax`: a surface already at `s`
   * receives at most `rimMax · (1 - s/ceiling)`. Setting both bounds to the same
   * cap `C` makes the total `s + C·(1 - s/C) = C` in the worst case and less
   * everywhere else — an algebraic guarantee rather than a tuned constant, which
   * is what "never pushes a surface above ~0.85 of the exposure range" has to be
   * if it is to survive a scene the rig has never seen.
   *
   * The art-authored caps still win where they are *stricter*: `skin` asks for
   * 0.18 and gets it. The rig only ever removes headroom, never grants it.
   */
  _applyRimBound() {
    const cap = this._rimSceneCap();
    for (let i = 0; i < this._rimBounded.length; i++) {
      const entry = this._rimBounded[i];
      entry.uniforms.uToonRimCeiling.value = Math.min(entry.ceiling, cap);
      entry.uniforms.uToonRimMax.value = Math.min(entry.max, cap);
    }
  }

  /**
   * Sweep the active scene for materials that still need wiring. Three jobs, one
   * traverse: cascade registration, the rim contract above, and the reference
   * gain the radiance solve normalises against.
   *
   * The gain and the bound list are both rebuilt from scratch on every sweep
   * rather than accumulated, because the quantity wanted is "what is *currently
   * in the scene*". A running maximum would survive a scene swap and keep the
   * cast of the previous battle setting the exposure of this one, and a running
   * list would keep the rig writing uniforms on materials nothing is drawing —
   * and `AssetForge` caches materials across swaps, so neither is hypothetical.
   * Measuring is a uniform read per toon material on a traverse that already
   * happens at 5 Hz.
   */
  refreshMaterials() {
    if (!this.scene || !this.csm) return;
    let gainPeak = 0;
    this._rimBounded.length = 0;
    // One material typically dresses many meshes; without this the bound list
    // would carry a duplicate entry per mesh and do the same writes N times.
    const seen = new Set();
    const visit = (m) => {
      this.registerMaterial(m);
      const toon = m?.userData?.toon;
      if (toon?.kind !== 'surface' || !RIM_SOLVE_CLASSES.has(toon.preset)) return;
      const u = toon.uniforms;
      const gain = u?.uToonRimGain?.value ?? 0;
      if (gain > gainPeak) gainPeak = gain;
      if (seen.has(m) || !u?.uToonRimCeiling || !u?.uToonRimMax) return;
      seen.add(m);
      const caps = m.userData.awRimCaps;
      if (caps) this._rimBounded.push({ uniforms: u, ceiling: caps.ceiling, max: caps.max });
    };
    this.scene.traverse((obj) => {
      const mat = obj.material;
      if (!mat) return;
      if (Array.isArray(mat)) {
        for (const m of mat) visit(m);
      } else {
        visit(mat);
      }
    });
    // A scene with no cast in it yet (a title card, a loading mount) must not
    // solve the rim against a gain of zero and blow the strength to its ceiling.
    this._rimGainPeak = gainPeak > 1e-3 ? gainPeak : RIM_GAIN_FALLBACK;
    this._applyRimBound();
  }

  /** Restore every patched material to the state it was handed to us in. */
  _detachAll() {
    for (const [material, prior] of this._patched) {
      if (prior) material.onBeforeCompile = prior;
      else delete material.onBeforeCompile;
      if (material.defines) {
        delete material.defines.USE_CSM;
        delete material.defines.CSM_CASCADES;
        delete material.defines.CSM_FADE;
      }
      material.needsUpdate = true;
    }
    this._patched.clear();
    // Clear CSM's own bookkeeping without letting its `dispose` delete the
    // hooks we have just restored.
    this.csm?.shaders.clear();
  }

  /* ------------------------------------------------------------- rig state */

  /**
   * Read the authoritative sources into `_target`. Never touches a light — the
   * easing in `update` is what actually drives them, so a scrub of the
   * time-of-day slider glides instead of cutting.
   */
  _sampleTarget() {
    const T = this._target;
    const sky = this.sky;
    let ambient;
    let sunHeight;

    if (sky) {
      // Sky already interpolates the ART_BIBLE section 3 table through a
      // periodic spline and already swings the key over to the moon-ring below
      // the horizon. Re-deriving any of it here would give the game two
      // opinions about what noon looks like.
      T.keyDir.copy(sky.sunDirection).normalize();
      T.keyColor.copy(sky.sunColor);
      T.keyIntensity = Math.max(0, sky.sunIntensity);
      T.exposure = sky.exposure * EXPOSURE_CALIBRATION;
      this._zenith.copy(sky.zenithColor);
      ambient = sky.ambientLevel;
      sunHeight = (sky.trueSunDirection ?? sky.sunDirection).y;
    } else {
      // Interior / no dome. Same table, same azimuth convention as Sky, so a
      // character walking indoors keeps a consistent key direction.
      const k = sampleTimeOfDay(this.timeOfDay);
      const elevation = THREE.MathUtils.degToRad(k.sunElevationDeg);
      const azimuth = THREE.MathUtils.degToRad(90 - (this.timeOfDay - 0.25) * 360);
      sunHeight = Math.sin(elevation);
      // A key arriving from below the floor lights nothing; keep the azimuth
      // and lift it, exactly as Sky does when the sun sets.
      const lifted = Math.max(Math.sin(elevation), 0.18);
      const ce = Math.sqrt(Math.max(0, 1 - lifted * lifted));
      T.keyDir.set(ce * Math.sin(azimuth), lifted, ce * Math.cos(azimuth)).normalize();
      T.keyColor.setHex(k.sun, THREE.SRGBColorSpace);
      T.keyIntensity = k.sunIntensity;
      T.exposure = k.exposure * EXPOSURE_CALIBRATION;
      this._zenith.setHex(k.zenith, THREE.SRGBColorSpace);
      ambient = k.ambient;
    }

    // ---- key chroma ------------------------------------------------------
    // The one place the rig is allowed to disagree with `Sky` about colour, and
    // it disagrees on purpose: `Sky` reports what its dome *renders*, which at a
    // 6-degree sun elevation is a heavily reddened disc, and section 2.2 does
    // not let a non-magic term carry that much chroma. Luminance and intensity
    // are untouched, so the exposure of the shot is unchanged and the sun disc
    // in frame keeps the saturated colour the dome painted; only the light
    // leaving it lands back inside the amber band.
    conformChroma(T.keyColor, pickKeyGamut(T.keyColor), KEY_CHROMA_TOLERANCE, KEY_CHROMA_RANGE);

    // Then the daylight white balance, gated on how high the sun genuinely is.
    // Sampling the section 3 table at the stage hour already lands on ~4900 K, so
    // on the frame this workstream is judged on the clamp is very nearly inert —
    // which is the point. It exists so the meadow key cannot drift out of the
    // late-morning band the plate shows as the clock moves, and it releases
    // entirely below ~27 degrees so every low-sun hour keeps its authored colour.
    // See `KEY_WHITE_MIN_K`.
    conformTemperature(
      T.keyColor,
      sstep(sunHeight, KEY_DAYLIGHT_HEIGHT_LOW, KEY_DAYLIGHT_HEIGHT_HIGH),
    );

    // ---- key elevation, staged -------------------------------------------
    // Azimuth is taken exactly as the dome reports it and rebuilt from the same
    // number, so the shadows and the sun disc always agree about *which way* the
    // light comes from. Only the elevation is held inside the staging band, and
    // the rebuild is unconditional rather than guarded on "did the clamp bite" —
    // reconstructing an unclamped direction from its own azimuth and elevation
    // is the identity to float precision, and a branch here would mean two code
    // paths for one vector.
    const keyAz = Math.atan2(T.keyDir.x, T.keyDir.z);
    const keyElDeg = THREE.MathUtils.clamp(
      THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(T.keyDir.y, -1, 1))),
      KEY_STAGE_ELEVATION_MIN_DEG, KEY_STAGE_ELEVATION_MAX_DEG,
    );
    const keyEl = THREE.MathUtils.degToRad(keyElDeg);
    const kce = Math.cos(keyEl);
    T.keyDir.set(kce * Math.sin(keyAz), Math.sin(keyEl), kce * Math.cos(keyAz)).normalize();

    // `dayness` drives every "is this a sunlit frame" decision in the rig. It
    // is a function of the *true* sun height, not the key's, so the night rig
    // does not flip back to daylight just because the ring happens to be high.
    const dayness = sstep(sunHeight, -0.10, 0.25);
    this._dayness = dayness;

    // ---- fill ------------------------------------------------------------
    // ART_BIBLE section 2.1, literally: sky colour = mix(skyZenith, SHADOW_TINT, 0.5),
    // then held inside the hue window and above the saturation floor.
    T.fillSky.copy(this._zenith).lerp(this._shadowTint, 0.5);
    this._enforceShadowRule(T.fillSky, true);

    // Ground bounce keeps BOUNCE_GROUND's hue at every hour and loses only
    // chroma as the sun goes; see BOUNCE_NIGHT_CHROMA for why the hue is left
    // alone. The saturation floor still applies.
    T.fillGround.copy(this._bounce).getHSL(this._hsl, THREE.SRGBColorSpace);
    T.fillGround.setHSL(
      this._hsl.h,
      Math.max(
        MIN_SHADOW_SATURATION,
        this._hsl.s * THREE.MathUtils.lerp(BOUNCE_NIGHT_CHROMA, 1, dayness),
      ),
      this._hsl.l,
      THREE.SRGBColorSpace,
    );

    // Both fill colours now carry hue only. The shadow rule and the bounce rule
    // above are statements about *hue and saturation* — neither says how bright
    // an ambient term is — so rescaling to unit luminance loses nothing they
    // assert and makes `fillIntensity` the single place the level is decided.
    // Without this the hemisphere's real contribution was its intensity times a
    // 0.088-luminance navy, i.e. an order of magnitude under what the budget
    // below believes it is spending. See `AMBIENT_KEY_SHARE`.
    normaliseLuminance(T.fillSky);
    normaliseLuminance(T.fillGround, BOUNCE_SKY_SHARE);

    // ---- the ambient budget, divided --------------------------------------
    // A *target* share of the key rather than a ceiling under the section 3
    // `ambient` column: that column is written against the old dark fill colour
    // and in these units is only meaningful as a night floor, which is the job it
    // keeps here. See `AMBIENT_KEY_SHARE`.
    const budget = Math.max(
      AMBIENT_MIN, ambient, T.keyIntensity * AMBIENT_KEY_SHARE,
    );
    // The probe is clamped to its share, never raised to it: a scene that wants
    // less environment reflection than the budget allows keeps what it authored,
    // and only an over-budget probe is pulled back.
    T.probeIntensity = Math.min(this._authoredProbe(), budget * AMBIENT_PROBE_SHARE);
    // Whatever the probe did not spend. Taking the remainder rather than a
    // second fixed share is what keeps the total on budget when the probe comes
    // in under its cap — or when there is no probe at all, in which case the
    // hemisphere absorbs its share and an interior looks exactly as before.
    T.fillIntensity = Math.max(0, budget - T.probeIntensity);

    // ---- rim -------------------------------------------------------------
    // Opposite the key in azimuth — the ring's own side of the sky, per
    // ART_BIBLE section 3's dusk note — with elevation derived from the *staged*
    // key's, so a low dusk key gets a low, raking rim and a high noon key gets a
    // steeper one, both inside the band that actually catches a chibi head.
    const rimAz = keyAz + THREE.MathUtils.degToRad(RIM_AZIMUTH_DEG);
    const rimElDeg = THREE.MathUtils.clamp(
      RIM_ELEVATION_BASE_DEG + keyElDeg * RIM_ELEVATION_FROM_KEY,
      RIM_ELEVATION_MIN_DEG, RIM_ELEVATION_MAX_DEG,
    );
    const rimEl = THREE.MathUtils.degToRad(rimElDeg);
    const rce = Math.cos(rimEl);
    T.rimDir.set(rce * Math.sin(rimAz), Math.sin(rimEl), rce * Math.cos(rimAz)).normalize();

    // RING_GLOW is the palette's named rim colour; a fraction of the key's
    // chroma is folded in so a sunset rim carries a trace of the sun without
    // ever losing the cool separation the whole look depends on. This is the
    // analytic light — the ring, lighting the environment.
    mixChroma(this._ringGlow, T.keyColor, RIM_KEY_TINT * dayness, T.rimColor);
    // A *share* of the key, not an absolute. The toon shader weights every
    // light's ramp by its radiance relative to `uKeyColor`, so an analytic back
    // light at a fixed level becomes a co-dominant second key the moment the sun
    // goes down — a broad unramped diffuse lift on every back-facing surface,
    // which is the shoulder blowout and the white hair the review measured.
    // Bounding it as a fraction of the key makes it a fill light at every hour
    // by construction. See `RIM_KEY_SHARE`.
    T.rimIntensity = THREE.MathUtils.clamp(
      T.keyIntensity * RIM_KEY_SHARE, RIM_INTENSITY_MIN, RIM_INTENSITY_MAX,
    ) * this.rimBoost;

    // The character rim is anchored rather than derived, at every hour: the haze
    // it has to cut through is pinned to the cool end of the palette by
    // `_conformAtmosphere`, and the answer to a low-chroma teal band is a
    // high-chroma teal edge a stop and a half above it — not a warm one. See
    // `CHAR_RIM_ANCHOR`. The gamut projection is what holds it under the magic
    // reserve while leaving it well clear of the environment's own ceiling.
    T.charRimColor.copy(this._charRimAnchor);
    conformChroma(T.charRimColor, CHAR_RIM_GAMUT, 0, KEY_CHROMA_RANGE);
  }

  /**
   * ART_BIBLE section 2.1's testable clause, enforced in place.
   *
   * `Palette.applyShadowRule` implements the same policy by blending further
   * toward `SHADOW_TINT`, which is only an approximate correction — one blend
   * step is not guaranteed to clear the floor, and it measurably does not for
   * the dim, near-neutral fill colours this rig produces at night. Setting
   * saturation and hue directly in HSL is exact in one step, preserves
   * lightness (so a correction can never shift the scene's exposure), and
   * allocates nothing on a path that runs every frame the clock is moving.
   * Saturation is measured in sRGB because that is what an eyedropper reports.
   *
   * @param {boolean} clampHue also pin the hue into the +/-8 degree window.
   *   True for sky-derived fill, false for the deliberately warm ground bounce.
   */
  _enforceShadowRule(c, clampHue) {
    c.getHSL(this._hsl, THREE.SRGBColorSpace);
    const s = Math.max(this._hsl.s, MIN_SHADOW_SATURATION);
    let h = this._hsl.h;
    if (clampHue) {
      // Signed shortest angular distance, so a hue at 350 corrects downward
      // through zero rather than the long way round.
      let delta = ((this._hsl.h * 360 - SHADOW_HUE_DEG + 540) % 360) - 180;
      delta = THREE.MathUtils.clamp(delta, -SHADOW_HUE_WINDOW_DEG, SHADOW_HUE_WINDOW_DEG);
      h = (((SHADOW_HUE_DEG + delta) / 360) % 1 + 1) % 1;
    }
    if (h === this._hsl.h && s === this._hsl.s) return c;
    return c.setHSL(h, s, this._hsl.l, THREE.SRGBColorSpace);
  }

  /**
   * The probe level the scene asked for, latched per environment map.
   *
   * `_applyState` writes `environmentIntensity` every frame, so reading the live
   * value back as the authored one would compound: the first clamp would become
   * the new authored level, the next frame would clamp that, and the probe would
   * ratchet toward zero and never recover when the budget widened again. Latched
   * on the texture's identity rather than on a mount callback because
   * `AssetForge` hands the same PMREM result to several scenes and a scene may
   * swap its environment without telling the rig.
   */
  _authoredProbe() {
    const env = this.scene?.environment ?? null;
    // A null probe reports nothing but does *not* clear the latch. Scenes drop
    // `scene.environment` for a pass and put the same texture back — the matte
    // silhouette capture does exactly that — and clearing here would re-latch on
    // restore against the clamped value the rig itself wrote, permanently losing
    // the level the scene authored.
    if (!env) return 0;
    if (this._probeSource !== env) {
      this._probeSource = env;
      // `environmentIntensity` defaults to 1 and a scene that never set it means
      // "as authored", which is the whole budget's worth — the clamp is what
      // brings that back into range.
      this._probeAuthoredLevel = this.scene.environmentIntensity ?? 1;
    }
    return this._probeAuthoredLevel;
  }

  /** Push `_current` into the actual lights and the shared uniform block. */
  _applyState() {
    const S = this._current;

    // The cascade lights are the key: CSM owns their transform, we own their
    // radiometry. Direction is the vector light *travels*, hence the negation.
    if (this.csm) {
      this.csm.lightDirection.copy(S.keyDir).negate().normalize();
      this.csm.lightIntensity = S.keyIntensity;
      for (const l of this.csm.lights) {
        l.color.copy(S.keyColor);
        l.intensity = S.keyIntensity;
      }
    }

    this.fill.color.copy(S.fillSky);
    this.fill.groundColor.copy(S.fillGround);
    this.fill.intensity = S.fillIntensity;

    // ARCHITECTURE's service table assigns the env probe to this module, and the
    // budget split is only true if the probe respects it — an unclamped
    // `environmentIntensity` is ambient the rig cannot see and cannot occlude.
    if (this.scene?.environment) this.scene.environmentIntensity = S.probeIntensity;

    // Directional lights in three are aimed from `position` toward `target`;
    // parking the rim at a fixed radius keeps it well outside any scene and
    // makes its world direction exactly `rimDir`.
    this.rim.position.copy(S.rimDir).multiplyScalar(60);
    this.rim.target.position.set(0, 0, 0);
    this.rim.target.updateMatrixWorld();
    this.rim.color.copy(S.rimColor);
    this.rim.intensity = S.rimIntensity;

    const u = this.uniforms;
    u.uKeyDirection.value.copy(S.keyDir);
    u.uKeyColor.value.copy(S.keyColor).multiplyScalar(S.keyIntensity);
    u.uRimDirection.value.copy(S.rimDir);
    // Unit colour: the character rim's level lives entirely in `uRimStrength`.
    // See the `uniforms` block for why this one is not premultiplied.
    u.uRimColor.value.copy(S.charRimColor);
    u.uFillSky.value.copy(S.fillSky).multiplyScalar(S.fillIntensity);
    u.uFillGround.value.copy(S.fillGround).multiplyScalar(S.fillIntensity);

    // Ahead of the rim solve, not after it: the solve's target is a ratio over
    // the fog, and the fog is not final until it has been conformed. Running
    // these the other way round is how the rim ended up chasing last frame's
    // haze — invisible while the clock is still, and a visible lag on a scrub.
    this._conformAtmosphere();
    this._solveCharacterRim();
    // The bound is a function of exposure, which eases on its own clock, so it
    // is restated every frame rather than only on the 5 Hz material sweep.
    this._applyRimBound();

    // ART_BIBLE section 3 pins exposure to the time of day. Sky writes the same
    // value un-eased; services tick in registration order and `lighting` is
    // registered after `sky`, so the eased value is the one that survives.
    const renderer = this.engine?.renderer;
    if (renderer) renderer.toneMappingExposure = S.exposure;
  }

  /**
   * Hold `scene.fog` inside the section 2.1 atmosphere band.
   *
   * Fog is listed in section 2.1's *Light and atmosphere* table alongside the
   * key, the bounce and the shadow tint, and it is in-scattered light — the
   * same class of quantity this rig already polices for the hemisphere fill. It
   * is also, in a frame built on heavy atmospheric perspective, the single
   * largest area of chroma on screen, so it decides the frame's dominant hue
   * more than any surface does.
   *
   * `Sky` derives it from the horizon radiance the dome is painting, which is
   * the right way to keep the fog and the sky from separating at the skirt, but
   * it inherits whatever the section 3 fog key says — and the dusk key is the
   * mauve `#8A5E7A`, hue 318, straight into the wedge section 2.2 reserves for
   * dark magic. The projection below leaves the value, the density and the
   * cool-to-warm trend across the day exactly as authored and only removes
   * chroma the contract does not allow.
   *
   * Recomputed from `Sky`'s own field rather than from `scene.fog.color`
   * wherever a dome exists, so this is a pure function of the authored colour
   * and cannot compound with itself, with `Sky`, or with a scene that tints the
   * fog further after the rig has ticked.
   */
  _conformAtmosphere() {
    const fog = this.scene?.fog;
    if (!fog?.color) return;

    // The depth cue, as a floor rather than a setting. See
    // `AERIAL_EXTINCTION_AT_RANGE`. Only `FogExp2` is driven: linear `Fog`
    // states its own near and far in metres, which is a scene composing a
    // specific cutoff rather than declaring an atmosphere, and overruling that
    // would move geometry in and out of visibility rather than wash it.
    if (fog.isFogExp2) {
      fog.density = Math.max(fog.density, AERIAL_DENSITY_K / Math.max(20, this.shadowDistance));
    }

    const source = this.sky?.fogColor ?? fog.color;
    fog.color.copy(source);
    conformChroma(fog.color, FOG_GAMUT, FOG_CHROMA_TOLERANCE, FOG_CHROMA_RANGE);

    // Then anchor the single available fog colour nearer the cool end of the
    // section 2.1 axis; see FOG_COOL_BIAS_LOW_SUN. `mixChroma` moves hue and
    // saturation only and restores the incoming luminance exactly, so this
    // cannot change the density read of the haze or the exposure of the shot —
    // it decides what colour the frame's largest chroma area is, and nothing
    // else. Recomputed from the authored source every frame like the projection
    // above, so it is idempotent rather than a per-frame ratchet toward teal.
    const bias = THREE.MathUtils.lerp(FOG_COOL_BIAS_LOW_SUN, FOG_COOL_BIAS_DAY, this._dayness);
    if (bias > 1e-3) {
      fog.color.copy(mixChroma(fog.color, this._hazeAnchor, bias, this._fogScratch));
      // Re-project. The bias moves along the neutral-to-`HAZE_SKY` edge, which is
      // inside the gamut by construction, so this second pass is purely the
      // chroma ceiling — and it is needed: a dark night fog carries very little
      // luminance and lands well past the ceiling once its chromaticity is pulled
      // all the way to the anchor.
      conformChroma(fog.color, FOG_GAMUT, FOG_CHROMA_TOLERANCE, FOG_CHROMA_RANGE);
    }

    // The haze's *value*, which `mixChroma` deliberately cannot set.
    //
    // This is the half of the distance cue the previous rig had no opinion about
    // at all, and it is the half that decides whether a background recedes. The
    // fog colour arrived carrying whatever luminance `Sky` was painting its
    // horizon at, and on the shipped meadow frame that landed the far rocks
    // *darker* than the sky above them — the one arrangement no amount of
    // desaturation reads as distance, because aerial perspective is a mix toward
    // the sky and a mix cannot pull a surface away from what it is mixing with.
    //
    // Authored on screen and inverted through the same transfer chain the frame
    // is graded with, exactly as `RIM_DISPLAY_CAP` is, then divided by the live
    // exposure — a scene-radiance constant cannot promise a display value while
    // the clock is moving exposure. A floor rather than an assignment, and faded
    // out by `dayness`, so a night or storm frame keeps its own dark air.
    const floor = HAZE_SCENE_LUMA_AT_UNIT_EXPOSURE * this._dayness
      / Math.max(1e-3, this._current.exposure);
    const y = lumOf(fog.color);
    if (y < floor) normaliseLuminance(fog.color, floor);
  }

  /**
   * Solve `uRimStrength` so the character rim's hottest sliver lands a fixed
   * contrast step above the haze it has to cut through.
   *
   * `toonSurface` adds `uRimColor * (awRim * awHeadroom * uToonRimGain *
   * uRimStrength)` to specular, and `awRim` reaches 1 exactly where the surface
   * is both grazing and facing the rim, so the unoccluded peak is the product
   * below. Three properties of that product are the point:
   *
   *  - It is solved against **luminance**, not the largest channel. Normalising
   *    the peak channel drives one primary to the target and leaves the other
   *    two near zero, which is a white line with a colourful name — and a white
   *    line is what the review read as a second, brighter outline.
   *  - The reference gain is **measured**, not copied. See `RIM_SOLVE_CLASSES`.
   *  - The target is **relative to the fog**, so a rim can never be dimmer than
   *    the mist it separates a character from. That is not a tuning preference;
   *    a separation device below the value it separates against does not exist
   *    on screen, whatever number is in the uniform.
   *
   * `awHeadroom` still bounds the result per surface, so this is the ceiling the
   * rim reaches on a dark coat and not a floor imposed on a lit face — and
   * `_applyRimBound` makes that ceiling the same display cap this solve targets,
   * so the two agree by construction instead of by two constants that were once
   * chosen to.
   */
  _solveCharacterRim() {
    const S = this._current;
    const cap = this._rimSceneCap();

    // The haze the cast reads against. `FogExp2` asymptotes to its own colour,
    // so for anything at mid-ground depth — the whole battle stage — that colour
    // *is* the background radiance, in the same pre-tonemap linear space as the
    // rim. Scenes with no fog fall through to the floor, which is correct: an
    // interior has no mist to lose the silhouette in, and the rim there is a
    // fixed art device rather than a contrast solve.
    const haze = this.scene?.fog?.color ? lumOf(this.scene.fog.color) : 0;
    const base = THREE.MathUtils.clamp(
      haze * RIM_OVER_HAZE, cap * RIM_PEAK_LUMA_FLOOR_SHARE, cap,
    );
    // `rimBoost` scales the *target*, and it has to be applied here rather than
    // left to ride `rimIntensity`: the solve is a ratio, so a boost folded into
    // the peak divides straight back out and a scene asking for a hotter rim
    // silently gets the standard one. Scaling after the floor rather than before
    // it keeps a deliberate *dim* honest too — a scene pulling the rim down for
    // a shot must not be clamped back up by the night floor — while the display
    // cap still holds, so a boost buys headroom up to it and no further.
    const target = Math.min(base * this.rimBoost, cap);

    // `rimIntensity` is deliberately absent: `uRimColor` is published at unit
    // level, so the analytic back light no longer scales the character edge and
    // dropping it to a fill level costs the cast nothing. Without that split the
    // solve had to make the ratio back up through `RIM_STRENGTH_MAX`, and the
    // clamp — not the target — decided how bright the rim was on exactly the
    // frames where the key is dimmest.
    const peak = lumOf(S.charRimColor) * this._rimGainPeak;
    this.uniforms.uRimStrength.value = target > 1e-4 && peak > 1e-4
      ? THREE.MathUtils.clamp(target / peak, RIM_STRENGTH_MIN, RIM_STRENGTH_MAX)
      : 0;
  }

  /**
   * Re-read every source and apply it immediately, with no easing.
   *
   * Used on a scene mount and on a scripted time-of-day jump, where a glide
   * would mean the capture harness screenshots a frame mid-transition.
   */
  sync() {
    this._sampleTarget();
    const S = this._current;
    const T = this._target;
    S.keyDir.copy(T.keyDir);
    S.keyColor.copy(T.keyColor);
    S.keyIntensity = T.keyIntensity;
    S.fillSky.copy(T.fillSky);
    S.fillGround.copy(T.fillGround);
    S.fillIntensity = T.fillIntensity;
    S.probeIntensity = T.probeIntensity;
    S.rimDir.copy(T.rimDir);
    S.rimColor.copy(T.rimColor);
    S.charRimColor.copy(T.charRimColor);
    S.rimIntensity = T.rimIntensity;
    S.exposure = T.exposure;
    this._applyState();
    this._fitCascades(true);
    return this;
  }

  /* ------------------------------------------------------------------ tick */

  /**
   * @param {number} dt seconds, already scaled by `engine.timeScale`.
   *
   * Guarded against double-integration: scenes call this directly *and* the
   * engine ticks it as a registered service, so without the frame stamp the
   * easing would run twice per frame and the light pool envelopes would decay
   * at double speed.
   */
  update(dt) {
    const frame = this.engine?.frame ?? -1;
    if (frame >= 0 && frame === this._lastFrame) return;
    this._lastFrame = frame;

    this._sampleTarget();

    const S = this._current;
    const T = this._target;
    const kc = approach(dt, TAU_COLOR);
    const kd = approach(dt, TAU_DIRECTION);
    const ke = approach(dt, TAU_EXPOSURE);

    slerpDir(S.keyDir, T.keyDir, kd, this._vecB);
    S.keyDir.copy(this._vecB);
    slerpDir(S.rimDir, T.rimDir, kd, this._vecB);
    S.rimDir.copy(this._vecB);

    S.keyColor.lerp(T.keyColor, kc);
    S.fillSky.lerp(T.fillSky, kc);
    S.fillGround.lerp(T.fillGround, kc);
    S.rimColor.lerp(T.rimColor, kc);
    S.charRimColor.lerp(T.charRimColor, kc);
    S.keyIntensity += (T.keyIntensity - S.keyIntensity) * kc;
    S.fillIntensity += (T.fillIntensity - S.fillIntensity) * kc;
    S.probeIntensity += (T.probeIntensity - S.probeIntensity) * kc;
    S.rimIntensity += (T.rimIntensity - S.rimIntensity) * kc;
    S.exposure += (T.exposure - S.exposure) * ke;

    this._applyState();
    this._fitCascades(false);
    this._updatePool(dt);

    this._scanTimer -= dt;
    if (this._scanTimer <= 0) {
      this._scanTimer = MATERIAL_SCAN_INTERVAL;
      this.refreshMaterials();
    }
  }

  /**
   * Refit the cascades to this frame's camera.
   *
   * Two things must be true before `csm.update()` can be trusted. First, the
   * camera's world matrix has to be current: scenes move the camera in their
   * own `update`, but three only refreshes `matrixWorld` inside `render()`,
   * which happens *after* services tick — without this the cascades would trail
   * the camera by one frame and pop shadows in during a fast pan. Second, a
   * lens or camera change invalidates the split distances entirely, so the
   * frustum is re-derived whenever the projection actually changed rather than
   * every frame (`updateFrustums` re-solves bounds for every cascade).
   */
  _fitCascades(force) {
    const csm = this.csm;
    if (!csm) return;
    const cam = this._activeCamera();
    if (!cam) return;

    const key = `${cam.uuid}|${cam.fov}|${cam.aspect}|${cam.near}|${cam.far}|${cam.zoom}`;
    if (force || key !== this._lensKey || csm.camera !== cam) {
      this._lensKey = key;
      csm.camera = cam;
      csm.maxFar = this.shadowDistance;
      csm.updateFrustums();
      this._applyCascadeBias();
    }

    cam.updateMatrixWorld();
    csm.update();
  }

  /* ------------------------------------------------------------ light pool */

  /**
   * Take a dynamic point light.
   *
   * Never returns null — a saturated pool evicts its lowest-priority, oldest
   * light instead, because a spell with no glow is a far more visible failure
   * than a torch that dimmed for a second. Callers may hold the handle for as
   * long as they like; a stale `release()` after eviction is a no-op.
   *
   * @param {object} o
   * @param {THREE.ColorRepresentation} [o.color]
   * @param {number} [o.intensity]  peak intensity
   * @param {number} [o.distance]   attenuation radius in metres
   * @param {number} [o.decay]      2 is physically correct
   * @param {THREE.Vector3} [o.position]
   * @param {number} [o.attack]     seconds to reach peak
   * @param {number} [o.hold]       seconds at peak; omit for a persistent light
   * @param {number} [o.release]    seconds to fade after `hold` or `release()`
   * @param {number} [o.flicker]    0..1 practical-fire modulation depth
   * @param {number} [o.priority]   higher survives eviction
   * @param {boolean} [o.shadow]    request the shadow-capable slot
   * @returns {LightHandle}
   */
  acquire(o = {}) {
    const slot = this._pickSlot(o.priority ?? 0, o.shadow === true);

    slot.serial++;
    slot.active = true;
    slot.age = 0;
    slot.t = 0;
    slot.priority = o.priority ?? 0;
    slot.attack = Math.max(0, o.attack ?? 0.06);
    slot.hold = o.hold === undefined ? Infinity : Math.max(0, o.hold);
    slot.release = Math.max(1e-3, o.release ?? 0.35);
    slot.peak = Math.max(0, o.intensity ?? 1.5);
    slot.flicker = THREE.MathUtils.clamp(o.flicker ?? 0, 0, 1);
    slot.env = 0;
    slot.releaseFrom = 1;
    // Seeded, never Math.random: a torch's flicker is on screen, so it has to
    // reproduce byte-for-byte between capture runs (ARCHITECTURE rule 7).
    slot.phase = rng.range(0, Math.PI * 2);

    const light = slot.light;
    // Default to the bible's practical tint — the one warm source it allows on
    // a night frame — so an un-coloured acquire is still on-palette.
    light.color.set(o.color ?? SURFACE_TINT.PRACTICAL);
    light.distance = o.distance ?? 12;
    light.decay = o.decay ?? 2;
    light.intensity = 0;
    if (o.position) light.position.copy(o.position);

    // The cube render is unfrozen only while a caller actually wants shadows,
    // so an idle or borrowed casting slot costs nothing.
    if (slot.canCastShadow) slot.light.shadow.autoUpdate = o.shadow === true;

    return new LightHandle(this, slot);
  }

  /**
   * Choose a slot. Free slots first, and the shadow-capable one is held back
   * unless it was asked for — otherwise the first spell of a battle takes the
   * only casting slot and the torch that needed it gets a flat light.
   *
   * With nothing free, evict. Preference goes to a victim the request actually
   * outranks; if every active light outranks it we still take the weakest,
   * because `acquire` returning nothing would mean a spell renders unlit and
   * that is the more visible failure.
   */
  _pickSlot(priority, wantsShadow) {
    if (wantsShadow) {
      for (const s of this._slots) if (!s.active && s.canCastShadow) return s;
    }
    for (const s of this._slots) if (!s.active && !s.canCastShadow) return s;
    for (const s of this._slots) if (!s.active) return s;

    let victim = null;
    let fallback = this._slots[0];
    for (const s of this._slots) {
      if (s.priority < fallback.priority
        || (s.priority === fallback.priority && s.age > fallback.age)) fallback = s;
      if (s.priority > priority) continue;
      if (!victim || s.priority < victim.priority
        || (s.priority === victim.priority && s.age > victim.age)) victim = s;
    }
    const chosen = victim ?? fallback;
    this._retire(chosen);
    return chosen;
  }

  _beginRelease(slot) {
    const cut = Math.max(0, slot.t - slot.attack);
    slot.hold = slot.hold === Infinity ? cut : Math.min(slot.hold, cut);
    slot.releaseFrom = slot.env;
  }

  _retire(slot) {
    slot.active = false;
    // Bumping the serial invalidates any handle still pointing here, so a late
    // `release()` from the previous owner cannot cut the new light short.
    slot.serial++;
    slot.light.intensity = 0;
    if (slot.canCastShadow) slot.light.shadow.autoUpdate = false;
  }

  /** Advance every active envelope. Runs once per frame, after the rig eases. */
  _updatePool(dt) {
    for (const slot of this._slots) {
      // Bake the shadow map for the casting slot on the first frames only; from
      // then on it is frozen until something acquires the slot, which keeps six
      // cube faces out of the frame budget while the light is idle.
      if (slot.canCastShadow && slot._warmFrames > 0) {
        slot._warmFrames--;
        if (slot._warmFrames === 0 && !slot.active) slot.light.shadow.autoUpdate = false;
      }
      if (!slot.active) continue;

      slot.t += dt;
      slot.age += dt;

      let env;
      if (slot.t < slot.attack) {
        const x = slot.t / slot.attack;
        env = x * x * (3 - 2 * x);
      } else if (slot.t < slot.attack + slot.hold) {
        env = 1;
      } else {
        const x = (slot.t - slot.attack - slot.hold) / slot.release;
        if (x >= 1) {
          this._retire(slot);
          continue;
        }
        env = slot.releaseFrom * (1 - x * x * (3 - 2 * x));
      }
      slot.env = env;

      if (slot.flicker > 0) {
        // Two incommensurate rates: a single sine reads as a pulsing bulb, and
        // real flame carries a slow buffet under a fast shimmer.
        const t = slot.t + slot.phase;
        const slow = 0.5 - 0.5 * Math.sin(t * 6.7);
        const fast = 0.5 - 0.5 * Math.sin(t * 19.3 + slot.phase * 2.13);
        env *= 1 - slot.flicker * (0.62 * slow + 0.38 * fast);
      }

      slot.light.intensity = slot.peak * env;
    }
  }

  /* --------------------------------------------------------------- teardown */

  _teardown() {
    if (this.csm) {
      for (const l of this.csm.lights) l.shadow?.map?.dispose();
      this.csm.remove();
      this.csm = null;
    }
    for (const slot of this._slots) slot.dispose();
    this._slots.length = 0;
  }

  dispose() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    // Unpatch before teardown: AssetForge caches materials across scene swaps,
    // so a chained hook still pointing at a destroyed CSM would follow them
    // into the next scene and throw on the first compile there.
    this._detachAll();
    this._teardown();
    // The bound list is the one place the rig holds a strong reference to
    // materials it does not own; a disposed rig must not keep the previous
    // scene's cast alive through it.
    this._rimBounded.length = 0;
    this.group.parent?.remove(this.group);
    this.rim.dispose?.();
    this.fill.dispose?.();
    this._probeSource = null;
    this.scene = null;
    this.sky = null;
  }
}
