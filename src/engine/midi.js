// Web MIDI input. Gated behind a permission prompt since Chrome 124, so the
// call has to be user-initiated and SecurityError has to be handled.
// Messages go straight into the engine's lock-free ring - never buffered here.

export class MidiIn extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.access = null;
    this.inputs = [];
    this.enabled = new Set();      // input ids we are listening to
    this.seen = new Set();         // ids we have already decided about
    this.learnTarget = null;       // param id awaiting a CC binding
    this.bindings = new Map();     // cc -> param id
    this.state = 'idle';           // idle | granted | denied | unsupported
    this.lastActivity = 0;
  }

  get supported() { return typeof navigator.requestMIDIAccess === 'function'; }

  async connect() {
    if (!this.supported) { this.state = 'unsupported'; return false; }
    try {
      // No sysex: it widens the permission for no benefit here.
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.state = err && err.name === 'SecurityError' ? 'denied' : 'error';
      this.error = err ? err.message : String(err);
      this.dispatchEvent(new Event('change'));
      return false;
    }
    this.state = 'granted';
    this.access.onstatechange = () => this._refresh();
    this._refresh();
    return true;
  }

  _refresh() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()];
    for (const input of this.inputs) {
      // Listen to anything new by default, but never silently re-enable an
      // input the user muted: otherwise muting everything and then plugging a
      // device in would switch them all back on.
      if (!this.seen.has(input.id)) {
        this.seen.add(input.id);
        this.enabled.add(input.id);
      }
      input.onmidimessage = this.enabled.has(input.id) ? (e => this._onMessage(e)) : null;
    }
    this.dispatchEvent(new Event('change'));
  }

  setInputEnabled(id, on) {
    if (on) this.enabled.add(id); else this.enabled.delete(id);
    const input = this.inputs.find(i => i.id === id);
    if (input) input.onmidimessage = on ? (e => this._onMessage(e)) : null;
    this.dispatchEvent(new Event('change'));
  }

  _onMessage(e) {
    const d = e.data;
    if (!d || d.length < 2) return;
    const status = d[0];
    if (status >= 0xf0) return;                 // ignore clock/sysex/realtime
    const type = status & 0xf0;
    const d1 = d[1], d2 = d.length > 2 ? d[2] : 0;
    this.lastActivity = performance.now();

    // MIDI learn consumes the next control change.
    if (type === 0xb0 && this.learnTarget && d1 !== 123 && d1 !== 120) {
      const param = this.learnTarget;
      this.learnTarget = null;
      for (const [cc, p] of [...this.bindings]) if (p === param) this.bindings.delete(cc);
      this.bindings.set(d1, param);
      this.save();
      this.dispatchEvent(new CustomEvent('learned', { detail: { cc: d1, param } }));
      this.dispatchEvent(new Event('change'));
      return;
    }

    if (type === 0xb0 && this.bindings.has(d1)) {
      this.dispatchEvent(new CustomEvent('cc', {
        detail: { param: this.bindings.get(d1), norm: d2 / 127 },
      }));
      // Mod wheel and sustain stay useful to the synth even when mapped.
      if (d1 !== 1 && d1 !== 64) return;
    }

    this.engine.pushMidi(status, d1, d2);
    if (type === 0x90 || type === 0x80) {
      this.dispatchEvent(new CustomEvent('note', {
        detail: { note: d1, on: type === 0x90 && d2 > 0, vel: d2 },
      }));
    }
  }

  learn(paramId) {
    this.learnTarget = paramId;
    this.dispatchEvent(new Event('change'));
  }
  cancelLearn() {
    this.learnTarget = null;
    this.dispatchEvent(new Event('change'));
  }
  unbind(paramId) {
    for (const [cc, p] of [...this.bindings]) if (p === paramId) this.bindings.delete(cc);
    this.save();
    this.dispatchEvent(new Event('change'));
  }
  ccFor(paramId) {
    for (const [cc, p] of this.bindings) if (p === paramId) return cc;
    return null;
  }

  save() {
    try {
      localStorage.setItem('vox.midicc', JSON.stringify([...this.bindings]));
    } catch {}
  }
  load() {
    try {
      const raw = localStorage.getItem('vox.midicc');
      if (raw) this.bindings = new Map(JSON.parse(raw));
    } catch {}
  }
}
