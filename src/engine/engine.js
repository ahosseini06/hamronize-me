// Audio engine: owns the AudioContext, the render-thread worklet, the
// microphone capture, and the lock-free transports between them.
//
// Latency strategy, driven by what Chrome actually honours:
//   - Never force a sampleRate on the AudioContext. Forcing a rate the device
//     does not run at inserts a resampler on the output path.
//   - Request the mic at the context's own rate for the same reason.
//   - `latency: {ideal: 0}` on getUserMedia plus all three processing flags off
//     is the single largest win on the input side.
//   - A numeric latencyHint is only a request, so measure and report what we
//     were actually granted rather than assuming.

import { PARAMS, PARAM_INDEX, PARAM_COUNT, DISCRETE_FLAGS, defaultValues,
         modDestIndices, curveTables, DIVISION_BEATS } from './params.js';

const MAX_BANDS = 32;
const VIS_LEN = 16 + MAX_BANDS * 2;
const VIS = {
  inLevel: 0, outL: 1, outR: 2, carrier: 3, voicing: 4,
  load: 5, voices: 6, bands: 7, gate: 8, limit: 9, busyUs: 10,
  lfo1: 11, lfo2: 12,
  env: 16, out: 16 + MAX_BANDS,
};
const MIDI_CAP = 256, MIDI_STRIDE = 4, MIDI_BASE = 2;

