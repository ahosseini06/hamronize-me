// End-to-end check in real Chrome over the DevTools Protocol.
// Uses a fake capture device so the whole mic -> DSP -> output path executes.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 5199);
const CDP_PORT = Number(process.env.CDP_PORT || 9311);
const URL_ = `http://localhost:${PORT}/`;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n} ${x}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP client

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = e => rej(new Error('cdp socket error'));
      this.ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? j(new Error(m.error.message)) : r(m.result);
        } else if (m.method) {
          this.events.push(m);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description
        || r.exceptionDetails.text);
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------- harness

const profile = mkdtempSync(join(tmpdir(), 'vox-chrome-'));
let server, chrome, cdp;

const cleanup = () => {
  if (cdp) cdp.close();
  if (chrome) try { chrome.kill('SIGKILL'); } catch {}
  if (server) try { server.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

try {
  // ---- server
  server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(URL_); if (r.ok) break; } catch {}
    await sleep(100);
  }
  const probe = await fetch(URL_);
  ok('server serves the app', probe.ok, `status=${probe.status}`);
  ok('cross-origin isolation headers present',
     probe.headers.get('cross-origin-opener-policy') === 'same-origin' &&
     /credentialless|require-corp/.test(probe.headers.get('cross-origin-embedder-policy') || ''),
     `coep=${probe.headers.get('cross-origin-embedder-policy')}`);
  const wk = await fetch(URL_ + 'worklet/vocoder-processor.js');
  ok('worklet served as JavaScript',
     (wk.headers.get('content-type') || '').includes('javascript'),
     wk.headers.get('content-type'));

  // ---- chrome
  chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream',   // synthetic mic signal
    '--use-fake-ui-for-media-stream',       // auto-grant capture
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1680,1020',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await sleep(150);
  }
  if (!target) throw new Error('Chrome did not expose a debug target');

  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const consoleMsgs = [];
  const failedReqs = [];
  const origOnMessage = cdp.ws.onmessage;
  cdp.ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push({
        level: m.params.type,
        text: (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '),
      });
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleMsgs.push({
        level: 'exception',
        text: m.params.exceptionDetails?.exception?.description
           || m.params.exceptionDetails?.text || 'exception',
      });
    } else if (m.method === 'Log.entryAdded') {
      consoleMsgs.push({ level: m.params.entry.level, text: m.params.entry.text });
    } else if (m.method === 'Network.loadingFailed') {
      failedReqs.push(m.params.errorText);
    }
    origOnMessage(ev);
  };

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(2200);

  // ---- pre-engage
  ok('page title loaded', (await cdp.eval('document.title')).includes('VOX MACHINA'));
  ok('cross-origin isolated in the page', await cdp.eval('crossOriginIsolated') === true);
  ok('custom elements registered',
     await cdp.eval('!!customElements.get("vk-knob") && !!customElements.get("vk-seg")'));
  ok('all 71 controls built',
     await cdp.eval('document.querySelectorAll("vk-knob,vk-seg,vk-toggle,vk-select").length') === 71);
  ok('no boot error shown', await cdp.eval('document.querySelector("#bootError").hidden') === true);

  // ---- engage
  await cdp.eval('document.querySelector("#engage").click()');
  await sleep(3000);

  const state = await cdp.eval(`(() => {
    const e = __vox.engine;
    return {
      running: e.running,
      shared: e.shared,
      ctxState: e.ctx && e.ctx.state,
      sampleRate: e.ctx && e.ctx.sampleRate,
      currentTime: e.ctx && e.ctx.currentTime,
      report: e.latencyReport(),
      appVisible: !document.querySelector('#app').hidden,
      bootGone: document.querySelector('#boot').classList.contains('gone'),
      transport: document.querySelector('#transportValue').textContent,
      midiState: __vox.midi.state,
    };
  })()`);

  ok('engine running', state.running === true);
  ok('audio context is running', state.ctxState === 'running', state.ctxState);
  ok('app revealed, boot dismissed', state.appVisible && state.bootGone);
  ok('SharedArrayBuffer transport active', state.shared === true,
     `transport=${state.transport}`);
  ok('context clock advancing', state.currentTime > 0, `t=${state.currentTime}`);
  console.log(`  context: ${state.sampleRate} Hz, quantum ${state.report.quantumMs.toFixed(2)} ms`);
  console.log(`  reported latency: base ${state.report.baseMs.toFixed(2)} ms, ` +
              `output ${state.report.outputMs.toFixed(2)} ms, ` +
              `input ${state.report.inputMs.toFixed(2)} ms ` +
              `-> round trip ${state.report.roundTripMs.toFixed(2)} ms`);
  console.log(`  midi: ${state.midiState}`);

  // ---- the DSP is actually running and metering
  await cdp.eval(`(() => {
    const e = __vox.engine;
    [48, 52, 55].forEach(n => e.noteOn(n, 100));
  })()`);
  // Chrome's fake capture device pulses rather than holding a tone, so watch
  // the meters over a window and keep the peak.
  await cdp.eval(`window.__peak = { inLevel: 0, carrier: 0, outL: 0, outR: 0, envSum: 0,
                                     bands: 0, voices: 0, load: 0, finite: true };
    window.__watch = setInterval(() => {
      const e = __vox.engine, V = e.visLayout, v = e.readVis();
      let s = 0; for (let b = 0; b < 32; b++) s += v[V.env + b];
      const p = window.__peak;
      p.inLevel = Math.max(p.inLevel, v[V.inLevel]);
      p.carrier = Math.max(p.carrier, v[V.carrier]);
      p.outL = Math.max(p.outL, v[V.outL]);
      p.outR = Math.max(p.outR, v[V.outR]);
      p.envSum = Math.max(p.envSum, s);
      p.bands = v[V.bands]; p.voices = Math.max(p.voices, v[V.voices]);
      p.load = Math.max(p.load, v[V.load]);
      if (![...v].every(Number.isFinite)) p.finite = false;
    }, 16);`);
  await sleep(4000);
  const live = await cdp.eval('clearInterval(window.__watch), window.__peak');

  ok('worklet reports its band count', live.bands === 24, `bands=${live.bands}`);
  ok('synth voices sounding', live.voices >= 3, `voices=${live.voices}`);
  ok('carrier has signal', live.carrier > 0.001, `carrier=${live.carrier}`);
  ok('fake microphone reaching the analysis bank', live.inLevel > 0.0005,
     `inLevel=${live.inLevel}`);
  ok('band envelopes non-zero', live.envSum > 0.001, `sum=${live.envSum}`);
  ok('vocoder producing output', Math.max(live.outL, live.outR) > 0.0005,
     `L=${live.outL} R=${live.outR}`);
  ok('all telemetry finite', live.finite);
  ok('DSP load measured and sane', live.load > 0 && live.load < 0.5,
     `load=${(live.load * 100).toFixed(1)}%`);
  console.log(`  dsp load in Chrome: ${(live.load * 100).toFixed(1)}% of the render budget`);

  // ---- parameter changes reach the DSP
  await cdp.eval('__vox.store.set("bands", 32); __vox.store.set("formant", 4);');
  await sleep(600);
  const after = await cdp.eval(
    '(() => { const e=__vox.engine; return { bands: e.readVis()[e.visLayout.bands], ' +
    'formant: e.getParam("formant") }; })()');
  ok('band count change applied on the render thread', after.bands === 32, `bands=${after.bands}`);
  ok('formant change stored', Math.abs(after.formant - 4) < 1e-6);
  await cdp.eval('__vox.store.set("bands", 24); __vox.store.set("formant", 0);');

  // ---- UI interaction
  const ui = await cdp.eval(`(() => {
    const k = document.querySelector('vk-knob[param="sib"]');
    const before = __vox.engine.getParam('sib');
    k.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    const after = __vox.engine.getParam('sib');
    const label = k.querySelector('.knob-value').textContent;
    // keyboard widget
    const keys = document.querySelectorAll('.kb-key').length;
    const whites = document.querySelectorAll('.kb-key.white').length;
    // preset load
    __vox.store.setAll(__vox.presets.valuesFor(__vox.presets.FACTORY[2]));
    const talkbox = { bands: __vox.engine.getParam('bands'), mode: __vox.engine.getParam('voiceMode') };
    const knobReflects = document.querySelector('vk-knob[param="qMul"]').querySelector('.knob-value').textContent;
    return { before, after, label, keys, whites, talkbox, knobReflects };
  })()`);
  ok('knob wheel changes the parameter', ui.after > ui.before,
     `${ui.before} -> ${ui.after}`);
  ok('knob renders a formatted value', /^[+-]?[\d.]+/.test(ui.label) && !/NaN|undefined/.test(ui.label), ui.label);
  ok('keyboard built with black and white keys', ui.keys > 24 && ui.whites >= 15,
     `keys=${ui.keys} whites=${ui.whites}`);
  ok('preset load reaches the engine',
     ui.talkbox.bands === 16 && ui.talkbox.mode === 1, JSON.stringify(ui.talkbox));
  ok('widgets redraw after a preset load', ui.knobReflects.includes('1.80'), ui.knobReflects);

  await cdp.eval('__vox.store.setAll(__vox.presets.valuesFor(__vox.presets.FACTORY[0]))');
  await sleep(400);

  // ---- real pointer drag on a knob
  const box = await cdp.eval(`(() => {
    const k = document.querySelector('vk-knob[param="formant"]');
    const b = k.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 20) };
  })()`);
  const beforeDrag = await cdp.eval('__vox.engine.getParam("formant")');
  const pt = (type, y, btn) => cdp.send('Input.dispatchMouseEvent', {
    type, x: box.x, y, button: btn || 'left', buttons: btn === 'none' ? 0 : 1,
    clickCount: 1, pointerType: 'mouse',
  });
  await pt('mousePressed', box.y);
  await pt('mouseMoved', box.y - 40);
  await pt('mouseMoved', box.y - 70);
  await pt('mouseReleased', box.y - 70);
  await sleep(250);
  const afterDrag = await cdp.eval('__vox.engine.getParam("formant")');
  ok('dragging a knob upward raises its value', afterDrag > beforeDrag + 0.5,
     `${beforeDrag} -> ${afterDrag}`);
  ok('drag result is finite', Number.isFinite(afterDrag), String(afterDrag));
  await cdp.eval('__vox.store.set("formant", 0)');

  // ---- computer keyboard plays notes
  await cdp.eval('document.body.focus()');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
  await sleep(500);
  const kbVoices = await cdp.eval('__vox.engine.readVis()[__vox.engine.visLayout.voices]');
  const litKeys = await cdp.eval('document.querySelectorAll(".kb-key.on").length');
  ok('computer keyboard starts a voice', kbVoices >= 1, `voices=${kbVoices}`);
  ok('pressed key is highlighted', litKeys >= 1, `lit=${litKeys}`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
  await sleep(400);
  ok('key release clears the highlight',
     await cdp.eval('document.querySelectorAll(".kb-key.on").length') === 0);

  // ---- freeze holds the spectrum
  await cdp.eval('__vox.store.set("freeze", 1)');
  await sleep(250);
  const f1 = await cdp.eval(`(() => { const e=__vox.engine,V=e.visLayout,v=e.readVis();
    return Array.from({length:8},(_,b)=>v[V.env+b]); })()`);
  await sleep(700);
  const f2 = await cdp.eval(`(() => { const e=__vox.engine,V=e.visLayout,v=e.readVis();
    return Array.from({length:8},(_,b)=>v[V.env+b]); })()`);
  ok('FREEZE holds the envelopes still',
     f1.every((v, i) => Math.abs(v - f2[i]) < 1e-9), JSON.stringify([f1[0], f2[0]]));
  await cdp.eval('__vox.store.set("freeze", 0)');

  // ---- sheets and menus open without throwing
  await cdp.eval('document.querySelector("#latencyPill").click()');
  await sleep(200);
  ok('latency sheet opens with a breakdown',
     await cdp.eval('!!document.querySelector(".sheet") && document.querySelectorAll(".sheet-row").length >= 4'));
  await cdp.eval('document.querySelector("#latencyPill").click()');

  await cdp.eval('document.querySelector("#midiPill").click()');
  await sleep(250);
  ok('MIDI sheet opens', await cdp.eval('!!document.querySelector(".sheet")'));
  await cdp.eval('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
  await sleep(100);

  await cdp.eval('document.querySelector("#savePreset").click()');
  await sleep(250);
  ok('save-preset sheet opens with a name field',
     await cdp.eval('!!document.querySelector("#pname")'));
  const saved = await cdp.eval(`(() => {
    document.querySelector('#pname').value = 'Test Patch';
    document.querySelector('#pdo').click();
    return __vox.presets.loadUser().map(p => p.name);
  })()`);
  ok('preset saves to storage', saved.includes('Test Patch'), JSON.stringify(saved));
  ok('saved preset appears in the picker',
     await cdp.eval('[...document.querySelectorAll("#presetSelect option")].some(o => o.textContent === "Test Patch")'));

  // ---- right-click menu
  await cdp.eval(`document.querySelector('vk-knob[param="sib"]')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }))`);
  await sleep(150);
  ok('right-click menu offers a reset',
     await cdp.eval('!document.querySelector("#ctxMenu").hidden && /Reset to/.test(document.querySelector("#ctxMenu").textContent)'));
  await cdp.eval('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');

  // ---- buffer switch rebuilds the graph cleanly
  const beforeSwitch = await cdp.eval('__vox.engine.ctx.baseLatency');
  await cdp.eval('__vox.engine.setLatencyMode("balanced")');
  await sleep(2500);
  const afterSwitch = await cdp.eval(`(() => {
    const e = __vox.engine;
    return { running: e.running, state: e.ctx && e.ctx.state, mode: e.latencyMode,
             base: e.ctx && e.ctx.baseLatency, shared: e.shared };
  })()`);
  ok('buffer switch leaves the engine running',
     afterSwitch.running && afterSwitch.state === 'running' && afterSwitch.mode === 'balanced',
     JSON.stringify(afterSwitch));
  ok('buffer switch actually changed the buffer', afterSwitch.base !== beforeSwitch,
     `${beforeSwitch} -> ${afterSwitch.base}`);
  await cdp.eval('[48,55].forEach(n => __vox.engine.noteOn(n, 100))');
  await sleep(900);
  ok('audio still renders after the switch',
     await cdp.eval('__vox.engine.readVis()[__vox.engine.visLayout.voices]') >= 2);
  await cdp.eval('__vox.engine.setLatencyMode("interactive")');
  await sleep(2200);

  // ---- panic
  await cdp.eval('document.querySelector("#panic").click()');
  await sleep(900);
  const panicked = await cdp.eval(
    '__vox.engine.readVis()[__vox.engine.visLayout.voices]');
  ok('panic silences all voices', panicked === 0, `voices=${panicked}`);

  // ---- layout sanity at a realistic window size
  const layout = await cdp.eval(`(() => {
    const r = el => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    const overflowing = [...document.querySelectorAll('.panel')].filter(p => {
      const b = p.getBoundingClientRect();
      return b.right > window.innerWidth + 1 || b.left < -1;
    }).map(p => p.querySelector('.panel-head')?.textContent?.trim());
    const cv = document.querySelector('#bands');
    return {
      doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      win: { w: window.innerWidth, h: window.innerHeight },
      canvas: r(cv), canvasBacking: { w: cv.width, h: cv.height },
      overflowing,
      panels: document.querySelectorAll('.panel').length,
    };
  })()`);
  ok('no horizontal overflow', layout.doc.w <= layout.win.w,
     `doc=${layout.doc.w} win=${layout.win.w}`);
  ok('fits the viewport height without scrolling', layout.doc.h <= layout.win.h + 2,
     `doc=${layout.doc.h} win=${layout.win.h}`);
  ok('no panel escapes the viewport', layout.overflowing.length === 0,
     JSON.stringify(layout.overflowing));
  ok('hero canvas sized and DPR-scaled',
     layout.canvas.w > 300 && layout.canvasBacking.w >= layout.canvas.w,
     JSON.stringify(layout));
  ok('all eleven panels present', layout.panels === 11, `panels=${layout.panels}`);

  // Fitting the viewport is worthless if a column is quietly clipping content.
  const clipped = await cdp.eval(`(() => {
    const bad = [];
    for (const el of document.querySelectorAll('.col, .panel, .panel-body, .fxrow, .bottom')) {
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
        const h = el.querySelector('.panel-head');
        bad.push((h ? h.firstChild.textContent.trim() : el.className) +
                 ' ' + el.scrollHeight + '/' + el.clientHeight +
                 ' ' + el.scrollWidth + '/' + el.clientWidth);
      }
    }
    return bad;
  })()`);
  ok('nothing is clipped inside a panel or column', clipped.length === 0,
     JSON.stringify(clipped));

  // ---- LFO runs, is tempo-locked, and reaches its destination
  await cdp.eval(`__vox.store.setAll(__vox.presets.valuesFor(__vox.presets.FACTORY[0]));
    __vox.store.set('bpm', 120);
    __vox.store.set('lfo1Rate', __vox.params.DIVISIONS.findIndex(d => d.label === '1/4'));
    __vox.store.set('lfo1Wave', 0);
    __vox.store.set('lfo1Depth', 1);
    __vox.store.set('lfo1Dest', 1);`);
  await sleep(400);
  const lfoTrace = await cdp.eval(`(async () => {
    const e = __vox.engine, V = e.visLayout;
    const out = [];
    for (let i = 0; i < 90; i++) {
      out.push(e.readVis()[V.lfo1]);
      await new Promise(r => setTimeout(r, 12));
    }
    return out;
  })()`);
  const lmin = Math.min(...lfoTrace), lmax = Math.max(...lfoTrace);
  ok('LFO telemetry is live', lmax - lmin > 1.2, `range ${lmin.toFixed(2)}..${lmax.toFixed(2)}`);
  ok('LFO stays in [-1,1]', lmin >= -1.001 && lmax <= 1.001,
     `${lmin.toFixed(3)}..${lmax.toFixed(3)}`);
  ok('LFO indicator is moving',
     await cdp.eval(`(async () => {
       const d = document.querySelector('[data-lfo="0"]');
       const a = d.style.transform;
       await new Promise(r => setTimeout(r, 180));
       return a !== d.style.transform;
     })()`));

  // Destination dropdown writes through the store.
  ok('destination select routes the LFO',
     await cdp.eval(`(() => {
       const s = document.querySelector('vk-select[param="lfo2Dest"]').querySelector('select');
       s.value = '4'; s.dispatchEvent(new Event('change'));
       return __vox.engine.getParam('lfo2Dest');
     })()`) === 4);
  await cdp.eval("__vox.store.set('lfo1Depth', 0); __vox.store.set('lfo2Dest', 0)");

  // ---- both effect busses run without upsetting the engine
  await cdp.eval(`__vox.store.set('dry', 0.5);
    ['va','vb'].forEach(b => {
      __vox.store.set(b + 'DlyMix', 0.6);
      __vox.store.set(b + 'RevMix', 0.6);
      __vox.store.set(b + 'DlyFb', 0.6);
    });
    [45, 52, 57].forEach(n => __vox.engine.noteOn(n, 100));`);
  await sleep(1800);
  const fxState = await cdp.eval(`(() => {
    const e = __vox.engine, V = e.visLayout, v = e.readVis();
    return { outL: v[V.outL], outR: v[V.outR], load: v[V.load],
             finite: [...v].every(Number.isFinite) };
  })()`);
  ok('output still finite with both busses wet', fxState.finite);
  ok('effects produce output', Math.max(fxState.outL, fxState.outR) > 1e-4,
     `L=${fxState.outL} R=${fxState.outR}`);
  ok('load stays reasonable with everything on', fxState.load < 0.5,
     `load=${(fxState.load * 100).toFixed(1)}%`);
  console.log(`  dsp load, both FX busses + LFO: ${(fxState.load * 100).toFixed(1)}%`);

  // Reverb should hold the sound up after the voices are cut.
  await cdp.eval("__vox.store.set('vbRevMix', 1); __vox.store.set('vbRevSize', 0.95)");
  await sleep(900);
  await cdp.eval('__vox.engine.panic()');
  await sleep(260);
  const ringing = await cdp.eval('__vox.engine.readVis()[__vox.engine.visLayout.outL]');
  ok('reverb tail outlives the notes', ringing > 1e-5, `tail=${ringing}`);

  await cdp.eval('__vox.store.setAll(__vox.presets.valuesFor(__vox.presets.FACTORY[0]))');
  await sleep(300);

  // ---- a preset that uses the new sections restores all of it
  const dub = await cdp.eval(`(() => {
    const p = __vox.presets.FACTORY.find(x => x.name === 'Dub Chamber');
    __vox.store.setAll(__vox.presets.valuesFor(p));
    const e = __vox.engine;
    return { bpm: e.getParam('bpm'), mix: e.getParam('vbDlyMix'),
             ping: e.getParam('vbDlyPing'), verb: e.getParam('vbRevMix'),
             voiceDry: e.getParam('vaDlyMix') };
  })()`);
  ok('preset restores tempo and bus effects',
     dub.bpm === 90 && Math.abs(dub.mix - 0.5) < 1e-6 && dub.ping === 1 &&
     Math.abs(dub.verb - 0.3) < 1e-6 && dub.voiceDry === 0, JSON.stringify(dub));
  await cdp.eval('__vox.store.setAll(__vox.presets.valuesFor(__vox.presets.FACTORY[0]))');

  // ---- readouts must not overflow their 54px cells
  const overflow = await cdp.eval(`(() => {
    const bad = [];
    for (const k of document.querySelectorAll('vk-knob')) {
      const v = k.querySelector('.knob-value'), l = k.querySelector('.knob-label');
      if (v.scrollWidth > v.clientWidth + 1) bad.push(k.getAttribute('param') + ':value:' + v.textContent);
      if (l.scrollWidth > l.clientWidth + 1) bad.push(k.getAttribute('param') + ':label');
      if (/NaN|undefined/.test(v.textContent)) bad.push(k.getAttribute('param') + ':NaN');
    }
    return bad;
  })()`);
  ok('no knob readout or label is clipped', overflow.length === 0, JSON.stringify(overflow));

  // ---- fonts actually applied
  const fonts = await cdp.eval(`(() => {
    const cs = getComputedStyle(document.querySelector('.brand-name'));
    const mono = getComputedStyle(document.querySelector('.knob-value'));
    return { sans: cs.fontFamily, mono: mono.fontFamily,
             loaded: document.fonts.status };
  })()`);
  ok('typography wired up',
     /Space Grotesk/.test(fonts.sans) && /JetBrains Mono/.test(fonts.mono),
     JSON.stringify(fonts));

  // ---- console must be clean
  const bad = consoleMsgs.filter(m =>
    (m.level === 'error' || m.level === 'exception') &&
    !/favicon/i.test(m.text));
  ok('no console errors or exceptions', bad.length === 0,
     '\n' + bad.map(b => `       [${b.level}] ${b.text}`).join('\n'));
  const badReqs = failedReqs.filter(t => !/favicon/i.test(t));
  ok('no failed resource loads', badReqs.length === 0, JSON.stringify(badReqs));

  // ---- screenshot
  // Hold a chord and wait for the fake mic to pulse, so the capture shows the
  // display actually working rather than mid-decay.
  await cdp.eval('[45,52,57,64].forEach(n => __vox.engine.noteOn(n, 100))');
  for (let i = 0; i < 160; i++) {
    const lit = await cdp.eval(`(() => { const e=__vox.engine,V=e.visLayout,v=e.readVis();
      let s=0; for(let b=0;b<32;b++) s+=v[V.env+b]; return s; })()`);
    if (lit > 0.05) break;
    await sleep(50);
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('test/screenshot.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  screenshot -> test/screenshot.png');

} catch (e) {
  fail++;
  console.log('\n  HARNESS ERROR:', e.message);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
cleanup();
process.exit(fail ? 1 : 0);
