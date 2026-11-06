import { Engine, LATENCY_MODES, SUPPORTS_OUTPUT_SELECTION } from '../engine/engine.js';
import { MidiIn } from '../engine/midi.js';
import { PARAM_BY_ID, PARAMS, format, fromNorm } from '../engine/params.js';
import * as paramsModule from '../engine/params.js';
import * as presets from '../engine/presets.js';
import * as store from './store.js';
import './knob.js';
import './switch.js';
import { BandDisplay } from './display.js';
import { Meters } from './meters.js';
import { Keyboard } from './keyboard.js';

const $ = s => document.querySelector(s);
const PREF = 'vox.prefs';

const engine = new Engine();
const midi = new MidiIn(engine);
store.attachEngine(engine);

let display, meters, keyboard;
let userPresets = presets.loadUser();
let prefs = { latencyMode: 'interactive', deviceId: null, sinkId: '', midiInput: 'all' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF) || '{}')); } catch {}
const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch {} };

/* ─────────────────────────────────────────────── toasts */

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

/* ─────────────────────────────────────────────── floating sheets */

let openSheetEl = null;

function closeSheet() {
  if (openSheetEl) { openSheetEl.remove(); openSheetEl = null; }
}

function openSheet(anchor, build) {
  const wasOpen = openSheetEl && openSheetEl.dataset.anchor === anchor.id;
  closeSheet();
  if (wasOpen) return;

  const el = document.createElement('div');
  el.className = 'sheet';
  el.dataset.anchor = anchor.id;
  build(el);
  document.body.append(el);

  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  el.style.top = Math.min(window.innerHeight - r.height - 8, a.bottom + 6) + 'px';
  el.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, a.left)) + 'px';
  openSheetEl = el;

  setTimeout(() => {
    const onDoc = e => {
      if (!el.contains(e.target) && !anchor.contains(e.target)) {
        closeSheet();
        document.removeEventListener('pointerdown', onDoc);
      }
    };
    document.addEventListener('pointerdown', onDoc);
  }, 0);
}

window.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

/* ─────────────────────────────────────────────── boot */

/* ─────────────────────────────────────────────── boot: device pickers */

// What the start screen will hand to engine.start(). Seeded from saved prefs,
// then corrected against whatever devices are actually present.
const choice = { input: null, output: '', midi: 'all' };
const audioDevices = { inputs: [], outputs: [], labelled: false };

async function scanAudioDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    audioDevices.inputs = all.filter(d => d.kind === 'audioinput');
    audioDevices.outputs = all.filter(d => d.kind === 'audiooutput');
    // Chrome withholds device names until the page has microphone permission.
    audioDevices.labelled = all.some(d => d.kind === 'audioinput' && d.label);
  } catch {
    audioDevices.inputs = []; audioDevices.outputs = []; audioDevices.labelled = false;
  }
}

async function unlockAudioDevices() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach(t => t.stop());
  await scanAudioDevices();
}

function bootSelect(id, options, value, onChange, disabled = false) {
  const sel = document.createElement('select');
  sel.id = id;
  sel.className = 'select';
  for (const o of options) {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    sel.append(el);
  }
  sel.value = value;
  sel.disabled = disabled;
  if (onChange) sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function bootPick(id, text, action) {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.className = 'boot-pick';
  b.textContent = text;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await action(); } finally { b.disabled = false; }
  });
  return b;
}

const pickFrom = (options, wanted, fallback) =>
  options.some(o => o.value === wanted) ? wanted : fallback;

async function unlockAndRepaint() {
  try {
    await unlockAudioDevices();
  } catch (e) {
    showBootError(explainStartError(e));
  }
  paintInputPicker();
  paintOutputPicker();
}

function paintInputPicker() {
  const slot = $('#bootInputSlot');
  slot.innerHTML = '';
  if (!audioDevices.labelled) {
    slot.append(bootPick('bootInput', 'Choose microphone…', unlockAndRepaint));
    return;
  }
  const opts = audioDevices.inputs.map(d => ({ value: d.deviceId, label: d.label || 'Microphone' }));
  if (!opts.length) {
    slot.append(bootSelect('bootInput', [{ value: '', label: 'No microphone found' }], '', null, true));
    choice.input = null;
    return;
  }
  choice.input = pickFrom(opts, prefs.deviceId, opts[0].value);
  slot.append(bootSelect('bootInput', opts, choice.input, v => {
    choice.input = v; prefs.deviceId = v; savePrefs();
  }));
}

