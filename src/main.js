import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { buildWorld } from './world.js';
import { buildSky } from './sky.js';
import { buildTanks } from './tanks.js';
import { buildAudio } from './audio.js';
import { buildParticles } from './particles.js';

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;   // tame the physical Sky's HDR output

// ---------------------------------------------------------------------------
// Scene, camera, lighting
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
const SKY = 0x9fc6e8;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 700, 3200);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 6000);

// ---------------------------------------------------------------------------
// World: Perlin-noise island + procedural city, plus sky/sun/clouds/day-night
// ---------------------------------------------------------------------------
// Procedural sound (engine, guns, shells) — synthesised, no asset files.
const audio = buildAudio();

let tanksHandle = null;   // forward ref so the city-ready hook can reach the tanks
const world = buildWorld(scene, () => {
  if (tanksHandle) tanksHandle.refreshObstacles();
  spawnHealthPacks();   // place packs once the city exists (so they land in the streets)
});
const env = buildSky(scene, camera);
const particles = buildParticles(scene);   // impact-fx fountains (bullet hits)

// ---------------------------------------------------------------------------
// Threat ring (HUD): a 2D canvas overlay centred on screen. Nothing is drawn
// by default — only glowing arcs at the bearing (relative to the plane's nose)
// of each nearby tank (white) or inbound shell (flashing red↔white).
// ---------------------------------------------------------------------------
const THREAT_R = 650;
const ringCanvas = document.createElement('canvas');
ringCanvas.id = 'threatRing';
ringCanvas.style.cssText = 'position:fixed;left:50%;top:44%;transform:translate(-50%,-50%);' +
                           'pointer-events:none;z-index:4;';
document.body.appendChild(ringCanvas);
const RING_PX = 320;                 // on-screen diameter of the indicator
const ringCtx = ringCanvas.getContext('2d');
{
  const dpr = Math.min(devicePixelRatio, 2);
  ringCanvas.width = RING_PX * dpr; ringCanvas.height = RING_PX * dpr;
  ringCanvas.style.width = RING_PX + 'px'; ringCanvas.style.height = RING_PX + 'px';
  ringCtx.scale(dpr, dpr);
}
const _fwd = new THREE.Vector3(), _rgt = new THREE.Vector3();

function updateThreatRing(t) {
  ringCtx.clearRect(0, 0, RING_PX, RING_PX);
  if (crashed) return;
  const threats = tanks.getThreats(planeRig.position, THREAT_R);
  if (!threats.length) return;        // no tanks near → nothing on screen

  // plane-relative axes (horizontal): forward = up on the ring, right = right
  _fwd.set(0, 0, -1).applyQuaternion(planeRig.quaternion);
  _rgt.set(1, 0, 0).applyQuaternion(planeRig.quaternion);
  let fn = Math.hypot(_fwd.x, _fwd.z) || 1, rn = Math.hypot(_rgt.x, _rgt.z) || 1;
  const fx = _fwd.x / fn, fz = _fwd.z / fn, rx = _rgt.x / rn, rz = _rgt.z / rn;

  const cx = RING_PX / 2, cy = RING_PX / 2, R = RING_PX / 2 - 14;
  const flash = Math.sin(t * 14) * 0.5 + 0.5;   // red↔white blink for inbound shells
  ringCtx.lineCap = 'round';
  for (const th of threats) {
    const ahead = th.dx * fx + th.dz * fz;
    const side  = th.dx * rx + th.dz * rz;
    const a = Math.atan2(side, ahead) - Math.PI / 2;   // 0 bearing → top of the ring
    const col = th.incoming
      ? `rgb(255,${(flash * 255) | 0},${(flash * 255) | 0})`   // red → white
      : 'rgb(255,255,255)';
    ringCtx.strokeStyle = col;
    ringCtx.shadowColor = col;
    ringCtx.shadowBlur = th.incoming ? 22 : 14;
    ringCtx.globalAlpha = th.incoming ? 0.45 : 0.28;
    ringCtx.lineWidth = th.incoming ? 5 : 4;
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, R, a - 0.22, a + 0.22);          // short glowing arc
    ringCtx.stroke();
  }
  ringCtx.globalAlpha = 1; ringCtx.shadowBlur = 0;
}

// ---------------------------------------------------------------------------
// The plane (a container we steer; the model sits inside, nose aligned to -Z)
// ---------------------------------------------------------------------------
const planeRig = new THREE.Group();   // position + orientation we control
scene.add(planeRig);

const START = { pos: new THREE.Vector3(340, 130, 0), throttle: 0.5 };

// Enemy tanks on the beach the plane launches toward (heading -Z). Hull + turret
// are separate, independently steerable objects — see tanks.js.
const tankFront = START.pos.clone().add(new THREE.Vector3(0, 0, -600));
const tanks = buildTanks(scene, world, tankFront, 5, audio);
tanksHandle = tanks;

// ---------------------------------------------------------------------------
// Propeller — procedural, because the model is a single fused mesh with no
// separate prop to spin. Built once the model loads so it can sit on the nose.
// ---------------------------------------------------------------------------
const propMount = new THREE.Group();   // holds nose position + tilt
const propeller = new THREE.Group();   // spins inside the mount
let propSpin = 0;
let propDisc = null;
const PROP_PITCH = 0.10;               // small nose-up tilt to square it to the thrust line
const PROP_RAISE = 0.34;               // lift it off the centreline

