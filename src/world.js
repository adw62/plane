import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { buildGrid, scatter } from './scatter.js';

// Use the BVH-accelerated raycast for meshes that have a boundsTree (our building
// collision mesh) — lets us ray-test the whole city's geometry cheaply per frame.
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ===========================================================================
// World: a Perlin-noise island with the procedurally-generated city sitting on
// a flattened central plateau. The city geometry comes from generator.js (the
// procity Web Worker) used verbatim; we only assemble its output into meshes
// exactly the way the procity viewer does.
// ===========================================================================

// --- island / terrain shape -------------------------------------------------
const TERRAIN_SIZE  = 3400;   // full width of the terrain plane
const TERRAIN_SEGS  = 384;    // grid resolution
const ISLAND_R      = 820;    // radius where land meets the sea
const BEACH_H       = 4;      // flat beach height, just above the waterline
const FOOT_AMP      = 60;     // ridged foothill height (only inland)
const RIDGE_COUNT   = 2.4;    // base angular frequency of the volcano ridges (non-integer + noise = irregular)
const RIDGE_H       = 45;     // height of those radial ridges (kept below the volcano)
const RIDGE_REACH   = 400;    // how far the ridges spill past the volcano rim
const VOLCANO_H     = 230;    // height of the central volcano (lower)
const VOLCANO_R     = 290;    // radius of the volcano's base
const SEA_DROP      = 100;    // how far the seabed sinks beyond the shore
const CITY_ELEV     = 24;     // reference offset for the city group (cancels out per building)
const CONFORM_MAX_DROP = 16;  // fine secondary check: cull if the lot's own footprint drops more than this
const FOUND_RAISE = 1.5;      // lift every building this far above the terrain so the ground floor never dips in
const FOUND_SINK  = 8;        // how far the foundation block extends below the lot's low corner (stays buried)
const FOUND_LIP   = 0.4;      // foundation oversize past the walls, so it reads as a base ledge
const PAVE_MARGIN = 8;        // how far concrete spreads past a lot — wide enough to bridge streets between blocks
const PAVE_FEATHER = 4;       // soft edge (world units) on the painted concrete patches
const PAVE_TILE   = 18;       // world units per repeat of the concrete detail texture
const MASK_SIZE   = 512;      // terrain city-mask resolution — only soft blobs live here, so it can be low-res (detail comes from the concrete tiling texture); bump it only if you stroke thin road lines
const CONCRETE_COL = '#8f9296';
const MAGMA_R     = 34;       // radius of the lava disc in the summit crater (terrain occludes it to the basin)
const MAGMA_RISE  = 12;       // lava surface height above the crater floor

// --- city generation config (fed straight to generator.js) ------------------
const CITY_CONFIG = {
  seed: 7,
  city_width: 1100, city_depth: 1100,
  scale: 1,                    // 1 unit == 1 metre (matches the flight world)
  dist: 'gumbel',              // mostly low buildings, rare towers
  max_floors: 24,
  block_width: 45, block_depth: 45, street_width: 9,
  voronoi_boulevards: true, voronoi_sites: 16,
  num_highways: 1,
  windows_enabled: true, window_min_floors: 4,
  add_base: false,             // no base plate — it z-fights the terrain plateau
};

// --- city palette (daytime-friendly) ----------------------------------------
const COLORS = {
  base:      new THREE.Color(0x6b7280),
  road:      new THREE.Color(0x3a3f47),
  building:  new THREE.Color(0xb9c2cc),
  wall:      new THREE.Color(0xc4ccd4),
  smallwall: new THREE.Color(0xccd2d8),
  roof:      new THREE.Color(0x8a929c),
  window:    new THREE.Color(0x2f6aaa),
};
const COLOR_KEYS = ['base', 'road', 'building', 'wall', 'smallwall', 'window', 'roof'];

function colorKey(name) {
  if (name === 'base_plate') return 'base';
  if (name && (name.startsWith('boulevard') || name.startsWith('highway'))) return 'road';
  if (name && name.startsWith('roof_'))      return 'roof';
  if (name && name.startsWith('window_'))    return 'window';
  if (name && name.startsWith('smallwall_')) return 'smallwall';
  if (name && name.startsWith('wall_'))      return 'wall';
  return 'building';
}

