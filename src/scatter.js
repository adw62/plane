import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// ===========================================================================
// Procedural placement system.
//
//   1. buildGrid()        — scan the island on a grid, recording height, slope
//                           and terrain type at every point.
//   2. grid.buildableAt() — rule used by the city to decide where towns go.
//   3. scatter()          — populate the grid with instanced trees & rocks
//                           according to per-type rules.
//
// One terrain analysis drives everything; placers are just predicates + density.
// ===========================================================================

export const TYPE = { WATER: 0, BEACH: 1, GRASS: 2, ROCK: 3, SNOW: 4 };

// ---------------------------------------------------------------------------
// The data layer: a regular grid of terrain samples.
// ---------------------------------------------------------------------------
export function buildGrid(heightAt, o) {
  const { step, extent } = o;
  const minX = -extent, minZ = -extent;
  const cols = Math.ceil((extent * 2) / step) + 1;
  const rows = cols;
  const height = new Float32Array(cols * rows);
  const slope = new Float32Array(cols * rows);
  const type = new Uint8Array(cols * rows);
  const s = step;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = minX + i * step, z = minZ + j * step;
      const h = heightAt(x, z);
      const gx = (heightAt(x + s, z) - heightAt(x - s, z)) / (2 * s);
      const gz = (heightAt(x, z + s) - heightAt(x, z - s)) / (2 * s);
      const sl = Math.hypot(gx, gz);            // rise/run gradient (0 flat → ~1 steep)
      const k = j * cols + i;
      height[k] = h; slope[k] = sl;

      let t;
      if (h < o.waterH) t = TYPE.WATER;
      else if (h < o.beachTop) t = TYPE.BEACH;
      else if (sl > o.rockSlope) t = TYPE.ROCK;
      else if (h > o.snowH) t = TYPE.SNOW;
      else t = TYPE.GRASS;
      type[k] = t;
    }
  }

  const idx = (x, z) => {
    const i = Math.round((x - minX) / step), j = Math.round((z - minZ) / step);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return -1;
    return j * cols + i;
  };

  return {
    step, minX, minZ, cols, rows, height, slope, type, opts: o,
    at(x, z) { const k = idx(x, z); return k < 0 ? null : { h: height[k], slope: slope[k], type: type[k] }; },
    // building rule: flat grass, above the beach, below the high slopes
    buildableAt(x, z) {
      const k = idx(x, z);
      if (k < 0) return false;
      return type[k] === TYPE.GRASS && slope[k] < o.buildSlope &&
             height[k] >= o.buildMinH && height[k] <= o.buildMaxH;
    },
  };
}

// ---------------------------------------------------------------------------
// Placeholder asset geometry (no external assets needed).
// ---------------------------------------------------------------------------
function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function makeTreeGeo() {
  const trunk = paint(new THREE.CylinderGeometry(0.5, 0.8, 4, 5).translate(0, 2, 0), 0x6b4a2b);
  const lowerFoliage = paint(new THREE.ConeGeometry(3.0, 6, 7).translate(0, 6.5, 0), 0x2f6b35);
  const upperFoliage = paint(new THREE.ConeGeometry(2.1, 5, 7).translate(0, 10, 0), 0x3a7d40);
  return mergeGeometries([trunk, lowerFoliage, upperFoliage], false);
}

