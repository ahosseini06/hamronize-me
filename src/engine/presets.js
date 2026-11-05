import { PARAMS, PARAM_INDEX, defaultValues } from './params.js';

// Factory patches. Each is a sparse override on top of the defaults.
export const FACTORY = [
  { name: 'Classic Robot', p: {
    bands: 24, fLow: 120, fHigh: 9000, qMul: 1, vAtk: 2.5, vRel: 16,
    shape: 0.3, unison: 3, detune: 14, sub: 0.4, drive: 0.2, sib: 0.5,
    tilt: 0.1, width: 0.35, formant: 0 } },

  { name: 'Choir Machine', p: {
    bands: 32, fLow: 110, fHigh: 10000, qMul: 1.1, vAtk: 12, vRel: 90,
    shape: 0.12, unison: 7, detune: 26, sub: 0.25, drive: 0.1, air: 0.1,
    sib: 0.35, tilt: 0.2, width: 1, atk: 40, rel: 400, vibDepth: 45 } },

  { name: 'Talk Box', p: {
    bands: 16, fLow: 180, fHigh: 7000, qMul: 1.8, vAtk: 1, vRel: 10,
    shape: 0.85, pw: 0.3, unison: 1, detune: 0, sub: 0.5, drive: 0.45,
    sib: 0.6, tilt: 0.25, width: 0, formant: 1, voiceMode: 1, glide: 60 } },

  { name: 'Whisper Pad', p: {
    bands: 28, fLow: 140, fHigh: 12000, qMul: 0.85, vAtk: 25, vRel: 160,
    shape: 0.05, unison: 5, detune: 18, sub: 0.15, air: 0.3, drive: 0,
    sib: 0.9, sibHz: 3000, tilt: 0.45, width: 0.8, atk: 120, rel: 700 } },

  { name: 'Sub Bass Bot', p: {
    bands: 16, fLow: 80, fHigh: 5500, qMul: 1.2, vAtk: 1.5, vRel: 12,
    shape: 0.4, unison: 1, detune: 0, sub: 1, subOct: 1, drive: 0.35,
    octave: -1, sib: 0.3, tilt: -0.35, width: 0.15, voiceMode: 1 } },

  { name: 'Unison Stack', p: {
    bands: 24, fLow: 110, fHigh: 9500, qMul: 1, vAtk: 2, vRel: 14,
    shape: 0.5, pw: 0.42, unison: 7, detune: 22, sub: 0.3, drive: 0.3,
    sib: 0.45, tilt: 0.3, width: 0.75, bright: 0.2 } },

  { name: 'Formant Freak', p: {
    bands: 28, fLow: 130, fHigh: 8000, qMul: 1.9, vAtk: 1.2, vRel: 22,
    shape: 0.6, unison: 3, detune: 10, sub: 0.35, drive: 0.4,
    formant: 4, sib: 0.5, tilt: 0.15, width: 0.5 } },

  { name: 'Clean Speech', p: {
    bands: 32, fLow: 110, fHigh: 11000, qMul: 0.9, vAtk: 1.2, vRel: 9,
    shape: 0.25, unison: 3, detune: 8, sub: 0.3, air: 0.08, drive: 0.15,
    sib: 0.75, sibHz: 3600, tilt: 0.3, dry: 0.18, width: 0.3, bright: 0.15 } },
];

export function valuesFor(patch) {
  const v = defaultValues();
  for (const [id, val] of Object.entries(patch.p || {})) {
    const i = PARAM_INDEX[id];
    if (i !== undefined) v[i] = val;
  }
  return v;
}

const KEY = 'vox.presets';

export function loadUser() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function saveUser(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

export function captureCurrent(name, values) {
  const p = {};
  PARAMS.forEach((def, i) => { p[def.id] = Number(values[i].toFixed(6)); });
  return { name, p, user: true };
}
