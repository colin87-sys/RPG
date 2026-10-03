/**
 * Structures board (World lane): the Cloudgate hull mass alone (3/4 view, side
 * view, black silhouette, plan view) and in context: a chase-camera frame with
 * the mass on the right of the corridor over a simple Cloudgate sky gradient
 * (the sky lane builds the real sky). Variants A/B/C = HULL_VARIANTS.
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { palette, stages } from '../../style/tokens';
import { tvec } from '../../style/color';
import { applyStageLook, lightUniforms } from '../../gen/common/lighting';
import { buildHullMass, HULL_VARIANTS } from '../../gen/world/structures/hullMass';
import { placeholderDelta } from './vista-wreck';

/** Board-only gradient sky from stages.cloudgate.sky (drawn at the far plane). */
function gradientSky(): THREE.Mesh {
  const s = stages.cloudgate.sky;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uZ: { value: tvec(s.zenith) },
      uM: { value: tvec(s.mid) },
      uH: { value: tvec(s.horizon) },
      uMidH: { value: s.midHeight },
      uSun: { value: tvec(s.sunColor) },
      uSunDir: { value: new THREE.Vector3(...stages.cloudgate.key.dir).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); p.z = p.w; gl_Position = p; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir; uniform vec3 uZ; uniform vec3 uM; uniform vec3 uH; uniform float uMidH; uniform vec3 uSun; uniform vec3 uSunDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 c = h < uMidH ? mix(uH, uM, smoothstep(0.0, uMidH, h)) : mix(uM, uZ, smoothstep(uMidH, 1.0, h));
        if (d.y < 0.0) c = uH;
        c += uSun * 0.25 * pow(max(dot(d, uSunDir), 0.0), 12.0);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), mat);
  m.frustumCulled = false;
  m.renderOrder = -1000;
  return m;
}

export default async function board(ctx: LabContext) {
  const variant = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const params = HULL_VARIANTS[variant];
  const seed = Number(ctx.q.get('seed') ?? 3);
  applyStageLook('cloudgate');
  const W = ctx.width, H = ctx.height;
  ctx.clearAll(palette.spaceDeep);

  const hull = buildHullMass(params, seed);
  hull.update(4.3);
  const L = hull.lengthMetres;

  // --- context: chase camera, craft at the origin, hull placed so an arch is ahead ---
  const ctxScene = new THREE.Scene();
  ctxScene.add(gradientSky());
  // place the hull so the camera sits ~35% into it
  hull.group.position.set(0, 0, L * 0.3);
  ctxScene.add(hull.group);
  const craft = placeholderDelta();
  craft.rotation.z = 0.12;
  ctxScene.add(craft);
  const chase = new THREE.PerspectiveCamera(68, 16 / 9, 0.5, 4000);
  chase.position.set(0, 5, 20);
  chase.lookAt(0, 2.2, -60);
  const main = { x: 12, y: 64, w: 1248, h: 702 };
  ctx.renderCells([{ scene: ctxScene, camera: chase, rect: main }], null);
  const info = ctx.renderer.info.render;
  const measured = { triangles: info.triangles, calls: info.calls };
  ctx.label('in context: chase cam (0,5,20) FOV 68, Cloudgate rig, gradient sky placeholder', main.x + 8, main.y + 8);

  // --- alone: 3/4, side, silhouette (right column), plan (below context) ---
  // (fog off for the kilometre-scale inspection views; restored after)
  const fogKeep = lightUniforms.uFogDensity.value;
  const fogHKeep = lightUniforms.uFogHeightFalloff.value;
  lightUniforms.uFogDensity.value = 0.00015;
  lightUniforms.uFogHeightFalloff.value = 0;
  const alone = new THREE.Scene();
  const hull2 = buildHullMass(params, seed);
  hull2.update(4.3);
  alone.add(hull2.group);
  alone.add(gradientSky());
  const cx = params.clearance + params.halfWidth;
  const target = new THREE.Vector3(cx * 0.6, 0, -L / 2);
  const colX = 1272, colW = W - colX - 12, cellH = (H - 64 - 12 - 24) / 3;
  const cells = [0, 1, 2].map((i) => ({ x: colX, y: 64 + i * (cellH + 12), w: colW, h: cellH }));

  const cam34 = new THREE.PerspectiveCamera(40, colW / cellH, 1, 6000);
  cam34.position.set(-L * 0.55, L * 0.42, L * 0.35);
  cam34.lookAt(target);
  ctx.renderCells([{ scene: alone, camera: cam34, rect: cells[0] }], null);
  ctx.label('3/4 view (front-left, above)', cells[0].x + 6, cells[0].y + 6);

  const side = new THREE.OrthographicCamera(-L * 0.55, L * 0.55, (L * 0.55 * cellH) / colW, (-L * 0.55 * cellH) / colW, 1, 6000);
  side.position.set(-1500, 5, -L / 2);
  side.lookAt(0, 5, -L / 2);
  ctx.renderCells([{ scene: alone, camera: side, rect: cells[1] }], null);
  ctx.label('side view from the corridor (ortho)', cells[1].x + 6, cells[1].y + 6);

  const sil = buildHullMass(params, seed, { silhouette: true });
  const silScene = new THREE.Scene();
  silScene.add(sil.group);
  const silCam = new THREE.PerspectiveCamera(50, colW / cellH, 1, 6000);
  silCam.position.set(-40, 14, 260);
  silCam.lookAt(cx * 0.4, 5, -L * 0.4);
  ctx.renderCells([{ scene: silScene, camera: silCam, rect: cells[2], clear: palette.cloudCream }], null);
  ctx.label('silhouette test (approach view, fill black)', cells[2].x + 6, cells[2].y + 6, palette.hudValue);

  const planRect = { x: 12, y: main.y + main.h + 12, w: 1248, h: H - (main.y + main.h + 12) - 12 };
  const halfH = 175, halfW = (halfH * planRect.w) / planRect.h;
  const plan = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 1, 6000);
  plan.position.set(15, 1500, -L / 2);
  plan.up.set(1, 0, 0);
  plan.lookAt(15, 0, -L / 2);
  ctx.renderCells([{ scene: alone, camera: plan, rect: planRect, clear: palette.cloudShadow }], null);
  ctx.label('plan view (corridor axis horizontal, bow curvature)', planRect.x + 6, planRect.y + 6);
  lightUniforms.uFogDensity.value = fogKeep;
  lightUniforms.uFogHeightFalloff.value = fogHKeep;

  const st = hull.stats;
  ctx.title('Cloudgate hull mass', `${st.triangles} tris, ${st.drawCalls} calls, ${st.lights} lights, ${L.toFixed(0)} m (${(L / 45).toFixed(1)} s at 45 m/s) | ctx frame measured ${measured.triangles} tris ${measured.calls} calls`);

  ctx.exportParams({ board: 'structures', variant, seed, params, lengthMetres: L, stats: st, measuredContextFrame: measured, camera: { pos: [0, 5, 20], lookAt: [0, 2.2, -60], fov: 68 }, placement: { hullGroupZ: L * 0.3 } });
  ctx.ready();
}
