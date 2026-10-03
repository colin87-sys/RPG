/**
 * Radial speed streaks (VFX lane A). Screen-space lines radiating from the
 * vanishing point, evaluated inside the PostStack composite pass (zero extra
 * passes, zero geometry). ~200 lines; dash length and opacity scale with
 * speed01; brighter toward the frame edges; fade out near the vanishing point
 * so the craft (lower centre) stays clean.
 *
 * Deterministic: animated only by PostFrame.time.
 */
import { vfx } from '../../style/tokens';

export interface StreakParams {
  /** number of radial lines (token vfx.speedStreaks.count) */
  count: number;
  /** fraction of lines that carry a dash at any moment */
  density: number;
  /** line width in px at 1080p (scaled with frame height) */
  widthPx: number;
  /** dash length as a fraction of the vanish->corner distance, at speed01 = 0 / 1 */
  lenMin: number;
  lenMax: number;
  /** max opacity (display space) */
  opacity: number;
  /** normalised radius where streaks start (0 = vanishing point, 1 = far corner) */
  inner: number;
  /** extra brightness toward the frame edges (token vfx.speedStreaks.edgeBoost) */
  edgeBoost: number;
  /** dash travel rate, cycles per second at speed01 = 1 */
  rate: number;
}

const base: StreakParams = {
  count: vfx.speedStreaks.count,
  density: 0.55,
  widthPx: 1.3,
  lenMin: 0.04,
  lenMax: 0.32,
  opacity: 0.34,
  inner: 0.42,
  edgeBoost: vfx.speedStreaks.edgeBoost,
  rate: 1.1,
};

export const STREAK_VARIANTS: Record<'A' | 'B' | 'C', StreakParams> = {
  /** A: token numbers, restrained */
  A: { ...base },
  /** B: sparser, thinner, longer (cleaner anime read) */
  B: { ...base, density: 0.4, widthPx: 1.1, lenMax: 0.42, opacity: 0.3, inner: 0.48 },
  /** C: denser analogue rush, shorter dashes */
  C: { ...base, density: 0.75, widthPx: 1.6, lenMin: 0.03, lenMax: 0.26, opacity: 0.42, inner: 0.38, rate: 1.4 },
};

/**
 * GLSL: float speedStreaks(vec2 fragPx, vec2 vanishPx, vec2 res, float time, float speed01)
 * Returns coverage 0..1. Needs the uniforms declared below (set by PostStack).
 */
export const GLSL_SPEED_STREAKS = /* glsl */ `
uniform float uStrCount;
uniform float uStrDensity;
uniform float uStrWidth;
uniform float uStrLenMin;
uniform float uStrLenMax;
uniform float uStrOpacity;
uniform float uStrInner;
uniform float uStrEdge;
uniform float uStrRate;

float strHash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }

float speedStreaks(vec2 fragPx, vec2 vanishPx, vec2 res, float time, float speed01) {
  if (speed01 <= 0.001 || uStrOpacity <= 0.0) return 0.0;
  vec2 d = fragPx - vanishPx;
  float r = length(d);
  // normalise by the distance from the vanishing point to the farthest corner
  vec2 far = max(vanishPx, res - vanishPx);
  float rn = r / max(length(far), 1.0);
  if (rn < uStrInner * 0.8) return 0.0;
  float a = atan(d.y, d.x) / 6.2831853 + 0.5;
  float s = a * uStrCount;
  float id = floor(s);
  float h1 = strHash(id * 1.37 + 0.11);
  float h2 = strHash(id * 3.17 + 7.30);
  float h3 = strHash(id * 5.71 + 1.90);
  float h4 = strHash(id * 9.13 + 3.70);
  if (h4 > uStrDensity) return 0.0;
  // line axis angle inside its sector, keeping a margin so neighbours never merge
  float la = (id + 0.25 + 0.5 * h1) / uStrCount;
  float perp = abs(r * sin((a - la) * 6.2831853));
  float sc = res.y / 1080.0;
  float halfW = uStrWidth * sc * (0.45 + 0.8 * h2) * 0.5;
  float line = 1.0 - smoothstep(halfW, halfW + sc, perp);
  if (line <= 0.0) return 0.0;
  // a dash travelling outward along the line, tail fading toward the centre
  float len = mix(uStrLenMin, uStrLenMax, speed01) * (0.55 + 0.9 * h3);
  float ph = fract(h2 * 7.13 + time * uStrRate * (0.6 + 0.8 * h1) * (0.35 + 0.65 * speed01));
  float head = mix(uStrInner, 1.0 + len, ph);
  float tail = clamp((rn - (head - len)) / max(len, 1e-3), 0.0, 1.0);
  float dash = tail * tail * (1.0 - smoothstep(head - 0.004, head + 0.004, rn));
  float edge = smoothstep(uStrInner, 1.0, rn);
  edge = edge * edge * (1.0 + (uStrEdge - 1.0) * edge) / uStrEdge;
  return clamp(line * dash * edge * uStrOpacity * speed01 * (0.45 + 0.55 * h3), 0.0, 1.0);
}
`;
