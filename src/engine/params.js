// Single source of truth for every control in the instrument.
// The main thread uses the full definitions (UI, formatting, curves).
// The audio thread only ever receives the id->index map via processorOptions,
// so this module never needs to be imported inside the AudioWorklet.

const def = (id, label, min, max, value, o = {}) => ({
  id, label, min, max, value,
  curve: 'lin',       // 'lin' | 'exp' | 'pow'
  unit: '',
  group: 'mix',
  discrete: false,    // true => no smoothing in the DSP, stepped in the UI
  bipolar: false,
  ...o,
});


// ---------------------------------------------------------------- tempo tables
// Rhythmic divisions, measured in quarter-note beats. Shared by the LFO rates
// and the delay times so everything locks to one TEMPO.
export const DIVISIONS = [
  { label: '1/32',  beats: 0.125 },
  { label: '1/16T', beats: 1 / 6 },
  { label: '1/16',  beats: 0.25 },
  { label: '1/16.', beats: 0.375 },
  { label: '1/8T',  beats: 1 / 3 },
  { label: '1/8',   beats: 0.5 },
  { label: '1/8.',  beats: 0.75 },
  { label: '1/4T',  beats: 2 / 3 },
  { label: '1/4',   beats: 1 },
  { label: '1/4.',  beats: 1.5 },
  { label: '1/2T',  beats: 4 / 3 },
  { label: '1/2',   beats: 2 },
  { label: '1/2.',  beats: 3 },
  { label: '1/1',   beats: 4 },
  { label: '2/1',   beats: 8 },
  { label: '4/1',   beats: 16 },
];
const clampIdx = v => Math.min(DIVISIONS.length - 1, Math.max(0, Math.round(v)));

export const LFO_WAVES = ['SINE', 'TRI', 'SAW', 'RAMP', 'SQR', 'S&H'];

// LFO destinations. Each routes to a real parameter and is modulated in that
// parameter's own curve space, so sweeping a frequency sounds musical rather
// than lopsided towards the top of its range.
export const MOD_DESTS = [
  { label: '— off —',      param: null },
  { label: 'Formant',      param: 'formant' },
  { label: 'Sibilance frq',param: 'sibHz' },
  { label: 'Band low',     param: 'fLow' },
  { label: 'Band high',    param: 'fHigh' },
  { label: 'Resonance Q',  param: 'qMul' },
  { label: 'Tilt',         param: 'tilt' },
  { label: 'Osc shape',    param: 'shape' },
  { label: 'Pulse width',  param: 'pw' },
  { label: 'Detune',       param: 'detune' },
  { label: 'Pitch',        param: 'fine' },
  { label: 'Vocoder level',param: 'vocLevel' },
  { label: 'Dry voice',    param: 'dry' },
  { label: 'Brightness',   param: 'bright' },
  { label: 'Echo · voice', param: 'vaDlyMix' },
  { label: 'Verb · voice', param: 'vaRevMix' },
  { label: 'Echo · vocoder', param: 'vbDlyMix' },
  { label: 'Verb · vocoder', param: 'vbRevMix' },
];

