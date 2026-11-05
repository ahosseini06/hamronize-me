/*
 * VOX MACHINA - vocoder render core
 *
 * Everything audio-rate happens here, on the render thread: the carrier synth,
 * the analysis/synthesis filterbank, voicing detection, and the output stage.
 * The main thread never touches a sample.
 *
 * Deliberate constraints:
 *   - No allocation after construction. Every buffer is sized for MAX_BANDS.
 *   - No imports, and only `sampleRate` / `AudioWorkletProcessor` /
 *     `registerProcessor` are taken from the global scope, so this file can be
 *     loaded in plain Node for numerical testing (see test/dsp.test.mjs).
 *   - Control data arrives through a SharedArrayBuffer when the page is
 *     cross-origin isolated, otherwise through postMessage. Neither path
 *     blocks or allocates in process().
 */

const MAX_BANDS = 32;
const SAMPLE_EVERY = 8;        // power of two: load is sampled 1 block in 8
const MAX_VOICES = 8;
const MAX_UNISON = 7;
const RQ = 128;               // render quantum, fixed by the spec

// Vis slot layout, shared with the main thread.
const VIS = {
  inLevel: 0, outL: 1, outR: 2, carrier: 3, voicing: 4,
  load: 5, voices: 6, bands: 7, gate: 8, limit: 9, busyUs: 10,
  env: 16,                    // MAX_BANDS floats: modulator envelope per band
  out: 16 + MAX_BANDS,        // MAX_BANDS floats: synthesised band level
};
const VIS_LEN = 16 + MAX_BANDS * 2;

// MIDI ring buffer layout (Int32Array): [0]=write, [1]=read, then 4 ints/event.
const MIDI_CAP = 256;
const MIDI_STRIDE = 4;
const MIDI_BASE = 2;

// ---------------------------------------------------------------- primitives

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Bandlimited step correction for the hard edges of saw/pulse oscillators.
function polyBlep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

// One-pole coefficient for a given time constant in milliseconds.
function poleCoef(ms, sr) {
  if (!(ms > 0)) return 1;
  return 1 - Math.exp(-1 / (ms * 0.001 * sr));
}

