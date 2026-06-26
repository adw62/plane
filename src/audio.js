// ===========================================================================
// Audio — procedural sound via the Web Audio API. No asset files and no deps
// (keeps the project's no-build / static-files ethos: nothing else to fetch).
// Everything is synthesised on the fly:
//
//   • engine()    — a "poor man's engine-sim": a baked firing-pulse loop whose
//                   playbackRate is the RPM, through fixed resonant formants. A
//                   9-cyl WWI rotary; RPM rides throttle, airspeed and dive.
//   • planeGun()  — a short filtered-noise crack + thump per round.
//   • tankGun(d)  — a deep boom + rolling reverb tail, attenuated by distance.
//   • whoosh()    — a sustained per-shell fly-by voice: builds with proximity,
//                   dopplers with closing speed (the subsonic approach).
//   • crack(i)    — the close-pass accent (crack + whizz + thump), scaled by how
//                   near the shell came; see the function for the layers.
//
// Output chain: master/low buses → per-bus limiter → soft clipper → destination.
// The shell-sound knobs live in `params` (exposed on the handle) so tune.html can
// tweak them live; the game just uses the defaults baked in here.
//
// Browsers block audio until a user gesture, so the context is created suspended
// and resumed (engine started) on the first key/click/touch.
// ===========================================================================

const MASTER_VOL = 0.66;      // overall mix level (events gain-staged low; this sets the sum into the limiter)
const AUDIBLE_R  = 2400;      // distance (world units) beyond which a tank shot is silent
const IDLE_RPM   = 750;       // engine idle (throttle 0) — rotaries lope slow
const MAX_RPM    = 1500;      // engine "redline" (throttle 1) — WWI rotaries barely revved
const CYLINDERS  = 9;         // firing pulses per cycle — a 9-cyl biplane rotary (Gnome/Le Rhône)
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// A do-nothing handle so the game still runs if Web Audio is unavailable.
const SILENT = { engine() {}, planeGun() {}, tankGun() {}, explosion() {}, whoosh() { return null; }, crack() {} };

