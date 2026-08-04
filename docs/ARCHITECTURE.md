# AETHERWIND SAGA — Architecture Contract

This document is binding. Every module is written by a different author working
in parallel, so the interfaces below are the only thing keeping the game from
becoming twelve incompatible codebases. **Do not change a signature or an event
payload in this file without changing every consumer of it.**

## Project shape

```
index.html            canvas + #ui-root + boot veil
src/main.js           bootstrap: build Engine, register services, mount first scene
src/core/             Engine, EventBus, GameState, Input, SaveSystem   [FROZEN — do not edit]
src/art/              procedural texture + material + palette generation
src/render/           sky, lighting, water, terrain, post-processing
src/characters/       procedural character meshes, rigs, animation, cloth
src/world/            field scene, zones, props, NPCs
src/battle/           ATB engine, abilities, formulas, AI, espers
src/vfx/              GPU particles, spell effects, cinematic camera
src/physics/          character controller, collision, projectile integration
src/audio/            Web Audio engine, adaptive score, procedural SFX
src/story/            script data, dialogue runtime, cutscene director, quests
src/ui/               HUD, battle UI, menus, theme.css
tools/screenshot.mjs  headless capture harness  [FROZEN]
```

## Hard rules

1. **No external asset downloads.** No GLTF, no PNGs, no audio files, no CDN
   fonts. Every texture, mesh, animation and sound is generated in code at
   runtime. This is not a limitation to work around — procedural generation is
   the art pipeline. The only dependency is `three`.
2. **`src/core/**` is frozen.** Read it, import from it, never edit it.
3. **You own only the files assigned to you.** If you need a change in someone
   else's file, it means the contract is wrong — report it instead of editing.
4. **Everything must survive `npm run build`.** No TypeScript syntax, no JSX,
   ES2022 modules only.
5. **Import three as `import * as THREE from 'three'`.** Addons come from
   `three/examples/jsm/...` and must be checked to exist in 0.185.
6. **Dispose what you allocate.** Scenes call `track(x)` for anything with a
   `.dispose()`; leaking a render target across a scene swap is a bug.
7. **Determinism.** Use `rng` from `core/GameState.js`, never `Math.random()`,
   for anything that affects what a screenshot looks like.

## Core API (frozen)

```js
import { bus } from './core/EventBus.js';
bus.on(type, handler) -> unsubscribe
bus.once(type, handler)
bus.emit(type, payload)

import { gameState, rng, ELEMENTS } from './core/GameState.js';
gameState.state            // the serialisable playthrough model
gameState.getFlag(name, fallback)
gameState.setFlag(name, value)
gameState.addToParty(id) / removeFromParty(id) / progressFor(id)
gameState.addItem(id, n) / consumeItem(id, n) / addGil(n)
rng.next() / range(a,b) / int(a,b) / pick(arr) / jitter(a)

import { input } from './core/Input.js';
input.axis {x,y}           // movement, already deadzoned and normalised
input.camAxis {x,y}
input.isDown(action)       // held
input.consume(action)      // one-shot, consumes the press
input.running              // sprint modifier

import { Engine, Scene, disposeTree } from './core/Engine.js';
engine.renderer / camera / scene / composer / elapsed / timeScale
engine.register(name, service)   // service may expose update(dt) / fixedUpdate(dt)
engine.get(name)
engine.setScene(sceneInstance)   // async
```

`timeScale` is the shared slow-motion channel. Hit-stop, limit breaks and
cutscenes all drive it; always restore it to `1` when your effect ends.

## Service registry — who registers what

`main.js` constructs these in order and registers them under these exact names.
Any module may `engine.get(name)`.

| name        | module                        | provides |
|-------------|-------------------------------|----------|
| `art`       | `art/AssetForge.js`           | procedural textures + shared materials |
| `postfx`    | `render/PostFX.js`            | composer, grading, effect toggles |
| `sky`       | `render/Sky.js`               | atmosphere, sun/moon, clouds, time of day |
| `lighting`  | `render/Lighting.js`          | key/fill/rim rig, shadows, env probe |
| `vfx`       | `vfx/VFXSystem.js`            | particle pools, `play(name, opts)` |
| `audio`     | `audio/AudioEngine.js`        | buses, `music`, `sfx` |
| `physics`   | `physics/Physics.js`          | character controller, collision queries |
| `ui`        | `ui/UIRoot.js`                | HUD mounting, `open(panel)` |
| `story`     | `story/Director.js`           | dialogue, cutscenes, quest state |