function buildPropeller(localBox) {
  const r = (localBox.max.y - localBox.min.y) * 0.42;          // size to the airframe
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7, roughness: 0.4 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.3, roughness: 0.6 });

  propeller.add(new THREE.Mesh(new THREE.SphereGeometry(r * 0.14, 12, 8), hubMat)); // hub
  const bladeGeo = new THREE.BoxGeometry(r * 0.16, r, r * 0.03);
  for (let i = 0; i < 3; i++) {                                 // 3 blades
    const blade = new THREE.Mesh(bladeGeo, bladeMat);
    blade.position.y = r * 0.5;
    const pivot = new THREE.Group();
    pivot.rotation.z = (i * Math.PI * 2) / 3;
    pivot.add(blade);
    propeller.add(pivot);
  }
  propDisc = new THREE.Mesh(                                    // motion-blur disc
    new THREE.CircleGeometry(r, 28),
    new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
  );
  propeller.add(propDisc);

  // Mount at the nose (front = −Z), on the centreline, raised + pitched up so the
  // disc sits square to the thrust line rather than vertical. The propeller spins
  // around the mount's local Z, so the tilt carries the spin axis with it.
  const cy = (localBox.min.y + localBox.max.y) / 2;
  propMount.position.set(0, cy + PROP_RAISE, localBox.min.z - 0.05);
  propMount.rotation.x = PROP_PITCH;
  propMount.add(propeller);
  planeRig.add(propMount);

  // Boost flame emitters: two points on the sides of the engine, just behind the
  // propeller. While boosting they spit tank-style fire particles (see emitBoostFire).
  const sideX = (localBox.max.x - localBox.min.x) * 0.16;      // close to the cowl, not the wings
  const noseZ = localBox.min.z * 0.5;                          // forward, by the prop
  for (const s of [-1, 1]) boostEmit.push(new THREE.Vector3(s * sideX, cy, noseZ));

  // Warm self-light by the engine, lit only while overheat flames burn (decay 1,
  // short range so it washes the airframe rather than the whole world).
  fireLight = new THREE.PointLight(0xff5512, 0, 34, 1);
  fireLight.position.set(0, cy, noseZ);
  planeRig.add(fireLight);
}

const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

const loaderEl = document.getElementById('loader');
const barEl = document.getElementById('bar');
let ready = false;
let planeModel = null;   // the loaded airframe mesh (hidden while crashed)

loader.load(
  './models/plane.glb',
  (gltf) => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.scale.setScalar(12 / Math.max(size.x, size.y, size.z));   // ~12u: a touch bigger than a tank (~10u long)

    // Orient so the nose points down -Z (three.js "forward").
    // Flip here if your plane ends up flying tail-first.
    model.rotation.y = Math.PI;

    model.updateMatrixWorld(true);
    buildPropeller(new THREE.Box3().setFromObject(model));   // nose from the posed model
    planeRig.add(model);
    planeModel = model;
    reset();
    ready = true;
    loaderEl.classList.add('hidden');
  },
  (e) => { if (e.lengthComputable) barEl.style.width = `${(e.loaded / e.total) * 100}%`; },
  (err) => {
    console.error(err);
    loaderEl.querySelector('div').textContent = 'Failed to load model (see console)';
  }
);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = {};
const GAME_KEYS = [
  'KeyQ', 'KeyW', 'KeyE', 'KeyA', 'KeyS', 'KeyD', 'KeyF',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Space',
];
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
  if (e.code === 'KeyR') reset();
  if (e.code === 'KeyT') env.toggleCycle();          // run/pause day-night cycle
  if (e.code === 'BracketLeft') env.scrub(-20);      // wind time of day back
  if (e.code === 'BracketRight') env.scrub(20);      // wind time of day forward
  if (e.code === 'KeyU') {                            // toggle detached free-fly camera
    freeCam = !freeCam;
    if (freeCam) {
      freePos.copy(camera.position);
      const eu = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      freeYaw = eu.y; freePitch = eu.x;
    }
    modeEl.textContent = freeCam
      ? '◉ FREE CAM — WASD move · Q/E down·up · Shift fast · drag to look · U exit'
      : '';
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

// mouse drag free-look: hold + drag to orbit the camera, release to snap back
const DRAG_SENS = 0.005;        // radians of look per pixel dragged
let dragging = false, dragYaw = 0, dragPitch = 0;

// detached free-fly camera (toggle with F) for inspecting the world
let freeCam = false, freeYaw = 0, freePitch = 0;
const freePos = new THREE.Vector3();
const freeRight = new THREE.Vector3();
const modeEl = document.getElementById('mode');

canvas.addEventListener('mousedown', () => { dragging = true; canvas.style.cursor = 'grabbing'; });
addEventListener('mouseup', () => { dragging = false; canvas.style.cursor = ''; });
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (freeCam) {
    freeYaw -= e.movementX * 0.0025;
    freePitch = THREE.MathUtils.clamp(freePitch - e.movementY * 0.0025, -1.45, 1.45);
  } else {
    dragYaw = THREE.MathUtils.clamp(dragYaw - e.movementX * DRAG_SENS, -LOOK_YAW, LOOK_YAW);
    dragPitch = THREE.MathUtils.clamp(dragPitch + e.movementY * DRAG_SENS, -LOOK_PITCH, LOOK_PITCH);
  }
});

// ---------------------------------------------------------------------------
// Flight state & physics  (Arcade+ : real forces, forgiving tuning)
//   We track a world-space velocity vector and push it with four forces every
//   frame: thrust (nose), drag (anti-velocity), gravity (down), lift (wing-up).
//   Everything else — energy trading, banked turns, gentle stalls — emerges.
// ---------------------------------------------------------------------------
let throttle = START.throttle;
// Throttle + boost: the lever caps at THROTTLE_MAX (shown as 100%). Holding Space
// at the cap engages BOOST — effective throttle ramps to 120%, the engine heats
// over BOOST_TIME seconds (flames grow, the readout flashes red); hit the limit
// and it overheats into a BOOST_COOLDOWN lockout.
const THROTTLE_MAX   = 0.9;                       // lever cap → "100%"
const BOOST_THROTTLE = THROTTLE_MAX * 3.0;        // = 2.7 effective → 300% display, +200% thrust
const BOOST_TIME     = 2;                         // seconds of boost before overheat
const OVERHEAT_COOLDOWN = 10;                     // lockout after a full overheat
const EARLY_COOLDOWN    = 2;                      // shorter lockout if you let off boost early
let effThrottle = throttle;   // throttle actually applied to thrust/engine (lever + boost)
let boostHeat = 0;            // 0..1; reaches 1 after BOOST_TIME of sustained boost
let boostBlend = 0;          // 0..1 eased boost depth (smooth thrust + flame growth)
let boosting = false, overheated = false, boostLock = 0;   // boostLock = seconds boost stays disabled
const boostEmit = [];        // engine-side emitter offsets (plane-local), set in buildPropeller
const boostFire = [];        // live flame/smoke puffs; emitted while boosting
let boostEmitT = 0;          // emission accumulator
let fireLight = null;        // warm light on the airframe while overheat flames burn
let fireFlick = 0;           // flicker phase
const _fireGeo = new THREE.SphereGeometry(1, 6, 5);
const _fwPos = new THREE.Vector3(), _fwRight = new THREE.Vector3();