function makeRockGeo() {
  // Detail 1 gives more facets; weld the duplicate vertices so the mesh is a
  // single watertight shell. (Icosahedron/Polyhedron geometry is non-indexed —
  // each face owns its own copy of every vertex, so displacing the raw position
  // array tears shared edges apart and leaves gaps.) mergeVertices compares ALL
  // attributes, and the source has per-face normals + seam UVs that differ at
  // shared corners, so those wouldn't weld — strip them first so welding is
  // decided by position alone, giving a truly watertight shell.
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {                 // each unique vertex moved once
    v.fromBufferAttribute(p, i).normalize();
    const r = 0.78 + Math.random() * 0.34;            // per-vertex radius jitter
    p.setXYZ(i, v.x * r, v.y * (r * 0.85), v.z * r);  // squash a touch on Y
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return paint(g, 0x807a72);
}

// ---------------------------------------------------------------------------
// The render layer: scatter instanced trees & rocks per terrain rules.
// ---------------------------------------------------------------------------
export function scatter(scene, grid, heightAt, o) {
  const noise = new ImprovedNoise();
  const fertility = (x, z) => noise.noise(x * 0.008, z * 0.008, 4.2) * 0.5 + 0.5;   // forest clumps

  const UP = new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const treeM = [], rockM = [];
  const { step, cols, rows, minX, minZ, type, slope, height } = grid;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const x = minX + i * step, z = minZ + j * step;
      const t = type[k];

      // trees: grass below the treeline, not too steep, not on town flats; clumped
      if (t === TYPE.GRASS && height[k] < o.treeline && slope[k] < o.treeSlope && !grid.buildableAt(x, z)) {
        let n = Math.random() < o.treeDensity * fertility(x, z) ? 1 : 0;
        if (n && Math.random() < 0.4) n = 2;
        for (let c = 0; c < n; c++) {
          const jx = x + (Math.random() - 0.5) * step, jz = z + (Math.random() - 0.5) * step;
          const h = heightAt(jx, jz);
          if (h < o.beachTop) continue;
          const sc = 0.7 + Math.random() * 0.9;
          const yScale = sc * (0.9 + Math.random() * 0.4);
          q.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
          pos.set(jx, h, jz); scl.set(sc, yScale, sc);
          treeM.push(m.clone().compose(pos, q, scl));
        }
      }
    }
  }

  // rocks: simulate boulder outcrops shedding smaller rocks that roll downhill,
  // then relax so they don't overlap (see simulateRocks).
  const eu = new THREE.Euler();
  for (const r of simulateRocks(grid, heightAt, o)) {
    if (r.h < o.waterH) continue;                    // nudged into the sea during relax
    const sc = r.size;
    // bigger rocks tilt with the slope (so half-buried boulders lean into the
    // hill); small ones tumble to a random rest pose.
    eu.set((Math.random() - 0.5) * 1.2, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 1.2);
    q.setFromEuler(eu);
    pos.set(r.x, r.h - sc * r.bury, r.z);            // sink it into the ground
    scl.set(sc, sc * (0.6 + Math.random() * 0.5), sc);
    rockM.push(m.clone().compose(pos, q, scl));
  }

  addInstances(scene, makeTreeGeo(), treeM);
  addInstances(scene, makeRockGeo(), rockM, true, o.snowH);   // rocks: flat-shaded, snow-capped up high
  return { treeCollisionGeo: makeTreeCollisionGeo(treeM) };
}