function paintOutputPicker() {
  const slot = $('#bootOutputSlot');
  slot.innerHTML = '';
  const systemDefault = [{ value: '', label: 'System default' }];
  if (!SUPPORTS_OUTPUT_SELECTION) {
    slot.append(bootSelect('bootOutput', systemDefault, '', null, true));
    choice.output = '';
    return;
  }
  if (!audioDevices.labelled) {
    slot.append(bootPick('bootOutput', 'Choose output…', unlockAndRepaint));
    return;
  }
  // Chrome's 'default' entry and '' both mean the system default output.
  const opts = audioDevices.outputs.map(d => ({
    value: d.deviceId === 'default' ? '' : d.deviceId,
    label: d.label || 'Output',
  }));
  if (!opts.length) {
    slot.append(bootSelect('bootOutput', systemDefault, '', null, true));
    choice.output = '';
    return;
  }
  if (!opts.some(o => o.value === '')) opts.unshift(systemDefault[0]);
  choice.output = pickFrom(opts, prefs.sinkId, '');
  slot.append(bootSelect('bootOutput', opts, choice.output, v => {
    choice.output = v; prefs.sinkId = v; savePrefs();
  }));
}

function paintMidiPicker() {
  const slot = $('#bootMidiSlot');
  if (!slot || $('#boot').hidden) return;
  slot.innerHTML = '';
  if (!midi.supported) {
    slot.append(bootSelect('bootMidi', [{ value: '', label: 'Not available in this browser' }], '', null, true));
    return;
  }
  if (midi.state === 'granted') {
    const opts = midi.inputs.length
      ? [{ value: 'all', label: 'All MIDI inputs' },
         ...midi.inputs.map(i => ({ value: i.id, label: i.name || 'MIDI input' }))]
      : [{ value: 'all', label: 'No MIDI devices — plug one in' }];
    opts.push({ value: 'none', label: 'None' });
    choice.midi = pickFrom(opts, prefs.midiInput, 'all');
    if (midi.only !== choice.midi) midi.selectOnly(choice.midi);
    slot.append(bootSelect('bootMidi', opts, choice.midi, v => {
      choice.midi = v; prefs.midiInput = v; savePrefs();
      midi.selectOnly(v);
    }));
    return;
  }
  if (midi.state === 'denied') {
    slot.append(bootSelect('bootMidi', [{ value: '', label: 'MIDI permission denied' }], '', null, true));
    return;
  }
  if (midi.state === 'error') {
    slot.append(bootSelect('bootMidi', [{ value: '', label: 'MIDI unavailable' }], '', null, true));
    return;
  }
  slot.append(bootPick('bootMidi', 'Enable MIDI…', async () => {
    await midi.connect();
    paintMidiPicker();
  }));
}

function showBootError(html) {
  const err = $('#bootError');
  err.hidden = false;
  err.innerHTML = html;
}

async function initDevicePickers() {
  choice.input = prefs.deviceId;
  choice.output = prefs.sinkId || '';
  choice.midi = prefs.midiInput || 'all';
  midi.load();
  midi.only = choice.midi;

  await scanAudioDevices();
  paintInputPicker();
  paintOutputPicker();

  // Only list MIDI devices up front if access was already granted; otherwise
  // wait for a click rather than throwing a permission prompt on page load.
  let midiGranted = false;
  try {
    const st = await navigator.permissions.query({ name: 'midi' });
    midiGranted = st.state === 'granted';
  } catch {}
  if (midiGranted) await midi.connect();
  paintMidiPicker();

  midi.addEventListener('change', paintMidiPicker);
  navigator.mediaDevices.addEventListener?.('devicechange', async () => {
    if ($('#boot').hidden) return;
    await scanAudioDevices();
    paintInputPicker();
    paintOutputPicker();
  });
}