// One tank-style fire puff: small, shot a bit sideways off the engine, then
// buoyant (rises). `right` is the plane's local +X (so the puff kicks outward).
function spawnBoostFire(pos, right, side, flaming) {
  const flame = flaming && Math.random() < 0.6;                                // flame only on a real overheat
  const m = new THREE.Mesh(_fireGeo, new THREE.MeshBasicMaterial({
    color: flame ? (Math.random() < 0.5 ? 0xff5a1a : 0xffb12a) : 0x2a2a2a,
    transparent: true, opacity: flame ? 0.8 : 0.34, depthWrite: false,
    blending: flame ? THREE.AdditiveBlending : THREE.NormalBlending,
  }));
  m.position.copy(pos);
  m.scale.setScalar(flame ? 0.22 + Math.random() * 0.28 : 0.4 + Math.random() * 0.45);
  scene.add(m);
  const vel = right.clone().multiplyScalar(side * (4 + Math.random() * 4));   // shoot sideways
  vel.x += (Math.random() * 2 - 1) * 1.5; vel.z += (Math.random() * 2 - 1) * 1.5;
  vel.y += 3 + Math.random() * 3;                                             // a little initial lift
  vel.add(velocity);                                                          // ride with the plane
  boostFire.push({ mesh: m, vel, age: 0, ttl: flame ? 0.35 + Math.random() * 0.3 : 0.7 + Math.random() * 0.5,
                   grow: flame ? 1.2 : 2.1 });
}

function updateBoostFire(dt) {
  // self-light: warm flicker on the airframe, only while overheat flames burn
  if (fireLight) {
    const lvl = overheated ? boostHeat : 0;                    // flame presence
    fireFlick += dt * 12;
    const flick = 0.6 + 0.25 * Math.sin(fireFlick) + 0.15 * Math.random();
    fireLight.intensity = lvl * flick * 16;
  }
  // emit from each engine side while there's heat (rate ramps with heat)
  if (boostHeat > 0.02 && boostEmit.length) {
    _fwRight.set(1, 0, 0).applyQuaternion(planeRig.quaternion);
    boostEmitT -= dt;
    while (boostEmitT <= 0) {
      boostEmitT += 0.05;                                      // ~20 puffs/s at full heat (sparser)
      if (Math.random() > boostHeat) continue;                // thin out as heat drops
      for (let i = 0; i < boostEmit.length; i++) {
        _fwPos.copy(boostEmit[i]).applyQuaternion(planeRig.quaternion).add(planeRig.position);
        spawnBoostFire(_fwPos, _fwRight, i === 0 ? -1 : 1, overheated);   // smoke while boosting, flames on overheat
      }
    }
  }
  // advance puffs: rise (buoyancy), grow, fade
  for (let i = boostFire.length - 1; i >= 0; i--) {
    const f = boostFire[i];
    f.age += dt;
    f.vel.y += 16 * dt;                                        // buoyant rise
    f.mesh.position.addScaledVector(f.vel, dt);
    f.mesh.scale.addScalar(f.grow * dt);
    f.mesh.material.opacity *= (1 - dt * 2.2);
    if (f.age >= f.ttl) { scene.remove(f.mesh); f.mesh.material.dispose(); boostFire.splice(i, 1); }
  }
}
const velocity = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Guns: the plane fires tracer bullets (hold F). Bullets fly forward (inheriting
// the plane's velocity), die on a timer or the ground, and destroy any tank they
// pass within range of — see tanks.tryHit().
// ---------------------------------------------------------------------------
let fireTimer = 0;
const bullets = [];
const BULLET_SPEED = 320, BULLET_LIFE = 2.0, FIRE_COOLDOWN = 0.09, BULLET_HIT_R = 6;
const bulletGeo = new THREE.SphereGeometry(0.5, 8, 6);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xfff2a0 });
// impact-fx colours + scratch (terrain colour is filled per-hit from the world)
const BUILDING_FX = new THREE.Color(0x9aa0a6);   // concrete grey
const TANK_FX     = new THREE.Color(0xffca3a);   // sparks yellow
const TREE_FX     = new THREE.Color(0x5b8f3a);   // leaf green   ┐ foliage spray
const TREE_FX2    = new THREE.Color(0x86b85a);   // light leaf   ┘ (mixed per speck)
const WATER_FX    = new THREE.Color(0xe8f6ff);   // foam white  ┐ ocean splash
const WATER_FX2   = new THREE.Color(0x4a90d9);   // sea blue    ┘ (mixed per speck)
const _groundFx   = new THREE.Color();
const _bPrev = new THREE.Vector3();
const _bDir  = new THREE.Vector3();
const _bNorm = new THREE.Vector3();

// Terrain surface normal at (x,z) from finite differences of the height field —
// so a ground fountain aligns to the slope it struck.
function terrainNormal(x, z, out) {
  const e = 1.5;
  const hL = world.heightAt(x - e, z), hR = world.heightAt(x + e, z);
  const hD = world.heightAt(x, z - e), hU = world.heightAt(x, z + e);
  return out.set(hL - hR, 2 * e, hD - hU).normalize();
}
let kills = 0;        // current kill streak — resets when the plane is wrecked or reset
let maxStreak = 0;    // best streak this session — persists until page reload
const killsEl = document.createElement('div');
document.getElementById('hud').appendChild(killsEl);
function updateStreakHUD() {
  killsEl.innerHTML = `STREAK ${kills} &nbsp; BEST <span style="color:#ffd86f">${maxStreak}</span>`;
}
updateStreakHUD();

