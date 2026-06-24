# Plane

Browser flight game (three.js): fly a low-poly plane over a procedurally generated volcanic island + city, strafing roaming enemy tanks that shoot back. Plain ES modules from CDNs, no build step — runs as static files.

## Run

```bash
cd plane && python3 -m http.server 8000   # open http://127.0.0.1:8000/
```

Gotchas:
- Must be served over **HTTP** — ES modules and the `.glb` fetch fail from `file://`.
- **Runtime network required**: three.js, `three-mesh-bvh`, `d3-delaunay`, and the Draco decoder load from CDNs.
- The city is built in a **Web Worker**, and browsers cache worker modules hard — after editing `generator.js`, bump `GEN_VERSION` in `world.js` or you'll keep running the old code.

## Controls

`W/S` pitch · `A/D` roll · `Q/E` yaw · `Space/Shift` throttle · `F` fire guns · `R` reset · `T` day/night · `[ ]` scrub time · `U` free-cam · mouse-drag orbits the chase cam.

## How it flies (`main.js`)

Force-based "Arcade+": a velocity vector pushed each frame by thrust, gravity, lift, and **anisotropic drag** (light along the nose, heavy across the body, so velocity tracks where you point). Lift uses a **Cl(AoA)** curve that collapses past the stall angle, so flying faster self-trims instead of ballooning. **Dart stability** rotates the nose toward the flight path; a **forward CG** noses over when slow. Net effect: a throttle-cut pull-up stalls, drops the nose, and recovers into a dive — all emergent, not scripted.

## Combat & enemies (`tanks.js`, `main.js`)

- **Guns**: hold `F` for tracers (they inherit the plane's velocity) that destroy tanks within range. The HUD tracks **STREAK** (consecutive kills) and **BEST** (session max); a wreck or `R` resets the current streak.
- **Health**: the plane survives 2 shell hits (`HP ♥♥`); glowing green **health packs** hover low among the buildings and restore a point (a steady handful, respawning away from you). A hard impact — building or hillside at speed > `CRASH_SPEED` — wrecks the plane instantly regardless of health: explosion, then auto-reset.
- **Tank rig**: hull (`tb.glb`) and turret (`tt.glb`) are **separate models**; the turret yaws on its own pivot to track the plane while the hull drives and conforms to the terrain slope.
- **Driving**: each tank follows a **BFS route** — 4-connected (forward/back/left/right, no diagonals) over a **traversability grid**: drivable terrain (beach/grass from the placement grid) minus cells covered by a building/tree (found by dropping a ray down each cell). Destinations alternate **beach⇄interior missions** so tanks traverse the map instead of circling.
- **Firing**: turrets **lead** the target (aim at `plane + velocity × distance/shellSpeed`) with distance-scaled **aim noise**, and only shoot if they've had **line of sight** within the last `LOS_MEMORY` seconds (terrain *and* buildings/trees occlude). Shells that reach the plane are reported back to `main.js`, which docks health.
- **Population**: 3–5 tanks are kept alive, respawning on drivable ground **away from the plane**. The obstacle grid and every tank's route are rebuilt when the async city finishes loading (so nobody keeps driving through buildings that appeared mid-route).

## Non-obvious techniques

- **Terrain is a single `heightAt(x,z)` field** shared by the mesh, collision, placement, and the shore/foam mask. Coastline radius is noise-warped (bays/headlands).
- **Concrete city surface** lives in the *terrain shader*, not geometry: a low-res "city mask" (blurred patches stamped around each building once the city exists) blends the terrain toward a tiling concrete texture → roads/paths conform for free.
- **Ocean foam**: a baked *shore-depth* texture drives breaking-wave crest lines that roll up the depth contours and break at the waterline (noise gates the lines into varying-thickness segments).
- **Magma pool**: a flat self-lit shader disc in the crater — the opaque crater walls occlude it, so only the basin reads as lava (no carving needed).
- **Foundations**: buildings sit on their footprint's *high* corner + a small raise (never clips a slope), and a plinth block fills the gap down to the terrain.
- **Collision** (`three-mesh-bvh`): BVH over the building's *real* geometry **including window panes** — the panes plug the wall openings, so it's the exact shape but solid (without them the plane slips through windows). Trees use a baked cone proxy. Each frame the move is swept as a ray (`raycastSolids`) → stop short + slide.
- **Rocks** aren't a uniform sprinkle: half-buried boulder outcrops *shed* smaller rocks that roll downhill (follow `-∇height`), then a relaxation pass spreads overlaps apart. Rocks above the snow line get shader snow-caps on up-facing faces.
- **Sun** is the Sky shader's own disc, enlarged via the `sunAngularDiameterCos` constant — there's no separate sun mesh.

## Tuning

Constants at the top of each module. `world.js`: terrain (`ISLAND_R`, `VOLCANO_*`, …), `GRID` (placement + rock sim: `boulderDensity`, `rockRest`, `rockRelax`, …), `FOUND_*`, `PAVE_*`/`MASK_SIZE`, `MAGMA_*`, `CITY_CONFIG`. `main.js`: flight feel, `COLLIDE_R`, combat (`CRASH_SPEED`, `MAX_HEALTH`, `BULLET_*`, `PACK_*`). `tanks.js`: turret seating (`TURRET_*`), driving (`DRIVE_SPEED`, `TURN_RATE`, `MIN_TRAVEL`, `INTERIOR_H`), gunnery (`FIRE_RANGE`, `FIRE_INTERVAL`, `SHELL_SPEED`, `AIM_NOISE`, `LOS_MEMORY`), population (`MIN_TANKS`/`MAX_TANKS`, `SPAWN_AWAY`). `sky.js`: `DAY_LENGTH`, `CLOUD_*`.

## Credits

- **cities.obj / procity** — `generator.js`, `mega_texture.png`, and the gaussian-splat cloud technique (beacons removed).
- **three.js** (`Sky`, `ImprovedNoise`, loaders) · **three-mesh-bvh** (collision raycasts).
- **Plane & tank models** (`plane.glb`, `tb.glb`/`tt.glb`) — AI-generated, Draco + WebP compressed.