export const PARAMS = [
  // ---------------------------------------------------------------- VOICE (modulator)
  def('inGain',   'INPUT',   -24, 24,   0,   { unit: 'dB', group: 'voice', bipolar: true }),
  def('inHpf',    'HI-PASS',  20, 400,  85,  { unit: 'Hz', group: 'voice', curve: 'exp' }),
  def('gate',     'GATE',    -80, -10, -58,  { unit: 'dB', group: 'voice',
                                               fmt: v => (v <= -79.5 ? 'OFF' : v.toFixed(0) + ' dB') }),

  // ---------------------------------------------------------------- CARRIER (synth)
  def('shape',    'SHAPE',     0, 1,    0.30, { group: 'carrier', unit: '%',
                                                hint: 'saw → pulse' }),
  def('pw',       'WIDTH',     0.05, 0.95, 0.5, { group: 'carrier', unit: '%' }),
  def('unison',   'UNISON',    1, 7,    3,    { group: 'carrier', discrete: true, step: 1,
                                                fmt: v => v.toFixed(0) + '×' }),
  def('detune',   'DETUNE',    0, 60,   14,   { group: 'carrier', unit: 'ct' }),
  def('sub',      'SUB',       0, 1,    0.40, { group: 'carrier', unit: '%' }),
  def('subOct',   'SUB OCT',   0, 1,    0,    { group: 'carrier', discrete: true,
                                                options: [{ label: '-1', value: 0 },
                                                          { label: '-2', value: 1 }] }),
  def('air',      'AIR',       0, 0.5,  0.05, { group: 'carrier', unit: '%',
                                                hint: 'broadband noise in the carrier' }),
  def('drive',    'DRIVE',     0, 1,    0.20, { group: 'carrier', unit: '%' }),
  def('octave',   'OCTAVE',   -2, 2,    0,    { group: 'carrier', discrete: true, bipolar: true,
                                                options: [{ label: '-2', value: -2 },
                                                          { label: '-1', value: -1 },
                                                          { label: '0',  value: 0 },
                                                          { label: '+1', value: 1 },
                                                          { label: '+2', value: 2 }] }),
  def('fine',     'FINE',    -50, 50,   0,    { group: 'carrier', unit: 'ct', bipolar: true }),
  def('glide',    'GLIDE',     0, 400,  0,    { group: 'carrier', unit: 'ms', curve: 'pow', pow: 2 }),
  def('atk',      'ATTACK',    0.2, 500, 2,   { group: 'carrier', unit: 'ms', curve: 'exp' }),
  def('dec',      'DECAY',     2, 2000, 300,  { group: 'carrier', unit: 'ms', curve: 'exp' }),
  def('sus',      'SUSTAIN',   0, 1,    1,    { group: 'carrier', unit: '%' }),
  def('rel',      'RELEASE',   2, 2000, 90,   { group: 'carrier', unit: 'ms', curve: 'exp' }),
  def('voiceMode','MODE',      0, 2,    0,    { group: 'carrier', discrete: true,
                                                options: [{ label: 'POLY',   value: 0 },
                                                          { label: 'MONO',   value: 1 },
                                                          { label: 'LEGATO', value: 2 }] }),
  def('velSens',  'VELOCITY',  0, 1,    0.25, { group: 'carrier', unit: '%' }),
  def('bendRange','BEND',      0, 12,   2,    { group: 'carrier', discrete: true, step: 1,
                                                fmt: v => '±' + v.toFixed(0) }),
  def('vibDepth', 'VIBRATO',   0, 100,  30,   { group: 'carrier', unit: 'ct',
                                                hint: 'depth at full mod wheel' }),
  def('hold',     'HOLD',      0, 1,    0,    { group: 'carrier', discrete: true, toggle: true }),

  // ---------------------------------------------------------------- VOCODER
  def('bands',    'BANDS',     12, 32,  24,   { group: 'vocoder', discrete: true,
                                                options: [12, 16, 20, 24, 28, 32]
                                                  .map(v => ({ label: String(v), value: v })) }),
  def('fLow',     'LOW',       60, 500, 120,  { group: 'vocoder', unit: 'Hz', curve: 'exp' }),
  def('fHigh',    'HIGH',      2500, 16000, 9000, { group: 'vocoder', unit: 'Hz', curve: 'exp' }),
  def('qMul',     'Q',         0.4, 3,  1.0,  { group: 'vocoder', unit: '×' }),
  def('vAtk',     'ATTACK',    0.2, 80, 2.5,  { group: 'vocoder', unit: 'ms', curve: 'exp' }),
  def('vRel',     'RELEASE',   2, 400,  16,   { group: 'vocoder', unit: 'ms', curve: 'exp' }),
  def('formant',  'FORMANT',  -8, 8,    0,    { group: 'vocoder', bipolar: true,
                                                fmt: v => (v > 0 ? '+' : '') + v.toFixed(1),
                                                hint: 'shift envelopes across bands' }),
  def('sib',      'SIBILANCE', 0, 1,    0.50, { group: 'vocoder', unit: '%',
                                                hint: 'noise for unvoiced consonants' }),
  def('sibHz',    'SIB FREQ',  1200, 9000, 4200, { group: 'vocoder', unit: 'Hz', curve: 'exp' }),
  def('tilt',     'TILT',     -1, 1,    0.10, { group: 'vocoder', bipolar: true, unit: '%' }),
  def('freeze',   'FREEZE',    0, 1,    0,    { group: 'vocoder', discrete: true, toggle: true }),

  // ---------------------------------------------------------------- OUTPUT
  def('vocLevel', 'VOCODER',   0, 1.5,  1.0,  { group: 'mix', unit: '%' }),
  def('dry',      'DRY VOICE', 0, 1,    0,    { group: 'mix', unit: '%' }),
  def('bleed',    'CARRIER',   0, 1,    0,    { group: 'mix', unit: '%' }),
  def('width',    'WIDTH',     0, 1,    0.35, { group: 'mix', unit: '%',
                                                hint: 'alternate bands across the stereo field' }),
  def('bright',   'BRIGHT',   -1, 1,    0,    { group: 'mix', bipolar: true, unit: '%' }),
  def('master',   'MASTER',  -40, 12,  -3,    { group: 'mix', unit: 'dB', bipolar: true }),
  def('limiter',  'LIMITER',   0, 1,    1,    { group: 'mix', discrete: true, toggle: true }),
  def('limThresh','CEILING', -12, 0,   -1,    { group: 'mix', unit: 'dB' }),  // never positive

  // ---------------------------------------------------------------- TEMPO + MODULATION
  def('bpm',      'TEMPO',    60, 220, 120,  { group: 'mod', discrete: true, step: 1,
                                               fmt: v => v.toFixed(0) + ' bpm' }),

  def('lfo1Rate', 'RATE',      0, 15,  13,   { group: 'mod', discrete: true, step: 1,
                                               fmt: v => DIVISIONS[clampIdx(v)].label,
                                               hint: 'synced to TEMPO' }),
  def('lfo1Wave', 'WAVE',      0, 5,   0,    { group: 'mod', discrete: true, step: 1,
                                               fmt: v => LFO_WAVES[Math.round(v)] || '?' }),
  def('lfo1Depth','DEPTH',     0, 1,   0,    { group: 'mod', unit: '%' }),
  def('lfo1Phase','PHASE',     0, 360, 0,    { group: 'mod', fmt: v => v.toFixed(0) + '\u00b0' }),
  def('lfo1Dest', 'TARGET',    0, 17,  0,    { group: 'mod', discrete: true, select: true,
                                               options: () => MOD_DESTS.map((d, i) => ({ label: d.label, value: i })) }),

  def('lfo2Rate', 'RATE',      0, 15,  11,   { group: 'mod', discrete: true, step: 1,
                                               fmt: v => DIVISIONS[clampIdx(v)].label,
                                               hint: 'synced to TEMPO' }),
  def('lfo2Wave', 'WAVE',      0, 5,   1,    { group: 'mod', discrete: true, step: 1,
                                               fmt: v => LFO_WAVES[Math.round(v)] || '?' }),
  def('lfo2Depth','DEPTH',     0, 1,   0,    { group: 'mod', unit: '%' }),
  def('lfo2Phase','PHASE',     0, 360, 90,   { group: 'mod', fmt: v => v.toFixed(0) + '\u00b0' }),
  def('lfo2Dest', 'TARGET',    0, 17,  0,    { group: 'mod', discrete: true, select: true,
                                               options: () => MOD_DESTS.map((d, i) => ({ label: d.label, value: i })) }),

  // ---------------------------------------------------------------- FX: VOICE bus
  def('vaDlyDiv', 'TIME',      0, 15,  6,    { group: 'fxa', discrete: true, step: 1,
                                               fmt: v => DIVISIONS[clampIdx(v)].label }),
  def('vaDlyFb',  'FEEDBACK',  0, 0.95, 0.35,{ group: 'fxa', unit: '%' }),
  def('vaDlyTone','TONE',      500, 16000, 5000, { group: 'fxa', unit: 'Hz', curve: 'exp',
                                               hint: 'darkens each repeat' }),
  def('vaDlyMix', 'ECHO',      0, 1,   0,    { group: 'fxa', unit: '%' }),
  def('vaDlyPing','PING-PONG', 0, 1,   1,    { group: 'fxa', discrete: true, toggle: true }),
  def('vaRevSize','SIZE',      0, 1,   0.62, { group: 'fxa', unit: '%' }),
  def('vaRevDamp','DAMP',      0, 1,   0.45, { group: 'fxa', unit: '%' }),
  def('vaRevPre', 'PREDELAY',  0, 200, 20,   { group: 'fxa', unit: 'ms' }),
  def('vaRevMix', 'REVERB',    0, 1,   0,    { group: 'fxa', unit: '%' }),

  // ---------------------------------------------------------------- FX: VOCODER bus
  def('vbDlyDiv', 'TIME',      0, 15,  6,    { group: 'fxb', discrete: true, step: 1,
                                               fmt: v => DIVISIONS[clampIdx(v)].label }),
  def('vbDlyFb',  'FEEDBACK',  0, 0.95, 0.35,{ group: 'fxb', unit: '%' }),
  def('vbDlyTone','TONE',      500, 16000, 5000, { group: 'fxb', unit: 'Hz', curve: 'exp',
                                               hint: 'darkens each repeat' }),
  def('vbDlyMix', 'ECHO',      0, 1,   0,    { group: 'fxb', unit: '%' }),
  def('vbDlyPing','PING-PONG', 0, 1,   1,    { group: 'fxb', discrete: true, toggle: true }),
  def('vbRevSize','SIZE',      0, 1,   0.62, { group: 'fxb', unit: '%' }),
  def('vbRevDamp','DAMP',      0, 1,   0.45, { group: 'fxb', unit: '%' }),
  def('vbRevPre', 'PREDELAY',  0, 200, 20,   { group: 'fxb', unit: 'ms' }),
  def('vbRevMix', 'REVERB',    0, 1,   0,    { group: 'fxb', unit: '%' }),
];

