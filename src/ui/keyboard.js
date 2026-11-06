// Playable keyboard: mouse/touch plus the standard two-row computer mapping,
// so the instrument is usable with no MIDI hardware attached.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);

// Lower row plays the base octave, upper row the one above it.
const KEYMAP = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
  ',': 12, l: 13, '.': 14, ';': 15, '/': 16,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21,
  7: 22, u: 23, i: 24, 9: 25, o: 26, 0: 27, p: 28,
};

export class Keyboard {
  constructor(root, engine) {
    this.engine = engine;
    this.root = root;
    this.octave = 3;                 // lowest C shown
    this.octaves = 2;
    this.down = new Map();           // note -> source
    this.external = new Set();       // notes lit by MIDI in
    this.keyEls = new Map();
    this.velocity = 100;

    root.classList.add('keyboard');
    root.innerHTML = `
      <div class="kb-side">
        <button class="kb-oct" data-d="-1" title="Octave down">&minus;</button>
        <span class="kb-octlabel">C<b>3</b></span>
        <button class="kb-oct" data-d="1" title="Octave up">+</button>
      </div>
      <div class="kb-keys"></div>`;
    this.keys = root.querySelector('.kb-keys');
    this.octLabel = root.querySelector('.kb-octlabel b');
    for (const b of root.querySelectorAll('.kb-oct')) {
      b.addEventListener('click', () => this.shift(Number(b.dataset.d)));
    }

    this.build();
    this._bindPointer();
    this._bindKeys();
  }

  shift(d) {
    const next = Math.min(7, Math.max(0, this.octave + d));
    if (next === this.octave) return;
    this.allOff();
    this.octave = next;
    this.octLabel.textContent = String(next);
    this.build();
  }

  build() {
    this.keys.innerHTML = '';
    this.keyEls.clear();
    const base = (this.octave + 1) * 12;      // MIDI: C3 = 48
    const count = this.octaves * 12 + 1;

    // Whites first for layout, blacks absolutely positioned over the seams.
    const whites = [];
    for (let i = 0; i < count; i++) if (!BLACK.has((base + i) % 12)) whites.push(base + i);
    const unit = 100 / whites.length;

    whites.forEach((note, wi) => {
      const el = document.createElement('div');
      el.className = 'kb-key white';
      el.style.left = (wi * unit) + '%';
      el.style.width = unit + '%';
      el.dataset.note = note;
      const n = note % 12;
      if (n === 0) {
        const lab = document.createElement('span');
        lab.textContent = 'C' + (Math.floor(note / 12) - 1);
        el.append(lab);
      }
      this.keys.append(el);
      this.keyEls.set(note, el);
    });

    for (let i = 0; i < count; i++) {
      const note = base + i;
      if (!BLACK.has(note % 12)) continue;
      const below = whites.filter(w => w < note).length;
      if (below === 0 || below >= whites.length) continue;
      const el = document.createElement('div');
      el.className = 'kb-key black';
      el.style.left = `calc(${below * unit}% - ${unit * 0.3}%)`;
      el.style.width = (unit * 0.6) + '%';
      el.dataset.note = note;
      this.keys.append(el);
      this.keyEls.set(note, el);
    }
  }

  noteAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.classList.contains('kb-key')) return null;
    return Number(el.dataset.note);
  }

  press(note, source = 'mouse') {
    if (note == null || this.down.has(note)) return;
    this.down.set(note, source);
    this.engine.noteOn(note, this.velocity);
    this.paint(note);
  }

  release(note) {
    if (note == null || !this.down.has(note)) return;
    this.down.delete(note);
    this.engine.noteOff(note);
    this.paint(note);
  }

  allOff() {
    for (const n of [...this.down.keys()]) this.release(n);
  }

  setExternal(note, on) {
    if (on) this.external.add(note); else this.external.delete(note);
    this.paint(note);
  }

  paint(note) {
    const el = this.keyEls.get(note);
    if (el) el.classList.toggle('on', this.down.has(note) || this.external.has(note));
  }

  _bindPointer() {
    let active = false;
    let last = null;
    const start = e => {
      if (e.button !== undefined && e.button !== 0) return;
      const n = this.noteAt(e.clientX, e.clientY);
      if (n == null) return;
      e.preventDefault();
      active = true; last = n;
      this.keys.setPointerCapture(e.pointerId);
      this.press(n);
    };
    const move = e => {
      if (!active) return;
      const n = this.noteAt(e.clientX, e.clientY);
      if (n !== last) {                        // glissando
        if (last != null) this.release(last);
        if (n != null) this.press(n);
        last = n;
      }
    };
    const end = () => {
      if (!active) return;
      active = false;
      if (last != null) this.release(last);
      last = null;
    };
    this.keys.addEventListener('pointerdown', start);
    this.keys.addEventListener('pointermove', move);
    this.keys.addEventListener('pointerup', end);
    this.keys.addEventListener('pointercancel', end);
    this.keys.addEventListener('pointerleave', e => { if (active && e.buttons === 0) end(); });
  }

  _bindKeys() {
    const typing = el =>
      el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

    window.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === '-' || k === '_') { e.preventDefault(); this.shift(-1); return; }
      if (k === '=' || k === '+') { e.preventDefault(); this.shift(1); return; }
      const off = KEYMAP[k];
      if (off === undefined || e.repeat) return;
      e.preventDefault();
      this.press((this.octave + 1) * 12 + off, 'key');
    });

    window.addEventListener('keyup', e => {
      const off = KEYMAP[e.key.toLowerCase()];
      if (off === undefined) return;
      this.release((this.octave + 1) * 12 + off);
    });

    // Losing focus mid-chord would otherwise leave notes stuck on.
    window.addEventListener('blur', () => this.allOff());
  }
}

export { NAMES };
