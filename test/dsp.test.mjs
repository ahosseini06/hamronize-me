// Numerical tests for the render core, run outside the browser.
// Stubs the three AudioWorkletGlobalScope globals the processor touches.

const SR = 48000;
const RQ = 128;

globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage() {}, set onmessage(_f) {}, get onmessage() { return null; } };
  }
};
globalThis.registerProcessor = () => {};

const { VocoderProcessor, MAX_BANDS } = await import('../worklet/vocoder-processor.js');
const Pm = await import('../src/engine/params.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

function makeProc(overrides = {}) {
  const initial = Pm.defaultValues();
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in Pm.PARAM_INDEX)) throw new Error('unknown param ' + k);
    initial[Pm.PARAM_INDEX[k]] = v;
  }
  const proc = new VocoderProcessor({
    processorOptions: {
      paramIndex: Pm.PARAM_INDEX,
      paramCount: Pm.PARAM_COUNT,
      discrete: Pm.DISCRETE_FLAGS,
      initial,
      curves: Pm.curveTables(),
      modDest: Pm.modDestIndices(),
      divisions: Pm.DIVISION_BEATS,
      visSAB: new SharedArrayBuffer(4 * 80),
    },
  });
  // Skip the smoothing ramp so tests see the requested values immediately.
  proc.p.set(initial);
  proc.pm.set(initial);
  return proc;
}

// Render n blocks; `inputFn(t, n)` supplies the modulator.
function render(proc, blocks, inputFn) {
  const L = new Float32Array(blocks * RQ);
  const R = new Float32Array(blocks * RQ);
  const inBuf = new Float32Array(RQ);
  const outL = new Float32Array(RQ), outR = new Float32Array(RQ);
  let frame = 0;
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < RQ; i++) {
      inBuf[i] = inputFn ? inputFn((frame + i) / SR, frame + i) : 0;
    }
    outL.fill(0); outR.fill(0);
    proc.process([[inBuf]], [[outL, outR]], {});
    L.set(outL, b * RQ); R.set(outR, b * RQ);
    frame += RQ;
  }
  return { L, R };
}

// Goertzel magnitude at a single frequency, Hann-windowed.
function magAt(buf, freq, from = 0, len = buf.length) {
  const w = 2 * Math.PI * freq / SR;
  let re = 0, im = 0;
  for (let i = 0; i < len; i++) {
    const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1));
    const s = buf[from + i] * win;
    re += s * Math.cos(w * i);
    im += s * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / len * 2;
}
const NATIVE_RANDOM = Math.random;
const seedRandom = seed => {
  let x = seed >>> 0;
  Math.random = () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
};
const restoreRandom = () => { Math.random = NATIVE_RANDOM; };

const peak = b => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = b => Math.sqrt(b.reduce((s, v) => s + v * v, 0) / b.length);
const finite = b => b.every(Number.isFinite);

console.log('\n--- silence ---');
{
  const proc = makeProc();
  const { L, R } = render(proc, 20, null);
  ok('silence in -> silence out', peak(L) === 0 && peak(R) === 0, `peak=${peak(L)}`);
  ok('output finite', finite(L) && finite(R));
}

console.log('\n--- analysis filterbank selectivity ---');
{
  // A sine into the modulator must light up the band containing it.
  for (const probe of [200, 700, 2000, 6000]) {
    const proc = makeProc({ gate: -80, vAtk: 1, vRel: 5 });
    render(proc, 120, t => 0.5 * Math.sin(2 * Math.PI * probe * t));
    let best = -1, bestV = -1;
    for (let b = 0; b < proc.numBands; b++) {
      if (proc.env[b] > bestV) { bestV = proc.env[b]; best = b; }
    }
    const fc = proc.centre[best];
    const errOct = Math.abs(Math.log2(fc / probe));
    const bwOct = Math.log2(9000 / 120) / proc.numBands;
    ok(`${probe} Hz -> band ${best} @ ${fc.toFixed(0)} Hz`,
       errOct <= bwOct, `err=${errOct.toFixed(3)} oct, bw=${bwOct.toFixed(3)}`);
  }
}

console.log('\n--- band geometry mirrors the UI helper ---');
{
  for (const [nb, lo, hi] of [[12, 120, 9000], [32, 80, 12000], [24, 200, 6000]]) {
    const proc = makeProc({ bands: nb, fLow: lo, fHigh: hi });
    render(proc, 2, null);
    const ui = Pm.bandCentres(nb, lo, hi);
    let worst = 0;
    for (let b = 0; b < nb; b++) worst = Math.max(worst, Math.abs(ui[b] - proc.centre[b]));
    ok(`centres match for ${nb}/${lo}/${hi}`, worst < 1e-9, `worst=${worst}`);
  }
}