// ---------------------------------------------------------------------------
// Rock simulation. Two ideas:
//   1. Boulder outcrops — large rocks half-buried in steep/rocky ground, the
//      "exposed bedrock" that sheds debris. They're the concentrated sources.
//   2. Shed rocks — each boulder spits out smaller rocks that ROLL downhill
//      (step along the negative height gradient) until the slope flattens, so
//      debris collects below outcrops and in gullies.
// Finally a relaxation pass pushes overlapping rocks apart (they don't like to
// share space), using a uniform grid so it stays cheap.
// ---------------------------------------------------------------------------
function simulateRocks(grid, heightAt, o) {
  const { step, cols, rows, minX, minZ, type, slope, height } = grid;
  const rocks = [];                       // { x, z, h, size, bury }

  const eps = 2.0;
  const gradAt = (x, z) => {
    const gx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps);
    const gz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps);
    return [gx, gz, Math.hypot(gx, gz)];
  };

  // roll a pebble downhill from (x,z); returns its resting spot, or null if it
  // tumbled into the sea.
  const rollDown = (x, z) => {
    for (let s = 0; s < o.rockRollSteps; s++) {
      const [gx, gz, sl] = gradAt(x, z);
      if (sl < o.rockRest) break;                    // shallow enough → it settles
      let dx = -gx / sl, dz = -gz / sl;              // downhill unit vector
      const a = (Math.random() - 0.5) * 0.7;         // wobble so paths fan out
      const c = Math.cos(a), sn = Math.sin(a);
      [dx, dz] = [dx * c - dz * sn, dx * sn + dz * c];
      x += dx * o.rockRollStep; z += dz * o.rockRollStep;
      if (heightAt(x, z) < o.waterH) return null;
    }
    return { x, z };
  };

  // 1 + 2: seed boulders on rocky/steep ground; shed children that roll.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const rocky = type[k] === TYPE.ROCK || slope[k] > o.rockSlope * 0.8;
      if (!rocky || height[k] < o.waterH) continue;
      if (Math.random() > o.boulderDensity) continue;

      const x = minX + i * step + (Math.random() - 0.5) * step;
      const z = minZ + j * step + (Math.random() - 0.5) * step;
      const bh = heightAt(x, z);
      if (bh < o.waterH) continue;

      const size = 5 + Math.random() * 7;            // big source boulder
      rocks.push({ x, z, h: bh, size, bury: 0.55 });

      const n = 3 + (Math.random() * 7 | 0);         // debris it sheds
      for (let c = 0; c < n; c++) {
        const sx = x + (Math.random() - 0.5) * size * 1.5;
        const sz = z + (Math.random() - 0.5) * size * 1.5;
        const landed = rollDown(sx, sz);
        if (!landed) continue;
        const lh = heightAt(landed.x, landed.z);
        if (lh < o.waterH) continue;
        rocks.push({ x: landed.x, z: landed.z, h: lh, size: 1 + Math.random() * 3, bury: 0.3 });
      }
    }
  }

  // background layer: a random scattering of loose rocks independent of the
  // outcrops, so the ground has rocks everywhere and the boulder fields read as
  // denser concentrations on top of it.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (height[k] < o.waterH) continue;
      let p = 0;
      if (type[k] === TYPE.ROCK || slope[k] > o.rockSlope * 0.7) p = o.rockScatterDensity;
      else if (type[k] === TYPE.GRASS) p = o.rockScatterDensity * 0.12;
      if (Math.random() > p) continue;
      const x = minX + i * step + (Math.random() - 0.5) * step;
      const z = minZ + j * step + (Math.random() - 0.5) * step;
      const h = heightAt(x, z);
      if (h < o.waterH) continue;
      rocks.push({ x, z, h, size: 1.2 + Math.random() * 3.5, bury: 0.3 });
    }
  }

  // relaxation: rocks repel so they don't occupy the same space. Uniform-grid
  // neighbour lookup keeps it ~O(n) per iteration.
  const cell = 10, key = (ci, cj) => ci + ',' + cj;
  for (let iter = 0; iter < o.rockRelax; iter++) {
    const map = new Map();
    for (let idx = 0; idx < rocks.length; idx++) {
      const r = rocks[idx], ci = Math.floor(r.x / cell), cj = Math.floor(r.z / cell);
      const kk = key(ci, cj); let arr = map.get(kk); if (!arr) { arr = []; map.set(kk, arr); }
      arr.push(idx);
    }
    for (let idx = 0; idx < rocks.length; idx++) {
      const r = rocks[idx], ci = Math.floor(r.x / cell), cj = Math.floor(r.z / cell);
      for (let nj = cj - 1; nj <= cj + 1; nj++) for (let ni = ci - 1; ni <= ci + 1; ni++) {
        const arr = map.get(key(ni, nj)); if (!arr) continue;
        for (const jdx of arr) {
          if (jdx <= idx) continue;
          const s = rocks[jdx];
          const dx = r.x - s.x, dz = r.z - s.z, d2 = dx * dx + dz * dz;
          const min = (r.size + s.size) * 0.5 * o.rockSpacing;
          if (d2 < min * min && d2 > 1e-4) {
            const d = Math.sqrt(d2), push = (min - d) * 0.5, nx = dx / d, nz = dz / d;
            r.x += nx * push; r.z += nz * push;       // shove the pair apart
            s.x -= nx * push; s.z -= nz * push;
          }
        }
      }
    }
    for (const r of rocks) r.h = heightAt(r.x, r.z);  // re-settle onto the terrain
  }
  return rocks;
}

// Low-poly cone (the canopy) baked once per tree into a single world-space
// geometry — a cheap stand-in for the full tree mesh, for BVH collision.
function makeTreeCollisionGeo(matrices) {
  if (!matrices.length) return null;
  const proxy = new THREE.ConeGeometry(2.8, 9, 6).translate(0, 8, 0).toNonIndexed();   // spans y 3.5..12.5
  const p = proxy.attributes.position, n = p.count;
  const out = new Float32Array(matrices.length * n * 3);
  const v = new THREE.Vector3();
  let o = 0;
  for (const mtx of matrices) {
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mtx);
      out[o++] = v.x; out[o++] = v.y; out[o++] = v.z;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

function addInstances(scene, geo, matrices, flatShading = false, snowH = null) {
  if (!matrices.length) return;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading });
  if (snowH != null) addSnowCaps(mat, snowH);
  const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;          // instances span the whole island
  scene.add(mesh);
}

// Snow-cap an instanced material: blend the diffuse toward white on upward-facing
// surfaces of instances sitting above the snow line. World height & normal are
// derived from the per-instance matrix.
function addSnowCaps(mat, snowH) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vSnowY;\nvarying vec3 vSnowN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec4 _wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vSnowN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        #else
          vec4 _wp = modelMatrix * vec4(position, 1.0);
          vSnowN = normalize(mat3(modelMatrix) * normal);
        #endif
        vSnowY = _wp.y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSnowY;\nvarying vec3 vSnowN;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float _up = smoothstep(0.25, 0.6, vSnowN.y);                       // up-facing only
        float _band = smoothstep(${(snowH - 20).toFixed(1)}, ${(snowH + 15).toFixed(1)}, vSnowY);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), _up * _band);`);
  };
}
