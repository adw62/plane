import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TYPE } from './scatter.js';

// ===========================================================================
// Tanks — roaming enemy units. The hull and turret are loaded as SEPARATE models
// so the turret yaws independently of the hull. Each tank is its own rig:
//
//   group           world transform + hull heading (the chassis we drive)
//     hull           the base model, conformed to the terrain slope
//     turretPivot    yaws independently to track the plane
//       turret       the turret model
//
// Behaviour, all driven from update():
//   • Drive    — follow a BFS route (4-connected, no diagonals) over drivable
//                cells to a far reachable goal; alternate beach⇄interior missions.
//   • Navigate — a traversability grid (drivable terrain minus building/tree
//                cells) the routes are planned on; rebuilt when the city loads.
//   • Fight    — track the plane and fire leading shells, but only with recent
//                line of sight; shells hitting the plane are reported to main.js.
//   • Spawn    — keep MIN..MAX tanks alive, respawning away from the plane.
//
// buildTanks() loads the two models once, builds a template, and clones it per
// tank so we pay the GLB decode a single time.
// ===========================================================================

const TANK_LEN     = 10;    // world units for the hull's largest horizontal dimension (plane is ~6)
const TURRET_FIX   = 0;     // radians: add a constant if the turret model's barrel isn't aligned to -Z
const TURRET_SCALE = (2 / 3) * 0.75;  // turret size relative to the hull
const TURRET_RAISE = -0.03; // EXTRA lift above the hull top, as a fraction of hull height (0 = flush, negative = sink in)
const TURRET_FWD   = 0.15;  // shift the turret toward the hull's front (+Z), as a fraction of hull length
const TURRET_PIVOT_BACK = 0.1;  // move the turret's yaw axis back (-Z) of its centre, as a fraction of hull length
const DRIVE_SPEED  = 11;    // hull top speed (world units/s)
const ACCEL        = 14;    // speed ramp toward the target speed (units/s^2)
const TURN_RATE    = 1.1;   // hull steering rate (rad/s)
const MIN_TRAVEL   = 90;    // a mission destination must be at least this far (world units) away
const INTERIOR_H   = 12;    // terrain height above which a grass cell counts as "interior" (inland)
const ARRIVE_DIST  = 7;     // within this distance of a path node → advance to the next one
const TILT_RATE    = 5;     // how fast the hull settles onto the terrain normal (per second)
const TURRET_TRACK = 2.4;   // turret yaw slew toward the plane (rad/s)
const TANK_HIT_R   = 6;     // shootable radius around a tank (world units)
const TANK_CENTRE_Y = 2;    // height of the tank's centre above its ground point (for aim/hit tests)
const FIRE_RANGE   = 700;   // tanks only shoot at the plane within this distance
const FIRE_INTERVAL = 6.5;  // average seconds between a tank's shots (randomised per shot)
const SHELL_SPEED  = 120;   // tank shell speed (world units/s) — also sets the lead time
const SHELL_LIFE   = 8;     // seconds before a shell expires
const LOS_MEMORY   = 10;    // a tank only fires if it has had line of sight within this many seconds
const LOS_INTERVAL = 0.25;  // how often a tank re-checks line of sight to the plane
const AIM_NOISE    = 0.05;  // aim scatter as a fraction of range (0 = perfect aim; bigger = wilder)
const MUZZLE_Y     = 4.5;   // height the shell leaves the turret (above the tank's ground point)
const PLANE_HIT_R  = 8;     // shell-vs-plane hit radius (world units)
const WHOOSH_R     = 66;    // a shell within this of the plane drives a building, doppler'd fly-by whoosh
const CRACK_R      = 20;    // only passes closer than this snap a "crack/whizz" accent at closest approach
const MIN_TANKS    = 3;     // keep at least this many tanks on the field
const MAX_TANKS    = 5;     // ...and at most this many
const RESPAWN_FAST = 1.5;   // seconds between respawns while below MIN_TANKS
const RESPAWN_SLOW = 6;     // seconds between respawns while topping up toward MAX_TANKS
const SPAWN_AWAY   = 280;   // new tanks spawn at least this far from the plane
const DIFFUSE_BOOST  = 1.6; // >1 brightens the tanks' diffuse (albedo) response to light
const TANK_METALNESS = 0.0; // metalness kills diffuse reflection; force dielectric so light bounces back matte

// Boost how much diffuse light the tank reflects: drop metalness (metals have no
// diffuse term) and scale the albedo up. Edits the loaded PBR material in place,
// so it affects tanks only — the rest of the world keeps its own materials.
function brightenTank(root) {
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      o.material.metalness = TANK_METALNESS;
      o.material.color.multiplyScalar(DIFFUSE_BOOST);
      o.material.needsUpdate = true;
    }
  });
}

