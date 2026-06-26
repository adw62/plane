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

The full list lives behind the **⌨ Controls** toggle (bottom-right). **Hold `Space` at full throttle to BOOST** — see *Boost* below. The day/night cycle runs by default (`T` pauses it).

> Sound starts on your **first key/click** (browsers block audio until a user gesture).

## How it flies (`main.js`)

Force-based "Arcade+": a velocity vector pushed each frame by thrust, gravity, lift, and **anisotropic drag** (light along the nose, heavy across the body, so velocity tracks where you point). Lift uses a **Cl(AoA)** curve that collapses past the stall angle. **Dart stability** rotates the nose toward the flight path; a **forward CG** noses over when slow. Net effect: a throttle-cut pull-up stalls, drops the nose, and recovers into a dive — all emergent, not scripted.

- **High-speed self-trim**: the camber lift at 0° AoA exceeds weight, so at speed the wing would balloon the nose up. Instead of fighting it with the elevator, the dart aims the nose at the **trim attitude** — the path tilted by the AoA that yields ~1g of lift (nose-down when fast). It's scaled by `TRIM_GAIN` so it tames the balloon without tucking into a dive, and only the nose-down side is used (slow/stall stays with the forward CG).
- **Boost**: the throttle lever caps at `THROTTLE_MAX` (shown as 100%). Hold `Space` there and you overdrive to `BOOST_THROTTLE` (150% on the gauge). The engine heats over `BOOST_TIME` — the throttle readout flashes red, a light camera rumble builds, and **smoke** pours off the engine sides. Ride it to the limit and it **overheats** (flames + an `OVERHEAT` warning + a self-light on the airframe) into a long `OVERHEAT_COOLDOWN` lockout; let off early for a short `EARLY_COOLDOWN`.

## Combat & enemies (`tanks.js`, `main.js`)