console.log('\n--- envelope follower timing ---');
{
  const proc = makeProc({ gate: -80, vAtk: 2, vRel: 50 });
  // Burst then silence; the release must actually decay.
  render(proc, 60, t => 0.5 * Math.sin(2 * Math.PI * 700 * t));
  const held = Math.max(...Array.from({ length: proc.numBands }, (_, b) => proc.env[b]));
  render(proc, 40, () => 0);
  const after = Math.max(...Array.from({ length: proc.numBands }, (_, b) => proc.env[b]));
  ok('envelope decays after input stops', after < held * 0.2,
     `held=${held.toFixed(4)} after=${after.toFixed(4)}`);
  ok('envelope was non-zero while driven', held > 0.01, `held=${held}`);
}

console.log('\n--- voicing / sibilance detection ---');
{
  seedRandom(0xA11CE);
  const low = makeProc({ gate: -80 });
  render(low, 80, t => 0.4 * Math.sin(2 * Math.PI * 180 * t));
  const vLow = low.vis[4];

  const hiss = makeProc({ gate: -80 });
  // Shaped noise concentrated well above the 4.2 kHz crossover.
  let z = 0;
  render(hiss, 80, () => { const w = Math.random() * 2 - 1; z += (w - z) * 0.9; return (w - z) * 0.8; });
  const vHigh = hiss.vis[4];

  ok('voiced tone reads low unvoicedness', vLow < 0.25, `v=${vLow.toFixed(3)}`);
  ok('hiss reads high unvoicedness', vHigh > 0.5, `v=${vHigh.toFixed(3)}`);
  ok('detector separates the two', vHigh - vLow > 0.4,
     `low=${vLow.toFixed(3)} high=${vHigh.toFixed(3)}`);
  restoreRandom();
}

console.log('\n--- carrier synth pitch ---');
{
  // Bypass the vocoder, listen to the carrier directly.
  for (const [note, hz] of [[45, 110], [57, 220], [69, 440]]) {
    const proc = makeProc({
      vocLevel: 0, bleed: 1, dry: 0, master: 0, unison: 1, detune: 0,
      sub: 0, air: 0, drive: 0, shape: 0, atk: 0.5, limiter: 0,
    });
    proc.handleMidi(0x90, note, 100);
    const { L } = render(proc, 80, null);
    const body = L.subarray(2048);
    const f0 = magAt(body, hz);
    const h2 = magAt(body, hz * 2);
    const offKey = magAt(body, hz * 1.45);
    ok(`note ${note} -> ${hz} Hz fundamental`, f0 > offKey * 8,
       `f0=${f0.toFixed(5)} off=${offKey.toFixed(5)}`);
    ok(`note ${note} saw has harmonics`, h2 > f0 * 0.25 && h2 < f0,
       `f0=${f0.toFixed(5)} h2=${h2.toFixed(5)}`);
  }
}

console.log('\n--- PolyBLEP anti-aliasing ---');
{
  // High saw: check a known alias image sits well below a true harmonic.
  const proc = makeProc({
    vocLevel: 0, bleed: 1, dry: 0, master: 0, unison: 1, detune: 0,
    sub: 0, air: 0, drive: 0, shape: 0, atk: 0.5, limiter: 0, octave: 0,
  });
  const f0 = 4186.01;                      // MIDI 108
  proc.handleMidi(0x90, 108, 100);
  const { L } = render(proc, 100, null);
  const body = L.subarray(4096);
  const h4 = magAt(body, f0 * 4);          // 16744 Hz, real harmonic
  const alias7 = magAt(body, SR - f0 * 7); // 18698 Hz, image of the 7th
  const ratioDb = 20 * Math.log10(alias7 / (h4 + 1e-12));
  ok('alias image >=12 dB below true harmonic', ratioDb < -12,
     `${ratioDb.toFixed(1)} dB`);
}

console.log('\n--- vocoder end to end ---');
{
  const proc = makeProc({ gate: -80, master: 0, limiter: 0 });
  proc.handleMidi(0x90, 45, 100);
  // Modulator: 300 Hz tone, so output energy should concentrate near 300 Hz
  // even though the carrier is a 110 Hz saw.
  const { L, R } = render(proc, 160, t => 0.5 * Math.sin(2 * Math.PI * 300 * t));
  const body = L.subarray(8192);
  ok('produces output', rms(body) > 1e-4, `rms=${rms(body).toExponential(2)}`);
  ok('output finite', finite(L) && finite(R));
  ok('output bounded', peak(L) <= 1.0 && peak(R) <= 1.0,
     `peakL=${peak(L).toFixed(3)}`);
  const near300 = magAt(body, 300) + magAt(body, 330) + magAt(body, 270);
  const near2k = magAt(body, 2000) + magAt(body, 2500);
  ok('energy tracks the modulator band', near300 > near2k * 4,
     `300=${near300.toExponential(2)} 2k=${near2k.toExponential(2)}`);
}

console.log('\n--- output level sanity ---');
{
  const proc = makeProc({ gate: -80 });
  proc.handleMidi(0x90, 48, 100);
  proc.handleMidi(0x90, 52, 100);
  // Speech-like modulator: a few voiced harmonics plus some breath.
  const { L } = render(proc, 200, t =>
    0.35 * (Math.sin(2 * Math.PI * 160 * t) + 0.6 * Math.sin(2 * Math.PI * 480 * t) +
            0.3 * Math.sin(2 * Math.PI * 1200 * t)) + 0.04 * (Math.random() * 2 - 1));
  const r = rms(L.subarray(8192));
  const db = 20 * Math.log10(r + 1e-12);
  console.log(`  stock patch output: ${db.toFixed(1)} dBFS rms, peak ${peak(L.subarray(8192)).toFixed(3)}`);
  ok('stock patch lands in a usable range', db > -30 && db < -8, `${db.toFixed(1)} dBFS`);
}