## Module contracts

### `art/AssetForge.js`
```js
export class AssetForge {
  constructor(renderer)
  // Cached by key. Returns THREE.Texture, sRGB or linear as appropriate.
  texture(key, opts) -> THREE.Texture
  // A complete PBR material set for a named surface.
  material(key, opts) -> THREE.Material
  // Generates and returns a PMREM environment map for the current sky.
  environment(skyScene) -> THREE.Texture
  dispose()
}
```
Texture keys other modules rely on: `stone`, `marble`, `wood`, `bark`, `foliage`,
`cloth`, `silk`, `leather`, `steel`, `gold`, `crystal`, `sand`, `grass`, `dirt`,
`water-normal`, `cloud`, `noise-rgb`, `blue-noise`, `ramp-fire`, `ramp-ice`,
`ramp-holy`, `spark`, `smoke`, `rune`.

### `render/PostFX.js`
```js
export class PostFX {
  constructor(engine)                // sets engine.composer
  setQuality(level)                  // 'low'|'medium'|'high'|'ultra'
  setGrade(name, t = 0.6)            // named LUT-ish grade, cross-faded
  shake(intensity, seconds)          // camera trauma, respects settings.screenShake
  flash(color, seconds)              // full-screen impact flash
  setDof(focusDistance, aperture)
  setRadialBlur(amount)              // limit-break speedlines
  setSize(w, h) / render() / dispose()
}
```
Chain order is fixed: render → SSAO → bloom (HDR threshold) → DOF → motion blur
→ radial blur → chromatic aberration → grade+tonemap → grain → vignette → FXAA.

### `render/Sky.js`
```js
export class Sky {
  constructor(engine)
  addTo(scene)
  setTimeOfDay(t)        // 0..1, drives sun elevation, colour, star fade
  setWeather(name, t)    // 'clear'|'overcast'|'storm'|'aurora'|'ash'
  get sunDirection() -> THREE.Vector3
  get sunColor() -> THREE.Color
  update(dt)
}
```

### `characters/CharacterFactory.js`
```js
export function buildCharacter(def, forge) -> {
  root: THREE.Group,          // origin at feet, +Z forward
  skeleton: THREE.Skeleton,
  bones: Record<string, THREE.Bone>,   // named per Rig.js
  animator: Animator,
  cloth: ClothSim | null,
  height: number,
  dispose(): void
}
```
`def` comes from `characters/roster.js`. Bone names are fixed in `Rig.js`:
`root, hips, spine, chest, neck, head, shoulderL/R, armL/R, forearmL/R, handL/R,
thighL/R, shinL/R, footL/R`, plus optional `hair0..n`, `cape0..n`, `weapon`.

```js
animator.play(clip, { loop, fade, speed })   // 'idle','walk','run','cast','attack','hurt','victory','ko','limit'
animator.update(dt)
animator.lookAt(worldPos)                     // additive head/eye aim
```

### `battle/*`
```js
// ATB.js
export class BattleEngine {
  constructor({ party, enemies, formation })
  start() / update(dt) / pause(b)
  issue(command)   // { actorId, abilityId, targetIds }
  get state()      // 'intro'|'active'|'awaiting'|'resolving'|'victory'|'defeat'
}
```
Emits, in order, per action: `battle:action-start`, `battle:hit`,
`battle:damage`, `battle:action-end`.

### `vfx/VFXSystem.js`
```js
export class VFXSystem {
  constructor(engine)
  addTo(scene)
  play(name, { position, target, scale, color, duration, onEvent }) -> handle
  stop(handle) / update(dt) / dispose()
}
```
Effect names the battle layer will call: `slash`, `pierce`, `blunt-impact`,
`fire`, `fira`, `firaga`, `blizzard`, `blizzaga`, `thunder`, `thundaga`,
`water`, `quake`, `aero`, `holy`, `flare`, `ultima`, `cure`, `curaga`, `raise`,
`haste`, `protect`, `poison`, `sleep`, `stone`, `limit-charge`, `limit-release`,
`esper-portal`, `crit`, `miss`, `heal-pop`, `level-up`.