- **Guns**: hold `F` for tracers (they inherit the plane's velocity) that destroy tanks within range. The HUD tracks **STREAK** (consecutive kills) and **BEST** (session max); a wreck or `R` resets the current streak.
- **Impact fx** (`particles.js`): each bullet that misses a tank still hits *something*, and sprays a small pooled-particle fountain in a colour that reads the surface — **terrain colour** off the ground (sampled from the same height-banded palette the mesh uses), **blue/white** off the sea, **grey** off buildings, **green** off trees, **yellow** sparks off a tank. Bullets now sweep-test the building/tree BVH each frame, so they no longer pass through walls.
- **Health / lives**: the plane survives 3 shell hits (red crosses **✚✚✚** in the dial face); glowing red **medical-cross packs** hover low among the buildings and restore a cross (a steady handful, respawning away from you). A hard impact — building or hillside at speed > `CRASH_SPEED` — wrecks the plane instantly regardless of health: explosion, then auto-reset.
- **Tank death**: a kill doesn't just vanish the tank — the **turret is blown off as a physics object** (launched with spin, falls, bounces, and settles on the terrain) while the **hull stays as a burning wreck** that smokes for ~20 s and is then removed the first moment it's off-screen (hard-capped so it can't pile up). At night each wreck casts a **flickering firelight** on the ground around it.
- **Tank rig**: hull (`tb.glb`) and turret (`tt.glb`) are **separate models**; the turret yaws on its own pivot to track the plane while the hull drives and conforms to the terrain slope.
- **Driving**: each tank follows a **BFS route** — 4-connected (forward/back/left/right, no diagonals) over a **traversability grid**: drivable terrain (beach/grass from the placement grid) minus cells covered by a building/tree (found by dropping a ray down each cell). Destinations alternate **beach⇄interior missions** so tanks traverse the map instead of circling.
- **Firing**: turrets **lead** the target (aim at `plane + velocity × distance/shellSpeed`) with distance-scaled **aim noise**, and only shoot if they've had **line of sight** within the last `LOS_MEMORY` seconds (terrain *and* buildings/trees occlude). Shells that reach the plane are reported back to `main.js`, which docks health.
- **Population**: 3–5 tanks are kept alive, respawning on drivable ground **away from the plane**. The obstacle grid and every tank's route are rebuilt when the async city finishes loading (so nobody keeps driving through buildings that appeared mid-route).

## HUD & feedback (`main.js`)

- **Instrument cluster** (bottom-left): SVG dials drawn in code. A big main dial reads **speed** on the rim with **health** + **throttle** in its face; a smaller satellite bubble (layered *behind*) reads **rpm** with **altitude** in its face. Each pointer is a triangle riding a recessed window slot — the rest of the pointer is clipped (hidden) behind the dial — and eases toward its value so it sweeps. The throttle readout flashes red on boost and shows `OVERHEAT` during a lockout.
- **Threat ring**: a thin HUD ring drawn on a 2D canvas. It's blank until a tank is near, then glows a short white arc toward each nearby tank (and a flashing **red/white** arc toward any tank with a shell inbound), bearings taken relative to the nose.
- **Camera shake**: a trauma model (events add trauma; it jitters the camera by trauma² then decays). Near-misses, taking a hit, close tank kills, the death blast, and the rising strain of a boost all feed it.

## Sound (`audio.js`)

Fully **procedural** Web Audio — no sample files, no deps (same no-build ethos). `buildAudio()` returns a handle the game drives; everything is synthesised:

- **Engine** — a "poor-man's engine-sim": one full engine cycle (9 firing pulses, a WWI rotary) is baked into a looping buffer whose `playbackRate` *is* the RPM, run through **fixed** resonant formants (the exhaust note stays put while the firing rate sweeps → reads as a real engine, not a synth glissando). RPM rides throttle, airspeed, and **dive** (vertical velocity over-revs it, which also keeps the note alive).
- **Guns** — plane gun is a noise crack + thump per round; tank gun is a deep `boom()` + rolling reverb tail, attenuated by distance.
- **Explosion** — `explosion(distance, scale)` fires on a tank death or the plane's crash/hit: the deep boom body + a swept low-noise roar + a sharp crack + a randomly-extended debris "whizz", distance-attenuated with a wetter reverb tail the farther off it is. Every knob lives in `audio.params` and is tunable in the lab (below).
- **Shell fly-by** — the part with the most care:
  - **whoosh** — a *sustained* per-shell voice (within `WHOOSH_R`) that builds with proximity (squared) and **Dopplers** with the closing speed (relative velocity projected onto the shell→plane line). The subsonic approach.
  - **accent** (within the smaller `CRACK_R`, at closest approach) — **crack** (whip-snap) + **whizz** (instant-attack resonant zip whose decay is pitch-tilted, so high zips die faster — air absorption) + **thump** (a deep boom on its own bus). Overall loudness scales with miss distance (max for a grazing pass).
- **Mix** — master and a dedicated **low bus** (so the big thump can't duck the crack/whizz) each go through a limiter → a `tanh` **soft clipper** at the output (catches sub-ms transients the limiter is too slow for). A synthesised convolution reverb provides "scale".

### Tuning lab — `tune.html`

The shell-fly-by knobs live in `audio.params`. Open **`/tune.html`** for an isolated harness: a single projectile flies past a listener at a tunable miss distance, driving the same `whoosh()`/`crack()` the game uses, with every knob as a live slider (plus a top-down viz). **Fire**/Space to test, **Auto-fire** to loop, **Copy params** to grab the JSON — paste it back into the `params` defaults in `audio.js` to bake it in.

The same lab also tunes the **explosion**: press **B** (or the 💥 Boom button) to fire one, with its own *Explosion* and *Explosion whizz* slider groups and an `exploDistance` sim knob to test the range rolloff.

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

Constants at the top of each module. `world.js`: terrain (`ISLAND_R`, `VOLCANO_*`, …), `GRID` (placement + rock sim: `boulderDensity`, `rockRest`, `rockRelax`, …), `FOUND_*`, `PAVE_*`/`MASK_SIZE`, `MAGMA_*`, `CITY_CONFIG`. `main.js`: flight feel (`CRUISE`, `MAX_THRUST`, `STABILITY`, `CG_DROP`, `TRIM_GAIN`), boost (`THROTTLE_MAX`, `BOOST_THROTTLE`, `BOOST_TIME`, `OVERHEAT_COOLDOWN`, `EARLY_COOLDOWN`), camera shake (`SHAKE_*`, `KILL_SHAKE_R`), threat ring (`THREAT_R`), `COLLIDE_R`, combat (`CRASH_SPEED`, `MAX_HEALTH`, `BULLET_*`, `PACK_*`). `tanks.js`: turret seating (`TURRET_*`), driving (`DRIVE_SPEED`, `TURN_RATE`, `MIN_TRAVEL`, `INTERIOR_H`), gunnery (`FIRE_RANGE`, `FIRE_INTERVAL`, `SHELL_SPEED`, `AIM_NOISE`, `LOS_MEMORY`), population (`MIN_TANKS`/`MAX_TANKS`, `SPAWN_AWAY`), wrecks (`WRECK_LIFE`, `WRECK_MAX`, `FX_GRAVITY`), fly-by sound radii (`WHOOSH_R`, `CRACK_R`). `sky.js`: `DAY_LENGTH`, sun-height shaping (`SUN_AMP`, `SUN_LIFT`), `CLOUD_*`. `audio.js`: engine (`IDLE_RPM`/`MAX_RPM`/`CYLINDERS`), `AUDIBLE_R`, and the live-tunable shell- and explosion-sound `params` (see the tuning lab above).

## Credits

- **cities.obj / procity** — `generator.js`, `mega_texture.png`, and the gaussian-splat cloud technique (beacons removed).
- **three.js** (`Sky`, `ImprovedNoise`, loaders) · **three-mesh-bvh** (collision raycasts).
- **Plane & tank models** (`plane.glb`, `tb.glb`/`tt.glb`) — AI-generated, Draco + WebP compressed.
- **Audio** (`audio.js`) — synthesised with the Web Audio API; no samples.
