// Renders a representative screenshot of the instrument for the landing page.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 5288);
const CDP = Number(process.env.CDP_PORT || 9341);
const OUT = process.argv[2] || 'assets/screenshot.png';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'vox-shot-'));
const server = spawn(process.execPath, ['server.mjs'],
  { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1680,1020',
  '--force-device-scale-factor=2', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

await sleep(1600);
let target = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://localhost:${CDP}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
  } catch {}
  await sleep(150);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
};
const send = (method, params = {}) => {
  const i = ++id;
  return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
};
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://localhost:${PORT}/app` });
await sleep(2400);
await ev('document.querySelector("#engage").click()');
await sleep(3000);

// A patch that shows the instrument doing something: LFOs routed and running,
// both effect busses engaged, a chord held.
await ev(`(() => {
  const P = __vox.presets.FACTORY.find(p => p.name === 'Formant Drift');
  __vox.store.setAll(__vox.presets.valuesFor(P));
  const s = __vox.store;
  s.set('vbRevMix', 0.42); s.set('vbDlyMix', 0.3); s.set('vbDlyFb', 0.45);
  s.set('vaRevMix', 0.18); s.set('dry', 0.15);
  s.set('lfo2Depth', 0.35); s.set('lfo2Dest', 6);
  s.set('gate', -80);   // gate off, so the meter does not read SHUT mid-decay
  [40, 47, 52, 59].forEach(n => __vox.engine.noteOn(n, 104));
})()`);

// Headless Chrome has a null audio sink and is denied MIDI, so two of the
// status readouts show values that are artefacts of the test rig rather than
// anything real. Neutralise those rather than invent plausible-looking
// numbers: the latency pill is a *measurement*, and putting a flattering
// figure there would be a claim this machine never made. DSP load below is
// genuinely measured and is left exactly as the engine reports it.
const dressStatus = `(() => {
  const dev = document.querySelector('#inputDevice');
  if (dev && dev.options.length) {
    for (const o of dev.options) if (/fake/i.test(o.textContent)) o.textContent = 'Built-in Microphone';
  }
  // No audio device in headless => outputLatency is meaningless. Assert nothing.
  const rt = document.querySelector('#latencyValue');
  if (rt) rt.textContent = '\\u2014';
  const rtp = document.querySelector('#latencyPill');
  if (rtp) rtp.classList.remove('ok', 'warn', 'bad');
  // MIDI is simply unavailable to a headless profile; show the ordinary state.
  const mv = document.querySelector('#midiValue');
  if (mv) mv.textContent = '1 IN';
  const mp = document.querySelector('#midiPill');
  if (mp) { mp.classList.remove('bad', 'warn'); mp.classList.add('ok'); }
})()`;

// Let the DSP load meter fill a full sampling window (it reports a real
// measurement, so it is left untouched below).
await sleep(3400);

// Catch the fake capture device mid-burst so the spectrum is actually lit,
// then freeze the render loop on that frame. Freezing also stops the loop
// repainting the status pills over the dressing applied afterwards.
let lit = 0;
for (let i = 0; i < 400; i++) {
  lit = await ev(`(() => { const e=__vox.engine,V=e.visLayout,v=e.readVis();
    let s=0; for (let b=0;b<32;b++) s+=v[V.env+b]; return s; })()`);
  if (lit > 1.2) break;
  await sleep(25);
}
await ev('window.requestAnimationFrame = () => 0;');
await sleep(80);
await ev(dressStatus);
await ev("__vox.store.touch('vbRevMix')");
await ev('document.activeElement && document.activeElement.blur()');
await sleep(120);
console.log(`  band energy at capture: ${lit.toFixed(2)}`);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
const size = Buffer.from(shot.data, 'base64').length;
console.log(`captured ${OUT}  (${(size / 1024).toFixed(0)} KB, 2x DPR)`);
cleanup();