function updateWeapons(dt) {
  fireTimer -= dt;
  if (keys['KeyF'] && fireTimer <= 0) {
    fireTimer = FIRE_COOLDOWN;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(planeRig.quaternion);
    const mesh = new THREE.Mesh(bulletGeo, bulletMat);
    mesh.position.copy(planeRig.position).addScaledVector(dir, 4);   // out the nose
    scene.add(mesh);
    bullets.push({ mesh, vel: dir.multiplyScalar(BULLET_SPEED).add(velocity), life: BULLET_LIFE });
    audio.planeGun();
  }
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    _bPrev.copy(b.mesh.position);
    b.mesh.position.addScaledVector(b.vel, dt);
    b.life -= dt;
    const p = b.mesh.position;
    let dead = false;

    // building/tree hit: sweep this frame's move as a ray against the solids.
    // (Bullets are fast — a position-only test would tunnel through walls.)
    if (b.life > 0) {
      _bDir.copy(p).sub(_bPrev);
      const seg = _bDir.length();
      if (seg > 1e-4) {
        _bDir.divideScalar(seg);
        const hit = world.raycastSolids(_bPrev, _bDir, seg);
        if (hit) {
          let n = hit.normal;
          if (n) { _bNorm.copy(n); if (_bDir.dot(_bNorm) > 0) _bNorm.negate(); n = _bNorm; }
          // tree → green leaf-spray (burst up, since the cone-proxy normal is crude);
          // building → grey concrete debris off the wall.
          if (hit.tree) particles.burst(hit.point.x, hit.point.y, hit.point.z, TREE_FX, { color2: TREE_FX2 });
          else          particles.burst(hit.point.x, hit.point.y, hit.point.z, BUILDING_FX, { normal: n });
          dead = true;
        }
      }
    }

    // tank hit → yellow burst
    if (!dead && b.life > 0 && tanks.tryHit(p, BULLET_HIT_R)) {
      particles.burst(p.x, p.y, p.z, TANK_FX);
      dead = true; kills++; if (kills > maxStreak) maxStreak = kills; updateStreakHUD();
      const d = p.distanceTo(planeRig.position);                // shake harder the closer the kill
      if (d < KILL_SHAKE_R) addShake(0.45 * (1 - d / KILL_SHAKE_R));
    }

    // ground/water hit → fountain. Land: terrain colour, aligned to the slope.
    // Ocean (terrain below sea level): a blue/white splash straight up.
    if (!dead && b.life > 0) {
      const groundY = world.groundAt(p.x, p.z);
      if (p.y < groundY) {
        if (world.heightAt(p.x, p.z) > 0) {
          world.terrainColorAt(p.x, p.z, _groundFx);
          terrainNormal(p.x, p.z, _bNorm);
          particles.burst(p.x, groundY, p.z, _groundFx, { normal: _bNorm });
        } else {
          particles.burst(p.x, groundY, p.z, WATER_FX, { color2: WATER_FX2, speed: 17 });
        }
        dead = true;
      }
    }

    if (b.life <= 0) dead = true;   // expired in flight (no impact)
    if (dead) { scene.remove(b.mesh); bullets.splice(i, 1); }
  }
}

// ---------------------------------------------------------------------------
// Health: the plane survives a couple of shell hits. Each tank shell takes one;
// at zero it crashes. (A hard terrain/building collision still wrecks instantly.)
// Health packs floating low over the city restore a point.
// ---------------------------------------------------------------------------
const MAX_HEALTH = 3;
let health = MAX_HEALTH;
const hpEl = document.getElementById('hp');   // lives in the instrument panel
function updateHealthHUD() { hpEl.innerHTML = `<span style="color:#ff4d4d">${'✚'.repeat(health)}</span><span style="opacity:.3">${'✚'.repeat(Math.max(0, MAX_HEALTH - health))}</span>`; }
updateHealthHUD();

function damagePlane() {
  if (crashed) return;
  health -= 1;
  updateHealthHUD();
  hpEl.style.transform = 'scale(1.3)';                 // quick flinch
  setTimeout(() => { hpEl.style.transform = ''; }, 120);
  if (health <= 0) crash();                            // fatal → crash() plays the big blast
  else { audio.explosion?.(0, 0.8); addShake(0.6); }   // non-fatal shell hit (guarded) + jolt
}

// --- health packs: glowing green crates that hover low near the city. A steady
//     handful are kept around, respawning over time and away from the plane. ----
const packs = [];
const PACK_TARGET = 6, PACK_PICKUP_R = 13, PACK_HOVER = 14, PACK_AREA_R = 520;
const PACK_RESPAWN = 8, PACK_SPAWN_AWAY = 220;
let packTimer = 0;
// A red medical cross (two crossed bars), cloned per pack. Self-lit so it reads
// as a glowing pickup; spun on Y in updatePacks.
const crossMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b });
const crossTemplate = new THREE.Group();
crossTemplate.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 7, 1.5), crossMat));   // vertical bar
crossTemplate.add(new THREE.Mesh(new THREE.BoxGeometry(7, 2.4, 1.5), crossMat));   // horizontal arm
const _packDown = new THREE.Vector3(0, -1, 0), _packTop = new THREE.Vector3();

// Place one pack on open ground in the city area, away from `avoid` (the plane).
function placeOnePack(avoid) {
  for (let i = 0; i < 200; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * PACK_AREA_R;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const gy = world.groundAt(x, z);
    if (gy < 3) continue;                               // not over water
    if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < PACK_SPAWN_AWAY) continue;
    _packTop.set(x, gy + 250, z);
    if (world.raycastSolids(_packTop, _packDown, 250)) continue;  // not inside/on a building → sits in the streets
    const y = gy + PACK_HOVER;
    const mesh = crossTemplate.clone();
    mesh.position.set(x, y, z);
    scene.add(mesh);
    packs.push({ mesh, baseY: y, spin: Math.random() * Math.PI * 2 });
    return true;
  }
  return false;
}

function spawnHealthPacks() {
  for (const p of packs) scene.remove(p.mesh);
  packs.length = 0;
  for (let i = 0; i < PACK_TARGET; i++) placeOnePack(planeRig.position);
}

function updatePacks(dt) {
  for (let i = packs.length - 1; i >= 0; i--) {
    const p = packs[i];
    p.spin += dt * 1.5;
    p.mesh.rotation.y = p.spin;
    p.mesh.position.y = p.baseY + Math.sin(p.spin * 1.3) * 1.2;     // gentle bob
    if (!crashed && health < MAX_HEALTH && p.mesh.position.distanceTo(planeRig.position) < PACK_PICKUP_R) {
      health = Math.min(MAX_HEALTH, health + 1);
      updateHealthHUD();
      scene.remove(p.mesh);
      packs.splice(i, 1);
    }
  }
  // keep a handful around, respawning over time and clear of the plane
  packTimer -= dt;
  if (packs.length < PACK_TARGET && packTimer <= 0) {
    packTimer = placeOnePack(planeRig.position) ? PACK_RESPAWN : 1;
  }
}