export function buildAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return SILENT;

  let ctx;
  try { ctx = new AC(); } catch { return SILENT; }

  const master = ctx.createGain();
  master.gain.value = 0.0001;            // silent until unlocked

  // Soft clipper at the very output: a tanh waveshaper that saturates gracefully
  // instead of hard-clipping. The limiter (4ms attack) can't catch sub-ms transients
  // like the N-wave crack, so those punch past 1.0 and clip — the soft clip is the
  // last-line catch for anything that fast, and adds a touch of pleasant crack bite.
  const softclip = ctx.createWaveShaper();
  {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 1.5); }
    softclip.curve = c; softclip.oversample = '4x';
  }
  softclip.connect(ctx.destination);

  // A limiter on the master bus, before the soft clip, so summed voices (engine +
  // guns + crack + whizz) sit under full scale rather than relying on the clipper.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 6;        // soft knee — gentler so it stops ducking quieter layers
  limiter.ratio.value = 6;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.12;
  master.connect(limiter);
  limiter.connect(softclip);

  // One second of white noise, reused (looped) for all the noisy transients.
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  // A synthesized reverb (decaying-noise impulse) → master. Sending a boom through
  // it gives a long rolling TAIL: the cue that a sound is large and travelling
  // across an open landscape, not a small thud right next to you. Faking "scale".
  function makeReverbIR(seconds, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return ir;
  }
  const reverb = ctx.createConvolver();   // IRs are built from params below (rebuildReverb)
  const reverbReturn = ctx.createGain(); reverbReturn.gain.value = 0.9;
  reverb.connect(reverbReturn).connect(master);
  // send a node's output into the reverb at `amount` wetness
  const sendToReverb = (node, amount) => {
    const s = ctx.createGain(); s.gain.value = amount;
    node.connect(s).connect(reverb);
  };

  // DEDICATED LOW BUS for the big shell thump (+ its own reverb), with its own
  // limiter straight to the output. The thump's resonant peak was re-triggering the
  // MAIN limiter and ducking the whizz/crack that share the master bus — routing it
  // here means its level can never touch the main mix. The two buses are kept low
  // enough that their sum at the output doesn't clip.
  const lowBus = ctx.createGain(); lowBus.gain.value = 0.8;
  const lowLimiter = ctx.createDynamicsCompressor();
  lowLimiter.threshold.value = -3; lowLimiter.knee.value = 8;
  lowLimiter.ratio.value = 5; lowLimiter.attack.value = 0.005; lowLimiter.release.value = 0.18;
  lowBus.connect(lowLimiter).connect(softclip);
  const thumpReverb = ctx.createConvolver();
  const thumpReverbReturn = ctx.createGain(); thumpReverbReturn.gain.value = 0.8;
  thumpReverb.connect(thumpReverbReturn).connect(lowBus);

  // -------------------------------------------------------------------------
  // Tunable parameters for the shell fly-by (whoosh + sonic boom). Exposed on the
  // returned handle (`.params`) so the tuning page can tweak them live; the game
  // just uses the defaults. Times are in ms / seconds where noted for easy sliders.
  // -------------------------------------------------------------------------
  const params = {
    masterVol: MASTER_VOL, lowBusGain: 0.8,
    // sustained whoosh (subsonic approach)
    whooshFreqMin: 340, whooshFreqMax: 800, whooshQ: 4, whooshLevel: 0.1, soundSpeed: 350,
    // crack — a sharp whip-snap that chirps down
    crackFreqMin: 1550, crackFreqMax: 2720, crackQ: 4, crackSweepTo: 785,
    crackPeak: 0.25, crackPeakV: 1.02, crackDurMs: 46, crackDurRangeMs: 48,
    // whizz — an instant-attack resonant zip, peak lands on the crack, then it
    // persists and slowly dies off over whizzDecayMs (amplitude time constant).
    // whizzDecayFreqDep tilts that decay by pitch — air absorbs highs faster, so a
    // higher-pitched zip dies quicker and a low one lingers (0 = uniform, 1 = ∝1/f).
    whizzFreqMin: 450, whizzFreqMax: 1120, whizzQ: 11, whizzSweepRatio: 0.15,
    whizzPeak: 0.1, whizzPeakV: 0.45, whizzDurMinMs: 295, whizzDurMaxMs: 800,
    whizzDecayMs: 520, whizzDecayFreqDep: 1.85,
    // thump — a single deep boom on the low bus + reverb tail
    thumpScale: 0.02, thumpScaleV: 0.11, thumpLp: 236, thumpLpQ: 12.7, thumpReverb: 0.91,
    // overall accent loudness vs miss distance: ×(1-miss/CRACK_R)^accentDistExp —
    // max for a grazing hit, falling to silence at the edge (higher exp = sharper falloff)
    accentDistExp: 1,
    // shared reverb (call rebuildReverb() after changing). These match the IR that
    // was actually playing in-game before the rebuild fix — it sounded better than
    // the longer tail tuned blind, so we kept it.
    reverbSeconds: 2.2, reverbDecay: 2.5,
    // explosion (tank death / plane crash): a deep boom body + a swept low-noise
    // roar + a sharp initial crack, with a distance-faded reverb send.
    exploBoom: 1.15,                                                // deep boom body scale
    exploRoarFreq: 390, exploRoarSweep: 110, exploRoarQ: 1.6, exploRoarPeak: 0.95, exploRoarDur: 1.25,
    exploCrackFreq: 700, exploCrackQ: 3, exploCrackPeak: 0.45, exploCrackDur: 0.11,
    exploReverbNear: 0.8, exploReverbFar: 1.1,                      // reverb send at point-blank vs far
    // explosion debris-whizz: its OWN randomly-extended zing layer (peak 0 = off),
    // independent of the shell whizz above.
    exploWhizzPeak: 0.18,
    exploWhizzFreqMin: 100, exploWhizzFreqMax: 590, exploWhizzQ: 8, exploWhizzSweepRatio: 0.2,
    exploWhizzDurMinMs: 335, exploWhizzDurMaxMs: 1225, exploWhizzDecayMs: 505, exploWhizzDecayFreqDep: 0.65,
  };
  const rebuildReverb = () => {
    reverb.buffer = makeReverbIR(params.reverbSeconds, params.reverbDecay);
    thumpReverb.buffer = makeReverbIR(params.reverbSeconds, params.reverbDecay);
  };
  const setMasterVol = (x) => { params.masterVol = x; master.gain.setTargetAtTime(x, ctx.currentTime, 0.05); };
  const setLowBusGain = (x) => { params.lowBusGain = x; lowBus.gain.setTargetAtTime(x, ctx.currentTime, 0.05); };
  rebuildReverb();   // build both reverb IRs from the params defaults (the game uses these)

  // -------------------------------------------------------------------------
  // Engine: a "poor man's engine-sim". One full engine CYCLE (CYLINDERS firing
  // pulses over 2 crank revolutions) is baked into a looping buffer; its
  // playbackRate sweeps with RPM to set the firing fundamental. The pulse train is
  // then run through FIXED resonant bandpass filters — the exhaust/intake "note"
  // formants. Those resonances stay put while the firing rate sweeps, which is
  // what reads as a real engine spooling up rather than a synth glissando.
  // -------------------------------------------------------------------------
  let eng = null;

  // Bake one engine cycle: CYLINDERS damped impulses, lightly jittered so the
  // firing isn't metronomic. Looped, this is the raw "putt-putt" the resonators
  // turn into a note. Reference cycle length = 0.5s → 2 Hz at playbackRate 1.
  const CYCLE_DUR = 0.5;
  function makeEngineCycle() {
    const len = Math.floor(ctx.sampleRate * CYCLE_DUR);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const decay = Math.floor(ctx.sampleRate * 0.1);      // per-pulse tail (longer = softer)
    const atk = ctx.sampleRate * 0.004;                  // ~4ms attack — no harsh click
    for (let c = 0; c < CYLINDERS; c++) {
      const start = Math.floor((c / CYLINDERS + (Math.random() - 0.5) * 0.01) * len);
      for (let i = 0; i < decay; i++) {
        const env = (1 - Math.exp(-i / atk)) * Math.exp(-i / (decay * 0.3));   // soft attack, gentle decay
        // mostly low-frequency body so it reads as a deep combustion thud, not a tick
        const v = Math.sin(i / ctx.sampleRate * 2 * Math.PI * 55) * 0.7 + (Math.random() * 2 - 1) * 0.3;
        d[(start + i) % len] += env * v;
      }
    }
    let max = 0; for (let i = 0; i < len; i++) max = Math.max(max, Math.abs(d[i]));
    if (max > 0) for (let i = 0; i < len; i++) d[i] /= max;
    return buf;
  }

  function startEngine() {
    if (eng) return;
    const gain = ctx.createGain(); gain.gain.value = 0.0001;

    // looping firing-pulse source — playbackRate carries the RPM
    const src = ctx.createBufferSource();
    src.buffer = makeEngineCycle();
    src.loop = true;

    // parallel resonant formants (fixed) + a body lowpass that opens with throttle.
    // Low frequencies + modest Q → a deep thrum that doesn't ring/buzz like clipping.
    const bus = ctx.createGain(); bus.gain.value = 0.5;
    src.connect(bus);
    const formants = [
      { f: 55,  q: 5, g: 0.8 },      // deep exhaust thrum
      { f: 110, q: 6, g: 0.45 },     // body
      { f: 200, q: 7, g: 0.22 },     // a little rasp on top
    ].map(({ f, q, g }) => {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const fg = ctx.createGain(); fg.gain.value = g;
      bus.connect(bp).connect(fg);
      return fg;
    });
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.5;
    bus.connect(lp);

    // tremolo for the propeller blade-pass thrum, on top of the firing rhythm
    const trem = ctx.createGain(); trem.gain.value = 0.85;
    const chopLFO = ctx.createOscillator(); chopLFO.type = 'sine'; chopLFO.frequency.value = 10;
    const chopDepth = ctx.createGain(); chopDepth.gain.value = 0.15;
    chopLFO.connect(chopDepth).connect(trem.gain);

    for (const f of formants) f.connect(trem);
    lp.connect(trem);
    trem.connect(gain).connect(master);

    const t = ctx.currentTime;
    src.start(t); chopLFO.start(t);
    eng = { src, lp, chopLFO, gain };
  }

  // Called every frame: throttle (0..1) → RPM → firing fundamental (playbackRate),
  // brightness (lowpass), prop-thrum rate, and loudness. Vertical velocity loads
  // the prop like a real airframe — diving (vy < 0) drives RPM up, climbing pulls
  // it down — which also keeps the note constantly varying instead of monotone.
  // `alive` cuts it on a wreck.
  function engine(throttle = 0, speed = 0, vy = 0, alive = true) {
    if (!eng) return;
    const t = ctx.currentTime, tc = 0.12;
    const base = lerp(IDLE_RPM, MAX_RPM, clamp01(throttle)) + speed * 2;
    const rpm = clamp(base - vy * 14, IDLE_RPM * 0.7, MAX_RPM * 1.5);   // dive over-revs, climb bogs down
    const load = clamp01((rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM));      // 0..1 "how hard it's working"
    const cycleFreq = rpm / 120;                          // engine cycles per second (4-stroke: rpm/60/2)
    eng.src.playbackRate.setTargetAtTime(cycleFreq * CYCLE_DUR, t, tc);   // rate 1 == 1/CYCLE_DUR Hz
    eng.lp.frequency.setTargetAtTime(lerp(380, 1000, load), t, tc);
    eng.chopLFO.frequency.setTargetAtTime(lerp(9, 18, load), t, tc);
    const vol = alive ? lerp(0.13, 0.26, load) + Math.min(0.04, speed * 0.0004) : 0.0001;
    eng.gain.gain.setTargetAtTime(vol, t, alive ? tc : 0.06);
  }

  // -------------------------------------------------------------------------
  // One-shot transients
  // -------------------------------------------------------------------------

  // A burst of band/lowpassed noise with an exponential decay envelope.
  // `when` optionally schedules the start (for events that arrive after a delay).
  function noiseBurst(dest, { freq, type = 'bandpass', Q = 1, peak, dur, sweepTo, when }) {
    const t = when ?? ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // A pitched body: an oscillator swept down with a decay envelope (thump/boom).
  function tone(dest, { type = 'sine', from, to, peak, dur, when }) {
    const t = when ?? ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // Plane gun: a crisp high crack + a small thump, fast — fired ~11×/s.
  function planeGun() {
    if (!eng) return;
    noiseBurst(master, { freq: 2200, type: 'bandpass', Q: 0.7, peak: 0.32, dur: 0.07 });
    tone(master, { type: 'square', from: 240, to: 70, peak: 0.16, dur: 0.07 });
  }

  // A deep boom into `dest`, scaled by `scale`: two low sines swept down + a
  // low-noise body. Shared by the tank gun and the shell-crack thump.
  function boom(dest, scale = 1, when) {
    tone(dest, { type: 'sine', from: 120, to: 26, peak: 1.6 * scale, dur: 0.7,  when });   // deep boom
    tone(dest, { type: 'sine', from: 60,  to: 20, peak: 1.1 * scale, dur: 0.85, when });   // sub-thud tail
    noiseBurst(dest, { freq: 500, type: 'lowpass', Q: 0.6, peak: 0.7 * scale, dur: 0.4, when });
  }

  // Tank gun: the boom, attenuated by distance to the plane.
  function tankGun(distance = 0) {
    if (!eng) return;
    // gentle (linear) rolloff with an audible floor — tanks fire from far off, so
    // a square curve made every shot inaudible. Even distant booms stay present.
    const att = lerp(0.3, 1, clamp01(1 - distance / AUDIBLE_R));
    const g = ctx.createGain(); g.gain.value = att; g.connect(master);
    boom(g);
    // more reverb the farther the shot — distant booms are nearly all rolling tail
    sendToReverb(g, lerp(0.7, 0.25, clamp01(1 - distance / AUDIBLE_R)));
  }

  // Explosion: a fat blast — the deep boom plus a swept low-noise body and a
  // sharp initial crack, distance-attenuated like the tank gun. `scale` sizes it
  // (tank death ~1, plane crash bigger). Reverb tail grows with distance.
  function explosion(distance = 0, scale = 1) {
    if (!eng) return;
    const P = params, near = clamp01(1 - distance / AUDIBLE_R);
    const att = lerp(0.35, 1, near) * scale;
    const g = ctx.createGain(); g.gain.value = att; g.connect(master);
    boom(g, P.exploBoom);                                                                              // deep body
    noiseBurst(g, { freq: P.exploRoarFreq, type: 'lowpass', Q: P.exploRoarQ, peak: P.exploRoarPeak, dur: P.exploRoarDur, sweepTo: P.exploRoarSweep }); // roar
    noiseBurst(g, { freq: P.exploCrackFreq, type: 'bandpass', Q: P.exploCrackQ, peak: P.exploCrackPeak, dur: P.exploCrackDur });                       // crack
    whizzVoice(g, P.exploWhizzPeak * scale, {                                                         // debris zing (its own knobs)
      freqMin: P.exploWhizzFreqMin, freqMax: P.exploWhizzFreqMax, Q: P.exploWhizzQ, sweepRatio: P.exploWhizzSweepRatio,
      durMinMs: P.exploWhizzDurMinMs, durMaxMs: P.exploWhizzDurMaxMs, decayMs: P.exploWhizzDecayMs, decayFreqDep: P.exploWhizzDecayFreqDep,
    });
    sendToReverb(g, lerp(P.exploReverbFar, P.exploReverbNear, near));
  }

  // Shell whoosh: a SUSTAINED fly-by voice for one shell. A looping band of noise
  // whose level builds as the shell nears the plane and whose pitch dopplers with
  // the closing speed (approaching → up, receding → down). The caller (a shell)
  // creates one with whoosh(), drives it each frame with .set(), and ends it with
  // .stop(). Returns null until audio is unlocked.
  function whoosh() {
    if (!eng) return null;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;       // decorrelate timbre per shell
    const baseFreq = params.whooshFreqMin + Math.random() * (params.whooshFreqMax - params.whooshFreqMin);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = baseFreq; bp.Q.value = params.whooshQ;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    src.connect(bp).connect(g).connect(master);
    src.start();
    let live = true;
    return {
      set(distance, closing, radius) {
        if (!live) return;
        const t = ctx.currentTime;
        const prox = clamp01(1 - distance / radius);
        g.gain.setTargetAtTime(params.whooshLevel * prox * prox, t, 0.04);   // squared → quiet far off, swells in close
        const ss = params.soundSpeed;
        const f = clamp(ss / (ss - clamp(closing, -260, 260)), 0.5, 2.6);
        bp.frequency.setTargetAtTime(baseFreq * f, t, 0.04);   // per-shell base × doppler
      },
      stop() {
        if (!live) return; live = false;
        const t = ctx.currentTime;
        g.gain.setTargetAtTime(0.0001, t, 0.06);
        try { src.stop(t + 0.25); } catch { /* already stopped */ }
      },
    };
  }

  // WHIZZ voice: an instant-attack resonant noise zip that glides down in pitch and
  // then rings out. The glide time and start pitch are randomised (within the given
  // bounds) so each one is a little different — sometimes a short snap, sometimes an
  // extended zing. Used by BOTH the shell-pass accent and the explosion (each passes
  // its own param set `W`, so they tune independently). `peak` is the final level.
  function whizzVoice(dest, peak, W) {
    if (peak <= 0) return;
    const tw = ctx.currentTime;
    const dur = (W.durMinMs + Math.random() * (W.durMaxMs - W.durMinMs)) / 1000;   // random pitch-glide time
    const f0 = W.freqMin + Math.random() * (W.freqMax - W.freqMin);                // random start pitch
    // air absorption: high pitches die faster. Scale the decay about the median pitch.
    const refF = (W.freqMin + W.freqMax) / 2;
    const decay = (W.decayMs / 1000) * Math.pow(refF / f0, W.decayFreqDep);
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = W.Q;
    bp.frequency.setValueAtTime(f0, tw);
    bp.frequency.exponentialRampToValueAtTime(f0 * W.sweepRatio, tw + dur);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(peak, tw);              // instant attack
    wg.gain.setTargetAtTime(0.0001, tw, decay);    // persist, then slowly die off
    const life = Math.max(dur, decay * 5);         // hold the voice through the tail
    src.connect(bp).connect(wg).connect(dest);
    src.start(tw); src.stop(tw + life + 0.05);
  }

  // The fly-by accent fired at a shell's closest approach: three layers together —
  //   • CRACK — a sharp whip-snap that chirps down (the air being torn)
  //   • WHIZZ — an instant-attack resonant zip whose peak lands on the crack
  //   • THUMP — a single deep boom on the low bus (own limiter) + reverb tail = scale
  // Everything scales with `intensity` (0..1), so an edge-of-radius pass is lighter.
  function crack(intensity = 1) {
    if (!eng) return;
    const v = clamp01(intensity);
    if (v < 0.04) return;
    const p = params;
    const dg = Math.pow(v, p.accentDistExp);   // overall accent gain: max for a grazing pass, ↓ with miss distance

    // --- CRACK: sharp whip-snap, chirps high→low in a few ms ---
    noiseBurst(master, {
      freq: p.crackFreqMin + Math.random() * (p.crackFreqMax - p.crackFreqMin), type: 'bandpass', Q: p.crackQ,
      peak: (p.crackPeak + p.crackPeakV * v) * dg, dur: (p.crackDurMs + Math.random() * p.crackDurRangeMs) / 1000,
      sweepTo: p.crackSweepTo,
    });

    // --- THUMP: a single deep boom on the low bus + reverb tail (its own limiter so
    //     it can't duck the crack/whizz on the master bus). ---
    const rlp = ctx.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = p.thumpLp; rlp.Q.value = p.thumpLpQ;
    rlp.connect(lowBus);
    boom(rlp, (p.thumpScale + p.thumpScaleV * v) * dg);
    const ts = ctx.createGain(); ts.gain.value = p.thumpReverb; rlp.connect(ts).connect(thumpReverb);

    // --- WHIZZ: resonant noise sweep, instant attack so its peak lands on the crack,
    //     fast pitch dive = a zip (not a whoosh). ---
    whizzVoice(master, (p.whizzPeak + p.whizzPeakV * v) * dg, {
      freqMin: p.whizzFreqMin, freqMax: p.whizzFreqMax, Q: p.whizzQ, sweepRatio: p.whizzSweepRatio,
      durMinMs: p.whizzDurMinMs, durMaxMs: p.whizzDurMaxMs, decayMs: p.whizzDecayMs, decayFreqDep: p.whizzDecayFreqDep,
    });
  }

  // -------------------------------------------------------------------------
  // Unlock on the first user gesture (autoplay policy).
  // -------------------------------------------------------------------------
  function unlock() {
    ctx.resume();
    master.gain.setTargetAtTime(params.masterVol, ctx.currentTime, 0.4);
    startEngine();
    removeEventListener('keydown', unlock);
    removeEventListener('mousedown', unlock);
    removeEventListener('touchstart', unlock);
  }
  addEventListener('keydown', unlock);
  addEventListener('mousedown', unlock);
  addEventListener('touchstart', unlock);

  return { engine, planeGun, tankGun, explosion, whoosh, crack, params, rebuildReverb, setMasterVol, setLowBusGain };
}
