import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// ===========================================================================
// Environment: three.js physical Sky for the atmosphere + a visible sun disc,
// with the cities.obj Gaussian-splat clouds up close. A single sun elevation
// drives everything, so the sky and the clouds always share the same tint.
// update(dt) advances the day/night cycle and returns the 0..1 "night" factor
// used to switch the city windows on.
// ===========================================================================

const DAY_LENGTH = 300;        // seconds for a full day↔night cycle
// Sun-height shaping: the raw sin() is lifted + shrunk so the trough sits near
// the horizon — a short, shallow night, and the sun's slow-moving low region
// lingers around the horizon for long golden sunrises/sunsets.
const SUN_AMP  = 0.72;        // < 1 → shallower swing
const SUN_LIFT = 0.36;        // > 0 → raises the curve (shorter night)
const CLOUD_COUNT = 20;        // number of cloud blobs (each ~200 splats)
const CLOUD_SPREAD = 1300;     // half-extent clouds are scattered over (around the city)
const CLOUD_LO = 95, CLOUD_HI = 220;   // low enough to fly through near the towers

// palette for the shared tint
const DAY_SKYCOL    = new THREE.Color(0x9fc6e8);
const SUNSET_SKYCOL = new THREE.Color(0xe2865a);
const NIGHT_SKYCOL  = new THREE.Color(0x0a0f1e);
const DAY_SUN  = new THREE.Color(0xfff4e6);
const LOW_SUN  = new THREE.Color(0xff8a4c);
const WARM_CLOUD = new THREE.Color(1.0, 0.55, 0.30);
const WHITE = new THREE.Color(1, 1, 1);

// ── Gaussian splat clouds (from the cities.obj viewer) ─────────────────────
function _makeGaussTex(sigma = 0.42) {
  const S = 128, h = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - h) / h, dy = (y - h) / h;
      const a = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

function _cloudGraph(n) {
  const nodes = Array.from({ length: n }, () => new THREE.Vector3(
    (Math.random() - 0.5) * 100, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 70));
  const edges = [], inTree = new Set([0]);
  while (inTree.size < n) {
    let best = null, bestDist = Infinity;
    for (const a of inTree) for (let b = 0; b < n; b++) {
      if (inTree.has(b)) continue;
      const d = nodes[a].distanceTo(nodes[b]);
      if (d < bestDist) { bestDist = d; best = [a, b]; }
    }
    edges.push(best); inTree.add(best[1]);
  }
  const extras = 1 + Math.floor(Math.random() * 3);
  for (let e = 0; e < extras; e++) {
    const a = Math.floor(Math.random() * n);
    let b = Math.floor(Math.random() * (n - 1)); if (b >= a) b++;
    if (!edges.some(([ea, eb]) => (ea === a && eb === b) || (ea === b && eb === a))) edges.push([a, b]);
  }
  return { nodes, edges };
}

function _layoutGraph(nodes, edges) {
  const n = nodes.length, vel = nodes.map(() => new THREE.Vector3()), f = nodes.map(() => new THREE.Vector3()), tmp = new THREE.Vector3();
  for (let iter = 0; iter < 200; iter++) {
    for (const fi of f) fi.set(0, 0, 0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      tmp.subVectors(nodes[i], nodes[j]);
      const dist = Math.max(tmp.length(), 0.5), mag = 2200 / (dist * dist);
      tmp.normalize().multiplyScalar(mag); f[i].add(tmp); f[j].sub(tmp);
    }
    for (const [a, b] of edges) {
      tmp.subVectors(nodes[b], nodes[a]);
      const mag = 0.09 * (tmp.length() - 55);
      tmp.normalize().multiplyScalar(mag); f[a].add(tmp); f[b].sub(tmp);
    }
    for (let i = 0; i < n; i++) { vel[i].addScaledVector(f[i], 0.1).multiplyScalar(0.87); nodes[i].add(vel[i]); }
  }
  for (const p of nodes) p.y *= 0.48;
}

