import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { buildWorld } from './world.js';
import { buildSky } from './sky.js';
import { buildTanks } from './tanks.js';

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
let tanksHandle = null;   // forward ref so the city-ready hook can reach the tanks
const world = buildWorld(scene, () => {
  if (tanksHandle) tanksHandle.refreshObstacles();
  spawnHealthPacks();   // place packs once the city exists (so they land in the streets)
});
const env = buildSky(scene, camera);

// ---------------------------------------------------------------------------
// The plane (a container we steer; the model sits inside, nose aligned to -Z)
// ---------------------------------------------------------------------------
const planeRig = new THREE.Group();   // position + orientation we control
scene.add(planeRig);

const START = { pos: new THREE.Vector3(340, 130, 0), throttle: 0.5 };

// Enemy tanks on the beach the plane launches toward (heading -Z). Hull + turret
// are separate, independently steerable objects — see tanks.js.
const tankFront = START.pos.clone().add(new THREE.Vector3(0, 0, -600));
const tanks = buildTanks(scene, world, tankFront, 5);
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
  }
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.mesh.position.addScaledVector(b.vel, dt);
    b.life -= dt;
    let dead = b.life <= 0;
    if (!dead && tanks.tryHit(b.mesh.position, BULLET_HIT_R)) {
      dead = true; kills++; if (kills > maxStreak) maxStreak = kills; updateStreakHUD();
    }
    if (!dead && b.mesh.position.y < world.groundAt(b.mesh.position.x, b.mesh.position.z)) dead = true;
    if (dead) { scene.remove(b.mesh); bullets.splice(i, 1); }
  }
}

// ---------------------------------------------------------------------------
// Health: the plane survives a couple of shell hits. Each tank shell takes one;
// at zero it crashes. (A hard terrain/building collision still wrecks instantly.)
// Health packs floating low over the city restore a point.
// ---------------------------------------------------------------------------
const MAX_HEALTH = 2;
let health = MAX_HEALTH;
const hpEl = document.createElement('div');
document.getElementById('hud').appendChild(hpEl);
function updateHealthHUD() { hpEl.innerHTML = `HP <span style="color:#ff6f6f">${'♥'.repeat(health)}</span><span style="opacity:.3">${'♥'.repeat(Math.max(0, MAX_HEALTH - health))}</span>`; }
updateHealthHUD();

function damagePlane() {
  if (crashed) return;
  health -= 1;
  updateHealthHUD();
  hpEl.style.transform = 'scale(1.3)';                 // quick flinch
  setTimeout(() => { hpEl.style.transform = ''; }, 120);
  if (health <= 0) crash();
}

// --- health packs: glowing green crates that hover low near the city. A steady
//     handful are kept around, respawning over time and away from the plane. ----
const packs = [];
const PACK_TARGET = 6, PACK_PICKUP_R = 13, PACK_HOVER = 14, PACK_AREA_R = 520;
const PACK_RESPAWN = 8, PACK_SPAWN_AWAY = 220;
let packTimer = 0;
const packGeo = new THREE.BoxGeometry(4, 4, 4);
const packMat = new THREE.MeshBasicMaterial({ color: 0x2bd24b });
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
    const mesh = new THREE.Mesh(packGeo, packMat);
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
  const fx = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffa22a, transparent: true, opacity: 1, depthWrite: false }),
  );
  fx.position.copy(planeRig.position);
  scene.add(fx);
  crashFx = fx;
  modeEl.textContent = '💥 CRASHED — resetting…';
}

function reset() {
  planeRig.position.copy(START.pos);
  planeRig.quaternion.identity();
  throttle = START.throttle;
  velocity.set(0, 0, -1).multiplyScalar(CRUISE);   // launch at cruise, not a stall
  camera.position.copy(START.pos).add(new THREE.Vector3(0, 8, 30));
  crashed = false;
  kills = 0; updateStreakHUD();                      // R / respawn clears the current streak (BEST persists)
  health = MAX_HEALTH;
  updateHealthHUD();
  if (planeModel) planeModel.visible = true;
  if (crashFx) { scene.remove(crashFx); crashFx.material.dispose(); crashFx = null; }
  modeEl.textContent = freeCam ? modeEl.textContent : '';
}

const forward = new THREE.Vector3();
const upVec = new THREE.Vector3();
const accel = new THREE.Vector3();
const flightDir = new THREE.Vector3();
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
    if (crashTimer >= CRASH_RESET_DELAY) reset();
    return;
  }

  // ---- throttle (Space up / Shift down) ----
  if (keys['Space']) throttle = Math.min(1, throttle + dt * 0.6);
  if (keys['ShiftLeft'] || keys['ShiftRight']) throttle = Math.max(0, throttle - dt * 0.6);

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
    const dot = THREE.MathUtils.clamp(forward.dot(flightDir), -1, 1);
    const ang = Math.acos(dot);                                // 0..π between nose & path
    if (ang > 1e-3) {
      wvAxis.crossVectors(forward, flightDir);
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
  accel.addScaledVector(forward, throttle * MAX_THRUST);       // thrust along nose

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

  // ---- propeller: idle spin + throttle, with a blur disc that fades in ----
  propSpin += (5 + throttle * 50) * dt;
  propeller.rotation.z = propSpin;
  if (propDisc) propDisc.material.opacity = 0.04 + throttle * 0.32;

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

  updateHUD();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const spdEl = document.getElementById('spd');
const altEl = document.getElementById('alt');
const vsEl = document.getElementById('vs');
const thrEl = document.getElementById('thr');
const thrBar = document.getElementById('thrbar');
const stallEl = document.getElementById('stall');
function updateHUD() {
  spdEl.textContent = Math.round(speed * 3.6);          // ~km/h-ish
  altEl.textContent = Math.round(planeRig.position.y);
  vsEl.textContent = (velocity.y >= 0 ? '+' : '') + Math.round(velocity.y); // climb/sink rate
  const t = Math.round(throttle * 100);
  thrEl.textContent = t;
  thrBar.style.width = `${t}%`;
  stallEl.style.opacity = stall > 0.35 ? 1 : 0;
}

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
  // enemy tanks drive + fire leading shells at the plane; a hit costs health
  const tankHit = tanks.update(dt, planeRig.position, velocity);
  if (tankHit && !freeCam) damagePlane();
  updatePacks(dt);                               // hover/spin health packs + pickups
  const night = env.update(dt);                  // advance day/night cycle
  world.update(clock.elapsedTime, night);        // city windows light up at night
  renderer.render(scene, camera);
}
animate();
