/**
 * View: maps the rail-space simulation to a three.js scene and camera.
 * Placeholder visuals (M0/M1) are built on the shared toon rig; lane modules
 * replace them at integration time. Story cameras for captures live here too.
 */
import * as THREE from 'three';
import type { Game } from './game';
import { Rail, makeFrame } from './rail';
import { T } from '../data/tuning';
import { palette, stages, type StageId } from '../style/tokens';
import { applyStageLook } from '../gen/common/lighting';
import { toonMaterial } from '../gen/common/materials';
import { tcol } from '../style/color';

export const STORY_CAMERAS = ['play', 'hero', 'vista', 'combat', 'hud', 'title'] as const;
export type StoryCamera = (typeof STORY_CAMERAS)[number];

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const frame = makeFrame();

export class View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  storyCam: StoryCamera = 'play';
  private craft: THREE.Group;
  private enemyMeshes: Record<string, THREE.InstancedMesh> = {};
  private bulletMesh: THREE.InstancedMesh;
  private shotMesh: THREE.InstancedMesh;
  private missileMesh: THREE.InstancedMesh;
  private laserMesh: THREE.InstancedMesh;
  private sky: THREE.Mesh;
  private sea: THREE.Mesh;
  private stageId: StageId | null = null;

  constructor(private game: Game) {
    this.camera = new THREE.PerspectiveCamera(T.camera.fov, 16 / 9, 0.5, 8000);
    // sky placeholder: gradient sphere
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uTop: { value: tcol(palette.skyZenith) }, uMid: { value: tcol(palette.skyDay) }, uBot: { value: tcol(palette.skyHorizon) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uBot; varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = h>0.0 ? mix(uMid,uTop,smoothstep(0.0,0.8,h)) : mix(uMid,uBot,smoothstep(0.0,0.3,-h)); c = mix(uBot, c, smoothstep(-0.05,0.25,h+0.05)); gl_FragColor = vec4(c,1.0);\n#include <colorspace_fragment>\n}',
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), skyMat);
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    this.sea = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 1, 1), toonMaterial({ albedo: palette.cloudSea }));
    this.sea.rotation.x = -Math.PI / 2;
    this.scene.add(this.sea);
    // craft placeholder: faceted delta
    this.craft = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(2.2, 12, 4, 1), toonMaterial({ albedo: palette.armourLight }));
    body.rotation.x = -Math.PI / 2;
    body.scale.set(1, 1, 0.35);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(9, 0.3, 3), toonMaterial({ albedo: palette.armourSteel }));
    wing.position.z = 2;
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), toonMaterial({ albedo: palette.accentOrange, emissive: palette.exhaustCore, emissiveStrength: 2 }));
    glow.position.z = 6.2;
    this.craft.add(body, wing, glow);
    this.scene.add(this.craft);
    // enemies (instanced placeholders per kind)
    const mk = (geo: THREE.BufferGeometry, hex: string, n: number, emissive?: string) => {
      const m = new THREE.InstancedMesh(geo, toonMaterial({ albedo: hex, emissive, emissiveStrength: 0.6 }), n);
      m.frustumCulled = false; m.count = 0; this.scene.add(m); return m;
    };
    this.enemyMeshes.caltrop = mk(new THREE.OctahedronGeometry(1.1), palette.caltropRed, 96, palette.caltropRed);
    this.enemyMeshes.dart = mk(new THREE.ConeGeometry(1.6, 7, 3), palette.enemyBody, 32, palette.enemyMarker);
    this.enemyMeshes.sniper = mk(new THREE.CylinderGeometry(0.8, 1.6, 8, 6), palette.enemyPanel, 16, palette.enemyMarker);
    this.enemyMeshes.strider = mk(new THREE.BoxGeometry(6, 16, 4), palette.enemyBody, 8, palette.enemyMarker);
    const add = (geo: THREE.BufferGeometry, hex: string, n: number) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: tcol(hex) }), n);
      m.frustumCulled = false; m.count = 0; this.scene.add(m); return m;
    };
    this.bulletMesh = add(new THREE.SphereGeometry(1, 10, 8), palette.hostileHalo, 320);
    this.shotMesh = add(new THREE.BoxGeometry(0.15, 0.15, 3), palette.playerShotHalo, 256);
    this.missileMesh = add(new THREE.ConeGeometry(0.3, 1.8, 6), palette.smokeLit, 24);
    this.laserMesh = add(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), palette.laserRed, 24);
  }

  private ensureStage(): void {
    const id = this.game.stage.id;
    if (id === this.stageId) return;
    this.stageId = id;
    const look = applyStageLook(id);
    const u = (this.sky.material as THREE.ShaderMaterial).uniforms;
    u.uTop.value = tcol(look.sky.zenith); u.uMid.value = tcol(look.sky.mid); u.uBot.value = tcol(look.sky.horizon);
    void stages;
  }

  /** place an object at rail coords with an orientation built from the rail frame */
  private railMatrix(rail: Rail, s: number, u: number, x: number, y: number, yaw: number, roll: number, scale: number, out: THREE.Matrix4) {
    rail.frameAt(s + u, frame);
    const pos = tmpV.copy(frame.pos).addScaledVector(frame.right, x).addScaledVector(frame.up, y);
    // basis: x = right, y = up, z = -tangent (three forward is -Z)
    tmpM.makeBasis(frame.right, frame.up, tmpV2.copy(frame.tan).negate());
    tmpQ.setFromRotationMatrix(tmpM);
    const q2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -yaw, -roll, 'YXZ'));
    tmpQ.multiply(q2);
    out.compose(pos, tmpQ, tmpV2.setScalar(scale));
    return out;
  }

  update(aspect: number): void {
    const g = this.game;
    this.ensureStage();
    const rail = g.rail, s = g.s, p = g.player;
    const m = new THREE.Matrix4();
    // craft
    this.railMatrix(rail, s, 0, p.x, p.y, p.yaw, p.bank + p.spin, 1, m);
    m.decompose(this.craft.position, this.craft.quaternion, this.craft.scale);
    this.craft.visible = g.state !== 'title' && p.alive;
    // enemies
    const counts: Record<string, number> = { caltrop: 0, dart: 0, sniper: 0, strider: 0 };
    for (const e of g.enemies) {
      if (!e.alive || !(e.kind in counts)) continue;
      if (e.b.pattern === 'chain' && e.age < e.b.delay) continue;
      const mesh = this.enemyMeshes[e.kind];
      this.railMatrix(rail, s, e.u, e.x, e.y, e.yaw, e.roll, 1, m);
      mesh.setMatrixAt(counts[e.kind]++, m);
    }
    for (const k in counts) { const mesh = this.enemyMeshes[k]; mesh.count = counts[k]; mesh.instanceMatrix.needsUpdate = true; }
    let n = 0;
    for (const b of g.bullets) if (b.alive) this.bulletMesh.setMatrixAt(n++, this.railMatrix(rail, s, b.u, b.x, b.y, 0, 0, b.radius, m));
    this.bulletMesh.count = n; this.bulletMesh.instanceMatrix.needsUpdate = true;
    n = 0;
    for (const sh of g.shots) if (sh.alive) this.shotMesh.setMatrixAt(n++, this.railMatrix(rail, s, sh.u, sh.x, sh.y, 0, 0, 1, m));
    this.shotMesh.count = n; this.shotMesh.instanceMatrix.needsUpdate = true;
    n = 0;
    for (const mi of g.missiles) if (mi.alive && mi.launchDelay <= 0) this.missileMesh.setMatrixAt(n++, this.railMatrix(rail, s, mi.u, mi.x, mi.y, 0, 0, 1, m));
    this.missileMesh.count = n; this.missileMesh.instanceMatrix.needsUpdate = true;
    n = 0;
    for (const l of g.lasers) {
      if (!l.alive || l.state === 'off') continue;
      const a = rail.worldOf(s, l.u0, l.x0, l.y0, new THREE.Vector3());
      const L = Math.min(l.length, 400);
      const b = rail.worldOf(s, l.u0 + l.du * L, l.x0 + l.dx * L, l.y0 + l.dy * L, new THREE.Vector3());
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      const w = l.state === 'fire' ? l.width : 0.12;
      m.compose(mid, q, new THREE.Vector3(w, dir.length(), w));
      this.laserMesh.setMatrixAt(n++, m);
    }
    this.laserMesh.count = n; this.laserMesh.instanceMatrix.needsUpdate = true;
    // ground/sea follows the camera
    rail.frameAt(s, frame);
    this.sea.position.set(frame.pos.x, frame.pos.y - 45, frame.pos.z);
    this.sky.position.copy(frame.pos);
    this.updateCamera(aspect);
  }

  private updateCamera(aspect: number): void {
    const g = this.game, rail = g.rail, s = g.s, p = g.player, c = g.cam;
    const cam = this.camera;
    cam.aspect = aspect;
    cam.fov = T.camera.fov + c.fovKick;
    let back: number = T.camera.back, up: number = T.camera.up, cx = c.x, cy = c.y, lookU: number = T.camera.lookAhead, lx = c.x + (p.rx - c.x) * 0.3, ly = c.y + (p.ry - c.y) * 0.3, roll = c.roll;
    if (g.state === 'launch') {
      const t = Math.min(1, g.stateT / 2.5), e = 1 - Math.pow(1 - t, 3);
      back = -30 + (T.camera.back + 30) * e; up = 6 - 3.4 * e; lx = p.x; ly = p.y; lookU = e * lookU; roll = 0;
    }
    switch (this.storyCam) {
      case 'hero': back = -14; up = 3; cx = p.x + 8; cy = p.y; lookU = 0; lx = p.x; ly = p.y; roll = 0; break;
      case 'vista': back = 30; up = 14; cx = 0; cy = 0; lookU = 300; lx = 0; ly = 10; roll = 0; break;
      case 'combat': back = 13; up = 4; break;
      case 'title': back = -18; up = 2; cx = p.x - 10; cy = p.y + 1; lookU = 0; lx = p.x; ly = p.y; roll = 0; break;
      default: break;
    }
    const shake = c.shake * Math.sin(c.shakeT * 53), shakeY = c.shake * Math.cos(c.shakeT * 41);
    rail.worldOf(s, -back, cx + shake, cy + up + shakeY, cam.position);
    const target = rail.worldOf(s, lookU, lx, ly, tmpV);
    rail.frameAt(s, frame);
    cam.up.copy(frame.up).applyAxisAngle(frame.tan, -roll);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
  }

  /** Screen-space (CSS px) position of a rail-space point; null if behind the camera. */
  project(u: number, x: number, y: number, w: number, h: number): { x: number; y: number; z: number } | null {
    const v = this.game.rail.worldOf(this.game.s, u, x, y, tmpV).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, z: v.z };
  }
}
