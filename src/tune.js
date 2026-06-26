// ===========================================================================
// Shell Sound — Tuning Lab. A standalone harness for src/audio.js: it simulates a
// single projectile flying past a stationary listener (within a tunable miss
// distance), drives the same whoosh()/crack() calls the game uses, and exposes
// every shell-sound knob as a live slider. Fire repeatedly and tune in isolation.
//
// The engine is held silent here (engine(0,0,0,false) every frame) so only the
// fly-by is audible, while still being "started" — whoosh()/crack() need that.
// ===========================================================================
import { buildAudio } from './audio.js';

const audio = buildAudio();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// --- simulation parameters (geometry of the fly-by) -----------------------
const sim = {
  missDistance: 16,   // closest approach (world units) — how near the round passes
  shellSpeed: 120,    // projectile speed
  planeSpeed: 36,     // listener speed (along the shell's travel axis) → adds to closing/doppler
  startDist: 120,     // how far back the shell starts
  whooshRadius: 66,   // matches WHOOSH_R in tanks.js
  crackRadius: 20,    // matches CRACK_R in tanks.js
  autofireGap: 1.8,   // seconds between auto-fires
  exploDistance: 0,   // distance from listener for the Boom test (0 = point-blank)
};
const SIM_SCHEMA = [
  ['missDistance', 0, 120, 1], ['shellSpeed', 20, 400, 5], ['planeSpeed', 0, 120, 1],
  ['startDist', 80, 600, 10], ['whooshRadius', 10, 200, 1], ['crackRadius', 5, 150, 1],
  ['autofireGap', 0.4, 6, 0.1], ['exploDistance', 0, 900, 10],
];

// --- audio param slider schema: [key, min, max, step] grouped by section ----
const AUDIO_SCHEMA = [
  ['Master', [['masterVol', 0, 1, 0.01], ['lowBusGain', 0, 1.5, 0.01]]],
  ['Whoosh (approach)', [
    ['whooshFreqMin', 80, 1200, 5], ['whooshFreqMax', 80, 1600, 5], ['whooshQ', 0.5, 16, 0.1],
    ['whooshLevel', 0, 1.5, 0.01], ['soundSpeed', 120, 700, 5],
  ]],
  ['Crack (whip-snap)', [
    ['crackFreqMin', 200, 3000, 10], ['crackFreqMax', 200, 4000, 10], ['crackQ', 0.2, 6, 0.1],
    ['crackSweepTo', 40, 800, 5], ['crackPeak', 0, 2, 0.01], ['crackPeakV', 0, 2, 0.01],
    ['crackDurMs', 5, 120, 1], ['crackDurRangeMs', 0, 80, 1],
  ]],
  ['Whizz (zip)', [
    ['whizzFreqMin', 150, 2000, 10], ['whizzFreqMax', 150, 2500, 10], ['whizzQ', 1, 20, 0.5],
    ['whizzSweepRatio', 0.05, 1, 0.01], ['whizzPeak', 0, 3, 0.05], ['whizzPeakV', 0, 3, 0.05],
    ['whizzDurMinMs', 40, 600, 5], ['whizzDurMaxMs', 40, 800, 5], ['whizzDecayMs', 10, 1200, 5],
    ['whizzDecayFreqDep', 0, 3, 0.05],
  ]],
  ['Thump (low boom)', [
    ['thumpScale', 0, 2, 0.01], ['thumpScaleV', 0, 2, 0.01], ['thumpLp', 30, 300, 1],
    ['thumpLpQ', 0.5, 16, 0.1], ['thumpReverb', 0, 2, 0.01],
  ]],
  ['Accent vs distance', [['accentDistExp', 0, 4, 0.05]]],
  ['Reverb', [['reverbSeconds', 0.3, 5, 0.1], ['reverbDecay', 0.5, 6, 0.1]]],
  ['Explosion (death — press B)', [
    ['exploBoom', 0, 3, 0.05], ['exploRoarFreq', 100, 2000, 10], ['exploRoarSweep', 40, 600, 5],
    ['exploRoarQ', 0.2, 6, 0.1], ['exploRoarPeak', 0, 2, 0.05], ['exploRoarDur', 0.1, 1.5, 0.05],
    ['exploCrackFreq', 500, 5000, 50], ['exploCrackQ', 0.2, 6, 0.1], ['exploCrackPeak', 0, 2, 0.05],
    ['exploCrackDur', 0.02, 0.5, 0.01], ['exploReverbNear', 0, 2, 0.05], ['exploReverbFar', 0, 2, 0.05],
  ]],
  ['Explosion whizz (debris zing)', [
    ['exploWhizzPeak', 0, 2, 0.01], ['exploWhizzFreqMin', 100, 2000, 10], ['exploWhizzFreqMax', 100, 2500, 10],
    ['exploWhizzQ', 1, 20, 0.5], ['exploWhizzSweepRatio', 0.05, 1, 0.01],
    ['exploWhizzDurMinMs', 40, 600, 5], ['exploWhizzDurMaxMs', 40, 1400, 5],
    ['exploWhizzDecayMs', 10, 1500, 5], ['exploWhizzDecayFreqDep', 0, 3, 0.05],
  ]],
];