// ---------------------------------------------------------------------------
// Terrain height field — shared by the mesh and by collision queries.
// ---------------------------------------------------------------------------
const noise = new ImprovedNoise();
const NSEED = 0;

function fbm(x, z) {
  let amp = 1, freq = 0.0028, sum = 0, norm = 0;   // higher frequency = lots of small foothills
  for (let o = 0; o < 5; o++) {
    sum += amp * noise.noise(x * freq, z * freq, NSEED);
    norm += amp;
    amp *= 0.5; freq *= 2.0;
  }
  return sum / norm;               // signed ~ -1..1
}

// Low coastal plain + foothills, with a big central volcano. The conform pass
// culls the steep volcano & foothill slopes, so the city fills the flat land
// in and around the hills.
function heightAt(x, z) {
  const d = Math.hypot(x, z);
  // warp the effective radius with noise so the coastline is irregular — water
  // cuts in to make bays and juts out into headlands rather than a clean circle.
  const warpN = noise.noise(x * 0.0026, z * 0.0026, 3.3);
  const r = d / ISLAND_R + warpN * 0.15;
  const inland = 1 - THREE.MathUtils.smoothstep(r, 0.45, 0.80);   // 1 centre → 0 at a narrow beach
  const shore = THREE.MathUtils.smoothstep(r, 0.86, 1.0);         // dip into the sea past the beach

  // flat beach everywhere; ridged foothills only grow inland
  const ridge = 1 - Math.abs(fbm(x, z));             // 0 valley floor → 1 ridge line
  let h = BEACH_H + ridge * ridge * FOOT_AMP * inland;

  // irregular ridges off the volcano flanks (also fade out toward the beach)
  const theta = Math.atan2(z, x);
  const warp = noise.noise(x * 0.004, z * 0.004, 7.0);
  const spoke = Math.pow(Math.max(0, Math.cos(theta * RIDGE_COUNT + warp * 6.0)), 4);
  const reach = THREE.MathUtils.clamp(1 - (d - VOLCANO_R) / RIDGE_REACH, 0, 1)
              * THREE.MathUtils.smoothstep(d, VOLCANO_R * 0.45, VOLCANO_R * 0.95);
  h += spoke * reach * RIDGE_H * inland;

  if (d < VOLCANO_R) {                                // central volcano cone
    const f = 1 - d / VOLCANO_R;                      // 1 centre → 0 rim
    let v = VOLCANO_H * f * f;
    const inner = THREE.MathUtils.clamp(1 - d / (VOLCANO_R * 0.16), 0, 1);
    v -= VOLCANO_H * 0.5 * inner;                     // carve a summit crater
    h += v;
  }

  return h * (1 - shore) - shore * SEA_DROP;          // drop into the sea past the beach
}

// ---------------------------------------------------------------------------
// Terrain colour: the same height-banded palette the mesh is vertex-coloured
// with, exposed as a point query so impact fx (bullet ground hits) can match
// the ground they struck. Kept as one function so mesh + query never drift.
// ---------------------------------------------------------------------------
const _tcSand   = new THREE.Color(0xcdc08a);
const _tcGrass  = new THREE.Color(0x5b8a4a);
const _tcGrassHi= new THREE.Color(0x6f9a52);
const _tcRock   = new THREE.Color(0x7d756b);
const _tcSnow   = new THREE.Color(0xeef2f5);

function terrainColorAt(x, z, out = new THREE.Color()) {
  const h = heightAt(x, z);
  // colour bands: green plain/foothills, rocky volcano flanks, snow-capped summit.
  // Bands blend with smoothstep (not hard cuts) so boundaries are soft gradients.
  const grassTop = 52;
  const rockTop = VOLCANO_H * 0.5;
  // 1) land colour: grass → rock → snow by height
  out.copy(_tcGrass).lerp(_tcGrassHi, (fbm(x + 99, z - 99) * 0.5 + 0.5));
  if (h >= grassTop) {
    const toRock = THREE.MathUtils.smoothstep(h, grassTop, rockTop);
    out.lerp(_tcRock, toRock);
    out.lerp(_tcSnow, THREE.MathUtils.smoothstep(h, rockTop, rockTop + VOLCANO_H * 0.25));
  }
  // 2) sand along the shoreline, blended over a band; jitter the height with
  //    noise so the sand line wiggles organically rather than sitting on a contour.
  const beachH = h + fbm(x - 53, z + 53) * 2.5;
  const sandT = 1 - THREE.MathUtils.smoothstep(beachH, 7, 13);   // 1 at the shore → 0 inland
  out.lerp(_tcSand, sandT);
  return out;
}