export const PARAM_INDEX = Object.freeze(
  Object.fromEntries(PARAMS.map((p, i) => [p.id, i])),
);
export const PARAM_COUNT = PARAMS.length;
export const PARAM_BY_ID = Object.freeze(
  Object.fromEntries(PARAMS.map(p => [p.id, p])),
);
export const DISCRETE_FLAGS = PARAMS.map(p => (p.discrete ? 1 : 0));

export const GROUPS = {
  voice:   { title: 'VOICE',   accent: 'warm' },
  carrier: { title: 'CARRIER', accent: 'cool' },
  vocoder: { title: 'VOCODER', accent: 'warm' },
  mix:     { title: 'OUTPUT',  accent: 'neutral' },
  mod:     { title: 'MODULATION', accent: 'cool' },
  fxa:     { title: 'SPACE \u00b7 VOICE', accent: 'warm' },
  fxb:     { title: 'SPACE \u00b7 VOCODER', accent: 'neutral' },
};

// Destination index -> parameter index, handed to the render thread so it can
// route modulation without knowing anything about the UI.
export function modDestIndices() {
  return MOD_DESTS.map(d => (d.param != null && d.param in PARAM_INDEX ? PARAM_INDEX[d.param] : -1));
}

// Curve descriptors, so the worklet can modulate in normalised space.
export function curveTables() {
  const n = PARAMS.length;
  const min = new Float32Array(n), max = new Float32Array(n);
  const curve = new Int32Array(n), pow = new Float32Array(n);
  PARAMS.forEach((p, i) => {
    min[i] = p.min; max[i] = p.max; pow[i] = p.pow || 2;
    curve[i] = p.curve === 'exp' ? 1 : p.curve === 'pow' ? 2 : 0;
  });
  return { min, max, curve, pow };
}