function _cloudBeads(nodes, edges) {
  const SC = 3, beads = [];
  for (const p of nodes) {
    const r = (18 + Math.random() * 12) * SC;
    beads.push({ center: p.clone(), radius: r });
    if (Math.random() > 0.35) {
      const jit = new THREE.Vector3((Math.random() - .5) * r * .7, (Math.random() - .5) * r * .35, (Math.random() - .5) * r * .7);
      beads.push({ center: p.clone().add(jit), radius: r * (0.45 + Math.random() * 0.4) });
    }
  }
  for (const [a, b] of edges) {
    const pa = nodes[a], pb = nodes[b], dist = pa.distanceTo(pb);
    const steps = Math.max(1, Math.floor(dist / (12 * SC)));
    const ra = beads.find(bd => bd.center.equals(pa))?.radius ?? 20 * SC;
    const rb = beads.find(bd => bd.center.equals(pb))?.radius ?? 20 * SC;
    for (let i = 1; i < steps; i++) {
      const t = i / steps, r = THREE.MathUtils.lerp(ra, rb, t) * (0.5 + Math.random() * 0.35);
      const jit = new THREE.Vector3((Math.random() - .5) * 21, (Math.random() - .5) * 12, (Math.random() - .5) * 21);
      beads.push({ center: pa.clone().lerp(pb, t).add(jit), radius: r });
    }
  }
  return beads;
}

function _sampleSphere(center, radius, out) {
  let x, y, z;
  do { x = (Math.random() * 2 - 1) * radius; y = (Math.random() * 2 - 1) * radius; z = (Math.random() * 2 - 1) * radius; }
  while (x * x + y * y + z * z > radius * radius);
  return out.set(center.x + x, center.y + y, center.z + z);
}

function _buildCloud(scene, GAUSS_TEX, cx, cy, cz) {
  const { nodes, edges } = _cloudGraph(5 + Math.floor(Math.random() * 4));
  _layoutGraph(nodes, edges);
  const offset = new THREE.Vector3(cx, cy, cz);
  for (const p of nodes) p.add(offset);
  const beads = _cloudBeads(nodes, edges);
  const totalVol = beads.reduce((s, b) => s + b.radius ** 3, 0);
  const pos = new THREE.Vector3(), splats = [];
  const numSplats = 180 + Math.floor(Math.random() * 80);
  for (let i = 0; i < numSplats; i++) {
    let pick = Math.random() * totalVol, bead;
    for (bead of beads) { pick -= bead.radius ** 3; if (pick <= 0) break; }
    _sampleSphere(bead.center, bead.radius, pos);
    const baseW = (8 + Math.random() * 17) * 3;
    const aspect = 0.45 + Math.random() * 1.05;
    const opac = 0.038 + Math.random() * 0.105;
    const heightT = (pos.y - cy + 50) / 100;
    const bright = 0.84 + Math.random() * 0.16 + heightT * 0.04;
    const blueShft = Math.random() * 0.06;
    const mat = new THREE.SpriteMaterial({
      map: GAUSS_TEX, transparent: true, depthWrite: false, opacity: opac, fog: false,
      color: new THREE.Color(Math.min(1, bright), Math.min(1, bright), Math.min(1, bright + blueShft)),
    });
    mat.rotation = Math.random() * Math.PI;
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    sprite.scale.set(baseW, baseW * aspect, 1);
    scene.add(sprite);
    splats.push({ mat, bright, blueShft });
  }
  return splats;
}