// ---------------------------------------------------------------------------
// Build terrain mesh (vertex-coloured by height) + a sea plane.
// ---------------------------------------------------------------------------
function buildTerrain(scene) {
  const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGS, TERRAIN_SEGS);
  geo.rotateX(-Math.PI / 2);                       // into the XZ plane
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, heightAt(x, z));
    terrainColorAt(x, z, c);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // --- concrete city surface: a tiling detail texture + a "city mask" canvas
  //     painted (later, once the city exists) with the concrete patches/paths.
  //     The terrain shader blends its natural colour toward concrete where the
  //     mask is set, so the paving lives in the island's surface texture rather
  //     than in extra geometry. ----------------------------------------------
  const concreteTex = makeConcreteTexture();
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = MASK_SIZE;
  const maskCtx = maskCanvas.getContext('2d');
  maskCtx.fillStyle = '#000'; maskCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);   // 0 = natural terrain
  const maskTex = new THREE.CanvasTexture(maskCanvas);
  maskTex.flipY = false;                 // match the world-XZ → uv mapping injected below
  maskTex.colorSpace = THREE.NoColorSpace;
  maskTex.generateMipmaps = false; maskTex.minFilter = THREE.LinearFilter;

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCityMask = { value: maskTex };
    shader.uniforms.uConcreteTex = { value: concreteTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCityUV;\nvarying vec2 vConcreteUV;')
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>\n  vCityUV = position.xz / ${TERRAIN_SIZE.toFixed(1)} + 0.5;\n  vConcreteUV = position.xz / ${PAVE_TILE.toFixed(1)};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform sampler2D uCityMask;\nuniform sampler2D uConcreteTex;\nvarying vec2 vCityUV;\nvarying vec2 vConcreteUV;')
      .replace('#include <color_fragment>',
        `#include <color_fragment>\n  float cityMask = texture2D(uCityMask, vCityUV).r;\n  vec3 concreteCol = texture2D(uConcreteTex, vConcreteUV).rgb;\n  diffuseColor.rgb = mix(diffuseColor.rgb, concreteCol, clamp(cityMask, 0.0, 1.0));`);
  };

  const terrain = new THREE.Mesh(geo, mat);
  scene.add(terrain);

  // shore-depth texture: water depth (0 at the waterline → 1 in deep water) over
  // the terrain extent, sampled from the height field. Drives the breaking foam.
  const FOAM_DEPTH = 24, SHN = 384;
  const shoreData = new Uint8Array(SHN * SHN);
  for (let j = 0; j < SHN; j++) for (let i = 0; i < SHN; i++) {
    const x = (i / (SHN - 1) - 0.5) * TERRAIN_SIZE, z = (j / (SHN - 1) - 0.5) * TERRAIN_SIZE;
    const d = THREE.MathUtils.clamp(Math.max(0, -heightAt(x, z)) / FOAM_DEPTH, 0, 1);
    shoreData[j * SHN + i] = d * 255;
  }
  const shoreTex = new THREE.DataTexture(shoreData, SHN, SHN, THREE.RedFormat);
  shoreTex.minFilter = shoreTex.magFilter = THREE.LinearFilter;
  shoreTex.wrapS = shoreTex.wrapT = THREE.ClampToEdgeWrapping;   // outside the island = deep, no foam
  shoreTex.needsUpdate = true;

  const seaUniforms = { uTime: { value: 0 }, uShore: { value: shoreTex } };
  const seaMat = new THREE.MeshStandardMaterial({ color: 0x2c6b8f, roughness: 0.35, metalness: 0.25 });
  seaMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = seaUniforms.uTime;
    shader.uniforms.uShore = seaUniforms.uShore;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSeaXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSeaXZ = (modelMatrix * vec4(position, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform sampler2D uShore; varying vec2 vSeaXZ;
        float _h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float _vn(vec2 p){ vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
          return mix(mix(_h21(i), _h21(i + vec2(1.0, 0.0)), u.x),
                     mix(_h21(i + vec2(0.0, 1.0)), _h21(i + vec2(1.0, 1.0)), u.x), u.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 _suv = vSeaXZ / ${TERRAIN_SIZE.toFixed(1)} + 0.5;
        float _d = texture2D(uShore, _suv).r;                 // 0 at the shore, 1 in deep water
        float _band = 1.0 - smoothstep(0.0, 0.9, _d);         // foam only near the coast
        // wave crests on the depth contours, spread out and rolling shoreward
        float _ph  = _d / 0.30 + uTime * 0.15;
        float _idx = floor(_ph + 0.5);
        float _cd  = abs(_ph - _idx);                         // 0 at the crest line
        // per-segment variation sampled along the shore (changes per wave via _idx)
        vec2  _np    = vSeaXZ * 0.014 + vec2(_idx * 7.3, _idx * 2.1);
        float _thick = mix(0.03, 0.17, _vn(_np));             // thickness varies along the line
        float _gate  = smoothstep(0.42, 0.58, _vn(_np * 0.6 + 19.0)); // line stops & starts
        float _line  = smoothstep(_thick, 0.0, _cd) * _gate * _band;
        float _edge  = smoothstep(0.10, 0.0, _d);             // foam right at the waterline
        float _foam  = clamp(max(_line, _edge), 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), _foam);`);
  };

  const sea = new THREE.Mesh(
    // large enough that the plane's edge sits well past the fog (so it fades to
    // sky rather than showing a lit horizon line)
    new THREE.PlaneGeometry(TERRAIN_SIZE * 3, TERRAIN_SIZE * 3),
    seaMat,   // opaque so it renders before the transparent clouds
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = 0;
  scene.add(sea);

  // --- molten magma pool in the volcano's summit crater. A flat, self-lit disc
  //     at the lava level: the opaque crater walls occlude it wherever the rock
  //     is higher, so only the basin reads as lava. Animated by uTime (pushed
  //     into shaderRefs by buildWorld). -------------------------------------
  const magmaGeo = new THREE.CircleGeometry(MAGMA_R, 72).rotateX(-Math.PI / 2);
  const magmaMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform float uTime;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
      }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.0; a *= 0.5; } return v; }
      void main(){
        vec2 p = (vUv - 0.5) * 9.0;
        float t = uTime * 0.13;
        // domain-warp the field with time so the crust rolls and churns
        vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, -t * 0.8)));
        float n = fbm(p + 1.6 * q + vec2(t * 0.4, t * 0.2));
        vec3 crust = vec3(0.16, 0.04, 0.02);
        vec3 fire  = vec3(1.0, 0.28, 0.02);
        vec3 hot   = vec3(1.0, 0.85, 0.35);
        vec3 col = mix(crust, fire, smoothstep(0.34, 0.55, n));
        col = mix(col, hot, smoothstep(0.58, 0.82, n));
        col += hot * pow(n, 4.0) * 0.7;                       // bright veins
        float edge = smoothstep(0.5, 0.4, length(vUv - 0.5)); // soften the disc rim
        col = mix(crust * 0.5, col, edge);
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
  const magma = new THREE.Mesh(magmaGeo, magmaMat);
  magma.position.set(0, heightAt(0, 0) + MAGMA_RISE, 0);
  magma.frustumCulled = false;
  scene.add(magma);

  // handle the city build uses to stamp concrete patches/paths into the mask
  const toPx = v => (v / TERRAIN_SIZE + 0.5) * MASK_SIZE;
  const cityMask = {
    paint(lots, decide) {
      maskCtx.save();
      maskCtx.filter = `blur(${(PAVE_FEATHER / TERRAIN_SIZE * MASK_SIZE).toFixed(1)}px)`;
      maskCtx.fillStyle = '#fff';
      for (const [id, e] of lots) {
        const d = decide.get(id); if (!d || d.culled) continue;
        const x0 = toPx(e.minX - PAVE_MARGIN), x1 = toPx(e.maxX + PAVE_MARGIN);
        const y0 = toPx(e.minZ - PAVE_MARGIN), y1 = toPx(e.maxZ + PAVE_MARGIN);
        maskCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      maskCtx.restore();
      maskTex.needsUpdate = true;
    },
  };
  return { cityMask, magmaMat, seaUniforms };
}

// Procedural concrete/asphalt detail texture (seamlessly tiling). Per-pixel
// speckle plus faint stains drawn toroidally (wrapped across all four edges) so
// there's no visible seam where the texture repeats.
function makeConcreteTexture() {
  const S = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = CONCRETE_COL; ctx.fillRect(0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 28;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 18; i++) {                    // faint oil/water stains
    const x = Math.random() * S, y = Math.random() * S, r = 10 + Math.random() * 38;
    const a = (0.03 + Math.random() * 0.05).toFixed(3);
    // draw the stain plus its 8 wrapped copies so it bleeds across edges seamlessly
    for (let oy = -S; oy <= S; oy += S) for (let ox = -S; ox <= S; ox += S) {
      const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------------------
// Assemble the city group from the worker's typed-array output. This mirrors
// the procity viewer's build (one mesh per colour group, animated window shader).
// ---------------------------------------------------------------------------
// Axis-aligned box as verts[]/faces[] in the same layout the worker emits (so it
// drops straight into a colour group). Sides + top only (the bottom stays buried);
// materials are DoubleSide so winding doesn't matter.
function makeBox(minX, maxX, minZ, maxZ, y0, y1) {
  const verts = [
    minX, y0, minZ,  maxX, y0, minZ,  maxX, y0, maxZ,  minX, y0, maxZ,   // 0..3 bottom
    minX, y1, minZ,  maxX, y1, minZ,  maxX, y1, maxZ,  minX, y1, maxZ,   // 4..7 top
  ];
  const faces = [
    0, 1, 5,  0, 5, 4,   // -Z
    1, 2, 6,  1, 6, 5,   // +X
    2, 3, 7,  2, 7, 6,   // +Z
    3, 0, 4,  3, 4, 7,   // -X
    4, 5, 6,  4, 6, 7,   // top
  ];
  return { verts, faces };
}

function buildCityGroup(objects, roomTex, shaderRefs, grid, cityMask) {
  // --- terrain-conform pass: for each building lot, sample the terrain under its
  //     footprint; cull lots on steep ground, raise the survivors onto it. The
  //     city's local XZ equals world XZ (centred at origin, scale 1), so the
  //     terrain query is direct. Roads (no lot index) are left as-is. ---
  const lotRe = /_(\d{4})$/;
  const lots = new Map();
  for (const o of objects) {
    const m = o.name.match(lotRe);
    if (!m) continue;
    const v = o.verts;
    let e = lots.get(m[1]);
    if (!e) { e = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }; lots.set(m[1], e); }
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], z = v[i + 2];
      if (x < e.minX) e.minX = x; if (x > e.maxX) e.maxX = x;
      if (z < e.minZ) e.minZ = z; if (z > e.maxZ) e.maxZ = z;
    }
  }
  const decide = new Map();
  for (const [id, e] of lots) {
    const cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
    let lo = Infinity, hi = -Infinity;
    for (const x of [e.minX, e.maxX]) for (const z of [e.minZ, e.maxZ]) {
      const h = heightAt(x, z); if (h < lo) lo = h; if (h > hi) hi = h;
    }
    // the terrain grid decides suitability (flat grass, above the beach); the
    // footprint drop is a fine-grained secondary check. The building sits on its
    // HIGH corner (+ a small raise) so the terrain never pokes up through the
    // ground floor; a foundation block (below) fills the gap down to the terrain.
    const culled = !grid.buildableAt(cx, cz) || (hi - lo) > CONFORM_MAX_DROP;
    const baseY = hi + FOUND_RAISE;
    decide.set(id, { culled, offY: baseY - CITY_ELEV, baseY, lo, e });
  }

  // group by colour, dropping culled lots and tagging each part with its Y offset
  const groupBuf = Object.fromEntries(COLOR_KEYS.map(k => [k, { totalIdx: 0, parts: [] }]));
  for (const o of objects) {
    const m = o.name.match(lotRe);
    let offY = 0;
    if (m) { const d = decide.get(m[1]); if (d) { if (d.culled) continue; offY = d.offY; } }
    const k = colorKey(o.name);
    if (k === 'road') continue;          // skip boulevards/highways (they float on the hills)
    if (groupBuf[k]) {
      groupBuf[k].parts.push({ verts: o.verts, faces: o.faces, uvs: o.uvs, subUVs: o.subUVs, offY });
      groupBuf[k].totalIdx += o.faces.length;
    }
  }

  // foundations: one block per surviving lot, spanning its footprint from below
  // the terrain up to the raised building base. Added to the 'base' colour group.
  // Coords are local to the city group (group.position.y === CITY_ELEV), so
  // worldY = localY + CITY_ELEV.
  for (const [id, e] of lots) {
    const d = decide.get(id);
    if (!d || d.culled) continue;
    const yTop = d.baseY - CITY_ELEV;            // flush with the building's ground floor
    const yBot = d.lo - FOUND_SINK - CITY_ELEV;  // buried below the lot's low corner
    const part = makeBox(e.minX - FOUND_LIP, e.maxX + FOUND_LIP,
                         e.minZ - FOUND_LIP, e.maxZ + FOUND_LIP, yBot, yTop);
    groupBuf.base.parts.push({ verts: part.verts, faces: part.faces, offY: 0 });
    groupBuf.base.totalIdx += part.faces.length;
  }

  // paint the concrete patches/paths onto the island's surface texture: for each
  // surviving lot, stamp a blurred rectangle (expanded by PAVE_MARGIN) into the
  // terrain's city-mask. Overlapping margins between close blocks merge into
  // continuous concrete paths/roads. The terrain shader blends to concrete where
  // the mask is set (see buildTerrain).
  if (cityMask) cityMask.paint(lots, decide);

  // Collision uses the building's real geometry — walls, roofs, foundations AND
  // the window panes (the panes fill the wall openings, so it's the exact shape
  // but solid: the plane can't slip through a window).
  const COLLIDE = new Set(['wall', 'smallwall', 'roof', 'base', 'window']);
  const collPos = [];

  const group = new THREE.Group();
  for (const key of COLOR_KEYS) {
    const g = groupBuf[key];
    if (!g.totalIdx) continue;

    const positions = new Float32Array(g.totalIdx * 3);
    let off = 0;
    for (const { verts, faces, offY } of g.parts) {
      for (let i = 0; i < faces.length; i++) {
        const idx = faces[i] * 3;
        positions[off++] = verts[idx];
        positions[off++] = verts[idx + 1] + offY;   // raise onto the terrain
        positions[off++] = verts[idx + 2];
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // accumulate collision triangles in WORLD space (group is lifted by CITY_ELEV)
    if (COLLIDE.has(key)) for (let i = 0; i < positions.length; i += 3) {
      collPos.push(positions[i], positions[i + 1] + CITY_ELEV, positions[i + 2]);
    }

    if (key === 'window') {
      const uvArr = new Float32Array(g.totalIdx * 2);
      const subUVArr = new Float32Array(g.totalIdx * 2);
      let uvOff = 0, sOff = 0;
      for (const { uvs, subUVs, faces } of g.parts) {
        for (let i = 0; i < faces.length; i++) {
          const vi = faces[i];
          uvArr[uvOff++] = uvs ? uvs[vi * 2] : 0;
          uvArr[uvOff++] = uvs ? uvs[vi * 2 + 1] : 0;
          subUVArr[sOff++] = subUVs ? subUVs[vi * 2] : 0;
          subUVArr[sOff++] = subUVs ? subUVs[vi * 2 + 1] : 0;
        }
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
      geo.setAttribute('aSubUV', new THREE.BufferAttribute(subUVArr, 2));
    }
    geo.computeVertexNormals();

    if (key === 'window') {
      group.add(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
        color: COLORS.window, shininess: 80, specular: new THREE.Color(0x4466aa), side: THREE.DoubleSide,
      })));
      const emissiveMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uNight: { value: 0 }, uWindowTex: { value: roomTex } },
        vertexShader: `
          attribute vec2 aSubUV; varying vec2 vPaneID; varying vec2 vSubUV; varying vec3 vWorldPos;
          void main() {
            vPaneID = uv; vSubUV = aSubUV;
            vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec2 vPaneID; varying vec2 vSubUV; varying vec3 vWorldPos;
          uniform float uTime; uniform float uNight; uniform sampler2D uWindowTex;
          void main() {
            vec2 pid = vPaneID + vec2(0.37, 0.71);
            float wh = fract(sin(dot(pid, vec2(127.1, 311.7))) * 43758.5453);
            vec2 blockID = floor(vPaneID / vec2(3.0, 2.0)) + vec2(0.37, 0.71);
            float bh = fract(sin(dot(blockID, vec2(127.1, 311.7))) * 43758.5453);
            float bPeriod = 600.0 + bh * 1200.0;
            float bSlot = floor(uTime / bPeriod);
            float bSlotHash = fract(sin(dot(vec2(bh * 131.7, bSlot), vec2(127.1, 311.7))) * 43758.5453);
            float blockLit = step(0.78, bSlotHash);
            float fineH = fract(sin(dot(pid, vec2(211.3, 97.7))) * 43758.5453);
            float fPeriod = 750.0 + fineH * 1350.0;
            float fSlot = floor(uTime / fPeriod);
            float fSlotHash = fract(sin(dot(vec2(fineH * 173.1, fSlot), vec2(311.7, 127.1))) * 43758.5453);
            float loneLit = step(0.80, fSlotHash);
            float lit = max(blockLit, loneLit) * step(0.2, wh);
            vec3 bq = floor(vWorldPos / 20.0);
            float buildingH = fract(sin(dot(bq, vec3(191.3, 463.7, 217.1))) * 43758.5453);
            float buildingBright = mix(0.65, 0.8, buildingH);
            float windowBright = mix(0.9, 1.0, wh);
            float ah = fract(sin(dot(pid + vec2(13.7, 91.3), vec2(431.1, 271.9))) * 93751.2453);
            float onThresh = mix(0.05, 0.95, ah);
            float nightFactor = smoothstep(onThresh - 0.12, onThresh + 0.12, uNight);
            float cellCol = floor(fract(sin(dot(pid, vec2(127.1, 311.7))) * 43758.5453) * 64.0);
            float cellRow = floor(fract(sin(dot(pid, vec2(269.5, 183.3))) * 93751.2453) * 64.0);
            vec2 atlasUV = vec2((cellCol + vSubUV.x) / 64.0, (63.0 - cellRow + vSubUV.y) / 64.0);
            float roomSilhouette = texture2D(uWindowTex, atlasUV).r;
            float roomFactor = 1.0 - roomSilhouette * 0.75;
            float em = lit * nightFactor * pow(uNight, 0.4) * buildingBright * windowBright * roomFactor;
            vec3 warm = vec3(1.0, 0.65, 0.2); vec3 white = vec3(0.95, 0.95, 1.0);
            vec3 col = mix(warm, white, step(0.5, buildingH));
            gl_FragColor = vec4(col * em, 1.0);
          }`,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide,
      });
      shaderRefs.push(emissiveMat);
      const em = new THREE.Mesh(geo, emissiveMat);
      group.add(em);
    } else {
      const mat = new THREE.MeshLambertMaterial({ color: COLORS[key], side: THREE.DoubleSide });
      group.add(new THREE.Mesh(geo, mat));
    }
  }

  // collision mesh: the big-block surfaces in world space, BVH'd for fast rays.
  let collisionMesh = null;
  if (collPos.length) {
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(collPos), 3));
    collisionMesh = makeCollisionMesh(cg);
  }
  return { group, collisionMesh };
}

// Wrap a world-space geometry in a BVH-accelerated, raycastable mesh (used for
// both the city's big blocks and the trees). DoubleSide so rays hit regardless
// of triangle winding. Not added to the scene — identity transform = world.
function makeCollisionMesh(geo) {
  if (!geo) return null;
  geo.boundsTree = new MeshBVH(geo);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

// ---------------------------------------------------------------------------
// Public entry: build terrain immediately, kick off the city worker, and
// return a handle with a collision query + per-frame shader update.
// ---------------------------------------------------------------------------
export function buildWorld(scene, onCityReady) {
  const { cityMask, magmaMat, seaUniforms } = buildTerrain(scene);

  // --- procedural placement grid: scan the island, then scatter trees & rocks
  //     and use the same grid to decide where the city can go. ---
  const GRID = {
    step: 11,
    extent: ISLAND_R * 1.05,
    waterH: 1, beachTop: 10,                   // ≤ this height is water/beach
    rockSlope: 0.55, snowH: VOLCANO_H * 0.55,  // terrain-type thresholds
    buildSlope: 0.16, buildMinH: 5, buildMaxH: VOLCANO_H * 0.45,   // building rule
    treeline: VOLCANO_H * 0.5, treeSlope: 0.5, treeDensity: 0.55,  // tree rule
    // rocks: boulder outcrops shed debris that rolls downhill, then relaxes apart
    boulderDensity: 0.06,    // chance a rocky cell spawns a source boulder
    rockScatterDensity: 0.14, // random background rocks on rocky ground
    rockRest: 0.12,          // slope below which a rolling rock settles
    rockRollStep: 4,         // metres advanced per roll step
    rockRollSteps: 60,       // max roll steps before it stops
    rockRelax: 4,            // repulsion iterations (no overlapping rocks)
    rockSpacing: 0.9,        // fraction of summed radii to keep rocks apart
  };
  const grid = buildGrid(heightAt, GRID);
  const { treeCollisionGeo } = scatter(scene, grid, heightAt, GRID);

  // collision meshes (BVH): trees now, the city's big blocks once the worker returns
  const collisionMeshes = [];
  const treeCollision = makeCollisionMesh(treeCollisionGeo);
  if (treeCollision) { treeCollision.userData.isTree = true; collisionMeshes.push(treeCollision); }

  const shaderRefs = [];
  if (magmaMat) shaderRefs.push(magmaMat);          // animate the lava via uTime
  if (seaUniforms) shaderRefs.push({ uniforms: seaUniforms });   // animate the ocean foam
  const roomTex = new THREE.TextureLoader().load('./textures/mega_texture.png');

  // Bump GEN_VERSION whenever generator.js changes — module workers are cached
  // hard by the browser, so the query param forces the updated code to load.
  const GEN_VERSION = 2;
  const genURL = new URL('./generator.js', import.meta.url);
  genURL.searchParams.set('v', GEN_VERSION);
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;                    // three-mesh-bvh fast path

  const worker = new Worker(genURL, { type: 'module' });
  worker.onmessage = (e) => {
    if (!e.data.ok) { console.error('City generation failed:', e.data.error); return; }
    const { group, collisionMesh } = buildCityGroup(e.data.objects, roomTex, shaderRefs, grid, cityMask);
    if (collisionMesh) collisionMeshes.push(collisionMesh);
    // the generator centres the city on the origin; lift it onto the plateau.
    group.position.y = CITY_ELEV;
    scene.add(group);
    worker.terminate();
    if (onCityReady) onCityReady(group);
  };
  worker.postMessage(CITY_CONFIG);

  return {
    heightAt,
    grid,   // terrain analysis (height/slope/type per cell) — drives tank traversability
    // ground height the plane should not pass through (land, or sea level)
    groundAt(x, z) { return Math.max(heightAt(x, z), 0); },
    // height-banded terrain colour at a point (matches the mesh) — for impact fx
    terrainColorAt,
    // nearest solid surface (building or tree) along a ray; { distance, point, normal } or null
    raycastSolids(origin, dir, far) {
      if (!collisionMeshes.length) return null;
      ray.set(origin, dir); ray.near = 0; ray.far = far;
      const hits = ray.intersectObjects(collisionMeshes, false);
      if (!hits.length) return null;
      const h = hits[0];
      return { distance: h.distance, point: h.point, normal: h.face ? h.face.normal : null,
               tree: h.object.userData.isTree === true };
    },
    update(elapsed, night = 0) {
      for (const m of shaderRefs) {
        m.uniforms.uTime.value = elapsed;
        if (m.uniforms.uNight) m.uniforms.uNight.value = night;
      }
    },
  };
}
