/**
 * Colour helpers. Everything derives from tokens.ts; this module adds no new colours.
 */
import * as THREE from 'three';

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of two token colours in sRGB space (t = 0 -> a, 1 -> b). */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}

/** Multiply brightness (k < 1 darkens, k > 1 brightens, clamped). */
export function shade(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * k, g * k, b * k);
}

/** CSS rgba() string for canvas drawing. */
export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}

/** THREE.Color from a token (sRGB hex -> linear working space handled by three's ColorManagement). */
export function tcol(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

/** Vector3 of a token in linear space, for shader uniforms. */
export function tvec(hex: string, intensity = 1): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r * intensity, c.g * intensity, c.b * intensity);
}

/** Relative luminance (sRGB, WCAG) of a hex colour. */
export function luminance(hex: string): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = hexToRgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