function initBoot() {
  initDevicePickers();
  const row = $('#bootLatency');
  const desc = $('#bootLatencyDesc');
  const paint = () => {
    row.innerHTML = '';
    for (const m of LATENCY_MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (m.id === prefs.latencyMode ? ' on' : '');
      b.textContent = m.label;
      b.addEventListener('click', () => {
        prefs.latencyMode = m.id; savePrefs(); paint();
      });
      row.append(b);
    }
    const m = LATENCY_MODES.find(x => x.id === prefs.latencyMode);
    desc.textContent = m ? m.desc : '';
  };
  paint();
  $('#engage').addEventListener('click', engage);
}

async function engage() {
  const btn = $('#engage');
  const err = $('#bootError');
  btn.disabled = true;
  btn.textContent = 'STARTING…';
  err.hidden = true;

  try {
    await engine.start({
      latencyMode: prefs.latencyMode,
      deviceId: choice.input && choice.input !== 'default' ? choice.input : null,
      sinkId: choice.output || '',
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'ENGAGE';
    err.hidden = false;
    err.innerHTML = explainStartError(e);
    return;
  }

  $('#boot').classList.add('gone');
  setTimeout(() => { $('#boot').hidden = true; }, 500);
  $('#app').hidden = false;

  initApp();

  if (engine.sinkId !== (choice.output || '')) {
    toast('Saved output is gone — using the system default');
    prefs.sinkId = ''; savePrefs();
  }

  // If MIDI was not enabled on the start screen, ask now that audio is live,
  // so the two permission prompts never stack.
  const wasGranted = midi.state === 'granted';
  const got = await midi.connect();
  if (got && !wasGranted) midi.selectOnly(choice.midi);
  refreshMidi();
  if (got && choice.midi !== 'none') {
    const n = midi.inputs.filter(i => midi.enabled.has(i.id)).length;
    toast(n ? `MIDI ready — ${n} input${n > 1 ? 's' : ''}` : 'MIDI ready — no devices found',
          n ? 'good' : '');
  } else if (midi.state === 'denied') {
    toast('MIDI permission denied — on-screen keyboard still works');
  }
}

function explainStartError(e) {
  const name = e && e.name ? e.name : '';
  const msg = e && e.message ? e.message : String(e);
  if (name === 'NotAllowedError') {
    return `<b>Microphone blocked.</b> Chrome denied access. Click the icon at the
            left of the address bar, allow the microphone, then reload.`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return `<b>No usable microphone.</b> Connect an input device and reload.
            <br><code>${msg}</code>`;
  }
  if (/secure|https/i.test(msg)) {
    return `<b>Insecure context.</b> Microphone capture needs
            <code>http://localhost</code> or HTTPS.`;
  }
  return `<b>Could not start audio.</b><br><code>${name} ${msg}</code>`;
}

/* ─────────────────────────────────────────────── app */

function initApp() {
  display = new BandDisplay($('#bands'), engine);
  meters = new Meters($('#meters'), engine);
  keyboard = new Keyboard($('#keyboard'), engine);

  initReadout();
  initPresets();
  initDevices();
  initLatency();
  initMidiUi();
  initContextMenu();

  $('#panic').addEventListener('click', doPanic);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') doPanic();
  });
  engine.addEventListener('error', e => toast(e.detail || 'Audio error', 'bad'));

  const tv = $('#transportValue');
  tv.textContent = engine.shared ? 'SHARED' : 'MESSAGE';
  $('#transportPill').classList.add(engine.shared ? 'ok' : 'warn');
  $('#transportPill').title = engine.shared
    ? 'Lock-free SharedArrayBuffer transport to the render thread'
    : 'Page is not cross-origin isolated — falling back to postMessage. Serve with server.mjs for the lock-free path.';

  let frame = 0;
  const loop = () => {
    display.draw();
    meters.draw();
    if (++frame % 30 === 0) paintLatencyPill();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  paintLatencyPill();
}

function doPanic() {
  if (keyboard) keyboard.allOff();
  engine.panic();
  toast('All notes off');
}

/* ─────────────────────────────────────────────── readout */

function initReadout() {
  const label = $('#readout .readout-label');
  const value = $('#readout .readout-value');
  let current = null;

  const paint = id => {
    const def = PARAM_BY_ID[id];
    if (!def) return;
    current = id;
    label.textContent = def.label;
    value.textContent = format(def, store.get(id));
    const g = def.group;
    value.style.color = g === 'carrier' ? 'var(--cool)'
      : g === 'mix' ? 'var(--neutral)' : 'var(--warm)';
  };

  store.bus.addEventListener('touch', e => paint(e.detail.id));
  store.bus.addEventListener('param', e => { if (e.detail.id === current) paint(current); });
}

/* ─────────────────────────────────────────────── presets */

function initPresets() {
  const sel = $('#presetSelect');

  const paint = () => {
    sel.innerHTML = '';
    const head = document.createElement('option');
    head.textContent = '— presets —';
    head.value = '';
    sel.append(head);

    const fg = document.createElement('optgroup');
    fg.label = 'Factory';
    presets.FACTORY.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = 'f' + i; o.textContent = p.name;
      fg.append(o);
    });
    sel.append(fg);

    if (userPresets.length) {
      const ug = document.createElement('optgroup');
      ug.label = 'Yours';
      userPresets.forEach((p, i) => {
        const o = document.createElement('option');
        o.value = 'u' + i; o.textContent = p.name;
        ug.append(o);
      });
      sel.append(ug);
    }
  };
  paint();

  sel.addEventListener('change', () => {
    const v = sel.value;
    if (!v) return;
    const patch = v[0] === 'f' ? presets.FACTORY[+v.slice(1)] : userPresets[+v.slice(1)];
    if (!patch) return;
    store.setAll(presets.valuesFor(patch));
    toast(`Loaded “${patch.name}”`, 'good');
  });

  $('#savePreset').addEventListener('click', () => {
    openSheet($('#savePreset'), el => {
      el.innerHTML = `
        <h3>Save preset</h3>
        <input class="select wide" id="pname" placeholder="Name" maxlength="40">
        <div style="display:flex;gap:6px;margin-top:10px">
          <button class="btn" id="pdo" style="flex:1">SAVE</button>
        </div>
        <div class="sheet-list" id="plist" style="margin-top:10px"></div>`;
      const input = el.querySelector('#pname');
      input.value = 'Patch ' + (userPresets.length + 1);

      const commit = () => {
        const name = input.value.trim();
        if (!name) return;
        const existing = userPresets.findIndex(p => p.name === name);
        const entry = presets.captureCurrent(name, engine.values);
        if (existing >= 0) userPresets[existing] = entry;
        else userPresets.push(entry);
        presets.saveUser(userPresets);
        paint();
        closeSheet();
        toast(`Saved “${name}”`, 'good');
      };
      el.querySelector('#pdo').addEventListener('click', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit();
        e.stopPropagation();
      });

      const list = el.querySelector('#plist');
      if (userPresets.length) {
        const h = document.createElement('h3');
        h.textContent = 'Delete';
        list.append(h);
        userPresets.forEach((p, i) => {
          const row = document.createElement('button');
          row.className = 'sheet-item';
          row.innerHTML = `<span>${p.name}</span><small>REMOVE</small>`;
          row.addEventListener('click', () => {
            userPresets.splice(i, 1);
            presets.saveUser(userPresets);
            paint();
            closeSheet();
            toast(`Deleted “${p.name}”`);
          });
          list.append(row);
        });
      }
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  });
}