// Padé approximant of tanh; cheap soft saturation for the carrier.
function satur(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

// Transparent below 0.9, asymptotes to 1.0, C1-continuous at the knee.
// Pure safety net after the limiter - never the primary gain control.
function safeClip(x) {
  if (x > 0.9) return 0.9 + 0.1 * Math.tanh((x - 0.9) * 10);
  if (x < -0.9) return -(0.9 + 0.1 * Math.tanh((-x - 0.9) * 10));
  return x;
}

const dbToGain = db => Math.pow(10, db / 20);

// ---------------------------------------------------------------- voice

class Voice {
  constructor() {
    this.phase = new Float64Array(MAX_UNISON);
    this.subPhase = 0;
    this.note = -1;
    this.vel = 1;
    this.amp = 1;
    this.env = 0;
    this.stage = 0;          // 0 idle | 1 attack | 2 decay | 3 sustain | 4 release
    this.freq = 440;
    this.target = 440;
    this.age = 0;
    this.held = false;
  }
  reset() {
    this.stage = 0; this.env = 0; this.note = -1; this.held = false;
  }
}

// ---------------------------------------------------------------- processor

class VocoderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return []; }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.P = o.paramIndex || {};
    this.paramCount = o.paramCount || 0;
    this.discrete = o.discrete || [];
    this.sr = (typeof sampleRate === 'number' ? sampleRate : 48000);

    // --- control transport -------------------------------------------------
    this.pTarget = o.paramSAB ? new Float32Array(o.paramSAB)
                              : new Float32Array(this.paramCount);
    if (!o.paramSAB && o.initial) this.pTarget.set(o.initial);
    this.p = new Float64Array(this.paramCount);   // smoothed, what the DSP reads
    this.p.set(this.pTarget);
    this.midi = o.midiSAB ? new Int32Array(o.midiSAB) : null;
    this.vis = o.visSAB ? new Float32Array(o.visSAB) : new Float32Array(VIS_LEN);
    this.fallbackMidi = [];

    this.port.onmessage = e => this.onMessage(e.data);

    // --- filterbank --------------------------------------------------------
    this.coef = new Float64Array(MAX_BANDS * 3);     // b0, a1, a2 (b2 = -b0)
    this.centre = new Float64Array(MAX_BANDS);
    this.aState = new Float64Array(MAX_BANDS * 4);   // 2 cascaded sections
    this.sState = new Float64Array(MAX_BANDS * 4);
    this.sStateR = new Float64Array(MAX_BANDS * 4);
    this.env = new Float64Array(MAX_BANDS);
    this.bandGain = new Float64Array(MAX_BANDS);
    this.uniPanL = new Float64Array(MAX_UNISON);
    this.uniPanR = new Float64Array(MAX_UNISON);
    this.srcLo = new Int32Array(MAX_BANDS);
    this.srcHi = new Int32Array(MAX_BANDS);
    this.srcFrac = new Float64Array(MAX_BANDS);
    this.numBands = 0;
    this.sibBand = MAX_BANDS;
    this.kBands = -1; this.kLo = -1; this.kHi = -1; this.kQ = -1;

    // --- scratch (never reallocated) --------------------------------------
    this.modBuf = new Float32Array(RQ);
    this.carL = new Float32Array(RQ);
    this.carR = new Float32Array(RQ);
    this.noiseL = new Float32Array(RQ);
    this.noiseR = new Float32Array(RQ);
    this.voiceBuf = new Float32Array(RQ);
    this.loBuf = new Float32Array(RQ);
    this.hiBuf = new Float32Array(RQ);
    this.accL = new Float32Array(RQ);
    this.accR = new Float32Array(RQ);
    this.envBuf = new Float32Array(MAX_BANDS * RQ);
    this.blockMax = new Float64Array(MAX_BANDS);
    this.outMax = new Float64Array(MAX_BANDS);

    // --- input conditioning ------------------------------------------------
    this.hp = new Float64Array(2);
    this.hpCoef = new Float64Array(5);
    this.hpFreq = -1;
    this.gateEnv = 0;
    this.gateGain = 0;
    this.limGain = 1;

    // --- synth -------------------------------------------------------------
    this.voices = Array.from({ length: MAX_VOICES }, () => new Voice());
    this.noteStack = [];
    this.bend = 0;
    this.modWheel = 0;
    this.sustainPedal = false;
    this.vibPhase = 0;
    this.ageCounter = 0;
    this.detuneMul = new Float64Array(MAX_UNISON);
    this.inc = new Float64Array(MAX_UNISON);
    this.lastUnison = -1;
    this.lastDetune = -1;
    this.lastWidth = -1;
    this.prevHold = 0;

    // --- output ------------------------------------------------------------
    this.lpL = 0; this.lpR = 0;
    this.limGain = 1;
    this.dispIn = 0; this.dispL = 0; this.dispR = 0; this.dispCar = 0;
    this.dispLimit = 0;
    this.load = 0;
    this.visCounter = 0;
    // AudioWorkletGlobalScope exposes no `performance`, and Date.now() is
    // 1 ms coarse - far coarser than one ~0.1 ms block. Two things follow:
    //  1. Sum integer deltas over a window. The rounding phase is uniform, so
    //     the sum converges on true busy time even though each delta is 0 or 1.
    //  2. Date.now() returns ~1.76e12, outside V8's Smi range, so every call
    //     heap-allocates. Sample one block in SAMPLE_EVERY instead of all of
    //     them to keep the render thread allocation-free in the common case.
    this.timing = new Float64Array(4);   // busyMs, windowStart, busyUs, samples
    this.timing[1] = Date.now();
    this.blockCount = 0;
    this.prevGains = new Float64Array(5);
    this.gainsInit = false;

    this.port.postMessage({ type: 'ready', visLayout: VIS, visLen: VIS_LEN });
  }

  onMessage(d) {
    if (!d) return;
    switch (d.type) {
      case 'params':                       // postMessage fallback
        if (d.values) this.pTarget.set(d.values);
        break;
      case 'midi':
        if (this.fallbackMidi.length < 512) this.fallbackMidi.push(d.data);
        break;
      case 'panic':
        this.allNotesOff(true);
        break;
      case 'reset':
        this.resetState();
        break;
    }
  }

  resetState() {
    this.aState.fill(0); this.sState.fill(0); this.sStateR.fill(0); this.env.fill(0);
    this.hp.fill(0); this.lpL = this.lpR = 0; this.limGain = 1;
    this.envBuf.fill(0);
    for (const v of this.voices) v.reset();
    this.noteStack.length = 0;
  }

  // -------------------------------------------------------------- control in

  readMidi() {
    if (this.midi) {
      const w = Atomics.load(this.midi, 0);
      let r = Atomics.load(this.midi, 1);
      while (r !== w) {
        const base = MIDI_BASE + (r & (MIDI_CAP - 1)) * MIDI_STRIDE;
        this.handleMidi(this.midi[base], this.midi[base + 1], this.midi[base + 2]);
        r = (r + 1) | 0;
      }
      Atomics.store(this.midi, 1, r);
    }
    if (this.fallbackMidi.length) {
      for (const m of this.fallbackMidi) this.handleMidi(m[0], m[1], m[2] | 0);
      this.fallbackMidi.length = 0;
    }
  }

  readParams() {
    const n = this.paramCount, t = this.pTarget, p = this.p, d = this.discrete;
    // Block-rate one-pole smoothing. At 128 frames the block rate is ~375 Hz,
    // so 0.3 lands a knob move within a few milliseconds with no zipper.
    for (let i = 0; i < n; i++) {
      const tv = t[i];
      if (d[i]) p[i] = tv;
      else {
        const c = p[i];
        const nv = c + (tv - c) * 0.3;
        p[i] = Math.abs(tv - nv) < 1e-7 ? tv : nv;
      }
    }
  }

  // -------------------------------------------------------------- MIDI

  handleMidi(status, d1, d2) {
    const type = status & 0xf0;
    switch (type) {
      case 0x90:
        if (d2 > 0) this.noteOn(d1, d2 / 127); else this.noteOff(d1);
        break;
      case 0x80: this.noteOff(d1); break;
      case 0xb0:
        if (d1 === 1) this.modWheel = d2 / 127;
        else if (d1 === 64) {
          const on = d2 >= 64;
          this.sustainPedal = on;
          if (!on) this.releaseUnheld();
        } else if (d1 === 120 || d1 === 123) this.allNotesOff(true);
        break;
      case 0xe0: this.bend = ((d1 | (d2 << 7)) - 8192) / 8192; break;
    }
  }

  noteOn(note, vel) {
    const P = this.P, p = this.p;
    const mode = p[P.voiceMode] | 0;
    this.ageCounter++;

    if (mode !== 0) {                        // MONO / LEGATO
      const i = this.noteStack.indexOf(note);
      if (i >= 0) this.noteStack.splice(i, 1);
      this.noteStack.push(note);
      const v = this.voices[0];
      const wasIdle = v.stage === 0;
      v.note = note; v.vel = vel; v.held = true;
      v.target = this.noteFreq(note);
      if (wasIdle || p[P.glide] <= 0) v.freq = v.target;
      // LEGATO keeps the running envelope when a note is already sounding.
      if (mode === 1 || wasIdle) { v.stage = 1; if (wasIdle) this.randomisePhase(v); }
      v.amp = 1 - p[P.velSens] * (1 - vel);
      v.age = this.ageCounter;
      return;
    }

    // POLY: prefer an idle voice, then the same note, then the quietest.
    let slot = -1;
    for (let i = 0; i < MAX_VOICES; i++) {
      if (this.voices[i].note === note) { slot = i; break; }
    }
    if (slot < 0) {
      for (let i = 0; i < MAX_VOICES; i++) {
        if (this.voices[i].stage === 0) { slot = i; break; }
      }
    }
    if (slot < 0) {
      let quiet = Infinity;
      for (let i = 0; i < MAX_VOICES; i++) {
        const v = this.voices[i];
        const score = v.env + (v.stage === 4 ? -1 : 0);
        if (score < quiet) { quiet = score; slot = i; }
      }
    }
    const v = this.voices[slot];
    const fresh = v.stage === 0 || v.note !== note;
    v.note = note; v.vel = vel; v.held = true;
    v.target = this.noteFreq(note);
    if (v.stage === 0 || p[P.glide] <= 0) v.freq = v.target;
    v.stage = 1;
    v.amp = 1 - p[P.velSens] * (1 - vel);
    v.age = this.ageCounter;
    if (fresh) this.randomisePhase(v);
  }

  noteOff(note) {
    const P = this.P, p = this.p;
    const mode = p[P.voiceMode] | 0;
    const holding = p[P.hold] >= 0.5 || this.sustainPedal;

    if (mode !== 0) {
      const i = this.noteStack.indexOf(note);
      if (i >= 0) this.noteStack.splice(i, 1);
      if (holding) return;
      const v = this.voices[0];
      if (this.noteStack.length) {
        // Last-note priority: fall back to the previous held note.
        const prev = this.noteStack[this.noteStack.length - 1];
        v.note = prev;
        v.target = this.noteFreq(prev);
        if (p[P.glide] <= 0) v.freq = v.target;
        if (mode === 1) v.stage = 1;
      } else if (v.note === note || v.stage !== 0) {
        v.held = false; v.stage = 4;
      }
      return;
    }

    for (const v of this.voices) {
      if (v.note === note && v.stage !== 0 && v.stage !== 4) {
        v.held = false;
        if (!holding) v.stage = 4;
      }
    }
  }

  releaseUnheld() {
    if (this.p[this.P.hold] >= 0.5) return;
    for (const v of this.voices) {
      if (!v.held && v.stage !== 0 && v.stage !== 4) v.stage = 4;
    }
    if ((this.p[this.P.voiceMode] | 0) !== 0 && !this.noteStack.length) {
      const v = this.voices[0];
      if (v.stage !== 0) v.stage = 4;
    }
  }

  allNotesOff(hard) {
    this.noteStack.length = 0;
    for (const v of this.voices) {
      if (hard) v.reset(); else if (v.stage !== 0) { v.held = false; v.stage = 4; }
    }
  }

  noteFreq(note) {
    const P = this.P, p = this.p;
    const semis = note + (p[P.octave] | 0) * 12 + p[P.fine] / 100;
    return 440 * Math.pow(2, (semis - 69) / 12);
  }

  randomisePhase(v) {
    // Decorrelated start phases keep stacked unison from clicking in a pile.
    for (let u = 0; u < MAX_UNISON; u++) v.phase[u] = Math.random();
    v.subPhase = Math.random();
  }

  // -------------------------------------------------------------- filterbank

  rebuildBank() {
    const P = this.P, p = this.p;
    const nb = clamp(Math.round(p[P.bands]), 4, MAX_BANDS);
    const lo = clamp(p[P.fLow], 20, 2000);
    const hi = clamp(p[P.fHigh], lo * 2, this.sr * 0.47);
    const qm = clamp(p[P.qMul], 0.1, 8);
    // Numeric comparison: building a string key here would allocate on the
    // render thread every block.
    if (nb === this.kBands && lo === this.kLo && hi === this.kHi && qm === this.kQ) return;
    this.kBands = nb; this.kLo = lo; this.kHi = hi; this.kQ = qm;
    this.numBands = nb;

    // Log-spaced centres; band width in octaves sets the nominal Q.
    const octaves = Math.log2(hi / lo);
    const bwOct = octaves / nb;
    const nominalQ = 1 / (Math.pow(2, bwOct / 2) - Math.pow(2, -bwOct / 2));
    // Two identical cascaded 2nd-order sections narrow the -3 dB width by
    // sqrt(2^(1/2)-1); widen each section's Q so the pair hits the target.
    const sectionQ = clamp(nominalQ * qm * 0.6436, 0.4, 40);

    for (let b = 0; b < nb; b++) {
      const f = lo * Math.pow(2, bwOct * (b + 0.5));
      this.centre[b] = f;
      const w = 2 * Math.PI * clamp(f, 10, this.sr * 0.48) / this.sr;
      const cs = Math.cos(w), sn = Math.sin(w);
      const alpha = sn / (2 * sectionQ);
      const a0 = 1 + alpha;
      this.coef[b * 3]     = alpha / a0;         // b0  (b2 = -b0)
      this.coef[b * 3 + 1] = (-2 * cs) / a0;     // a1
      this.coef[b * 3 + 2] = (1 - alpha) / a0;   // a2
    }
    // Stale state from a previous geometry would ring at the wrong pitch.
    this.aState.fill(0); this.sState.fill(0); this.sStateR.fill(0);
    for (let b = nb; b < MAX_BANDS; b++) { this.env[b] = 0; this.blockMax[b] = 0; this.outMax[b] = 0; }
  }

  updateDerived() {
    const P = this.P, p = this.p, nb = this.numBands;

    // Sibilance crossover -> first band treated as "high".
    const sh = p[P.sibHz];
    let sb = nb;
    for (let b = 0; b < nb; b++) if (this.centre[b] >= sh) { sb = b; break; }
    this.sibBand = sb;

    // Spectral tilt across the band range, +-10 dB at the extremes.
    const tilt = p[P.tilt];
    const formant = p[P.formant];
    for (let b = 0; b < nb; b++) {
      const rel = nb > 1 ? b / (nb - 1) - 0.5 : 0;
      this.bandGain[b] = dbToGain(tilt * 20 * rel);

      const src = b - formant;
      const f = Math.floor(src);
      this.srcLo[b] = clamp(f, 0, nb - 1);
      this.srcHi[b] = clamp(f + 1, 0, nb - 1);
      this.srcFrac[b] = src - f;
    }

    // Input high-pass (RBJ, Q=0.707) - recomputed only when it moves.
    const hf = clamp(p[P.inHpf], 10, this.sr * 0.45);
    if (Math.abs(hf - this.hpFreq) > 0.01) {
      this.hpFreq = hf;
      const w = 2 * Math.PI * hf / this.sr;
      const cs = Math.cos(w), sn = Math.sin(w);
      const alpha = sn / (2 * 0.7071);
      const a0 = 1 + alpha;
      this.hpCoef[0] = ((1 + cs) / 2) / a0;    // b0
      this.hpCoef[1] = (-(1 + cs)) / a0;       // b1
      this.hpCoef[2] = ((1 + cs) / 2) / a0;    // b2
      this.hpCoef[3] = (-2 * cs) / a0;         // a1
      this.hpCoef[4] = (1 - alpha) / a0;       // a2
    }
  }

  // -------------------------------------------------------------- synth

  renderCarrier() {
    const P = this.P, p = this.p, sr = this.sr;
    const carL = this.carL, carR = this.carR;
    carL.fill(0); carR.fill(0);

    const uni = clamp(Math.round(p[P.unison]), 1, MAX_UNISON);
    const detune = p[P.detune];
    const width = clamp(p[P.width], 0, 1);
    if (uni !== this.lastUnison || Math.abs(detune - this.lastDetune) > 1e-6 ||
        Math.abs(width - this.lastWidth) > 1e-6) {
      this.lastUnison = uni; this.lastDetune = detune; this.lastWidth = width;
      for (let u = 0; u < uni; u++) {
        const spread = uni === 1 ? 0 : (u / (uni - 1)) * 2 - 1;
        this.detuneMul[u] = Math.pow(2, (spread * detune) / 1200);
        // Symmetric constant-power pan, so total L/R energy stays equal for
        // any unison count and collapses to exact dual mono at width 0.
        const s = spread * width;
        this.uniPanL[u] = Math.sqrt(1 - s * 0.5);
        this.uniPanR[u] = Math.sqrt(1 + s * 0.5);
      }
    }

    const shape = clamp(p[P.shape], 0, 1);
    const pw = clamp(p[P.pw], 0.02, 0.98);
    const subLvl = p[P.sub];
    const subDiv = (p[P.subOct] | 0) === 1 ? 0.25 : 0.5;
    const bendSemis = this.bend * p[P.bendRange];
    const vibCents = this.modWheel * p[P.vibDepth];
    const glideCoef = p[P.glide] > 0 ? poleCoef(p[P.glide] * 0.4, sr / RQ) : 1;

    const atkInc = 1 / Math.max(1, p[P.atk] * 0.001 * sr);
    const decCoef = poleCoef(p[P.dec] * 0.35, sr);
    const relCoef = poleCoef(p[P.rel] * 0.35, sr);
    const sus = clamp(p[P.sus], 0, 1);

    // Vibrato runs at block rate; 128 frames is far finer than 5.6 Hz needs.
    this.vibPhase += (5.6 * RQ) / sr;
    if (this.vibPhase >= 1) this.vibPhase -= 1;
    const vib = Math.sin(this.vibPhase * 2 * Math.PI) * vibCents;
    const pitchMul = Math.pow(2, bendSemis / 12 + vib / 1200);

    const uniNorm = 1 / Math.sqrt(uni);
    let active = 0;

    for (let vi = 0; vi < MAX_VOICES; vi++) {
      const v = this.voices[vi];
      if (v.stage === 0) continue;
      active++;

      v.freq += (v.target - v.freq) * glideCoef;
      const f0 = v.freq * pitchMul;
      const amp = v.amp;

      // Oscillator increments, clamped below Nyquist.
      const inc = this.inc;
      for (let u = 0; u < uni; u++) {
        inc[u] = clamp(f0 * this.detuneMul[u] / sr, 0, 0.49);
      }
      const subInc = clamp(f0 * subDiv / sr, 0, 0.49);
      const phase = v.phase;
      let sp = v.subPhase;
      let env = v.env, stage = v.stage;

      for (let n = 0; n < RQ; n++) {
        // --- amp envelope (linear attack, exponential decay/release)
        if (stage === 1) {
          env += atkInc;
          if (env >= 1) { env = 1; stage = 2; }
        } else if (stage === 2) {
          env += (sus - env) * decCoef;
          if (env - sus < 1e-4 && sus - env < 1e-4) { env = sus; stage = 3; }
        } else if (stage === 3) {
          env = sus;
        } else {
          env += (0 - env) * relCoef;
          if (env < 1e-5) { env = 0; stage = 0; }
        }
        if (env <= 0 && stage === 0) break;

        // --- oscillator stack
        let sL = 0, sR = 0;
        for (let u = 0; u < uni; u++) {
          const dt = inc[u];
          let t = phase[u] + dt;
          if (t >= 1) t -= 1;
          phase[u] = t;

          let saw = 2 * t - 1 - polyBlep(t, dt);
          let osc = saw;
          if (shape > 0) {
            let t2 = t - pw;
            if (t2 < 0) t2 += 1;
            const pul = (t < pw ? 1 : -1) + polyBlep(t, dt) - polyBlep(t2, dt);
            osc = saw + (pul - saw) * shape;
          }
          sL += osc * this.uniPanL[u];
          sR += osc * this.uniPanR[u];
        }
        sL *= uniNorm; sR *= uniNorm;

        if (subLvl > 0) {
          let t = sp + subInc;
          if (t >= 1) t -= 1;
          sp = t;
          let t2 = t - 0.5;
          if (t2 < 0) t2 += 1;
          const sq = (t < 0.5 ? 1 : -1) + polyBlep(t, subInc) - polyBlep(t2, subInc);
          const sv = sq * subLvl;           // sub stays centred
          sL += sv; sR += sv;
        }

        const g = env * amp;
        carL[n] += sL * g;
        carR[n] += sR * g;
      }

      v.subPhase = sp;
      v.env = env;
      v.stage = stage;
      if (stage === 0) { v.note = -1; v.held = false; }
    }

    // Normalise for stacking, then saturate for extra harmonic density. A
    // spectrally rich carrier is what makes a vocoder intelligible.
    const voiceNorm = 1 / (1 + 0.55 * Math.max(0, active - 1));
    const drive = p[P.drive];
    const dg = 1 + drive * 5;
    const dnorm = drive > 0 ? 1 / satur(dg * 0.8) : 1;
    for (let n = 0; n < RQ; n++) {
      let l = carL[n] * voiceNorm * 0.42;
      let r = carR[n] * voiceNorm * 0.42;
      if (drive > 0) {
        l = satur(l * dg) * dnorm * 0.8;
        r = satur(r * dg) * dnorm * 0.8;
      }
      carL[n] = l; carR[n] = r;
    }
    return active;
  }

  // Synthesis filterbank for one channel. Coefficients and envelopes are
  // shared with the analysis pass; only the carrier and filter state differ.
  renderBank(car, noise, acc, state, trackMax) {
    const P = this.P, p = this.p, nb = this.numBands;
    const envBuf = this.envBuf, voiceBuf = this.voiceBuf;
    const sib = p[P.sib], air = p[P.air];
    acc.fill(0);

    for (let b = 0; b < nb; b++) {
      const ci = b * 3;
      const c0 = this.coef[ci], ca1 = this.coef[ci + 1], ca2 = this.coef[ci + 2];
      const si = b * 4;
      let z1 = state[si], z2 = state[si + 1];
      let z3 = state[si + 2], z4 = state[si + 3];

      const g = this.bandGain[b];
      const loB = this.srcLo[b] * RQ, hiB = this.srcHi[b] * RQ;
      const fr = this.srcFrac[b];
      const isHi = b >= this.sibBand;
      let mx = 0;

      for (let n = 0; n < RQ; n++) {
        // Noise replaces the carrier in the high bands on unvoiced content,
        // which is what makes consonants legible instead of buzzy.
        let nm = air;
        if (isHi) nm += voiceBuf[n] * sib;
        if (nm > 1) nm = 1;
        const c = nm > 0 ? car[n] + (noise[n] - car[n]) * nm : car[n];

        const y1 = c0 * c + z1;
        z1 = -ca1 * y1 + z2;
        z2 = -c0 * c - ca2 * y1;
        const y2 = c0 * y1 + z3;
        z3 = -ca1 * y2 + z4;
        z4 = -c0 * y1 - ca2 * y2;

        const e = envBuf[loB + n] + (envBuf[hiB + n] - envBuf[loB + n]) * fr;
        const v = y2 * e * g;
        acc[n] += v;
        const av = v < 0 ? -v : v;
        if (av > mx) mx = av;
      }

      state[si] = z1; state[si + 1] = z2;
      state[si + 2] = z3; state[si + 3] = z4;
      if (trackMax) this.outMax[b] = mx;
    }
  }

  // -------------------------------------------------------------- main render

  process(inputs, outputs, _parameters) {
    const sampled = (this.blockCount & (SAMPLE_EVERY - 1)) === 0;
    const t0 = sampled ? Date.now() : 0;

    const out = outputs[0];
    if (!out || !out.length) return true;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];

    this.readMidi();
    this.readParams();
    const P = this.P, p = this.p;

    // HOLD released -> let everything that is no longer physically held go.
    const hold = p[P.hold] >= 0.5 ? 1 : 0;
    if (this.prevHold && !hold) this.releaseUnheld();
    this.prevHold = hold;

    this.rebuildBank();
    this.updateDerived();
    const nb = this.numBands;

    const sr = this.sr;
    const mod = this.modBuf;
    const carL = this.carL, carR = this.carR;
    const noiseL = this.noiseL, noiseR = this.noiseR;
    const envBuf = this.envBuf, voiceBuf = this.voiceBuf;
    const loBuf = this.loBuf, hiBuf = this.hiBuf;
    const accL = this.accL, accR = this.accR;

    // ---------------------------------------------------- modulator input
    const inp = inputs[0];
    const src = (inp && inp.length && inp[0] && inp[0].length === RQ) ? inp[0] : null;
    const inGain = dbToGain(p[P.inGain]);
    const hc = this.hpCoef;
    const b0 = hc[0], b1 = hc[1], b2 = hc[2], a1 = hc[3], a2 = hc[4];
    let h1 = this.hp[0], h2 = this.hp[1];
    let inPeak = 0;

    if (src) {
      for (let n = 0; n < RQ; n++) {
        const x = src[n] * inGain;
        const y = b0 * x + h1;
        h1 = b1 * x - a1 * y + h2;
        h2 = b2 * x - a2 * y;
        mod[n] = y;
        const a = y < 0 ? -y : y;
        if (a > inPeak) inPeak = a;
      }
    } else {
      mod.fill(0);
      h1 = h2 = 0;
    }
    this.hp[0] = h1; this.hp[1] = h2;

    // Gate: fast-attack / slow-release follower, then a smoothed gain.
    const gateDb = p[P.gate];
    if (gateDb > -79.5) {
      const thr = dbToGain(gateDb);
      const gAtk = poleCoef(1.0, sr), gRel = poleCoef(60, sr);
      const open = poleCoef(1.5, sr), close = poleCoef(80, sr);
      let ge = this.gateEnv, gg = this.gateGain;
      for (let n = 0; n < RQ; n++) {
        const a = mod[n] < 0 ? -mod[n] : mod[n];
        ge += (a - ge) * (a > ge ? gAtk : gRel);
        const want = ge > thr ? 1 : 0;
        gg += (want - gg) * (want > gg ? open : close);
        mod[n] *= gg;
      }
      this.gateEnv = ge; this.gateGain = gg;
    } else {
      this.gateGain = 1; this.gateEnv = inPeak;
    }

    // ---------------------------------------------------- carrier + noise
    const active = this.renderCarrier();
    // Noise decorrelates with width, so width 0 stays exactly dual mono.
    const nWidth = clamp(p[P.width], 0, 1);
    for (let n = 0; n < RQ; n++) {
      const a = Math.random() * 2 - 1;
      noiseL[n] = a;
      noiseR[n] = nWidth > 0 ? a + ((Math.random() * 2 - 1) - a) * nWidth : a;
    }

    // ---------------------------------------------------- pass A: analysis
    const freeze = p[P.freeze] >= 0.5;
    const atk = poleCoef(p[P.vAtk], sr);
    const rel = poleCoef(p[P.vRel], sr);
    loBuf.fill(0); hiBuf.fill(0);

    for (let b = 0; b < nb; b++) {
      const ci = b * 3;
      const c0 = this.coef[ci], ca1 = this.coef[ci + 1], ca2 = this.coef[ci + 2];
      const si = b * 4;
      let z1 = this.aState[si], z2 = this.aState[si + 1];
      let z3 = this.aState[si + 2], z4 = this.aState[si + 3];
      let env = this.env[b];
      const base = b * RQ;
      const tgt = b >= this.sibBand ? hiBuf : loBuf;
      let mx = 0;

      for (let n = 0; n < RQ; n++) {
        const x = mod[n];
        // section 1
        const y1 = c0 * x + z1;
        z1 = -ca1 * y1 + z2;
        z2 = -c0 * x - ca2 * y1;
        // section 2
        const y2 = c0 * y1 + z3;
        z3 = -ca1 * y2 + z4;
        z4 = -c0 * y1 - ca2 * y2;

        if (!freeze) {
          const r = y2 < 0 ? -y2 : y2;
          env += (r - env) * (r > env ? atk : rel);
        }
        envBuf[base + n] = env;
        tgt[n] += env;
        if (env > mx) mx = env;
      }

      this.aState[si] = z1; this.aState[si + 1] = z2;
      this.aState[si + 2] = z3; this.aState[si + 3] = z4;
      this.env[b] = env;
      this.blockMax[b] = mx;
    }

    // ---------------------------------------------------- voicing detection
    // High/low envelope-energy ratio. Voiced speech sits low; sibilants and
    // plosives spike it. Drives noise substitution in the carrier.
    let voiceAvg = 0;
    for (let n = 0; n < RQ; n++) {
      const lo = loBuf[n], hi = hiBuf[n];
      const tot = lo + hi + 1e-9;
      let u = (hi / tot - 0.22) * (1 / (0.55 - 0.22));
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      voiceBuf[n] = u;
      voiceAvg += u;
    }
    voiceAvg /= RQ;

    // ---------------------------------------------------- pass B: synthesis
    // Run once per channel against a genuinely stereo carrier. The envelopes
    // are mono and shared, so the spectral image is identical on both sides -
    // width comes from the carrier, never from splitting the bands apart.
    this.renderBank(carL, noiseL, accL, this.sState, true);
    this.renderBank(carR, noiseR, accR, this.sStateR, false);

    // ---------------------------------------------------- output stage
    // Two cascaded BPFs halve the per-band amplitude, and summing N bands of a
    // flat-ish carrier does not add coherently; this keeps unity-ish output
    // across band counts.
    const bankMakeup = 7.0 * Math.sqrt(24 / Math.max(4, nb));

    const gVoc = p[P.vocLevel] * bankMakeup;
    const gDry = p[P.dry];
    const gBleed = p[P.bleed] * 0.7;
    const gMaster = dbToGain(p[P.master]);
    const bright = p[P.bright];
    const hfGain = dbToGain(bright * 9);
    const lpCoef = 1 - Math.exp(-2 * Math.PI * 900 / sr);

    const pg = this.prevGains;
    if (!this.gainsInit) {
      pg[0] = gVoc; pg[1] = gDry; pg[2] = gBleed; pg[3] = gMaster; pg[4] = hfGain;
      this.gainsInit = true;
    }
    // Per-sample ramp on the output gains so even a fast knob sweep is clean.
    const dVoc = (gVoc - pg[0]) / RQ, dDry = (gDry - pg[1]) / RQ;
    const dBleed = (gBleed - pg[2]) / RQ, dMaster = (gMaster - pg[3]) / RQ;
    const dHf = (hfGain - pg[4]) / RQ;
    let cVoc = pg[0], cDry = pg[1], cBleed = pg[2], cMaster = pg[3], cHf = pg[4];

    const limOn = p[P.limiter] >= 0.5;
    const ceiling = dbToGain(p[P.limThresh]);
    const lRel = poleCoef(120, sr);
    let limGain = this.limGain;
    let lpL = this.lpL, lpR = this.lpR;
    let peakL = 0, peakR = 0, carPeak = 0, minGain = 1;

    for (let n = 0; n < RQ; n++) {
      cVoc += dVoc; cDry += dDry; cBleed += dBleed; cMaster += dMaster; cHf += dHf;

      const dryC = mod[n] * cDry;
      let l = accL[n] * cVoc + dryC + carL[n] * cBleed;
      let r = accR[n] * cVoc + dryC + carR[n] * cBleed;

      // Tilt shelf: one-pole split, high band scaled.
      lpL += (l - lpL) * lpCoef;
      lpR += (r - lpR) * lpCoef;
      l = lpL + (l - lpL) * cHf;
      r = lpR + (r - lpR) * cHf;

      l *= cMaster; r *= cMaster;

      if (limOn) {
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        const a = al > ar ? al : ar;
        // Instant attack, exponential release. Without lookahead this is the
        // only way to actually guarantee the ceiling; the cost is a little
        // harmonic distortion on the very fastest transients.
        const req = a * limGain > ceiling ? ceiling / a : 1;
        if (req < limGain) limGain = req;
        else limGain += (req - limGain) * lRel;
        l *= limGain; r *= limGain;
        if (limGain < minGain) minGain = limGain;
      }

      l = safeClip(l); r = safeClip(r);
      outL[n] = l;
      if (outR !== outL) outR[n] = r;

      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
      const ac = carL[n] < 0 ? -carL[n] : carL[n];
      if (ac > carPeak) carPeak = ac;
    }

    this.limGain = limGain; this.lpL = lpL; this.lpR = lpR;
    pg[0] = gVoc; pg[1] = gDry; pg[2] = gBleed; pg[3] = gMaster; pg[4] = hfGain;

    // Blow-up guard: one bad coefficient should not wedge the graph forever.
    if (!Number.isFinite(outL[0]) || !Number.isFinite(outL[RQ - 1])) {
      this.resetState();
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      peakL = peakR = 0;
    }

    // ---------------------------------------------------- metering
    const tm = this.timing;
    if (sampled) {
      const now = Date.now();
      tm[0] += now - t0;
      tm[3] += 1;
      // Window closes on sample count, so the span is measured on the clock
      // we already paid for.
      if (tm[3] >= 128) {
        const span = now - tm[1];
        if (span > 0) {
          // Busy time was observed on 1 block in SAMPLE_EVERY; scale up.
          const busyTotal = tm[0] * SAMPLE_EVERY;
          this.load += (busyTotal / span - this.load) * 0.5;
          tm[2] = (tm[0] * 1000) / tm[3];
        }
        tm[0] = 0; tm[3] = 0; tm[1] = now;
      }
    }
    this.blockCount = (this.blockCount + 1) | 0;

    const dec = 0.86;
    this.dispIn = Math.max(inPeak, this.dispIn * dec);
    this.dispL = Math.max(peakL, this.dispL * dec);
    this.dispR = Math.max(peakR, this.dispR * dec);
    this.dispCar = Math.max(carPeak, this.dispCar * dec);
    this.dispLimit = Math.max(1 - minGain, this.dispLimit * 0.9);

    if (++this.visCounter >= 6) {         // ~60 Hz
      this.visCounter = 0;
      const vs = this.vis;
      vs[VIS.inLevel] = this.dispIn;
      vs[VIS.outL] = this.dispL;
      vs[VIS.outR] = this.dispR;
      vs[VIS.carrier] = this.dispCar;
      vs[VIS.voicing] = voiceAvg;
      vs[VIS.load] = this.load;
      vs[VIS.busyUs] = this.timing[2];
      vs[VIS.voices] = active;
      vs[VIS.bands] = nb;
      vs[VIS.gate] = this.gateGain;
      vs[VIS.limit] = this.dispLimit;
      for (let b = 0; b < nb; b++) {
        vs[VIS.env + b] = this.blockMax[b];
        vs[VIS.out + b] = this.outMax[b] * gVoc;
      }
      for (let b = nb; b < MAX_BANDS; b++) { vs[VIS.env + b] = 0; vs[VIS.out + b] = 0; }
      if (!this.vis.buffer || !(this.vis.buffer instanceof SharedArrayBuffer)) {
        this.port.postMessage({ type: 'vis', data: vs.slice() });
      }
    }

    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('vox-machina', VocoderProcessor);
}

export { VocoderProcessor, VIS, VIS_LEN, MIDI_CAP, MIDI_STRIDE, MIDI_BASE, MAX_BANDS, polyBlep, safeClip };