console.log('\n--- formant shift ---');
{
  const mk = f => {
    const proc = makeProc({ gate: -80, master: 0, limiter: 0, formant: f, sib: 0, air: 0 });
    proc.handleMidi(0x90, 33, 100);        // low carrier, rich spectrum
    const { L } = render(proc, 160, t => 0.5 * Math.sin(2 * Math.PI * 400 * t));
    return L.subarray(8192);
  };
  const base = mk(0), up = mk(4);
  // Shifting envelopes upward should move output energy to higher bands.
  const cBase = magAt(base, 400), cUp = magAt(up, 400);
  const hBase = magAt(base, 1400), hUp = magAt(up, 1400);
  ok('positive formant moves energy up',
     (hUp / (cUp + 1e-12)) > (hBase / (cBase + 1e-12)) * 2,
     `base=${(hBase / (cBase + 1e-12)).toFixed(3)} up=${(hUp / (cUp + 1e-12)).toFixed(3)}`);
}

console.log('\n--- limiter ---');
{
  for (const ceil of [-1, -6]) {
    const proc = makeProc({
      gate: -80, master: 12, limiter: 1, limThresh: ceil, vocLevel: 1.5,
    });
    proc.handleMidi(0x90, 45, 127);
    const { L, R } = render(proc, 200, t =>
      0.9 * Math.sin(2 * Math.PI * 300 * t) + 0.5 * Math.sin(2 * Math.PI * 900 * t));
    const lin = Math.pow(10, ceil / 20);
    const p = Math.max(peak(L.subarray(4096)), peak(R.subarray(4096)));
    ok(`ceiling ${ceil} dB respected (+ ~1 dB knee)`, p <= lin * 1.15,
       `peak=${p.toFixed(4)} ceil=${lin.toFixed(4)}`);
  }
}

console.log('\n--- stereo width ---');
{
  const proc = makeProc({ gate: -80, width: 0, master: 0, limiter: 0, unison: 5, detune: 20 });
  proc.handleMidi(0x90, 45, 100);
  const { L, R } = render(proc, 80, t => 0.5 * Math.sin(2 * Math.PI * 500 * t));
  let diff = 0;
  for (let i = 0; i < L.length; i++) diff += Math.abs(L[i] - R[i]);
  ok('width=0 is dual mono', diff / L.length < 1e-7, `diff=${diff / L.length}`);

  const wide = makeProc({ gate: -80, width: 1, master: 0, limiter: 0, unison: 5, detune: 20 });
  wide.handleMidi(0x90, 45, 100);
  const w = render(wide, 80, t => 0.5 * Math.sin(2 * Math.PI * 500 * t));
  let d2 = 0;
  for (let i = 0; i < w.L.length; i++) d2 += Math.abs(w.L[i] - w.R[i]);
  ok('width=1 decorrelates channels', d2 / w.L.length > 1e-5, `diff=${d2 / w.L.length}`);
  const bl = rms(w.L), br = rms(w.R);
  ok('width keeps channels balanced', Math.abs(bl - br) / Math.max(bl, br) < 0.12,
     `L=${bl.toExponential(2)} R=${br.toExponential(2)}`);

  // A narrowband modulator must not drag the image to one side.
  const narrow = makeProc({ gate: -80, width: 1, master: 0, limiter: 0, unison: 5, detune: 20 });
  narrow.handleMidi(0x90, 45, 100);
  let worstSkew = 0;
  for (const probe of [300, 500, 900, 1800, 3000]) {
    const o = render(narrow, 90, t => 0.5 * Math.sin(2 * Math.PI * probe * t));
    const a = rms(o.L.subarray(4096)), b2 = rms(o.R.subarray(4096));
    worstSkew = Math.max(worstSkew, Math.abs(a - b2) / Math.max(a, b2));
  }
  ok('narrowband input stays centred', worstSkew < 0.15,
     `worst skew=${(worstSkew * 100).toFixed(1)}%`);
}

console.log('\n--- voice allocation ---');
{
  const proc = makeProc({ gate: -80 });
  for (let i = 0; i < 12; i++) proc.handleMidi(0x90, 48 + i, 100);  // over-subscribe
  render(proc, 10, null);
  const act = proc.voices.filter(v => v.stage !== 0).length;
  ok('never exceeds the voice budget', act <= 8, `active=${act}`);

  for (let i = 0; i < 12; i++) proc.handleMidi(0x80, 48 + i, 0);
  render(proc, 400, null);
  const left = proc.voices.filter(v => v.stage !== 0).length;
  ok('all voices free after note-off', left === 0, `left=${left}`);
}

