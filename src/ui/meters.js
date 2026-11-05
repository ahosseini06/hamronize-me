// Level, load and latency readouts. DOM-based: a handful of transforms per
// frame is cheaper and sharper than a second canvas.

const DB_FLOOR = -54;
const norm = v => {
  if (!(v > 0)) return 0;
  const db = 20 * Math.log10(v);
  return Math.min(1, Math.max(0, (db - DB_FLOOR) / -DB_FLOOR));
};

export class Meters {
  constructor(root, engine) {
    this.engine = engine;
    this.root = root;
    this.bars = {};
    this.clipUntil = { in: 0, out: 0 };

    root.innerHTML = `
      <div class="meter-bars">
      <div class="meter-row">
        <span class="meter-name">VOICE</span>
        <div class="meter-track"><i data-m="in" class="meter-fill warm"></i></div>
        <span class="meter-clip" data-c="in">CLIP</span>
      </div>
      <div class="meter-row">
        <span class="meter-name">CARRIER</span>
        <div class="meter-track"><i data-m="car" class="meter-fill cool"></i></div>
        <span class="meter-clip"></span>
      </div>
      <div class="meter-row">
        <span class="meter-name">OUT L</span>
        <div class="meter-track"><i data-m="outL" class="meter-fill out"></i></div>
        <span class="meter-clip" data-c="out">CLIP</span>
      </div>
      <div class="meter-row">
        <span class="meter-name">OUT R</span>
        <div class="meter-track"><i data-m="outR" class="meter-fill out"></i></div>
        <span class="meter-clip"></span>
      </div>
      <div class="meter-row">
        <span class="meter-name">LIMIT</span>
        <div class="meter-track"><i data-m="lim" class="meter-fill hot"></i></div>
        <span class="meter-clip"></span>
      </div>
      </div>
      <div class="meter-stats">
        <div class="stat"><b data-s="load">--</b><span>DSP LOAD</span></div>
        <div class="stat"><b data-s="busy">--</b><span>&micro;S/BLOCK</span></div>
        <div class="stat"><b data-s="voices">0</b><span>VOICES</span></div>
        <div class="stat"><b data-s="gate">--</b><span>GATE</span></div>
      </div>`;

    for (const el of root.querySelectorAll('[data-m]')) this.bars[el.dataset.m] = el;
    this.stats = {};
    for (const el of root.querySelectorAll('[data-s]')) this.stats[el.dataset.s] = el;
    this.clips = {};
    for (const el of root.querySelectorAll('[data-c]')) this.clips[el.dataset.c] = el;
    this.frame = 0;
  }

  draw() {
    const e = this.engine;
    if (!e.running) return;
    const V = e.visLayout;
    const vis = e.readVis();

    this.bars.in.style.transform = `scaleX(${norm(vis[V.inLevel]).toFixed(3)})`;
    this.bars.car.style.transform = `scaleX(${norm(vis[V.carrier]).toFixed(3)})`;
    this.bars.outL.style.transform = `scaleX(${norm(vis[V.outL]).toFixed(3)})`;
    this.bars.outR.style.transform = `scaleX(${norm(vis[V.outR]).toFixed(3)})`;
    this.bars.lim.style.transform = `scaleX(${Math.min(1, vis[V.limit] * 2.5).toFixed(3)})`;

    const now = performance.now();
    if (vis[V.inLevel] >= 0.995) this.clipUntil.in = now + 900;
    if (Math.max(vis[V.outL], vis[V.outR]) >= 0.995) this.clipUntil.out = now + 900;
    this.clips.in.classList.toggle('on', now < this.clipUntil.in);
    this.clips.out.classList.toggle('on', now < this.clipUntil.out);

    // Text is far cheaper to update at 10 Hz and reads better when stable.
    if (++this.frame % 6 === 0) {
      const busy = vis[V.busyUs] || 0;
      const load = vis[V.load] || 0;
      if (busy > 0) {
        this.stats.load.textContent = (load * 100).toFixed(0) + '%';
        this.stats.load.className = load > 0.75 ? 'bad' : load > 0.45 ? 'warn' : '';
        this.stats.busy.textContent = busy.toFixed(0);
      } else {
        this.stats.load.textContent = '\u2014';
        this.stats.busy.textContent = '\u2014';
      }
      this.stats.voices.textContent = String(Math.round(vis[V.voices] || 0));
      const gate = vis[V.gate];
      this.stats.gate.textContent = gate > 0.5 ? 'OPEN' : 'SHUT';
      this.stats.gate.className = gate > 0.5 ? '' : 'warn';
    }
  }
}
