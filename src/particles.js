import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Impact fx: pooled "fountain" particles.
//
// One THREE.Points cloud holds a fixed ring-buffer pool of debris specks; a
// burst() seeds N of them at an impact point with up-biased velocities, then
// update() integrates gravity and fades them out. Colour is per-particle, so
// the caller picks it (terrain dirt, building grey, tank yellow). A tiny
// custom shader gives round, distance-scaled, alpha-fading points — cheap
// enough to spray on every bullet hit.
// ---------------------------------------------------------------------------
const GRAVITY = -60;

export function buildParticles(scene, { max = 2400 } = {}) {
  const positions = new Float32Array(max * 3);
  const pcolors   = new Float32Array(max * 3);
  const sizes     = new Float32Array(max);
  const alphas    = new Float32Array(max);   // 0 = unused/dead (shader discards)

  // CPU-side sim state (parallel arrays, indexed like the attributes)
  const vx = new Float32Array(max), vy = new Float32Array(max), vz = new Float32Array(max);
  const life = new Float32Array(max), maxLife = new Float32Array(max);
  let cursor = 0;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(pcolors, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = aColor; vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (320.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.0) discard;
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;                 // round speck
        float soft = smoothstep(0.25, 0.04, r2);
        gl_FragColor = vec4(vColor, vAlpha * soft);
      }`,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;                  // pool spans the whole map
  scene.add(points);

  const _up = new THREE.Vector3(0, 1, 0);
  const _dir = new THREE.Vector3();
  const _srgb  = { r: 1, g: 1, b: 1 };
  const _srgb2 = { r: 1, g: 1, b: 1 };

  return {
    // x,y,z impact point · color THREE.Color · opts:
    //   normal  — fountain axis (surface normal); defaults to straight up
    //   color2  — if set, each speck lerps randomly between color and color2
    //   count,speed,size,spread,life
    burst(x, y, z, color, opts = {}) {
      const count  = opts.count  ?? 18;
      const speed  = opts.speed  ?? 22;
      const size   = opts.size   ?? 2.0;
      const spread = opts.spread ?? 0.5;
      const lifeS  = opts.life   ?? 0.7;
      // Write straight to an sRGB framebuffer, so hand the shader sRGB-encoded
      // components (the renderer's tonemap/colorspace pass doesn't touch a raw
      // ShaderMaterial). Convert once per burst.
      color.getRGB(_srgb, THREE.SRGBColorSpace);
      const twoTone = !!opts.color2;
      if (twoTone) opts.color2.getRGB(_srgb2, THREE.SRGBColorSpace);

      // Spray in a cone around the surface normal (falls back to straight up).
      _dir.copy(opts.normal ? opts.normal : _up).normalize();

      for (let k = 0; k < count; k++) {
        const jx = _dir.x + (Math.random() * 2 - 1) * spread;
        const jy = _dir.y + (Math.random() * 2 - 1) * spread;
        const jz = _dir.z + (Math.random() * 2 - 1) * spread;
        const inv = 1 / Math.hypot(jx, jy, jz);
        const sp = speed * (0.4 + Math.random() * 1.0);

        const i = cursor; cursor = (cursor + 1) % max;
        positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
        vx[i] = jx * inv * sp; vy[i] = jy * inv * sp; vz[i] = jz * inv * sp;
        const t = twoTone ? Math.random() : 0;
        pcolors[i * 3]     = _srgb.r + (_srgb2.r - _srgb.r) * t;
        pcolors[i * 3 + 1] = _srgb.g + (_srgb2.g - _srgb.g) * t;
        pcolors[i * 3 + 2] = _srgb.b + (_srgb2.b - _srgb.b) * t;
        sizes[i] = size * (0.6 + Math.random() * 0.8);
        const L = lifeS * (0.7 + Math.random() * 0.6);
        life[i] = L; maxLife[i] = L; alphas[i] = 1;
      }
      geo.attributes.aColor.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
    },

    update(dt) {
      for (let i = 0; i < max; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        if (life[i] <= 0) { alphas[i] = 0; continue; }
        vy[i] += GRAVITY * dt;
        positions[i * 3]     += vx[i] * dt;
        positions[i * 3 + 1] += vy[i] * dt;
        positions[i * 3 + 2] += vz[i] * dt;
        // hold full alpha, then fade over the last ~60% of life
        alphas[i] = Math.min(1, life[i] / (maxLife[i] * 0.6));
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
    },
  };
}