console.log('\n--- mono / legato ---');
{
  const proc = makeProc({ gate: -80, voiceMode: 1, glide: 0 });
  proc.handleMidi(0x90, 60, 100);
  proc.handleMidi(0x90, 64, 100);
  render(proc, 4, null);
  ok('mono tracks the newest note', proc.voices[0].note === 64, `note=${proc.voices[0].note}`);
  proc.handleMidi(0x80, 64, 0);
  render(proc, 4, null);
  ok('mono falls back to the held note', proc.voices[0].note === 60,
     `note=${proc.voices[0].note}`);
  proc.handleMidi(0x80, 60, 0);
  render(proc, 400, null);
  ok('mono releases when the stack empties', proc.voices[0].stage === 0,
     `stage=${proc.voices[0].stage}`);
}

console.log('\n--- hold / sustain ---');
{
  const proc = makeProc({ gate: -80, hold: 1 });
  proc.handleMidi(0x90, 60, 100);
  proc.handleMidi(0x80, 60, 0);
  render(proc, 200, null);
  ok('HOLD sustains past note-off', proc.voices.some(v => v.stage !== 0 && v.stage !== 4));
  proc.pTarget[Pm.PARAM_INDEX.hold] = 0;
  proc.p[Pm.PARAM_INDEX.hold] = 0;
  render(proc, 400, null);
  ok('releasing HOLD frees the voices',
     proc.voices.every(v => v.stage === 0));
}

console.log('\n--- band count changes ---');
{
  const proc = makeProc({ gate: -80, master: 0 });
  proc.handleMidi(0x90, 45, 100);
  let worst = 0;
  for (const nb of [12, 32, 16, 24, 28, 20]) {
    proc.pTarget[Pm.PARAM_INDEX.bands] = nb;
    proc.p[Pm.PARAM_INDEX.bands] = nb;
    const { L } = render(proc, 40, t => 0.5 * Math.sin(2 * Math.PI * 600 * t));
    ok(`bands=${nb} renders cleanly`, finite(L) && peak(L) <= 1.0 && proc.numBands === nb,
       `peak=${peak(L).toFixed(3)} nb=${proc.numBands}`);
    worst = Math.max(worst, rms(L.subarray(2048)));
  }
  ok('level survives band switching', worst > 1e-4, `rms=${worst.toExponential(2)}`);
}

console.log('\n--- parameter sweep robustness ---');
{
  // Hammer every continuous param across its range while rendering.
  const proc = makeProc({ gate: -80 });
  proc.handleMidi(0x90, 48, 100);
  proc.handleMidi(0x90, 55, 100);
  let bad = 0, loudest = 0;
  for (const p of Pm.PARAMS) {
    const i = Pm.PARAM_INDEX[p.id];
    for (const t of [0, 0.5, 1]) {
      proc.pTarget[i] = Pm.fromNorm(p, t);
      const { L, R } = render(proc, 12, tt =>
        0.6 * Math.sin(2 * Math.PI * 440 * tt) + 0.2 * (Math.random() * 2 - 1));
      if (!finite(L) || !finite(R)) { bad++; console.log(`    non-finite at ${p.id}=${t}`); }
      loudest = Math.max(loudest, peak(L), peak(R));
    }
    proc.pTarget[i] = p.value;
  }
  ok('no NaN/Inf across the full parameter space', bad === 0, `${bad} failures`);
  ok('never exceeds full scale', loudest <= 1.0, `peak=${loudest.toFixed(4)}`);
}

console.log('\n--- effects under stress ---');
{
  const proc = makeProc({
    gate: -80, inGain: 18, master: 6, dry: 1, vocLevel: 1.5,
    vaDlyMix: 1, vaDlyFb: 0.95, vaRevMix: 1, vaRevSize: 1, vaRevDamp: 0,
    vbDlyMix: 1, vbDlyFb: 0.95, vbRevMix: 1, vbRevSize: 1, vbRevDamp: 0,
    lfo1Depth: 1, lfo1Dest: 1, lfo2Depth: 1, lfo2Dest: 4,
  });
  for (let i = 0; i < 6; i++) proc.handleMidi(0x90, 40 + i * 4, 120);
  const { L, R } = render(proc, 1500, () => (Math.random() * 2 - 1) * 2);
  ok('maximum feedback stays finite', finite(L) && finite(R));
  ok('maximum feedback stays inside full scale', peak(L) <= 1.0 && peak(R) <= 1.0,
     `peak=${peak(L).toFixed(4)}`);

  // Sweeping tempo and divisions must not click or blow up.
  const sweep = makeProc({ gate: -80, dry: 1, vaDlyMix: 1, vaDlyFb: 0.7, master: 0 });
  let bad = 0;
  for (const bpm of [60, 220, 90, 174, 128]) {
    for (let d = 0; d < Pm.DIVISIONS.length; d++) {
      sweep.pTarget[Pm.PARAM_INDEX.bpm] = bpm;
      sweep.pTarget[Pm.PARAM_INDEX.vaDlyDiv] = d;
      const o = render(sweep, 20, t => 0.4 * Math.sin(2 * Math.PI * 300 * t));
      if (!finite(o.L) || peak(o.L) > 1.0) bad++;
    }
  }
  ok('every tempo x division combination is stable', bad === 0, `${bad} bad`);
}