export const DIVISION_BEATS = Float64Array.from(DIVISIONS.map(d => d.beats));

export function defaultValues() {
  const a = new Float32Array(PARAM_COUNT);
  for (let i = 0; i < PARAM_COUNT; i++) a[i] = PARAMS[i].value;
  return a;
}

// ---------------------------------------------------------------- curves
// Knobs operate on a normalised 0..1 position; the stored value is always real.

export function toNorm(p, v) {
  const x = Math.min(p.max, Math.max(p.min, v));
  switch (p.curve) {
    case 'exp': return Math.log(x / p.min) / Math.log(p.max / p.min);
    case 'pow': return Math.pow((x - p.min) / (p.max - p.min), 1 / (p.pow || 2));
    default:    return (x - p.min) / (p.max - p.min);
  }
}

export function fromNorm(p, n) {
  const t = Math.min(1, Math.max(0, n));
  let v;
  switch (p.curve) {
    case 'exp': v = p.min * Math.pow(p.max / p.min, t); break;
    case 'pow': v = p.min + (p.max - p.min) * Math.pow(t, p.pow || 2); break;
    default:    v = p.min + (p.max - p.min) * t;
  }
  return quantise(p, v);
}

export function optionsOf(p) {
  if (!p.options) return null;
  return typeof p.options === 'function' ? p.options() : p.options;
}