// Build one tank from the two loaded GLTF scenes. Returns a Group with a named
// `turretPivot` child so clones can find their turret again.
function makeTankTemplate(baseScene, turretScene) {
  // Measure both in their shared model space (they were authored together, so we
  // apply ONE scale + offset to keep the turret seated correctly on the hull).
  const baseBox = new THREE.Box3().setFromObject(baseScene);
  const turretBox = new THREE.Box3().setFromObject(turretScene);
  const size = baseBox.getSize(new THREE.Vector3());
  const cB = baseBox.getCenter(new THREE.Vector3());
  const cT = turretBox.getCenter(new THREE.Vector3());

  const s = TANK_LEN / Math.max(size.x, size.z);     // scale by hull footprint
  // offset (in model units): centre the hull in XZ, rest its underside on y=0
  const ox = -cB.x, oy = -baseBox.min.y, oz = -cB.z;

  const norm = new THREE.Group();   // applies the shared scale to hull + turret
  norm.scale.setScalar(s);

  baseScene.position.set(ox, oy, oz);
  norm.add(baseScene);

  // Turret on its own pivot at the turret's own centre, so yaw AND the shrink both
  // act about that point. Both models are authored base-at-y=0 (the turret isn't
  // modelled on top of the hull), so we explicitly seat the shrunken turret's
  // underside onto the hull's top surface rather than leaving it buried.
  const turretPivot = new THREE.Group();
  turretPivot.name = 'turretPivot';
  turretPivot.scale.setScalar(TURRET_SCALE);
  const hullTop = baseBox.max.y + oy;                       // hull rests on y=0, so this is its height
  const baseBelowCentre = (turretBox.min.y - cT.y) * TURRET_SCALE;  // turret underside relative to its centre (negative)
  const seatY = hullTop - baseBelowCentre + size.y * TURRET_RAISE;
  // Move the yaw axis back of the turret's centre, but keep the turret itself in
  // place: shift the pivot by -B and compensate the model by +B/scale so only the
  // rotation centre moves, not the visible turret.
  const B = size.z * TURRET_PIVOT_BACK;
  turretPivot.position.set(cT.x + ox, seatY, cT.z + oz + size.z * TURRET_FWD - B);
  turretScene.position.set(-cT.x, -cT.y, -cT.z + B / TURRET_SCALE);
  turretPivot.add(turretScene);
  norm.add(turretPivot);

  const template = new THREE.Group();
  template.add(norm);
  return template;
}

// Find a flat beach point along a compass direction (radial from the island
// centre), by marching outward until the terrain drops to the waterline and
// taking the middle of the sand band. Returns {x, z} or null.
function beachPoint(heightAt, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const h = (r) => heightAt(cos * r, sin * r);
  let rTop = null, rBot = null;
  for (let r = 400; r <= 1000; r += 3) {        // inland → sea
    const y = h(r);
    if (rTop === null && y <= 6) rTop = r;       // top of the beach
    if (rTop !== null && y <= 1) { rBot = r; break; }  // waterline
  }
  if (rTop === null) return null;
  const r = rBot === null ? rTop : (rTop + rBot) / 2;
  return { x: cos * r, z: sin * r };
}

// Place a loose cluster of tanks on the beach nearest `front` (a point roughly
// ahead of the plane), spread along the shoreline tangent.
function placeOnBeach(heightAt, front, count) {
  const angle = Math.atan2(front.z, front.x);
  const centre = beachPoint(heightAt, angle);
  if (!centre) return [];
  // unit tangent along the shore (perpendicular to the radial), to spread the row
  const tx = -Math.sin(angle), tz = Math.cos(angle);
  const nx = -Math.cos(angle), nz = -Math.sin(angle);    // inland normal (toward island centre)
  const spots = [];
  for (let i = 0; i < count; i++) {
    const along = (i - (count - 1) / 2) * 40;            // spread wide so they read as separate tanks
    const inland = 18 + (Math.random() - 0.5) * 10;      // sit on firm beach, back from the waterline
    const x = centre.x + tx * along + nx * inland;
    const z = centre.z + tz * along + nz * inland;
    spots.push({ x, z, yaw: angle + Math.PI / 2 + (Math.random() - 0.5) * 0.5 });
  }
  return spots;
}