console.log('\n--- extreme input ---');
{
  const proc = makeProc({ inGain: 24, vocLevel: 1.5, master: 12 });
  proc.handleMidi(0x90, 36, 127);
  const { L, R } = render(proc, 120, () => (Math.random() * 2 - 1) * 4);  // overdriven
  ok('survives a hot clipped input', finite(L) && finite(R));
  ok('stays inside full scale', peak(L) <= 1.0 && peak(R) <= 1.0, `peak=${peak(L).toFixed(4)}`);
}

console.log('\n--- LFO tempo sync ---');
{
  // The LFO cycle must equal its division at the set tempo.
  for (const [bpm, label] of [[120, '1/4'], [120, '1/1'], [90, '1/2'], [140, '1/8']]) {
    const idx = Pm.DIVISIONS.findIndex(d => d.label === label);
    const beats = Pm.DIVISIONS[idx].beats;
    const proc = makeProc({ gate: -80, bpm, lfo1Rate: idx, lfo1Wave: 0, lfo1Depth: 0 });
    // Phase advance per block gives the cycle length exactly; counting wraps
    // loses whichever cycle lands on the window boundary.
    proc.updateLfos();
    const p1 = proc.lfoPhase[0];
    proc.updateLfos();
    let d = proc.lfoPhase[0] - p1;
    if (d < 0) d += 1;
    const measured = (RQ / SR) / d;
    const expected = beats * (60 / bpm);
    ok(`${bpm} bpm ${label} -> ${expected.toFixed(3)}s cycle`,
       Math.abs(measured - expected) / expected < 0.001,
       `measured ${measured.toFixed(4)}s`);
  }
}

console.log('\n--- LFO shapes ---');
{
  const shape = (wave, rateLabel = '1/16', blocks = 2400) => {
    const proc = makeProc({ gate: -80, bpm: 120, lfo1Wave: wave, lfo1Depth: 0,
                            lfo1Rate: Pm.DIVISIONS.findIndex(d => d.label === rateLabel) });
    const out = [];
    for (let i = 0; i < blocks; i++) { proc.updateLfos(); out.push(proc.lfoVal[0]); }
    return out;
  };
  for (const [wave, name] of [[0, 'SINE'], [1, 'TRI'], [2, 'SAW'], [3, 'RAMP'], [4, 'SQR'], [5, 'S&H']]) {
    const v = shape(wave);
    ok(`${name} stays in [-1,1]`, v.every(x => x >= -1.0001 && x <= 1.0001),
       `min=${Math.min(...v).toFixed(3)} max=${Math.max(...v).toFixed(3)}`);
    ok(`${name} uses its range`, Math.max(...v) - Math.min(...v) > 1.2,
       `span=${(Math.max(...v) - Math.min(...v)).toFixed(3)}`);
  }
  const sq = shape(4);
  ok('SQR is two-valued', sq.every(x => Math.abs(Math.abs(x) - 1) < 1e-9));
  // Slow rate: S&H should latch only a handful of times.
  const sh = shape(5, '1/2', 400);
  let changes = 0;
  for (let i = 1; i < sh.length; i++) if (sh[i] !== sh[i - 1]) changes++;
  ok('S&H holds its value between steps', changes >= 1 && changes <= 3, `changes=${changes}`);
  const shFast = shape(5, '1/16', 2400);
  let runs = 0;
  for (let i = 1; i < shFast.length; i++) if (shFast[i] !== shFast[i - 1]) runs++;
  ok('S&H steps once per cycle', runs > 20 && runs < 70, `steps=${runs}`);
}

console.log('\n--- LFO routing ---');
{
  const fIdx = Pm.PARAM_INDEX.formant;
  // Depth 0 must leave every parameter untouched.
  const off = makeProc({ gate: -80, lfo1Dest: 1, lfo1Depth: 0 });
  for (let i = 0; i < 400; i++) { off.updateLfos(); off.applyMod(); }
  ok('depth 0 modulates nothing',
     off.pm.every((v, i) => Math.abs(v - off.p[i]) < 1e-12));

  // Full depth on FORMANT should sweep most of its range and never leave it.
  const on = makeProc({ gate: -80, bpm: 120, lfo1Rate: Pm.DIVISIONS.findIndex(d => d.label === '1/4'),
                        lfo1Wave: 0, lfo1Depth: 1, lfo1Dest: 1, formant: 0 });
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 400; i++) {
    on.updateLfos(); on.applyMod();
    lo = Math.min(lo, on.pm[fIdx]); hi = Math.max(hi, on.pm[fIdx]);
  }
  const def = Pm.PARAM_BY_ID.formant;
  ok('full depth sweeps a wide range', hi - lo > (def.max - def.min) * 0.4,
     `${lo.toFixed(2)}..${hi.toFixed(2)}`);
  ok('modulation stays inside the parameter range',
     lo >= def.min - 1e-6 && hi <= def.max + 1e-6, `${lo}..${hi}`);

  // An exponential destination must move by ratio, not by linear offset.
  const sIdx = Pm.PARAM_INDEX.sibHz;
  const exp = makeProc({ gate: -80, bpm: 120, lfo1Rate: Pm.DIVISIONS.findIndex(d => d.label === '1/4'),
                         lfo1Wave: 0, lfo1Depth: 0.5, lfo1Dest: 2 });
  let elo = Infinity, ehi = -Infinity;
  for (let i = 0; i < 400; i++) {
    exp.updateLfos(); exp.applyMod();
    elo = Math.min(elo, exp.pm[sIdx]); ehi = Math.max(ehi, exp.pm[sIdx]);
  }
  const centre = exp.p[sIdx];
  const upRatio = ehi / centre, downRatio = centre / elo;
  ok('log destination sweeps symmetrically in ratio',
     Math.abs(upRatio - downRatio) / upRatio < 0.05,
     `up x${upRatio.toFixed(3)} down x${downRatio.toFixed(3)}`);

  // Routing to an effect parameter has to work like any other destination.
  const fx = makeProc({ gate: -80, lfo1Depth: 1, lfo1Dest: 15, vaRevMix: 0.5 });
  let moved = false;
  for (let i = 0; i < 400; i++) {
    fx.updateLfos(); fx.applyMod();
    if (Math.abs(fx.pm[Pm.PARAM_INDEX.vaRevMix] - 0.5) > 0.05) moved = true;
  }
  ok('LFO can target an effect control', moved);
}