export function quantise(p, v) {
  let x = Math.min(p.max, Math.max(p.min, v));
  const opts = optionsOf(p);
  if (opts) {
    // Snap to the nearest declared option.
    let best = opts[0].value, bd = Infinity;
    for (const o of opts) {
      const d = Math.abs(o.value - x);
      if (d < bd) { bd = d; best = o.value; }
    }
    return best;
  }
  if (p.step) x = Math.round(x / p.step) * p.step;
  return x;
}

// ---------------------------------------------------------------- display
export function format(p, v) {
  if (p.fmt) return p.fmt(v);
  if (p.toggle) return v >= 0.5 ? 'ON' : 'OFF';
  const opts = optionsOf(p);
  if (opts) {
    const o = opts.find(o => o.value === quantise(p, v));
    return o ? o.label : String(v);
  }
  const sign = v > 0 && p.bipolar ? '+' : '';
  switch (p.unit) {
    // Percent is absolute (value x 100), not a fraction of the control's
    // range, so unity gain reads 100% instead of a share of the maximum.
    case '%':  return Math.round(v * 100) + '%';
    case 'dB': return sign + v.toFixed(1) + ' dB';
    case 'Hz': return v >= 1000 ? (v / 1000).toFixed(2) + ' kHz' : v.toFixed(0) + ' Hz';
    case 'ms': return (v < 10 ? v.toFixed(2) : v.toFixed(0)) + ' ms';
    case 'ct': return sign + v.toFixed(0) + ' ct';
    case '×': return v.toFixed(2) + '×';
    default:   return Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0);
  }
}

// format() now returns a complete display string, units included.

// Band centre frequencies. MUST mirror rebuildBank() in the worklet; the
// display labels would otherwise drift away from what the DSP actually does.
// test/dsp.test.mjs asserts the two agree.
export function bandCentres(numBands, fLow, fHigh) {
  const nb = Math.max(4, Math.round(numBands));
  const lo = Math.min(Math.max(fLow, 20), 2000);
  const hi = Math.max(fHigh, lo * 2);
  const bwOct = Math.log2(hi / lo) / nb;
  const out = new Float64Array(nb);
  for (let b = 0; b < nb; b++) out[b] = lo * Math.pow(2, bwOct * (b + 0.5));
  return out;
}