// ===========================================================================
export function buildSky(scene, camera) {
  // --- atmospheric sky dome -------------------------------------------------
  const sky = new Sky();
  sky.scale.setScalar(4500);            // fit inside the camera far-plane
  sky.material.depthWrite = false;
  sky.renderOrder = -1;                 // always draw behind the world
  scene.add(sky);
  const su = sky.material.uniforms;
  su.turbidity.value = 5;
  su.rayleigh.value = 2.0;
  su.mieCoefficient.value = 0.005;
  su.mieDirectionalG.value = 0.8;
  // enlarge the Sky's built-in sun disc ~3× (its angular size is a constant in
  // the shader). cos(3 × 0.00931 rad) ≈ 0.99961.
  sky.material.fragmentShader = sky.material.fragmentShader.replace(
    /const float sunAngularDiameterCos = [0-9.]+;/,
    'const float sunAngularDiameterCos = 0.99961;'
  );
  sky.material.needsUpdate = true;

  // --- lights ---------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.6);
  scene.add(sunLight);
  const hemi = new THREE.HemisphereLight(0xbfd6ef, 0x4a5440, 0.9);
  scene.add(hemi);
  const nightAmbient = new THREE.AmbientLight(0x6678a0, 0.0);   // moonlit fill
  scene.add(nightAmbient);

  // (the visible sun is the Sky shader's own enlarged disc — no separate sphere)

  // --- stars ----------------------------------------------------------------
  const starN = 2500, starPos = new Float32Array(starN * 3);
  for (let i = 0; i < starN; i++) {
    const theta = Math.random() * Math.PI * 2, phi = Math.acos(2 * Math.random() - 1), r = 4200;
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = Math.abs(r * Math.cos(phi));
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.0, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  // --- clouds ---------------------------------------------------------------
  const GAUSS_TEX = _makeGaussTex();
  const cloudSplats = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const cx = (Math.random() - 0.5) * 2 * CLOUD_SPREAD;
    const cz = (Math.random() - 0.5) * 2 * CLOUD_SPREAD;
    const cy = CLOUD_LO + Math.random() * (CLOUD_HI - CLOUD_LO);
    cloudSplats.push(..._buildCloud(scene, GAUSS_TEX, cx, cy, cz));
  }

  // --- reusable temporaries -------------------------------------------------
  const sunVec = new THREE.Vector3();
  const horiz = new THREE.Color();
  const warm = new THREE.Color();
  let t = DAY_LENGTH * 0.25;            // midday
  let cycle = true;                     // day/night cycle runs by default; T toggles it

  function update(dt) {
    if (cycle) t += dt;
    const day = (t / DAY_LENGTH) * Math.PI * 2;
    // lifted + shrunk sine → short shallow night, long lingering dawn/dusk
    const elevation = THREE.MathUtils.clamp(Math.sin(day) * SUN_AMP + SUN_LIFT, -1, 1);
    const dayAmount = THREE.MathUtils.smoothstep(elevation, -0.12, 0.28);
    const night = 1 - THREE.MathUtils.smoothstep(elevation, -0.06, 0.14);
    const sunset = Math.exp(-(elevation * elevation) / (0.34 * 0.34));   // horizon glow (wider = longer sunset)

    // one sun direction drives the Sky and the light
    const elevAngle = elevation * Math.PI / 2;
    sunVec.setFromSphericalCoords(1, Math.PI / 2 - elevAngle, day);
    su.sunPosition.value.copy(sunVec);

    sunLight.position.copy(sunVec).multiplyScalar(1000);
    sunLight.color.copy(LOW_SUN).lerp(DAY_SUN, THREE.MathUtils.smoothstep(elevation, 0.0, 0.5));
    sunLight.intensity = 0.05 + dayAmount * 2.6;
    hemi.intensity = 0.6 + dayAmount * 0.8;          // brighter floor so night isn't black
    nightAmbient.intensity = night * 2.75;

    // shared horizon tint → fog colour (matches the sky near the ground)
    if (elevation >= 0) horiz.copy(SUNSET_SKYCOL).lerp(DAY_SKYCOL, THREE.MathUtils.smoothstep(elevation, 0.0, 0.45));
    else horiz.copy(SUNSET_SKYCOL).lerp(NIGHT_SKYCOL, THREE.MathUtils.smoothstep(-elevation, 0.0, 0.42));
    if (scene.fog) scene.fog.color.copy(horiz);

    // sky dome + stars ride the camera (effectively infinite)
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    starMat.opacity = THREE.MathUtils.clamp((-elevation - 0.05) / 0.25, 0, 1);

    // clouds share the sky's mood: warm at sunset, bright by day, dark at night
    warm.copy(WHITE).lerp(WARM_CLOUD, sunset * 0.85);
    const bMul = 0.16 + dayAmount * 0.84;
    const tr = warm.r * bMul, tg = warm.g * bMul, tb = warm.b * bMul;
    for (const { mat, bright, blueShft } of cloudSplats) {
      mat.color.setRGB(Math.min(1, bright * tr), Math.min(1, bright * tg), Math.min(1, (bright + blueShft) * tb));
    }

    return night;
  }

  return {
    update, sunLight, hemi,
    toggleCycle: () => (cycle = !cycle),     // returns new state
    scrub: (d) => { t += d; },               // jump time of day by d seconds
  };
}