// Public entry. Loads the models, drops `count` tanks on the beach near `front`,
// and returns a handle. They patrol drivable terrain between random waypoints,
// conform to the ground slope, and keep their turrets aimed at `targetPos`.
//   world: { heightAt, grid, raycastSolids }  (from buildWorld)
export function buildTanks(scene, world, front, count = 5, audio = null) {
  const heightAt = world.heightAt;
  const grid = world.grid;
  const tanks = [];   // declared early so refresh() (runs before the models load) can reach it
  let template = null;   // the loaded tank rig, cloned per spawn
  let respawnTimer = 0;
  let lastTarget = null;   // most recent plane position (for the death-blast distance)

  // --- obstacle grid: cells whose column hits a building/tree are removed from the
  //     tanks' nav (no dilation — only the actually-covered cells). The collision
  //     world has no terrain, so any downward hit means an obstacle covers the cell.
  //     The city builds asynchronously, so markObstacles() re-runs at city-ready. ---
  const blocked = grid ? new Uint8Array(grid.cols * grid.rows) : null;
  const cellIndex = (x, z) => {
    const i = Math.round((x - grid.minX) / grid.step), j = Math.round((z - grid.minZ) / grid.step);
    if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) return -1;
    return j * grid.cols + i;
  };
  const blockedAt = (x, z) => { const k = cellIndex(x, z); return k >= 0 && blocked[k] === 1; };

  const _obsO = new THREE.Vector3(), _obsD = new THREE.Vector3(0, -1, 0);
  const obstacleAt = (x, z) => {
    if (!world.raycastSolids) return false;
    _obsO.set(x, heightAt(x, z) + 250, z);                // start above the tallest tower
    return !!world.raycastSolids(_obsO, _obsD, 250);      // far = 250 stops at the terrain
  };

  const markObstacles = () => {
    if (!blocked) return;
    const { cols, rows, minX, minZ, step } = grid;
    blocked.fill(0);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = minX + i * step, z = minZ + j * step;
      const c = grid.at(x, z);
      if (!c || (c.type !== TYPE.BEACH && c.type !== TYPE.GRASS)) continue;  // only test drivable cells
      if (obstacleAt(x, z)) blocked[j * cols + i] = 1;
    }
  };

  // Drivable = flat sand or grass (the grid's type folds in slope + waterline) AND
  // not a cell covered by a building/tree.
  const passable = (x, z) => {
    const c = grid.at(x, z);
    return !!c && (c.type === TYPE.BEACH || c.type === TYPE.GRASS) && !blockedAt(x, z);
  };

  // Re-scan obstacles and force live tanks to replan so they stop following routes
  // planned before these obstacles were known (e.g. a spawn route that ran through
  // where the city has since appeared). Run now (trees), and again at city-ready
  // (buildings) via the handle's refreshObstacles.
  const refresh = () => {
    markObstacles();
    for (const t of tanks) { t.path = null; t.wait = 0; }   // invalidate stale routes
  };
  refresh();

  // Plan a route to a far, REACHABLE cell that satisfies the tank's mission
  // ('beach' → a sand cell; 'interior' → an inland grass cell), by breadth-first
  // search over 4-connected drivable cells (forward/back/left/right — no diagonals).
  // Flooding the whole reachable region and aiming at a distant goal of the right
  // kind sends them across the map instead of circling. Returns the path as world
  // points (corner nodes only), or null if boxed in. A generation stamp on
  // _visited avoids clearing the whole grid each call.
  const _visited = grid ? new Int32Array(grid.cols * grid.rows) : null;
  const _parent = grid ? new Int32Array(grid.cols * grid.rows) : null;
  let _gen = 0;

  const planPath = (sx, sz, mission) => {
    if (!grid) return null;
    const { cols, rows, minX, minZ, step, type, height } = grid;
    const start = cellIndex(sx, sz);
    if (start < 0) return null;
    const gen = ++_gen;
    const si = start % cols, sj = (start / cols) | 0;
    const queue = [start]; let head = 0;
    _visited[start] = gen; _parent[start] = -1;
    const reach = [];
    while (head < queue.length) {
      const k = queue[head++];
      reach.push(k);
      const i = k % cols, j = (k / cols) | 0;
      // 4-connected neighbours only (no diagonal moves)
      const ni = [i + 1, i - 1, i, i], nj = [j, j, j + 1, j - 1];
      for (let n = 0; n < 4; n++) {
        const a = ni[n], b = nj[n];
        if (a < 0 || b < 0 || a >= cols || b >= rows) continue;
        const nk = b * cols + a;
        if (_visited[nk] === gen) continue;
        if (!passable(minX + a * step, minZ + b * step)) continue;
        _visited[nk] = gen; _parent[nk] = k; queue.push(nk);
      }
    }
    // candidate destinations: far enough away AND matching the mission
    const minCells = MIN_TRAVEL / step;
    const far = (k) => Math.abs(k % cols - si) + Math.abs((k / cols | 0) - sj) >= minCells;
    const fits = (k) => mission === 'beach'
      ? type[k] === TYPE.BEACH
      : (type[k] === TYPE.GRASS && height[k] > INTERIOR_H);
    let cand = reach.filter((k) => far(k) && fits(k));
    if (!cand.length) cand = reach.filter(far);          // fall back to any far cell
    if (!cand.length) cand = reach.filter((k) => k !== start);
    if (!cand.length) return null;
    // walk parents back from a random matching cell to the start
    const cells = [];
    let k = cand[(Math.random() * cand.length) | 0];
    while (k !== start && k >= 0) { cells.push(k); k = _parent[k]; }
    cells.reverse();
    // keep only corner nodes (direction changes) so segments are straight runs
    const path = [];
    for (let n = 0; n < cells.length; n++) {
      const corner = n === 0 || n === cells.length - 1
        || Math.sign(cells[n] % cols - cells[n - 1] % cols) !== Math.sign(cells[n + 1] % cols - cells[n] % cols)
        || Math.sign((cells[n] / cols | 0) - (cells[n - 1] / cols | 0)) !== Math.sign((cells[n + 1] / cols | 0) - (cells[n] / cols | 0));
      if (corner) path.push({ x: minX + (cells[n] % cols) * step, z: minZ + (cells[n] / cols | 0) * step });
    }
    return path.length ? path : null;
  };

  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  const load = (url) => new Promise((res, rej) => loader.load(url, (g) => res(g.scene), undefined, rej));

  // Spawn one tank at (x,z) facing `yaw`. heading drives the hull (model faces +Z);
  // each tank runs beach⇄interior missions, alternating each leg so it crosses the
  // map instead of circling.
  function addTank(x, z, yaw) {
    if (!template) return;
    const group = template.clone(true);
    group.position.set(x, heightAt(x, z), z);
    group.rotation.y = yaw;
    const turret = group.getObjectByName('turretPivot');
    turret.rotation.y = TURRET_FIX;
    scene.add(group);
    const mission = Math.random() < 0.5 ? 'beach' : 'interior';
    tanks.push({
      group, turret, heading: yaw, speed: 0, mission,
      path: planPath(x, z, mission), pathIdx: 0, wait: 0,
      cooldown: Math.random() * FIRE_INTERVAL,   // stagger first shots
      lastSeen: -Infinity, losTimer: Math.random() * LOS_INTERVAL,   // line-of-sight memory
    });
  }

  // Find a random drivable cell at least SPAWN_AWAY from `avoid` (the plane).
  function findSpawnCell(avoid) {
    if (!grid) return null;
    const { cols, rows, minX, minZ, step } = grid;
    for (let i = 0; i < 80; i++) {
      const x = minX + ((Math.random() * cols) | 0) * step;
      const z = minZ + ((Math.random() * rows) | 0) * step;
      if (!passable(x, z)) continue;
      if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < SPAWN_AWAY) continue;
      return { x, z };
    }
    return null;
  }

  Promise.all([load('./models/tb.glb'), load('./models/tt.glb')])
    .then(([baseScene, turretScene]) => {
      brightenTank(baseScene);
      brightenTank(turretScene);
      template = makeTankTemplate(baseScene, turretScene);
      for (const spot of placeOnBeach(heightAt, front, count)) addTank(spot.x, spot.z, spot.yaw);
    })
    .catch((err) => console.error('Tank load failed:', err));

  // reusable temporaries for the per-frame orientation maths (avoid allocations)
  const _up = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
  const _basis = new THREE.Matrix4(), _q = new THREE.Quaternion();

  // --- explosions: a quick expanding, fading puff when a tank is destroyed -----
  const fx = [];
  const fxGeo = new THREE.SphereGeometry(1, 12, 10);
  function spawnExplosion(pos, scale = 1) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa22a, transparent: true, opacity: 1, depthWrite: false });
    const mesh = new THREE.Mesh(fxGeo, mat);
    mesh.position.copy(pos);
    scene.add(mesh);
    fx.push({ mesh, age: 0, ttl: 0.5, scale });
  }

  // --- burning wrecks: when a tank dies it doesn't vanish. The turret is blown
  //     off as a tumbling physics object (gravity + spin, bounces, settles) and
  //     the hull stays put, on fire, until ~WRECK_LIFE has passed AND it's off
  //     screen (so it never pops out from under the player's gaze). ------------
  const wrecks = [];
  const WRECK_LIFE = 20;        // min seconds a wreck burns before it may be removed
  const WRECK_MAX  = 45;        // hard cap: gone by now even if stared at
  const FX_GRAVITY = -34;       // gravity for the flying turret (world u/s^2)
  const _frustum = new THREE.Frustum();
  const _frMat   = new THREE.Matrix4();
  const _wp = new THREE.Vector3(), _wq = new THREE.Quaternion(), _ws = new THREE.Vector3();

  // Rising flame / smoke puffs (continuously emitted by burning wrecks).
  const fire = [];
  const fireGeo = new THREE.SphereGeometry(1, 6, 5);
  function spawnFire(x, y, z) {
    const flame = Math.random() < 0.65;
    const mat = new THREE.MeshBasicMaterial({
      color: flame ? (Math.random() < 0.5 ? 0xff5a1a : 0xffb12a) : 0x2a2a2a,
      transparent: true, opacity: flame ? 0.9 : 0.45, depthWrite: false,
      blending: flame ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const m = new THREE.Mesh(fireGeo, mat);
    m.position.set(x + (Math.random() * 2 - 1) * 2, y + Math.random() * 1.5, z + (Math.random() * 2 - 1) * 2);
    m.scale.setScalar(flame ? 1.0 + Math.random() * 1.4 : 1.6 + Math.random() * 1.8);
    scene.add(m);
    fire.push({ mesh: m, age: 0, ttl: flame ? 0.5 + Math.random() * 0.4 : 1.2 + Math.random() * 0.9,
                vy: flame ? 7 + Math.random() * 4 : 9 + Math.random() * 5, grow: flame ? 1.6 : 2.6 });
  }

  // Turn tank `t` into a burning wreck: blast, detach the turret as a physics
  // object, keep the hull as the smouldering chassis.
  function wreckTank(t) {
    const p = t.group.position;
    spawnExplosion(new THREE.Vector3(p.x, p.y + TANK_CENTRE_Y, p.z), 1.5);

    // Detach the turret pivot into world space (scene is identity), then launch it.
    const pivot = t.turret;
    pivot.updateWorldMatrix(true, false);
    pivot.matrixWorld.decompose(_wp, _wq, _ws);
    scene.add(pivot);                                  // reparent to scene
    pivot.position.copy(_wp); pivot.quaternion.copy(_wq); pivot.scale.copy(_ws);

    // Flickering firelight that washes the surroundings — reads mostly at night.
    // decay 1 (gentle falloff) so it pools over the ground without blowing out.
    const light = new THREE.PointLight(0xff6a22, 0, 140, 1);
    light.position.set(p.x, p.y + 3, p.z);
    scene.add(light);

    wrecks.push({
      hull: t.group, turret: pivot, light, flicker: Math.random() * 6.28, age: 0, emit: 0, landed: false,
      tVel: new THREE.Vector3((Math.random() * 2 - 1) * 7, 28 + Math.random() * 14, (Math.random() * 2 - 1) * 7),
      tSpin: new THREE.Vector3((Math.random() * 2 - 1) * 7, (Math.random() * 2 - 1) * 7, (Math.random() * 2 - 1) * 7),
    });

    // Sound last + guarded: a stale/old audio module must never block the kill.
    audio?.explosion?.(lastTarget ? p.distanceTo(lastTarget) : 0);   // boom, by range to the plane
  }

  // --- tank shells: straight-line tracers the tanks fire at the plane -----------
  let clock = 0;   // accumulated time, for line-of-sight memory timestamps
  const shells = [];
  const shellGeo = new THREE.SphereGeometry(0.6, 8, 6);
  const shellMat = new THREE.MeshBasicMaterial({ color: 0xff4422 });
  const _muzzle = new THREE.Vector3(), _aim = new THREE.Vector3(), _dir = new THREE.Vector3();
  const _losO = new THREE.Vector3(), _losD = new THREE.Vector3();

  // Clear line of sight from a muzzle point to the plane? Blocked by a building/
  // tree (BVH ray) OR by terrain (march the ray and check it stays above ground).
  function hasLOS(mx, my, mz, target) {
    const dx = target.x - mx, dy = target.y - my, dz = target.z - mz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1) return true;
    if (world.raycastSolids) {
      _losO.set(mx, my, mz);
      _losD.set(dx / dist, dy / dist, dz / dist);
      if (world.raycastSolids(_losO, _losD, dist - 2)) return false;   // wall/tree in the way
    }
    const steps = Math.max(4, Math.min(48, (dist / 12) | 0));          // terrain occlusion
    for (let s = 1; s < steps; s++) {
      const f = s / steps;
      if (my + dy * f < heightAt(mx + dx * f, mz + dz * f)) return false;
    }
    return true;
  }

  // Fire one shell from a tank at the plane, leading the target: aim at where the
  // plane WILL be after the shell's travel time (dist / SHELL_SPEED), then add a
  // distance-scaled random scatter so shots aren't pin-accurate.
  function fireShell(t, targetPos, targetVel) {
    const g = t.group;
    _muzzle.set(g.position.x, g.position.y + MUZZLE_Y, g.position.z);
    const dist = _muzzle.distanceTo(targetPos);
    const lead = dist / SHELL_SPEED;
    _aim.copy(targetVel).multiplyScalar(lead).add(targetPos);          // predicted position
    const spread = AIM_NOISE * dist;                                   // scatter grows with range
    _aim.x += (Math.random() - 0.5) * 2 * spread;
    _aim.y += (Math.random() - 0.5) * 2 * spread;
    _aim.z += (Math.random() - 0.5) * 2 * spread;
    _dir.copy(_aim).sub(_muzzle).normalize();
    const mesh = new THREE.Mesh(shellGeo, shellMat);
    mesh.position.copy(_muzzle);
    scene.add(mesh);
    shells.push({ mesh, vel: _dir.clone().multiplyScalar(SHELL_SPEED), life: SHELL_LIFE });
    if (audio) audio.tankGun(dist);                                    // boom, attenuated by range
  }

  return {
    tanks,
    refreshObstacles: refresh,   // re-scan obstacles + replan tanks (call once the city exists)
    // Threat bearings for the cockpit ring: normalised horizontal directions
    // (dx,dz) from the plane toward each nearby tank, plus each inbound shell
    // (flagged `incoming`). Directions point at where the danger is.
    getThreats(planePos, radius = 600) {
      const out = [];
      const r2 = radius * radius;
      for (const t of tanks) {
        const p = t.group.position;
        const dx = p.x - planePos.x, dz = p.z - planePos.z;
        if (dx * dx + dz * dz > r2) continue;
        const inv = 1 / Math.max(1e-3, Math.hypot(dx, dz));
        out.push({ dx: dx * inv, dz: dz * inv, incoming: false });
      }
      for (const s of shells) {
        const sp = s.mesh.position;
        const dx = planePos.x - sp.x, dy = planePos.y - sp.y, dz = planePos.z - sp.z;
        if (s.vel.x * dx + s.vel.y * dy + s.vel.z * dz <= 0) continue;   // shell moving away → no threat
        const inv = 1 / Math.max(1e-3, Math.hypot(dx, dz));
        out.push({ dx: -dx * inv, dz: -dz * inv, incoming: true });      // point toward the oncoming shell
      }
      return out;
    },
    // Destroy the nearest tank within `radius` of `point`; returns true on a hit.
    tryHit(point, radius = TANK_HIT_R) {
      for (let i = 0; i < tanks.length; i++) {
        const p = tanks[i].group.position;
        const dx = p.x - point.x, dy = p.y + TANK_CENTRE_Y - point.y, dz = p.z - point.z;
        if (dx * dx + dy * dy + dz * dz <= radius * radius) {
          wreckTank(tanks[i]);     // blast + flying turret + burning hull (kept in scene)
          tanks.splice(i, 1);
          return true;
        }
      }
      return false;
    },
    update(dt, targetPos, targetVel, camera = null, night = 0) {
      clock += dt;
      if (targetPos) lastTarget = targetPos;   // remember plane pos for death-blast distance

      // --- keep MIN..MAX tanks on the field, respawning away from the plane
      //     (quickly while below the minimum, slowly while topping up to the max) ---
      respawnTimer -= dt;
      if (template && tanks.length < MAX_TANKS) {
        if (tanks.length < MIN_TANKS && respawnTimer > RESPAWN_FAST) respawnTimer = RESPAWN_FAST;
        if (respawnTimer <= 0) {
          const spot = findSpawnCell(targetPos);
          if (spot) addTank(spot.x, spot.z, Math.random() * Math.PI * 2);
          respawnTimer = spot ? (tanks.length < MIN_TANKS ? RESPAWN_FAST : RESPAWN_SLOW) : 1;
        }
      } else {
        respawnTimer = RESPAWN_SLOW;   // at max: arm the delay so the next loss waits a beat
      }

      // --- drive each tank along its planned route (replanning when it finishes) ---
      for (const t of tanks) {
        const g = t.group;
        const x = g.position.x, z = g.position.z;

        // finished the route (or boxed in)? switch mission and plan the next leg.
        t.wait -= dt;
        if ((!t.path || t.pathIdx >= t.path.length) && t.wait <= 0) {
          t.mission = t.mission === 'beach' ? 'interior' : 'beach';
          t.path = planPath(x, z, t.mission); t.pathIdx = 0;
          if (!t.path) t.wait = 0.6;
        }

        // follow the path: aim at the current node, advance when we reach it.
        let desired = t.heading, moving = false;
        if (t.path && t.pathIdx < t.path.length) {
          if (Math.hypot(t.path[t.pathIdx].x - x, t.path[t.pathIdx].z - z) < ARRIVE_DIST) t.pathIdx++;
          if (t.pathIdx < t.path.length) {
            desired = Math.atan2(t.path[t.pathIdx].x - x, t.path[t.pathIdx].z - z);
            moving = true;
          }
        }

        // steer toward the desired heading at a limited rate (shortest way round)
        let d = Math.atan2(Math.sin(desired - t.heading), Math.cos(desired - t.heading));
        t.heading += THREE.MathUtils.clamp(d, -TURN_RATE * dt, TURN_RATE * dt);

        // ramp speed toward the target (ease off in sharp turns; stop when idle)
        const turnEase = 1 - Math.min(1, Math.abs(d) / 1.2) * 0.6;
        const target = moving ? DRIVE_SPEED * turnEase : 0;
        t.speed += THREE.MathUtils.clamp(target - t.speed, -ACCEL * dt, ACCEL * dt);

        // advance along the heading (model forward is +Z) and sit on the terrain
        const step = t.speed * dt;
        g.position.x += Math.sin(t.heading) * step;
        g.position.z += Math.cos(t.heading) * step;
        g.position.y = heightAt(g.position.x, g.position.z);

        // --- conform the hull to the ground: align local +Y to the terrain normal,
        //     keep +Z pointing along the heading. Slerp so crests/dips read smoothly.
        const nx = g.position.x, nz = g.position.z, dd = TANK_LEN * 0.4;
        _up.set(heightAt(nx - dd, nz) - heightAt(nx + dd, nz),
                2 * dd,
                heightAt(nx, nz - dd) - heightAt(nx, nz + dd)).normalize();
        _fwd.set(Math.sin(t.heading), 0, Math.cos(t.heading));
        _right.crossVectors(_up, _fwd).normalize();
        _fwd.crossVectors(_right, _up).normalize();
        _basis.makeBasis(_right, _up, _fwd);
        _q.setFromRotationMatrix(_basis);
        g.quaternion.slerp(_q, Math.min(1, TILT_RATE * dt));

        // --- turret tracks the plane (yaw only, about the hull's up), slewing smoothly ---
        if (targetPos) {
          const aim = Math.atan2(targetPos.x - g.position.x, targetPos.z - g.position.z);
          let local = Math.atan2(Math.sin(aim - t.heading + TURRET_FIX), Math.cos(aim - t.heading + TURRET_FIX));
          let dy = Math.atan2(Math.sin(local - t.turret.rotation.y), Math.cos(local - t.turret.rotation.y));
          t.turret.rotation.y += THREE.MathUtils.clamp(dy, -TURRET_TRACK * dt, TURRET_TRACK * dt);
        }

        // --- line of sight: re-check periodically, remember when last seen ---
        if (targetPos) {
          t.losTimer -= dt;
          if (t.losTimer <= 0) {
            t.losTimer = LOS_INTERVAL;
            if (hasLOS(g.position.x, g.position.y + MUZZLE_Y, g.position.z, targetPos)) t.lastSeen = clock;
          }
        }

        // --- fire a leading shell: in range, reloaded, and seen within LOS_MEMORY ---
        t.cooldown -= dt;
        if (targetPos && targetVel && t.cooldown <= 0
            && (clock - t.lastSeen) <= LOS_MEMORY
            && g.position.distanceTo(targetPos) < FIRE_RANGE) {
          fireShell(t, targetPos, targetVel);
          t.cooldown = FIRE_INTERVAL * (0.7 + Math.random() * 0.6);
        }
      }

      // --- advance shells: straight-line travel; a shell that passes within
      //     PLANE_HIT_R of the plane hits it (returned so main.js can crash). ---
      let playerHit = false;
      let nearMiss = 0;   // strongest close-pass intensity this frame (0..1), for camera shake
      for (let i = shells.length - 1; i >= 0; i--) {
        const s = shells[i];
        s.mesh.position.addScaledVector(s.vel, dt);
        s.life -= dt;
        let dead = s.life <= 0;
        const toPlane = targetPos ? s.mesh.position.distanceTo(targetPos) : Infinity;
        // sustained fly-by: a whoosh that builds as the shell nears and dopplers
        // with the closing speed. Spin up a voice on entry, update it each frame,
        // tear it down when the shell leaves the radius (or dies, below).
        if (audio && targetPos && toPlane < WHOOSH_R) {
          if (!s.whoosh) s.whoosh = audio.whoosh();
          if (s.whoosh) {
            // closing speed = rate the gap shrinks = relative velocity projected
            // onto the shell→plane line (positive when approaching → pitch up)
            const ux = (targetPos.x - s.mesh.position.x) / toPlane;
            const uy = (targetPos.y - s.mesh.position.y) / toPlane;
            const uz = (targetPos.z - s.mesh.position.z) / toPlane;
            const vx = s.vel.x - (targetVel ? targetVel.x : 0);
            const vy = s.vel.y - (targetVel ? targetVel.y : 0);
            const vz = s.vel.z - (targetVel ? targetVel.z : 0);
            const closing = vx * ux + vy * uy + vz * uz;
            s.whoosh.set(toPlane, closing, WHOOSH_R);
            // closest approach = closing flips approaching→receding → snap a crack,
            // gated to genuinely close passes (intensity 0 beyond CRACK_R) and to a
            // every close pass cracks/whizzes (volume scales with how close it is)
            if (s.prevClosing > 0 && closing <= 0) {
              const intensity = 1 - toPlane / CRACK_R;
              audio.crack(intensity);
              if (intensity > nearMiss) nearMiss = intensity;   // closest pass drives the shake
            }
            s.prevClosing = closing;
          }
        } else if (s.whoosh) { s.whoosh.stop(); s.whoosh = null; }
        if (!dead && toPlane < PLANE_HIT_R) {
          spawnExplosion(s.mesh.position); playerHit = true; dead = true;
        }
        if (!dead && s.mesh.position.y < heightAt(s.mesh.position.x, s.mesh.position.z)) dead = true;
        if (dead) { if (s.whoosh) s.whoosh.stop(); scene.remove(s.mesh); shells.splice(i, 1); }
      }

      // --- advance explosions ---
      for (let i = fx.length - 1; i >= 0; i--) {
        const e = fx[i];
        e.age += dt;
        const k = e.age / e.ttl;
        e.mesh.scale.setScalar((2 + k * 14) * e.scale);
        e.mesh.material.opacity = 1 - k;
        if (k >= 1) { scene.remove(e.mesh); e.mesh.material.dispose(); fx.splice(i, 1); }
      }

      // --- burning wrecks: tumble the flying turret, emit fire, retire off-screen ---
      if (wrecks.length && camera) {
        _frMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _frustum.setFromProjectionMatrix(_frMat);
      }
      for (let i = wrecks.length - 1; i >= 0; i--) {
        const w = wrecks[i];
        w.age += dt;

        // turret physics: gravity, spin, bounce + settle on the terrain
        const tp = w.turret.position;
        if (!w.landed) {
          w.tVel.y += FX_GRAVITY * dt;
          tp.addScaledVector(w.tVel, dt);
          w.turret.rotation.x += w.tSpin.x * dt;
          w.turret.rotation.y += w.tSpin.y * dt;
          w.turret.rotation.z += w.tSpin.z * dt;
          const restY = heightAt(tp.x, tp.z) + 1.2;
          if (tp.y <= restY) {
            tp.y = restY;
            w.tVel.y *= -0.35; w.tVel.x *= 0.6; w.tVel.z *= 0.6;   // damped bounce
            w.tSpin.multiplyScalar(0.5);
            if (Math.abs(w.tVel.y) < 2.5) { w.tVel.set(0, 0, 0); w.tSpin.set(0, 0, 0); w.landed = true; }
          }
        }

        // emit flame/smoke from the hull (thins out as it burns down)
        w.emit -= dt;
        if (w.emit <= 0) {
          w.emit = 0.04;
          const hp = w.hull.position;
          spawnFire(hp.x, hp.y + TANK_CENTRE_Y, hp.z);
          if (w.age > WRECK_LIFE * 0.4 && Math.random() < 0.5) spawnFire(tp.x, tp.y, tp.z);  // turret smokes too
        }

        // flickering firelight: brightest at night, fading over the last seconds
        w.flicker += dt * 11;
        const fade = 1 - THREE.MathUtils.clamp((w.age - (WRECK_MAX - 4)) / 4, 0, 1);   // ease off near the end
        const flick = 0.62 + 0.22 * Math.sin(w.flicker) + 0.16 * Math.random();
        w.light.intensity = (9 + night * 42) * flick * fade;   // mostly reads after dark

        // retire: past its burn time and out of view, or past the hard cap
        const onScreen = camera ? _frustum.containsPoint(w.hull.position) : true;
        if ((w.age > WRECK_LIFE && !onScreen) || w.age > WRECK_MAX) {
          scene.remove(w.hull); scene.remove(w.turret); scene.remove(w.light);
          wrecks.splice(i, 1);
        }
      }

      // --- advance flame / smoke puffs ---
      for (let i = fire.length - 1; i >= 0; i--) {
        const f = fire[i];
        f.age += dt;
        const k = f.age / f.ttl;
        f.mesh.position.y += f.vy * dt;
        f.vy *= (1 - dt * 0.8);                       // slow as it rises
        f.mesh.scale.addScalar(f.grow * dt);
        f.mesh.material.opacity *= (1 - dt * 1.6);
        if (k >= 1) { scene.remove(f.mesh); f.mesh.material.dispose(); fire.splice(i, 1); }
      }

      return { hit: playerHit, nearMiss };
    },
  };
}
