/**
 * AssetForge — every pixel of texture in the game is generated here.
 * STUB: returns flat placeholders so the app boots. Replaced by the art pass.
 */
import * as THREE from 'three';

export class AssetForge {
  constructor(renderer) {
    this.renderer = renderer;
    this._textures = new Map();
    this._materials = new Map();
  }

  texture(key, opts = {}) {
    if (this._textures.has(key)) return this._textures.get(key);
    const size = 64;
    const data = new Uint8Array(size * size * 4).fill(160);
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    this._textures.set(key, tex);
    return tex;
  }

  material(key, opts = {}) {
    if (this._materials.has(key)) return this._materials.get(key);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.8, ...opts });
    this._materials.set(key, mat);
    return mat;
  }

  environment() {
    return null;
  }

  dispose() {
    for (const t of this._textures.values()) t.dispose();
    for (const m of this._materials.values()) m.dispose();
    this._textures.clear();
    this._materials.clear();
  }
}