/* ─────────────────────────────────────────────── input devices */

function initDevices() {
  const sel = $('#inputDevice');
  const paint = () => {
    sel.innerHTML = '';
    if (!engine.devices.length) {
      const o = document.createElement('option');
      o.textContent = engine.inputLabel || 'Default input';
      sel.append(o);
      return;
    }
    for (const d of engine.devices) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label;
      if (d.id === engine.deviceId) o.selected = true;
      sel.append(o);
    }
  };
  paint();
  sel.addEventListener('change', async () => {
    try {
      await engine.setDevice(sel.value);
      prefs.deviceId = engine.deviceId;
      savePrefs();
      toast('Input switched', 'good');
    } catch (e) {
      toast('Could not open that input', 'bad');
      paint();
    }
  });
  engine.addEventListener('devicechange', paint);
  navigator.mediaDevices.addEventListener?.('devicechange', async () => {
    await engine._listDevices();
    paint();
  });
}

/* ─────────────────────────────────────────────── latency */

function paintLatencyPill() {
  const r = engine.latencyReport();
  const pill = $('#latencyPill');
  if (!r) return;
  $('#latencyValue').textContent = r.roundTripMs.toFixed(1) + ' ms';
  pill.classList.toggle('ok', r.roundTripMs < 12);
  pill.classList.toggle('warn', r.roundTripMs >= 12 && r.roundTripMs < 25);
  pill.classList.toggle('bad', r.roundTripMs >= 25);
}