### `audio/AudioEngine.js`
```js
export class AudioEngine {
  constructor()
  async resume()                     // must be called from a user gesture
  music.play(trackId, { fade })      // 'prelude','field','town','battle','boss','victory','sorrow','esper'
  music.setIntensity(0..1)           // adaptive layering
  music.stop({ fade })
  sfx.play(id, { volume, rate, position })
  setBusVolume(bus, v)               // 'master'|'music'|'sfx'
}
```

## Event catalogue

Payload shapes are contractual.

| event | payload |
|---|---|
| `engine:started` | — |
| `engine:resize` | `{width, height}` |
| `scene:changing` | `{from, to}` |
| `scene:changed` | `{scene}` |
| `state:flag` | `{name, value, prev}` |
| `party:joined` / `party:left` | `{characterId, party}` |
| `inventory:changed` | `{itemId, count}` |
| `battle:start` | `{party, enemies, encounterId}` |
| `battle:turn-ready` | `{actorId}` |
| `battle:action-start` | `{actorId, abilityId, targetIds}` |
| `battle:hit` | `{actorId, targetId, index, total}` |
| `battle:damage` | `{targetId, amount, element, kind, crit, weak, resist}` — `kind`: `'damage'\|'heal'\|'mp'\|'miss'\|'immune'` |
| `battle:status` | `{targetId, status, applied}` |
| `battle:ko` | `{targetId}` |
| `battle:limit-ready` | `{actorId}` |
| `battle:esper` | `{esperId, casterId}` |
| `battle:end` | `{result:'victory'\|'defeat'\|'flee', rewards}` |
| `dialogue:line` | `{speaker, text, portrait, emotion}` |
| `dialogue:choice` | `{prompt, options}` |
| `dialogue:end` | `{scriptId}` |
| `cutscene:start` / `cutscene:end` | `{id}` |
| `quest:updated` | `{questId, step, status}` |
| `ui:open` / `ui:close` | `{panel}` |
| `audio:cue` | `{id, params}` |

## Debug surface

`main.js` publishes `window.__AW__` for the capture harness. Every hook must
resolve only once the requested state is fully visible on screen.

```js
window.__AW__ = {
  engine,
  gotoField(zoneId?), gotoBattle(encounterId?), gotoTitle(),
  poseCamera(poseName),      // 'hero-closeup','battle-command','wide','esper'
  setTimeOfDay(t),
  castAbility(abilityId), summon(esperId),
  openMenu(panel),
  setQuality(level),
  stats() -> {fps, drawCalls, triangles, programs}
}
```

## Art direction (binding on every visual module)

> **`docs/BRAVELY_REFERENCE.md` is authoritative and overrides this section and
> every other art document wherever they disagree.** It records the actual reference frames supplied by
> the user: chibi / super-deformed characters (3.0–3.5 heads tall) staged in a
> fixed side-view battle camera, inside full-3D painterly environments with
> heavy mist and depth of field. Read it first.

Environments are physically-grounded; characters are toon-shaded with a
mandatory rim light. Not photoreal. Specifics:

- **Palette**: deep teal-and-amber base. Cool shadows (never neutral grey —
  shadow tint is always toward the sky colour), warm key light, saturated
  magic accents that are the only pure-chroma elements in frame.
- **Contrast**: true blacks are crushed slightly; highlights bloom past 1.0.
  Every frame needs a clear value structure — dark foreground framing, bright
  midground subject, atmospheric-perspective background.
- **Composition**: every camera pose must be composed, not merely positioned.
  Rule-of-thirds subject placement, a foreground occluder for depth, and
  visible atmospheric depth cueing.
- **Materials**: no flat-coloured surfaces anywhere. Everything carries
  roughness variation, normal detail, and either a subtle fresnel rim or
  micro-occlusion. Metal must show anisotropic highlight direction.
- **Silhouette first**: characters and props must read as black shapes.
- **Motion**: nothing snaps. Every state change is eased. Idle poses breathe.
  Cloth and hair always carry secondary motion.
- **Never ship**: default Three.js grey `MeshStandardMaterial`, untextured
  primitives, a flat single-colour background, hard unlit shadows, or UI drawn
  in a browser default font.