export const LATENCY_MODES = [
  { id: 'min',         label: 'MINIMUM',     hint: 0,             desc: 'smallest buffer Chrome will grant' },
  { id: 'interactive', label: 'INTERACTIVE', hint: 'interactive', desc: 'lowest glitch-free buffer' },
  { id: 'balanced',    label: 'BALANCED',    hint: 'balanced',    desc: 'safer on a loaded machine' },
];

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.source = null;
    this.running = false;
    this.shared = false;
    this.values = defaultValues();
    this.vis = new Float32Array(VIS_LEN);
    this.visLayout = VIS;
    this.latencyMode = 'interactive';
    this.deviceId = null;
    this.devices = [];
    this.inputLatency = 0;
    this._pendingParams = false;
    this._err = null;
  }

  get crossOriginIsolated() {
    return typeof globalThis.crossOriginIsolated === 'boolean'
      ? globalThis.crossOriginIsolated : false;
  }

  // ------------------------------------------------------------------ start

  async start({ latencyMode = 'interactive', deviceId = null } = {}) {
    if (this.running) return;
    this.latencyMode = latencyMode;
    this.deviceId = deviceId;

    const mode = LATENCY_MODES.find(m => m.id === latencyMode) || LATENCY_MODES[1];
    // No sampleRate here on purpose: let the context adopt the hardware rate.
    this.ctx = new AudioContext({ latencyHint: mode.hint });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    await this.ctx.audioWorklet.addModule('./worklet/vocoder-processor.js');

    this._initTransport();

    this.node = new AudioWorkletNode(this.ctx, 'vox-machina', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: {
        paramIndex: PARAM_INDEX,
        paramCount: PARAM_COUNT,
        discrete: DISCRETE_FLAGS,
        initial: this.values,
        curves: curveTables(),
        modDest: modDestIndices(),
        divisions: DIVISION_BEATS,
        paramSAB: this.paramSAB || null,
        midiSAB: this.midiSAB || null,
        visSAB: this.visSAB || null,
      },
    });

    this.node.onprocessorerror = e => {
      this._err = 'render thread error';
      this.dispatchEvent(new CustomEvent('error', { detail: 'The audio render thread stopped.' }));
    };
    this.node.port.onmessage = e => {
      const d = e.data;
      if (d && d.type === 'vis' && !this.shared) this.vis.set(d.data);
    };

    await this._openMic();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    // Minimal graph: nothing between the mic, the DSP, and the device.
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);

    this.running = true;
    await this._listDevices();
    this.dispatchEvent(new CustomEvent('started'));
  }

  _initTransport() {
    if (this.crossOriginIsolated && typeof SharedArrayBuffer === 'function') {
      try {
        this.paramSAB = new SharedArrayBuffer(PARAM_COUNT * 4);
        this.midiSAB = new SharedArrayBuffer((MIDI_BASE + MIDI_CAP * MIDI_STRIDE) * 4);
        this.visSAB = new SharedArrayBuffer(VIS_LEN * 4);
        this.paramArr = new Float32Array(this.paramSAB);
        this.midiArr = new Int32Array(this.midiSAB);
        this.vis = new Float32Array(this.visSAB);
        this.paramArr.set(this.values);
        this.shared = true;
        return;
      } catch { /* fall through to postMessage */ }
    }
    this.paramSAB = this.midiSAB = this.visSAB = null;
    this.paramArr = this.midiArr = null;
    this.shared = false;
  }

  async _openMic() {
    const audio = {
      // Every one of these mangles a vocoder's modulator and adds latency.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Chrome-specific duplicates, still honoured in some builds.
      googEchoCancellation: false,
      googAutoGainControl: false,
      googNoiseSuppression: false,
      googHighpassFilter: false,
      latency: { ideal: 0 },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: this.ctx.sampleRate },
    };
    if (this.deviceId) audio.deviceId = { exact: this.deviceId };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      if (this.deviceId) {
        // The remembered device may be gone; fall back to the default.
        delete audio.deviceId;
        this.deviceId = null;
        this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } else {
        throw err;
      }
    }

    const track = this.stream.getAudioTracks()[0];
    const st = track ? track.getSettings() : {};
    this.deviceId = st.deviceId || this.deviceId;
    this.inputLatency = typeof st.latency === 'number' ? st.latency : 0;
    this.inputLabel = track ? track.label : 'unknown';
  }

  async _listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter(d => d.kind === 'audioinput')
        .map(d => ({ id: d.deviceId, label: d.label || 'Input' }));
    } catch { this.devices = []; }
  }

  async setDevice(id) {
    if (!this.running || id === this.deviceId) return;
    const oldStream = this.stream;
    const oldSource = this.source;
    const oldId = this.deviceId;
    this.deviceId = id;
    try {
      await this._openMic();
    } catch (err) {
      // Keep the previous input live rather than ending up with silence.
      this.deviceId = oldId;
      this.stream = oldStream;
      throw err;
    }
    if (oldSource) { try { oldSource.disconnect(); } catch {} }
    if (oldStream) oldStream.getTracks().forEach(t => t.stop());
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
    this.dispatchEvent(new CustomEvent('devicechange'));
  }

  // Changing the buffer size means a new AudioContext.
  async setLatencyMode(mode) {
    if (mode === this.latencyMode) return;
    const values = Float32Array.from(this.values);
    await this.stop();
    this.values = values;
    await this.start({ latencyMode: mode, deviceId: this.deviceId });
  }

  async stop() {
    this.running = false;
    try { if (this.source) this.source.disconnect(); } catch {}
    try { if (this.node) this.node.disconnect(); } catch {}
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = this.node = this.stream = this.source = null;
    this.vis = new Float32Array(VIS_LEN);
  }

  // ------------------------------------------------------------------ params

  setParam(id, value) {
    const i = PARAM_INDEX[id];
    if (i === undefined) return;
    this.values[i] = value;
    if (this.paramArr) this.paramArr[i] = value;
    else this._queueParams();
  }

  getParam(id) { return this.values[PARAM_INDEX[id]]; }

  setAll(values) {
    this.values.set(values);
    if (this.paramArr) this.paramArr.set(values);
    else this._queueParams();
  }

  // postMessage fallback: coalesce to one message per frame.
  _queueParams() {
    if (this._pendingParams || !this.node) return;
    this._pendingParams = true;
    requestAnimationFrame(() => {
      this._pendingParams = false;
      if (this.node) {
        this.node.port.postMessage({ type: 'params', values: Float32Array.from(this.values) });
      }
    });
  }

  // ------------------------------------------------------------------ MIDI

  pushMidi(status, d1, d2) {
    if (this.midiArr) {
      const w = Atomics.load(this.midiArr, 0);
      const base = MIDI_BASE + (w & (MIDI_CAP - 1)) * MIDI_STRIDE;
      this.midiArr[base] = status;
      this.midiArr[base + 1] = d1;
      this.midiArr[base + 2] = d2;
      this.midiArr[base + 3] = 0;
      Atomics.store(this.midiArr, 0, (w + 1) | 0);
    } else if (this.node) {
      this.node.port.postMessage({ type: 'midi', data: [status, d1, d2] });
    }
  }

  noteOn(note, vel = 100) { this.pushMidi(0x90, note, vel); }
  noteOff(note) { this.pushMidi(0x80, note, 0); }
  panic() {
    if (this.node) this.node.port.postMessage({ type: 'panic' });
  }

  // ------------------------------------------------------------------ status

  // Reported, not guessed. baseLatency is internal buffering; outputLatency is
  // the device-side path; the input leg comes from the track settings.
  latencyReport() {
    if (!this.ctx) return null;
    const base = this.ctx.baseLatency || 0;
    const output = this.ctx.outputLatency || 0;
    const input = this.inputLatency || 0;
    const quantum = 128 / this.ctx.sampleRate;
    return {
      sampleRate: this.ctx.sampleRate,
      quantumMs: quantum * 1000,
      baseMs: base * 1000,
      outputMs: output * 1000,
      inputMs: input * 1000,
      roundTripMs: (input + base + output) * 1000,
      // True round trip also depends on the driver, which the page cannot see.
      estimated: input === 0,
    };
  }

  readVis() { return this.vis; }
}

export { VIS, VIS_LEN, MAX_BANDS };
