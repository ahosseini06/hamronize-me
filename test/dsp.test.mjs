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
      visSAB: new SharedArrayBuffer(4 * 80),
    },
  });
  // Skip the smoothing ramp so tests see the requested values immediately.
  proc.p.set(initial);
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

console.log('\n--- extreme input ---');
{
  const proc = makeProc({ inGain: 24, vocLevel: 1.5, master: 12 });
  proc.handleMidi(0x90, 36, 127);
  const { L, R } = render(proc, 120, () => (Math.random() * 2 - 1) * 4);  // overdriven
  ok('survives a hot clipped input', finite(L) && finite(R));
  ok('stays inside full scale', peak(L) <= 1.0 && peak(R) <= 1.0, `peak=${peak(L).toFixed(4)}`);
}

console.log('\n--- allocation discipline ---');
{
  // GC pauses on the render thread are dropouts, so measure two things:
  // what the processor retains, and how much transient garbage it makes.
  const proc = makeProc({ gate: -80 });
  proc.handleMidi(0x90, 48, 100);
  const drive = t => 0.4 * Math.sin(2 * Math.PI * 500 * t);
  render(proc, 4000, drive);                       // warm up, let the JIT settle

  const N = 30000;                                 // ~80 s of audio
  if (typeof global.gc === 'function') {
    global.gc(); global.gc();
    const r0 = process.memoryUsage().heapUsed;
    render(proc, N, drive);
    global.gc(); global.gc();
    const retained = (process.memoryUsage().heapUsed - r0) / N;
    ok('retains nothing per block', Math.abs(retained) < 2,
       `${retained.toFixed(3)} B/block retained`);
  } else {
    console.log('  note  run with --expose-gc to also check retention');
  }

  const t0 = process.memoryUsage().heapUsed;
  render(proc, N, drive);
  const transient = (process.memoryUsage().heapUsed - t0) / N;
  console.log(`  transient garbage: ${transient.toFixed(1)} B/block`);
  ok('transient garbage stays trivial', transient < 40, `${transient.toFixed(1)} B/block`);
}

console.log('\n--- throughput headroom ---');
{
  const proc = makeProc({ gate: -80, bands: 32, unison: 7 });
  for (let i = 0; i < 8; i++) proc.handleMidi(0x90, 40 + i * 3, 100);
  const blocks = 4000;
  render(proc, 20, t => Math.sin(t));
  const t0 = performance.now();
  render(proc, blocks, t => 0.4 * Math.sin(2 * Math.PI * 440 * t));
  const ms = performance.now() - t0;
  const realtime = (blocks * RQ / SR) * 1000;
  const ratio = ms / realtime;
  console.log(`  worst case: 32 bands, 8 voices x 7 unison -> ${(ratio * 100).toFixed(1)}% of one core`);
  ok('worst case under 25% of realtime', ratio < 0.25, `${(ratio * 100).toFixed(1)}%`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