function initLatency() {
  $('#latencyPill').addEventListener('click', () => {
    openSheet($('#latencyPill'), el => {
      const r = engine.latencyReport();
      const rows = [
        ['Input (reported)', r.inputMs],
        ['Context buffer', r.baseMs],
        ['Output device', r.outputMs],
      ];
      el.innerHTML = `
        <h3>Signal path latency</h3>
        <div class="sheet-rows">
          ${rows.map(([k, v]) =>
            `<div class="sheet-row"><span>${k}</span><b>${v.toFixed(2)} ms</b></div>`).join('')}
          <div class="sheet-row total"><span>Round trip</span>
            <b>${r.roundTripMs.toFixed(2)} ms</b></div>
        </div>
        <h3>Buffer</h3>
        <div class="sheet-list" id="lmodes"></div>
        <p class="sheet-note">
          Render quantum ${r.quantumMs.toFixed(2)} ms at ${(r.sampleRate / 1000).toFixed(1)} kHz.
          These are the figures Chrome reports; true acoustic round trip also
          includes driver and converter delay the page cannot measure.
          ${r.inputMs === 0 ? '<br><b>Chrome reported no input latency</b>, so the real figure is higher than shown.' : ''}
        </p>`;

      const list = el.querySelector('#lmodes');
      for (const m of LATENCY_MODES) {
        const b = document.createElement('button');
        b.className = 'sheet-item' + (m.id === engine.latencyMode ? ' on' : '');
        b.innerHTML = `<span>${m.label}</span><small>${m.desc}</small>`;
        b.addEventListener('click', async () => {
          closeSheet();
          // Held notes belong to the context we are about to discard.
          if (keyboard) keyboard.allOff();
          toast('Rebuilding audio graph…');
          try {
            await engine.setLatencyMode(m.id);
            prefs.latencyMode = m.id;
            savePrefs();
            paintLatencyPill();
            toast(`Buffer: ${m.label}`, 'good');
          } catch (e) {
            toast('Could not change buffer', 'bad');
          }
        });
        list.append(b);
      }
    });
  });
}

/* ─────────────────────────────────────────────── MIDI */

function refreshMidi() {
  const pill = $('#midiPill');
  const v = $('#midiValue');
  pill.classList.remove('ok', 'warn', 'bad');
  if (midi.state === 'granted') {
    const n = midi.inputs.filter(i => midi.enabled.has(i.id)).length;
    v.textContent = n ? `${n} IN` : 'NONE';
    pill.classList.add(n ? 'ok' : 'warn');
  } else if (midi.state === 'denied') { v.textContent = 'DENIED'; pill.classList.add('bad'); }
  else if (midi.state === 'unsupported') { v.textContent = 'N/A'; pill.classList.add('bad'); }
  else if (midi.state === 'error') { v.textContent = 'ERR'; pill.classList.add('bad'); }
  else { v.textContent = 'OFF'; pill.classList.add('warn'); }

  // Refresh the CC badge on every bound control.
  for (const def of PARAMS) {
    const cc = midi.ccFor(def.id);
    document.querySelectorAll(`[param="${def.id}"]`).forEach(w => {
      if (w.showCc) w.showCc(cc);
      if (w.setLearning) w.setLearning(midi.learnTarget === def.id);
    });
  }
}