console.log('\n--- echo ---');
{
  // Impulse in, measure where the repeat lands.
  const mkEcho = (bpm, label, extra = {}) => {
    const idx = Pm.DIVISIONS.findIndex(d => d.label === label);
    const proc = makeProc({
      gate: -80, inHpf: 20, master: 0, limiter: 0, vocLevel: 0, dry: 1, bleed: 0,
      vaDlyDiv: idx, vaDlyFb: 0, vaDlyMix: 1, vaDlyPing: 0, vaDlyTone: 16000,
      vaRevMix: 0, bpm, ...extra,
    });
    let fired = false;
    const { L, R } = render(proc, 400, (t, i) => {
      if (!fired && i > 256) { fired = true; return 1; }
      return 0;
    });
    return { L, R, expected: Pm.DIVISIONS[idx].beats * (60 / bpm) * SR };
  };

  for (const [bpm, label] of [[120, '1/16'], [120, '1/8'], [90, '1/8']]) {
    const { L, expected } = mkEcho(bpm, label);
    // Direct hit is near sample 257; find the next peak after it.
    let peak = -1, best = 0;
    for (let i = 600; i < L.length; i++) {
      const a = Math.abs(L[i]);
      if (a > best) { best = a; peak = i; }
    }
    const measured = peak - 257;
    ok(`${bpm} bpm ${label} echo at ${(expected / SR * 1000).toFixed(0)} ms`,
       Math.abs(measured - expected) / expected < 0.02,
       `measured ${measured} vs ${expected.toFixed(0)} samples`);
  }

  // Feedback must produce decaying repeats.
  const fb = mkEcho(120, '1/16', { vaDlyFb: 0.6 });
  const peaks = [];
  const step = Math.round(fb.expected);
  for (let k = 1; k <= 3; k++) {
    let m = 0;
    for (let i = 257 + k * step - 40; i < 257 + k * step + 40; i++) m = Math.max(m, Math.abs(fb.L[i]));
    peaks.push(m);
  }
  ok('repeats decay with feedback', peaks[0] > peaks[1] && peaks[1] > peaks[2],
     peaks.map(p => p.toFixed(4)).join(' > '));

  // Tone control darkens the tail.
  const bright = mkEcho(120, '1/16', { vaDlyFb: 0.7, vaDlyTone: 16000 });
  const dark = mkEcho(120, '1/16', { vaDlyFb: 0.7, vaDlyTone: 800 });
  const hf = b => magAt(b, 6000, 1024, 8192);
  ok('TONE darkens the repeats', hf(dark.L) < hf(bright.L) * 0.6,
     `dark=${hf(dark.L).toExponential(2)} bright=${hf(bright.L).toExponential(2)}`);

  // Ping-pong alternates sides.
  const pp = mkEcho(120, '1/16', { vaDlyFb: 0.65, vaDlyPing: 1 });
  const at = (buf, k) => {
    let m = 0;
    for (let i = 257 + k * step - 40; i < 257 + k * step + 40; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  };
  ok('ping-pong puts repeat 1 left', at(pp.L, 1) > at(pp.R, 1) * 8,
     `L=${at(pp.L, 1).toFixed(4)} R=${at(pp.R, 1).toFixed(4)}`);
  ok('ping-pong puts repeat 2 right', at(pp.R, 2) > at(pp.L, 2) * 8,
     `L=${at(pp.L, 2).toFixed(4)} R=${at(pp.R, 2).toFixed(4)}`);
}

console.log('\n--- reverb ---');
{
  seedRandom(0xBEEF);
  const mkVerb = (over = {}) => makeProc({
    gate: -80, inHpf: 20, master: 0, limiter: 0, vocLevel: 0, dry: 1, bleed: 0,
    vaDlyMix: 0, vaRevMix: 1, vaRevSize: 0.7, vaRevDamp: 0.3, vaRevPre: 0, ...over,
  });
  const burst = (proc, blocks = 500) => {
    seedRandom(0xBEEF);                       // identical excitation every time
    const out = render(proc, blocks, (t, i) => (i < 2048 ? (Math.random() * 2 - 1) * 0.5 : 0));
    return out;
  };

  const v = mkVerb();
  const { L, R } = burst(v);
  const tailAt = (b, from) => rms(b.subarray(from, from + 4096));
  ok('reverb rings on after the source stops', tailAt(L, 6000) > 1e-4,
     `tail=${tailAt(L, 6000).toExponential(2)}`);
  ok('reverb tail decays', tailAt(L, 6000) > tailAt(L, 40000) * 2,
     `${tailAt(L, 6000).toExponential(2)} -> ${tailAt(L, 40000).toExponential(2)}`);
  ok('reverb output is finite', finite(L) && finite(R));
  let diff = 0;
  for (let i = 6000; i < 30000; i++) diff += Math.abs(L[i] - R[i]);
  ok('reverb tail is stereo', diff / 24000 > 1e-5, `diff=${(diff / 24000).toExponential(2)}`);

  const small = burst(mkVerb({ vaRevSize: 0.05 }));
  const big = burst(mkVerb({ vaRevSize: 1 }));
  ok('SIZE lengthens the tail',
     tailAt(big.L, 40000) > tailAt(small.L, 40000) * 2,
     `big=${tailAt(big.L, 40000).toExponential(2)} small=${tailAt(small.L, 40000).toExponential(2)}`);

  const damped = burst(mkVerb({ vaRevDamp: 1 }));
  const open = burst(mkVerb({ vaRevDamp: 0 }));
  ok('DAMP removes high frequencies from the tail',
     magAt(damped.L, 7000, 8192, 16384) < magAt(open.L, 7000, 8192, 16384) * 0.7,
     `damped=${magAt(damped.L, 7000, 8192, 16384).toExponential(2)}`);

  // Predelay must hold the tail back.
  const pre = mkVerb({ vaRevPre: 150 });
  let impulseFired = false;
  const pr = render(pre, 300, (t, i) => (i === 300 ? 1 : 0));
  const early = rms(pr.L.subarray(400, 400 + 2048));
  const late = rms(pr.L.subarray(300 + Math.round(0.15 * SR), 300 + Math.round(0.15 * SR) + 2048));
  ok('PREDELAY holds the tail back', late > early * 3,
     `early=${early.toExponential(2)} late=${late.toExponential(2)}`);
  restoreRandom();
}

console.log('\n--- effect busses are independent ---');
{
  seedRandom(0xC0FFEE);
  const base = {
    gate: -80, inHpf: 20, master: 0, limiter: 0, bleed: 0,
    vaDlyMix: 0, vbDlyMix: 0, vaRevMix: 0, vbRevMix: 0,
  };
  const run = over => {
    seedRandom(0xC0FFEE);                     // identical excitation every time
    const proc = makeProc({ ...base, ...over });
    proc.handleMidi(0x90, 48, 100);
    return render(proc, 600, (t, i) => (i < 4096 ? (Math.random() * 2 - 1) * 0.5 : 0));
  };
  const tail = b => rms(b.subarray(30000, 40000));

  // Reverb on the voice bus only: audible when dry is up, silent when it is not.
  const voiceVerb = run({ dry: 1, vocLevel: 0, vaRevMix: 1 });
  const vocOnly = run({ dry: 0, vocLevel: 1, vaRevMix: 1 });
  ok('voice-bus reverb reaches the output through the dry path',
     tail(voiceVerb.L) > 1e-4, `tail=${tail(voiceVerb.L).toExponential(2)}`);
  ok('voice-bus reverb does not leak into the vocoder bus',
     tail(vocOnly.L) < tail(voiceVerb.L) * 0.05,
     `voc=${tail(vocOnly.L).toExponential(2)} voice=${tail(voiceVerb.L).toExponential(2)}`);

  // And the mirror image.
  const vocVerb = run({ dry: 0, vocLevel: 1, vbRevMix: 1 });
  const dryOnly = run({ dry: 1, vocLevel: 0, vbRevMix: 1 });
  ok('vocoder-bus reverb reaches the output',
     tail(vocVerb.L) > 1e-5, `tail=${tail(vocVerb.L).toExponential(2)}`);
  ok('vocoder-bus reverb does not leak into the voice bus',
     tail(dryOnly.L) < tail(vocVerb.L) * 0.05,
     `dry=${tail(dryOnly.L).toExponential(2)} voc=${tail(vocVerb.L).toExponential(2)}`);

  // Each bus can carry a different echo time at the same tempo.
  const a = Pm.DIVISIONS.findIndex(d => d.label === '1/16');
  const b = Pm.DIVISIONS.findIndex(d => d.label === '1/4');
  const split = makeProc({ ...base, dry: 1, vocLevel: 1, bpm: 120,
                           vaDlyDiv: a, vaDlyMix: 1, vbDlyDiv: b, vbDlyMix: 1 });
  const sp = render(split, 400, (t, i) => (i === 300 ? 1 : 0));
  ok('busses run different echo times simultaneously',
     finite(sp.L) && peak(sp.L) > 1e-4);
  restoreRandom();
}

console.log('\n--- effects are transparent at zero mix ---');
{
  // The carrier seeds its oscillator phases randomly and the sibilance path
  // uses noise, so pin the PRNG or two runs can never be compared sample
  // for sample regardless of what the effects do.
  const mk = over => {
    seedRandom(12345);
    const proc = makeProc({ gate: -80, master: 0, limiter: 0, dry: 1,
                            vaDlyMix: 0, vaRevMix: 0, vbDlyMix: 0, vbRevMix: 0, ...over });
    proc.handleMidi(0x90, 48, 100);
    const out = render(proc, 150, t => 0.4 * Math.sin(2 * Math.PI * 440 * t));
    restoreRandom();
    return out;
  };
  const plain = mk({});
  const loaded = mk({ vaRevSize: 1, vaDlyFb: 0.9, vbRevSize: 0.2, vbDlyFb: 0.9 });
  let maxDiff = 0;
  for (let i = 0; i < plain.L.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(plain.L[i] - loaded.L[i]));
  }
  ok('zero mix is bit-identical regardless of effect settings', maxDiff === 0,
     `maxDiff=${maxDiff}`);
}