const CRUISE      = 38;                           // airspeed where lift == gravity
const MAX_THRUST  = 28;                           // accel at full throttle (softened engine)
const DRAG_FWD    = 0.012;                        // drag along the nose (sets top speed)
const DRAG_PERP   = 0.06;                         // drag across the body (kills sideslip → velocity follows nose)
const GRAVITY     = 16;                           // downward accel
const LIFT_MAX    = 2 * GRAVITY / (CRUISE * CRUISE); // wing strength scale
const CL0         = 0.57;                          // wing camber: lift at 0° AoA → trims to level cruise
const CL_SLOPE    = 3.0;                           // extra lift per radian of angle of attack
const AOA_STALL   = 0.30;                          // critical angle of attack (~17°); lift drops beyond
const STABILITY   = 8.0;                           // pitch/yaw stiffness: nose tracks the flight path
const CG_DROP     = 0.6;                           // forward engine weight: noses over when slow
const TRIM_GAIN   = 0.5;                            // how hard the high-speed self-trim noses down (1 = full 1g trim)
const PITCH_RATE = 1.6, ROLL_RATE = 2.2, YAW_RATE = 0.7; // rad/s at full authority

let speed = 0;
let stall = 0;   // 0 = clean, 1 = fully stalled (for HUD)

// ---------------------------------------------------------------------------
// Crash: a hard enough impact (into a building/tree or the terrain) wrecks the
// plane — freeze it, puff an explosion, then auto-reset after a beat.
// ---------------------------------------------------------------------------
const CRASH_SPEED = 20;          // impact speed INTO a surface (u/s) that wrecks the plane
const CRASH_RESET_DELAY = 1.6;   // seconds wrecked before respawning
let crashed = false, crashTimer = 0;
let crashFx = null;

function crash() {
  if (crashed) return;
  crashed = true; crashTimer = 0;
  velocity.set(0, 0, 0);
  kills = 0; updateStreakHUD();                      // wreck ends the kill streak (BEST persists)
  if (planeModel) planeModel.visible = false;       // hide the wreck under the fireball
  propMount.visible = false;                         // …and the propeller with it
  const fx = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffa22a, transparent: true, opacity: 1, depthWrite: false }),
  );
  fx.position.copy(planeRig.position);
  scene.add(fx);
  crashFx = fx;
  modeEl.textContent = '💥 CRASHED — resetting…';
  audio.explosion?.(0, 1.3);                          // big blast (guarded; never blocks the crash)
  addShake(1);                                        // full camera shake on death
}

function reset() {
  planeRig.position.copy(START.pos);
  planeRig.quaternion.identity();
  throttle = START.throttle;
  boostHeat = 0; boostBlend = 0; boosting = false; overheated = false; boostLock = 0;   // clear boost state
  velocity.set(0, 0, -1).multiplyScalar(CRUISE);   // launch at cruise, not a stall
  camera.position.copy(START.pos).add(new THREE.Vector3(0, 8, 30));
  crashed = false;
  kills = 0; updateStreakHUD();                      // R / respawn clears the current streak (BEST persists)
  health = MAX_HEALTH;
  updateHealthHUD();
  if (planeModel) planeModel.visible = true;
  propMount.visible = true;                           // restore the propeller
  if (crashFx) { scene.remove(crashFx); crashFx.material.dispose(); crashFx = null; }
  modeEl.textContent = freeCam ? modeEl.textContent : '';
}

const forward = new THREE.Vector3();
const upVec = new THREE.Vector3();
const accel = new THREE.Vector3();
const flightDir = new THREE.Vector3();
const targetDir = new THREE.Vector3();
const pitchAxis = new THREE.Vector3();
const wvAxis = new THREE.Vector3();
const wvTest = new THREE.Vector3();
const invQ = new THREE.Quaternion();
const localWind = new THREE.Vector3();
const vFwd = new THREE.Vector3();
const vPerp = new THREE.Vector3();
const hitDir = new THREE.Vector3();
const hitOrigin = new THREE.Vector3();
const groundNormal = new THREE.Vector3();
const camOffset = new THREE.Vector3(0, 6, 26);     // behind (+Z) and above — pulled back for the bigger plane
const camTarget = new THREE.Vector3();
const desiredCam = new THREE.Vector3();
const lookOffset = new THREE.Vector3();
const lookEuler = new THREE.Euler();

// Camera shake: events add "trauma" (0..1); each frame it jitters the camera's
// orientation by trauma² (so it eases out), then decays. Applied after lookAt.
let shakeTrauma = 0;
const SHAKE_PITCH = 0.05, SHAKE_YAW = 0.05, SHAKE_ROLL = 0.09;   // max jitter (rad) at full trauma
const SHAKE_DECAY = 1.1;                                         // trauma drained per second (lower = longer shake)
const KILL_SHAKE_R = 350;                                        // tank kills within this range shake the cam
function addShake(amount) { shakeTrauma = Math.min(1, shakeTrauma + amount); }
// Jitter the camera by trauma² (eased out), then decay. Call right after a lookAt
// so each frame jitters from a fresh orientation (no drift).
function applyShake(dt) {
  if (shakeTrauma <= 0) return;
  const s = shakeTrauma * shakeTrauma;
  camera.rotateX((Math.random() * 2 - 1) * SHAKE_PITCH * s);
  camera.rotateY((Math.random() * 2 - 1) * SHAKE_YAW * s);
  camera.rotateZ((Math.random() * 2 - 1) * SHAKE_ROLL * s);
  shakeTrauma = Math.max(0, shakeTrauma - dt * SHAKE_DECAY);
}
const LOOK_YAW = THREE.MathUtils.degToRad(180);    // max look left/right with mouse
const LOOK_PITCH = THREE.MathUtils.degToRad(80);   // max look up/down with mouse
let lookYaw = 0, lookPitch = 0;

