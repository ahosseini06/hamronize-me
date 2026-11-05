// Segmented selector and on/off toggle, sharing the knob's store plumbing.

import { PARAM_BY_ID, format } from '../engine/params.js';
import * as store from './store.js';

export class Seg extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.id_ = this.getAttribute('param');
    this.def = PARAM_BY_ID[this.id_];
    if (!this.def) return;
    this.classList.add('seg');

    const label = document.createElement('div');
    label.className = 'seg-label';
    label.textContent = this.def.label;

    this.row = document.createElement('div');
    this.row.className = 'seg-row';

    const options = this.def.options
      || Array.from({ length: this.def.max - this.def.min + 1 },
                    (_, i) => ({ label: String(this.def.min + i), value: this.def.min + i }));

    this.buttons = options.map(o => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = o.label;
      b.addEventListener('click', () => { store.set(this.id_, o.value); store.touch(this.id_); });
      this.row.append(b);
      return { b, value: o.value };
    });

    this.append(label, this.row);
    if (this.def.hint) this.title = `${this.def.label} - ${this.def.hint}`;
    this.addEventListener('pointerenter', () => store.touch(this.id_));
    store.register(this.id_, this);
  }
  disconnectedCallback() { store.unregister(this.id_, this); }
  update(v) {
    this.value = v;
    for (const { b, value } of this.buttons) {
      b.classList.toggle('on', Math.abs(value - v) < 1e-6);
    }
  }
  showCc(cc) { this.classList.toggle('has-cc', cc != null); }
  setLearning(on) { this.classList.toggle('learning', on); }
}

export class Toggle extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.id_ = this.getAttribute('param');
    this.def = PARAM_BY_ID[this.id_];
    if (!this.def) return;
    this.classList.add('toggle');

    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'toggle-btn';
    this.btn.innerHTML = `<span class="toggle-led"></span><span>${this.def.label}</span>`;
    this.btn.addEventListener('click', () => {
      store.set(this.id_, this.value >= 0.5 ? 0 : 1);
      store.touch(this.id_);
    });
    this.btn.addEventListener('contextmenu', e => {
      e.preventDefault();
      this.dispatchEvent(new CustomEvent('knob-menu', {
        bubbles: true, detail: { param: this.id_, x: e.clientX, y: e.clientY },
      }));
    });
    this.append(this.btn);
    if (this.def.hint) this.title = `${this.def.label} - ${this.def.hint}`;
    store.register(this.id_, this);
  }
  disconnectedCallback() { store.unregister(this.id_, this); }
  update(v) {
    this.value = v;
    this.btn.classList.toggle('on', v >= 0.5);
    this.btn.setAttribute('aria-pressed', v >= 0.5 ? 'true' : 'false');
  }
  showCc(cc) { this.classList.toggle('has-cc', cc != null); }
  setLearning(on) { this.classList.toggle('learning', on); }
}

customElements.define('vk-seg', Seg);
customElements.define('vk-toggle', Toggle);