console.log('\n--- allocation discipline ---');
{
  // GC pauses on the render thread are dropouts, so measure two things:
  // what the processor retains, and how much transient garbage it makes.
  const proc = makeProc({ gate: -80 });
  proc.handleMidi(0x90, 48, 100);
  const drive = t => 0.4 * Math.sin(2 * Math.PI * 500 * t);
  render(proc, 4000, drive);                       // warm up, let the JIT settle

  // Drive process() directly with pre-built argument structures. render()
  // allocates two large capture buffers and a fresh [[in]]/[[out]] pair every
  // block, which would otherwise be charged to the DSP.
  const N = 40000;                                 // ~107 s of audio
  const inBuf = new Float32Array(RQ);
  const oL = new Float32Array(RQ), oR = new Float32Array(RQ);
  const argIn = [[inBuf]], argOut = [[oL, oR]], argParams = {};
  for (let i = 0; i < RQ; i++) inBuf[i] = 0.4 * Math.sin(2 * Math.PI * 500 * i / SR);
  const spin = k => { for (let i = 0; i < k; i++) proc.process(argIn, argOut, argParams); };
  spin(6000);                                      // warm up

  if (typeof global.gc === 'function') {
    global.gc(); global.gc();
    const r0 = process.memoryUsage().heapUsed;
    spin(N);
    global.gc(); global.gc();
    const retained = (process.memoryUsage().heapUsed - r0) / N;
    ok('retains nothing per block', Math.abs(retained) < 2,
       `${retained.toFixed(3)} B/block retained`);

    // heapUsed deltas are a coarse instrument at this granularity - a single
    // sample swings by tens of bytes per block - so take the minimum of
    // several runs, which is the least GC-contaminated estimate. The bound is
    // deliberately loose: any allocation inside a per-sample loop would show
    // up as thousands of bytes per block, not tens.
    const samples = [];
    for (let r = 0; r < 5; r++) {
      global.gc(); global.gc();
      const t0 = process.memoryUsage().heapUsed;
      spin(N);
      samples.push((process.memoryUsage().heapUsed - t0) / N);
    }
    const transient = Math.min(...samples);
    console.log(`  transient garbage: ${transient.toFixed(1)} B/block` +
                ` (runs: ${samples.map(x => x.toFixed(0)).join(", ")})`);
    ok('no per-sample allocation on the render thread', transient < 64,
       `${transient.toFixed(1)} B/block`);
  } else {
    console.log('  note  run with --expose-gc to measure allocation');
  }
}

console.log('\n--- throughput headroom ---');
{
  const proc = makeProc({ gate: -80, bands: 32, unison: 7, dry: 1,
                          vaDlyMix: 1, vaDlyFb: 0.6, vaRevMix: 1,
                          vbDlyMix: 1, vbDlyFb: 0.6, vbRevMix: 1,
                          lfo1Depth: 0.5, lfo1Dest: 1, lfo2Depth: 0.5, lfo2Dest: 6 });
  for (let i = 0; i < 8; i++) proc.handleMidi(0x90, 40 + i * 3, 100);
  const blocks = 4000;
  render(proc, 20, t => Math.sin(t));
  const t0 = performance.now();
  render(proc, blocks, t => 0.4 * Math.sin(2 * Math.PI * 440 * t));
  const ms = performance.now() - t0;
  const realtime = (blocks * RQ / SR) * 1000;
  const ratio = ms / realtime;
  console.log(`  worst case: 32 bands, 8 voices x 7 unison, both FX busses, 2 LFOs` +
              ` -> ${(ratio * 100).toFixed(1)}% of one core`);
  ok('worst case under 25% of realtime', ratio < 0.25, `${(ratio * 100).toFixed(1)}%`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