function update(dt) {
  if (!ready) return;

  // ---- wrecked: grow the fireball, hold, then respawn ----
  if (crashed) {
    crashTimer += dt;
    if (crashFx) {
      const k = Math.min(1, crashTimer / 0.5);
      crashFx.scale.setScalar(3 + k * 16);
      crashFx.material.opacity = 1 - k;
    }
    camera.lookAt(planeRig.position);   // keep the wreck framed, with a stable base…
    applyShake(dt);                     // …so the death shake plays now, not after respawn
    if (crashTimer >= CRASH_RESET_DELAY) reset();
    return;
  }

  // ---- throttle (Space up / Shift down), capped at the lever max ----
  if (keys['Space']) throttle = Math.min(THROTTLE_MAX, throttle + dt * 0.6);
  if (keys['ShiftLeft'] || keys['ShiftRight']) throttle = Math.max(0, throttle - dt * 0.6);

  // ---- boost: Space at full lever → overdrive, until the engine overheats ----
  const wasBoosting = boosting;
  boosting = keys['Space'] && throttle >= THROTTLE_MAX - 1e-3 && boostLock <= 0;
  if (boosting) {
    boostHeat += dt / BOOST_TIME;
    addShake(boostHeat * 0.35 * dt);                       // a light rumble that grows toward overheat
    if (boostHeat >= 1) {                                   // overheat → long lockout + warning
      boostHeat = 1; boosting = false; overheated = true; boostLock = OVERHEAT_COOLDOWN;
    }
  } else {
    if (wasBoosting && boostLock <= 0 && boostHeat > 0.02) boostLock = EARLY_COOLDOWN;   // let off early → short lockout
    boostHeat = Math.max(0, boostHeat - dt / 2.5);         // flames cool off
  }
  if (boostLock > 0) { boostLock -= dt; if (boostLock <= 0) { boostLock = 0; overheated = false; } }
  boostBlend += ((boosting ? 1 : 0) - boostBlend) * Math.min(1, dt * 6);   // eased boost depth
  effThrottle = throttle + (BOOST_THROTTLE - THROTTLE_MAX) * boostBlend;

  // ---- airframe axes & airspeed ----
  forward.set(0, 0, -1).applyQuaternion(planeRig.quaternion);
  upVec.set(0, 1, 0).applyQuaternion(planeRig.quaternion);
  speed = velocity.length();

  // ---- pilot attitude input (authority fades with airspeed) ----
  const authority = THREE.MathUtils.clamp(speed / CRUISE, 0.25, 1.3);
  const pitch = (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0);   // W nose up
  const roll  = (keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0);   // A/D bank
  const yaw   = (keys['KeyQ'] ? 1 : 0) - (keys['KeyE'] ? 1 : 0);   // Q/E rudder
  planeRig.rotateX(pitch * PITCH_RATE * authority * dt);
  planeRig.rotateZ(roll  * ROLL_RATE  * authority * dt);
  planeRig.rotateY(yaw   * YAW_RATE   * authority * dt);

  // ---- forward CG: the heavy engine noses the plane over when it's slow ----
  // (vanishes at cruise so it doesn't fight normal flight; dominates in a stall)
  const cg = CG_DROP * (1 - Math.min(1, speed / CRUISE));
  planeRig.rotateX(cg * dt);                                   // +X = nose down

  // ---- dart stability: the centre of lift sits BEHIND the centre of mass, so
  //      the airframe is pulled nose-first into the relative wind. The nose is
  //      rotated toward the flight path; the antiparallel (tail-first) case is
  //      handled explicitly so a stalled plane noses OVER instead of dropping
  //      tail-first. ----
  if (speed > 1) {
    flightDir.copy(velocity).divideScalar(speed);
    // Self-trim: aim the nose at the path tilted by the AoA that yields ~1g of
    // lift, easing the nose DOWN so the wing sheds excess camber lift instead of
    // ballooning. The trim AoA already scales naturally with speed (≈0 at cruise,
    // growing as you go faster), so TRIM_GAIN (<1) just keeps it from overshooting
    // into a nose-down dive. Nose-down side only — slow/stall stays with CG_DROP.
    const clTrim = GRAVITY / (LIFT_MAX * speed * speed);       // lift coefficient for 1g here
    const aoaTrim = THREE.MathUtils.clamp((clTrim - CL0) / CL_SLOPE, -AOA_STALL, 0) * TRIM_GAIN;
    pitchAxis.set(1, 0, 0).applyQuaternion(planeRig.quaternion);   // wing axis
    targetDir.copy(flightDir).applyAxisAngle(pitchAxis, aoaTrim);  // desired nose direction
    const dot = THREE.MathUtils.clamp(forward.dot(targetDir), -1, 1);
    const ang = Math.acos(dot);                                // 0..π between nose & trim attitude
    if (ang > 1e-3) {
      wvAxis.crossVectors(forward, targetDir);
      if (wvAxis.lengthSq() < 1e-6) {
        // nose pointing straight back into the wind = unstable equilibrium.
        // Nose over about the wing axis, choosing the sign that drops the nose.
        wvAxis.set(1, 0, 0).applyQuaternion(planeRig.quaternion);
        wvTest.copy(forward).applyAxisAngle(wvAxis, 0.01);
        if (wvTest.y > forward.y) wvAxis.negate();
      }
      wvAxis.normalize();
      // proportional restoring: each frame close a fraction of the nose↔path
      // angle. Linear stiffness (∝ angle) gives genuine pitch stability at the
      // small angles you fly at, which is what stops the nose-up divergence,
      // while still snapping the nose around hard in a tail-first stall.
      const closeRate = STABILITY * THREE.MathUtils.clamp(speed / CRUISE, 0.5, 1.6);
      planeRig.rotateOnWorldAxis(wvAxis, Math.min(ang, ang * closeRate * dt));
      forward.set(0, 0, -1).applyQuaternion(planeRig.quaternion);   // refresh after re-orient
      upVec.set(0, 1, 0).applyQuaternion(planeRig.quaternion);
    }
  }

  // ---- forces (accelerations; mass = 1) ----
  accel.set(0, -GRAVITY, 0);                                   // gravity
  accel.addScaledVector(forward, effThrottle * MAX_THRUST);    // thrust along nose (incl. boost)

  // Lift from the wing. The lift coefficient rises with angle of attack, then
  // collapses past the critical AoA (stall). Because lift tracks AoA — not raw
  // speed — flying faster no longer forces the nose up: the plane self-trims.
  let aoa = 0;
  if (speed > 1) {
    invQ.copy(planeRig.quaternion).invert();
    localWind.copy(flightDir).applyQuaternion(invQ);           // airflow in body frame
    aoa = Math.atan2(-localWind.y, -localWind.z);              // +ve = nose above flight path
    const a = THREE.MathUtils.clamp(aoa, -1.2, 1.2);
    let cl = CL0 + CL_SLOPE * a;                                // cambered linear lift
    if (a >  AOA_STALL) cl = (CL0 + CL_SLOPE * AOA_STALL) * Math.max(0, 1 - (a - AOA_STALL) / 0.45);
    if (a < -AOA_STALL) cl = (CL0 - CL_SLOPE * AOA_STALL) * Math.max(0, 1 - (-a - AOA_STALL) / 0.45);
    accel.addScaledVector(upVec, LIFT_MAX * speed * speed * cl); // lift ∝ speed²·Cl(AoA)
  }
  stall = THREE.MathUtils.clamp((Math.abs(aoa) - AOA_STALL) / 0.2, 0, 1);

  // anisotropic drag: light along the nose, heavy across the body so velocity
  // is pulled into line with where the plane points.
  const vAlong = forward.dot(velocity);
  vFwd.copy(forward).multiplyScalar(vAlong);
  vPerp.copy(velocity).sub(vFwd);
  accel.addScaledVector(vFwd,  -DRAG_FWD  * speed);
  accel.addScaledVector(vPerp, -DRAG_PERP * speed);

  // ---- integrate ----
  const prevX = planeRig.position.x, prevY = planeRig.position.y, prevZ = planeRig.position.z;
  velocity.addScaledVector(accel, dt);
  planeRig.position.addScaledVector(velocity, dt);

  // ---- buildings & trees: sweep this frame's move against their collision
  //      meshes. Stop just short of the surface and slide along it, so the plane
  //      can't fly through the blocks or the trees (only the big shapes collide). ----
  const COLLIDE_R = 5;                                  // plane collision radius (scaled with the bigger plane)
  const dx = planeRig.position.x - prevX, dy = planeRig.position.y - prevY, dz = planeRig.position.z - prevZ;
  const moveLen = Math.hypot(dx, dy, dz);
  if (moveLen > 1e-4) {
    hitDir.set(dx / moveLen, dy / moveLen, dz / moveLen);
    hitOrigin.set(prevX, prevY, prevZ);
    const hit = world.raycastSolids(hitOrigin, hitDir, moveLen + COLLIDE_R);
    if (hit) {
      planeRig.position.set(prevX, prevY, prevZ).addScaledVector(hitDir, Math.max(0, hit.distance - COLLIDE_R));
      if (hit.normal) {                                 // remove velocity into the surface → slide
        const n = hit.normal;
        if (hitDir.dot(n) > 0) n.negate();              // make the normal face back toward us
        const vn = velocity.dot(n);
        if (vn < 0) {
          if (-vn > CRASH_SPEED) { crash(); return; }   // hit a wall/tree too hard → wreck
          velocity.addScaledVector(n, -vn);             // otherwise slide along it
        }
      }
    }
  }

  // ---- terrain: skid along, don't tunnel through hills or sea ----
  const groundY = world.groundAt(planeRig.position.x, planeRig.position.z) + 2;
  if (planeRig.position.y < groundY) {
    // impact speed into the ground = velocity against the terrain normal (from the
    // height field). Diving into flat ground or ramming a hillside both crash;
    // skimming level or settling gently doesn't.
    const gx = planeRig.position.x, gz = planeRig.position.z, e = 2;
    groundNormal.set(
      world.heightAt(gx - e, gz) - world.heightAt(gx + e, gz),
      2 * e,
      world.heightAt(gx, gz - e) - world.heightAt(gx, gz + e),
    ).normalize();
    if (-velocity.dot(groundNormal) > CRASH_SPEED) { crash(); return; }
    planeRig.position.y = groundY;
    if (velocity.y < 0) velocity.y = 0;
  }

  // ---- guns: spawn/advance bullets, destroy tanks they reach ----
  updateWeapons(dt);
  particles.update(dt);   // advance/fade impact-fx fountains

  // ---- propeller: idle spin + throttle, with a blur disc that fades in ----
  propSpin += (5 + effThrottle * 50) * dt;
  propeller.rotation.z = propSpin;
  if (propDisc) propDisc.material.opacity = 0.04 + effThrottle * 0.32;

  // ---- boost flames: tank-style fire off the engine sides, grown by heat ----
  updateBoostFire(dt);

  // ---- chase camera: mouse orbits the camera around the plane, always keeping
  //      the plane centred in frame. Centre cursor → straight chase view.
  if (!dragging) {                                   // released → drift back to chase view
    dragYaw   += (0 - dragYaw)   * Math.min(1, dt * 5);
    dragPitch += (0 - dragPitch) * Math.min(1, dt * 5);
  }
  lookYaw   += (dragYaw   - lookYaw)   * Math.min(1, dt * 12);
  lookPitch += (dragPitch - lookPitch) * Math.min(1, dt * 12);
  lookOffset.copy(camOffset).applyEuler(lookEuler.set(lookPitch, lookYaw, 0, 'YXZ'));
  desiredCam.copy(lookOffset).applyQuaternion(planeRig.quaternion).add(planeRig.position);
  camera.position.lerp(desiredCam, Math.min(1, dt * 6));
  camTarget.copy(planeRig.position);   // look at the plane → stays centred
  camera.lookAt(camTarget);
  applyShake(dt);

  updateHUD();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const thrEl = document.getElementById('thr');
const thrBar = document.getElementById('thrbar');
const altEl = document.getElementById('alt');
const stallEl = document.getElementById('stall');
const overheatEl = document.getElementById('overheat');

// An analog dial: a dark face + metal bezel and a 270° tick scale around the rim,
// with an optional redline arc. The pointer is a triangle that rides a recessed
// window channel; its body extends inward but is CLIPPED to that channel (an
// annular band), so only the arrow tip shows and the rest is hidden behind the
// face — leaving the centre clear for overlaid content. Returns a setter that
// eases the pointer toward `value` each frame so it sweeps.
function makeDial(hostId, { min, max, redFrom = null, ticks = 12 }) {
  const R = 42, RS = 33, START = -135, SWEEP = 270;            // R = tick radius; RS = window-channel radius
  const ang = (f) => START + f * SWEEP;
  const pt = (a, r) => [50 + r * Math.sin(a * Math.PI / 180), 50 - r * Math.cos(a * Math.PI / 180)];
  const arc = (f0, f1, r) => {
    const [x0, y0] = pt(ang(f0), r), [x1, y1] = pt(ang(f1), r);
    const large = (f1 - f0) * SWEEP > 180 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  let tk = '';
  for (let i = 0; i <= ticks; i++) {
    const big = i % 3 === 0;
    const [x0, y0] = pt(ang(i / ticks), R), [x1, y1] = pt(ang(i / ticks), R - (big ? 6 : 4));
    tk += `<line class="tick${big ? ' big' : ''}" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
  }
  const red = redFrom != null ? `<path class="red" d="${arc((redFrom - min) / (max - min), 1, R)}"/>` : '';
  // clip = an annular band over the window channel; the pointer is clipped to it
  const cid = `${hostId}-clip`;
  const circ = (r) => `M ${(50 - r).toFixed(2)},50 a ${r},${r} 0 1,0 ${(2 * r).toFixed(2)},0 a ${r},${r} 0 1,0 ${(-2 * r).toFixed(2)},0`;
  const clip = `<clipPath id="${cid}"><path clip-rule="evenodd" d="${circ(38)} ${circ(30)}"/></clipPath>`;
  // pointer at the top (angle 0): triangle tip outward + a stem toward centre
  // (the stem is clipped away → "the rest of the pointer is hidden behind the dial")
  const ptr = `<g class="ind" clip-path="url(#${cid})">
    <rect class="stem" x="48.6" y="16" width="2.8" height="18"/>
    <path class="ptr" d="M 50 ${(50 - 37).toFixed(1)} L 46.6 ${(50 - 30).toFixed(1)} L 53.4 ${(50 - 30).toFixed(1)} Z"/>
  </g>`;
  document.getElementById(hostId).innerHTML = `<svg class="dial" viewBox="0 0 100 100">
    <defs>${clip}</defs>
    <circle class="face" cx="50" cy="50" r="47"/>
    <path class="slot" d="${arc(0, 1, RS)}"/>
    <path class="arc" d="${arc(0, 1, R)}"/>${red}${tk}
    <circle class="bezel" cx="50" cy="50" r="47"/>${ptr}
  </svg>`;
  const indEl = document.querySelector(`#${hostId} .ind`);
  let cur = min;
  return (value) => {
    cur += (value - cur) * 0.18;                                // damped sweep
    const f = Math.max(0, Math.min(1, (cur - min) / (max - min)));
    indEl.setAttribute('transform', `rotate(${ang(f).toFixed(2)} 50 50)`);
  };
}

const setSpd = makeDial('dialMainSvg', { min: 0, max: 300, redFrom: 250, ticks: 12 });  // speed on the big dial
const setRpm = makeDial('dialSatSvg',  { min: 0, max: 3000, redFrom: 2650, ticks: 9 });  // rpm on the bubble

function updateHUD() {
  setSpd(speed * 3.6);                                          // ~km/h-ish around the main dial
  // tachometer feel: throttle-led, lifted by airspeed and dives, idling off zero
  const rpm01 = 0.15 + throttle * 0.65 + Math.min(speed / 130, 1) * 0.2 - velocity.y * 0.004;
  setRpm((rpm01 + boostBlend * 0.18) * 3000);                  // boost spikes the tach a touch
  altEl.textContent = Math.round(planeRig.position.y);          // alt in the satellite face
  // throttle readout: % of the lever max (100% at the cap, up to 120% on boost)
  thrEl.textContent = Math.round((effThrottle / THROTTLE_MAX) * 100);
  thrBar.style.width = `${Math.min(100, (throttle / THROTTLE_MAX) * 100)}%`;
  const fl = 0.5 + 0.5 * Math.sin(performance.now() * 0.018);
  if (boostBlend > 0.05) {                                      // boosting → flash red + heat-shaded bar
    const c = `rgb(255,${(70 + fl * 70) | 0},${(60 + fl * 50) | 0})`;
    thrEl.style.color = c; thrBar.style.background = c;
  } else if (boostLock > 0) {                                   // locked out (overheat or early let-off) → warm
    thrEl.style.color = '#ff9a5a'; thrBar.style.background = '#ff9a5a';
  } else {
    thrEl.style.color = ''; thrBar.style.background = '';       // back to defaults
  }
  overheatEl.style.opacity = boostLock > 0 ? (0.25 + 0.75 * fl) : 0;   // flash the warning during any lockout
  stallEl.style.opacity = stall > 0.35 ? 1 : 0;
}

// controls help: collapsed by default, toggled by the button
const helpBody = document.getElementById('helpBody');
document.getElementById('helpToggle').addEventListener('click', () => helpBody.classList.toggle('collapsed'));

// ---------------------------------------------------------------------------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// detached free-fly camera: keys move along the view, drag to look
function freeUpdate(dt) {
  lookEuler.set(freePitch, freeYaw, 0, 'YXZ');
  forward.set(0, 0, -1).applyEuler(lookEuler);
  freeRight.set(1, 0, 0).applyEuler(lookEuler);
  const sp = 130 * ((keys['ShiftLeft'] || keys['ShiftRight']) ? 4 : 1) * dt;
  if (keys['KeyW']) freePos.addScaledVector(forward, sp);
  if (keys['KeyS']) freePos.addScaledVector(forward, -sp);
  if (keys['KeyD']) freePos.addScaledVector(freeRight, sp);
  if (keys['KeyA']) freePos.addScaledVector(freeRight, -sp);
  if (keys['KeyE'] || keys['Space']) freePos.y += sp;
  if (keys['KeyQ']) freePos.y -= sp;
  camera.position.copy(freePos);
  camTarget.copy(freePos).add(forward);
  camera.lookAt(camTarget);
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (freeCam) freeUpdate(dt); else update(dt);  // free-fly cam freezes the plane
  audio.engine(effThrottle, speed, velocity.y, ready && !crashed);  // RPM rides throttle (incl. boost)/speed/dive
  const night = env.update(dt);                  // advance day/night cycle (needed by tank wreck lights)
  // enemy tanks drive + fire leading shells at the plane; a hit costs health
  const tankEvt = tanks.update(dt, planeRig.position, velocity, camera, night);
  if (!freeCam) {
    if (tankEvt.hit) damagePlane();
    else if (tankEvt.nearMiss > 0) addShake(0.1 + 0.4 * tankEvt.nearMiss);   // close shell pass rattles the cam
  }
  updateThreatRing(clock.elapsedTime);           // glow arcs toward tank threats
  updatePacks(dt);                               // hover/spin health packs + pickups
  world.update(clock.elapsedTime, night);        // city windows light up at night
  renderer.render(scene, camera);
}
animate();