const AUDIO_DEFAULTS = JSON.parse(JSON.stringify(audio.params));
const SIM_DEFAULTS = { ...sim };

// --- UI ------------------------------------------------------------------
const controls = document.getElementById('controls');
const valEls = {};   // key -> the value <span>, for live label updates

function addSlider(parent, store, key, min, max, step, onChange) {
  const row = document.createElement('div'); row.className = 'row';
  const label = document.createElement('label'); label.textContent = key;
  const range = document.createElement('input');
  range.type = 'range'; range.min = min; range.max = max; range.step = step; range.value = store[key];
  const val = document.createElement('span'); val.className = 'val'; val.textContent = fmt(store[key]);
  valEls[key] = { range, val };
  range.addEventListener('input', () => {
    const x = parseFloat(range.value);
    store[key] = x; val.textContent = fmt(x);
    if (onChange) onChange(key, x);
    dump();
  });
  row.append(label, range, val); parent.appendChild(row);
}
const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3));

function onAudioChange(key) {
  if (key === 'masterVol') audio.setMasterVol(audio.params.masterVol);
  else if (key === 'lowBusGain') audio.setLowBusGain(audio.params.lowBusGain);
  else if (key === 'reverbSeconds' || key === 'reverbDecay') audio.rebuildReverb();
  // everything else is read live by whoosh()/crack() on the next fire
}

function buildUI() {
  controls.innerHTML = '';
  // simulation group first
  const simGroup = document.createElement('div'); simGroup.className = 'group';
  simGroup.innerHTML = '<h2>Simulation (fly-by)</h2>';
  controls.appendChild(simGroup);
  for (const [key, min, max, step] of SIM_SCHEMA) addSlider(simGroup, sim, key, min, max, step);
  // audio groups
  for (const [title, rows] of AUDIO_SCHEMA) {
    const g = document.createElement('div'); g.className = 'group';
    g.innerHTML = `<h2>${title}</h2>`; controls.appendChild(g);
    for (const [key, min, max, step] of rows) addSlider(g, audio.params, key, min, max, step, onAudioChange);
  }
}

function syncUI() {   // push current store values back into the sliders (after reset)
  for (const [key, , , ] of SIM_SCHEMA) setSlider(key, sim[key]);
  for (const [, rows] of AUDIO_SCHEMA) for (const [key] of rows) setSlider(key, audio.params[key]);
}
function setSlider(key, v) { const e = valEls[key]; if (e) { e.range.value = v; e.val.textContent = fmt(v); } }

function dump() {
  document.getElementById('dump').textContent =
    'audio.params = ' + JSON.stringify(audio.params, null, 2) + '\n\nsim = ' + JSON.stringify(sim, null, 2);
}

// --- simulation ----------------------------------------------------------
let shell = null;     // { x,y,z (shell), vz, voice, prevClosing }
let listenerZ = 0;
let autofire = false, autofireTimer = 0;

function fire() {
  if (shell && shell.voice) shell.voice.stop();
  listenerZ = 0;
  shell = { x: sim.missDistance, y: 0, z: -sim.startDist, vz: sim.shellSpeed, voice: null, prevClosing: undefined };
}

// One-shot explosion test at the chosen distance (tank death / plane crash blast).
function fireBoom() { audio.explosion(sim.exploDistance); }