function initMidiUi() {
  midi.addEventListener('change', refreshMidi);
  midi.addEventListener('note', e => {
    if (keyboard) keyboard.setExternal(e.detail.note, e.detail.on);
  });
  midi.addEventListener('cc', e => {
    const def = PARAM_BY_ID[e.detail.param];
    if (def) store.set(def.id, fromNorm(def, e.detail.norm));
  });
  midi.addEventListener('learned', e => {
    const def = PARAM_BY_ID[e.detail.param];
    toast(`CC${e.detail.cc} → ${def ? def.label : e.detail.param}`, 'good');
  });

  $('#midiPill').addEventListener('click', async () => {
    if (midi.state === 'idle') {
      await midi.connect();
      refreshMidi();
    }
    openSheet($('#midiPill'), el => {
      el.innerHTML = '<h3>MIDI inputs</h3><div class="sheet-list" id="mlist"></div>';
      const list = el.querySelector('#mlist');

      if (midi.state === 'unsupported') {
        list.innerHTML = '<p class="sheet-note">This browser has no Web MIDI API.</p>';
      } else if (midi.state === 'denied') {
        list.innerHTML = `<p class="sheet-note">MIDI permission was denied. Allow it from
          the icon in the address bar, then reload.</p>`;
      } else if (midi.state === 'error') {
        list.innerHTML = `<p class="sheet-note">MIDI could not start.
          <br><code>${midi.error || 'unknown error'}</code></p>`;
      } else if (!midi.inputs.length) {
        list.innerHTML = '<p class="sheet-note">No MIDI inputs detected. Connect a device — it should appear here automatically.</p>';
      } else {
        for (const input of midi.inputs) {
          const on = midi.enabled.has(input.id);
          const b = document.createElement('button');
          b.className = 'sheet-item' + (on ? ' on' : '');
          b.innerHTML = `<span>${input.name || 'Input'}</span><small>${on ? 'LISTENING' : 'MUTED'}</small>`;
          b.addEventListener('click', () => {
            midi.setInputEnabled(input.id, !on);
            closeSheet();
          });
          list.append(b);
        }
      }

      const bound = [...midi.bindings];
      const h = document.createElement('h3');
      h.textContent = 'CC map';
      h.style.marginTop = '12px';
      el.append(h);
      if (!bound.length) {
        const p = document.createElement('p');
        p.className = 'sheet-note';
        p.style.margin = '0';
        p.textContent = 'Right-click any knob to assign it to a CC.';
        el.append(p);
      } else {
        const bl = document.createElement('div');
        bl.className = 'sheet-list';
        for (const [cc, pid] of bound) {
          const def = PARAM_BY_ID[pid];
          const b = document.createElement('button');
          b.className = 'sheet-item';
          b.innerHTML = `<span>CC${cc} → ${def ? def.label : pid}</span><small>CLEAR</small>`;
          b.addEventListener('click', () => { midi.unbind(pid); closeSheet(); });
          bl.append(b);
        }
        el.append(bl);
      }
    });
  });
}

/* ─────────────────────────────────────────────── right-click menu */

function initContextMenu() {
  const menu = $('#ctxMenu');

  const close = () => { menu.hidden = true; menu.innerHTML = ''; };

  document.addEventListener('knob-menu', e => {
    const { param, x, y } = e.detail;
    const def = PARAM_BY_ID[param];
    if (!def) return;
    const cc = midi.ccFor(param);

    menu.innerHTML = `<div class="ctx-title">${def.label}</div>`;
    const add = (text, fn, dim) => {
      const b = document.createElement('button');
      b.className = 'ctx-item' + (dim ? ' dim' : '');
      b.textContent = text;
      b.addEventListener('click', () => { fn(); close(); });
      menu.append(b);
    };

    if (midi.state === 'granted') {
      add(cc == null ? 'Learn MIDI CC…' : `Relearn (now CC${cc})`, () => {
        midi.learn(param);
        refreshMidi();
        toast(`Move a control to bind ${def.label}`);
      });
      if (cc != null) add(`Clear CC${cc}`, () => midi.unbind(param));
    } else {
      add('MIDI not connected', () => {}, true);
    }
    add(`Reset to ${format(def, def.value)}`, () => store.set(param, def.value));

    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  });

  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target)) close();
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      close();
      if (midi.learnTarget) { midi.cancelLearn(); refreshMidi(); }
    }
  });
}

/* ─────────────────────────────────────────────── go */

// Handy from the console, and what the browser test harness inspects.
globalThis.__vox = { engine, midi, store, presets, toast, params: paramsModule };

export function boot() {
  initBoot();
  // Surface the common "opened the file directly" mistake immediately.
  if (location.protocol === 'file:') {
    const err = $('#bootError');
    err.hidden = false;
    err.innerHTML = `<b>Served from the filesystem.</b> ES modules, AudioWorklet and
      microphone access all need a real origin. Run <code>node server.mjs</code>
      and open <code>http://localhost:5173</code>.`;
  }
}
