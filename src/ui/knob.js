// <vk-knob param="shape"> - the workhorse control.
// Vertical drag, shift for fine, double-click to reset, wheel to nudge,
// right-click for MIDI learn.

import { PARAM_BY_ID, toNorm, fromNorm, format } from '../engine/params.js';
import * as store from './store.js';

const SWEEP = 270;           // degrees of travel
const START = -135;
const R = 15.5;
const CX = 20, CY = 20;

function polar(a) {
  const r = (a - 90) * Math.PI / 180;
  return [CX + R * Math.cos(r), CY + R * Math.sin(r)];
}

function arc(a0, a1) {
  if (Math.abs(a1 - a0) < 0.01) return '';
  const [x0, y0] = polar(a0), [x1, y1] = polar(a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export class Knob extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.id_ = this.getAttribute('param');
    this.def = PARAM_BY_ID[this.id_];
    if (!this.def) { this.textContent = `?${this.id_}`; return; }

    this.classList.add('knob');
    this.tabIndex = 0;
    this.setAttribute('role', 'slider');
    this.setAttribute('aria-label', this.def.label);

    const svg = svgEl('svg', { viewBox: '0 0 40 40', class: 'knob-dial' });
    this.trackEl = svgEl('path', { class: 'knob-track', d: arc(START, START + SWEEP) });
    this.glowEl = svgEl('path', { class: 'knob-glow', d: '' });
    this.valEl = svgEl('path', { class: 'knob-arc', d: '' });
    this.pointEl = svgEl('line', { class: 'knob-point', x1: CX, y1: CY, x2: CX, y2: CY });
    this.capEl = svgEl('circle', { class: 'knob-cap', cx: CX, cy: CY, r: 10.5 });
    svg.append(this.trackEl, this.glowEl, this.valEl, this.capEl, this.pointEl);

    this.labelEl = document.createElement('div');
    this.labelEl.className = 'knob-label';
    this.labelEl.textContent = this.def.label;

    this.valueEl = document.createElement('div');
    this.valueEl.className = 'knob-value';

    this.ccEl = document.createElement('span');
    this.ccEl.className = 'knob-cc';

    this.append(svg, this.labelEl, this.valueEl, this.ccEl);
    if (this.def.hint) this.title = `${this.def.label} - ${this.def.hint}`;

    this.addEventListener('pointerdown', this._down);
    this.addEventListener('dblclick', this._reset);
    this.addEventListener('wheel', this._wheel, { passive: false });
    this.addEventListener('keydown', this._key);
    this.addEventListener('contextmenu', this._ctx);
    this.addEventListener('pointerenter', () => store.touch(this.id_));

    store.register(this.id_, this);
  }

  disconnectedCallback() { store.unregister(this.id_, this); }

  update(v) {
    if (!Number.isFinite(v)) v = this.def.value;
    this.value = v;
    const n = toNorm(this.def, v);
    const a = START + n * SWEEP;
    // Bipolar params fill outward from 12 o'clock so "centred" reads as centred.
    const a0 = this.def.bipolar ? START + 0.5 * SWEEP : START;
    this.valEl.setAttribute('d', arc(a0, a));
    this.glowEl.setAttribute('d', arc(a0, a));
    const [px, py] = polar(a);
    this.pointEl.setAttribute('x2', (CX + (px - CX) * 0.82).toFixed(2));
    this.pointEl.setAttribute('y2', (CY + (py - CY) * 0.82).toFixed(2));
    this.valueEl.textContent = format(this.def, v);
    this.setAttribute('aria-valuenow', String(v));
    this.setAttribute('aria-valuetext', format(this.def, v));
    this.classList.toggle('is-zero', Math.abs(n) < 0.001);
  }

  showCc(cc) {
    this.ccEl.textContent = cc == null ? '' : 'CC' + cc;
    this.classList.toggle('has-cc', cc != null);
  }
  setLearning(on) { this.classList.toggle('learning', on); }

  _commit(norm) {
    if (!Number.isFinite(norm)) return;
    const v = fromNorm(this.def, norm);
    store.set(this.id_, v, this);
    this.update(v);
    store.touch(this.id_);
  }

  _down = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    this.setPointerCapture(e.pointerId);
    this.classList.add('active');
    const startY = e.clientY;
    const startN = toNorm(this.def, this.value);
    const span = (this.def.options || this.def.step) ? 140 : 190;

    const move = ev => {
      const fine = ev.shiftKey ? 0.22 : 1;
      this._commit(startN - ((ev.clientY - startY) / span) * fine);
    };
    const up = () => {
      this.classList.remove('active');
      this.removeEventListener('pointermove', move);
      this.removeEventListener('pointerup', up);
      this.removeEventListener('pointercancel', up);
    };
    this.addEventListener('pointermove', move);
    this.addEventListener('pointerup', up);
    this.addEventListener('pointercancel', up);
  };

  _reset = e => { e.preventDefault(); store.set(this.id_, this.def.value); store.touch(this.id_); };

  _wheel = e => {
    e.preventDefault();
    const step = (e.shiftKey ? 0.004 : 0.02) * (e.deltaY > 0 ? -1 : 1);
    this._commit(toNorm(this.def, this.value) + step);
  };

  _key = e => {
    const big = e.shiftKey ? 0.004 : 0.02;
    let d = 0;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') d = big;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') d = -big;
    else if (e.key === 'Home') { store.set(this.id_, this.def.value); return; }
    else return;
    e.preventDefault();
    this._commit(toNorm(this.def, this.value) + d);
  };

  _ctx = e => {
    e.preventDefault();
    this.dispatchEvent(new CustomEvent('knob-menu', {
      bubbles: true,
      detail: { param: this.id_, x: e.clientX, y: e.clientY },
    }));
  };
}

customElements.define('vk-knob', Knob);