function updateSim(dt) {
  audio.engine(0, 0, 0, false);   // keep the engine silent in the lab
  listenerZ += sim.planeSpeed * dt;
  if (!shell) { if (autofire) { autofireTimer -= dt; if (autofireTimer <= 0) { fire(); autofireTimer = sim.autofireGap; } } return; }

  shell.z += shell.vz * dt;
  const dx = shell.x, dy = shell.y, dz = shell.z - listenerZ;
  const dist = Math.hypot(dx, dy, dz) || 1e-6;
  // unit vector shell→listener, and closing speed = relative velocity along it
  const ux = -dx / dist, uy = -dy / dist, uz = -dz / dist;
  const closing = (shell.vz - sim.planeSpeed) * uz;   // shell vx,vy = 0; listener moves in z

  if (dist < sim.whooshRadius) {
    if (!shell.voice) shell.voice = audio.whoosh();
    if (shell.voice) shell.voice.set(dist, closing, sim.whooshRadius);
  } else if (shell.voice) { shell.voice.stop(); shell.voice = null; }

  if (shell.prevClosing > 0 && closing <= 0) audio.crack(clamp01(1 - dist / sim.crackRadius));
  shell.prevClosing = closing;

  draw(dist, closing);

  if (dz > sim.startDist) {   // flown well past → done
    if (shell.voice) shell.voice.stop();
    shell = null;
    if (autofire) autofireTimer = sim.autofireGap;
  }
}

// --- viz (top-down: x = miss offset, z = travel) -------------------------
const cv = document.getElementById('view'), g2 = cv.getContext('2d');
const readout = document.getElementById('readout');
function draw(dist, closing) {
  const W = cv.width, H = cv.height;
  g2.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const sx = W / (sim.startDist * 2.2);   // z (travel) → horizontal
  const sy = H / (Math.max(sim.whooshRadius, sim.missDistance) * 2.6); // x (offset) → vertical
  // radii rings around the listener
  for (const [r, col] of [[sim.whooshRadius, '#2a5a7a'], [sim.crackRadius, '#7a3a3a']]) {
    g2.strokeStyle = col; g2.beginPath(); g2.ellipse(cx, cy, r * sx, r * sy, 0, 0, 7); g2.stroke();
  }
  // listener
  g2.fillStyle = '#6fd36f'; g2.beginPath(); g2.arc(cx, cy, 5, 0, 7); g2.fill();
  // shell
  if (shell) {
    const px = cx + (shell.z - listenerZ) * sx, py = cy + shell.x * sy;
    g2.fillStyle = '#ffd86f'; g2.beginPath(); g2.arc(px, py, 4, 0, 7); g2.fill();
  }
  readout.innerHTML = `dist <b>${dist.toFixed(1)}</b> &nbsp; closing <b>${closing.toFixed(1)}</b> u/s &nbsp; ` +
    `${closing > 0 ? 'approaching ↑pitch' : 'receding ↓pitch'}`;
}

// --- buttons -------------------------------------------------------------
document.getElementById('fire').addEventListener('click', fire);
document.getElementById('boom').addEventListener('click', fireBoom);
document.getElementById('auto').addEventListener('click', (e) => {
  autofire = !autofire; autofireTimer = 0;
  e.target.textContent = `⟳ Auto-fire: ${autofire ? 'on' : 'off'}`;
  e.target.classList.toggle('secondary', !autofire);
});
document.getElementById('reset').addEventListener('click', () => {
  Object.assign(audio.params, JSON.parse(JSON.stringify(AUDIO_DEFAULTS)));
  Object.assign(sim, SIM_DEFAULTS);
  audio.setMasterVol(audio.params.masterVol); audio.setLowBusGain(audio.params.lowBusGain); audio.rebuildReverb();
  syncUI(); dump();
});
document.getElementById('copy').addEventListener('click', () => {
  const text = document.getElementById('dump').textContent;
  navigator.clipboard?.writeText(text);
});
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); fire(); }
  else if (e.code === 'KeyB') { e.preventDefault(); fireBoom(); }
});

// audio-unlocked LED (the context resumes on the first gesture)
const led = document.getElementById('led');

buildUI(); dump();
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  updateSim(dt);
  led.classList.toggle('on', !!shell);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
