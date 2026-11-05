// The hero visualiser: one column per vocoder band, showing the modulator
// envelope that is driving it and the level it is contributing to the output.

import { bandCentres } from '../engine/params.js';
import * as store from './store.js';

const DB_FLOOR = -60;
const DB_TOP = -4;
// The synthesis bank's output carries the bank makeup gain, so raw band levels
// sit well above the modulator envelopes that drive them. This brings the two
// onto one visual scale for a stock patch, so the cyan caps read as "what the
// carrier is answering with" rather than as a second unrelated series.
const OUT_DISPLAY_GAIN = 0.16;
const toUnit = v => {
  if (!(v > 0)) return 0;
  const db = 20 * Math.log10(v);
  return Math.min(1, Math.max(0, (db - DB_FLOOR) / (DB_TOP - DB_FLOOR)));
};

export class BandDisplay {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.peaks = new Float32Array(32);
    this.smooth = new Float32Array(32);
    this.outSmooth = new Float32Array(32);
    this.dpr = 1;
    this.w = 0; this.h = 0;
    this.centres = bandCentres(24, 120, 9000);
    this.lastGeom = '';

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  resize() {
    const host = this.canvas.parentElement || this.canvas;
    // clientWidth excludes any scrollbar and never reflects the canvas's own
    // size, so it cannot participate in a sizing feedback loop.
    const rect = {
      width: host.clientWidth || host.getBoundingClientRect().width,
      height: host.clientHeight || host.getBoundingClientRect().height,
    };
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
  }

  draw() {
    const g = this.ctx;
    const { w, h, dpr } = this;
    const V = this.engine.visLayout;
    const vis = this.engine.readVis();
    const nb = Math.max(4, Math.round(vis[V.bands]) || 24);

    const lo = store.get('fLow'), hi = store.get('fHigh');
    const geom = `${nb}:${lo}:${hi}`;
    if (geom !== this.lastGeom) { this.lastGeom = geom; this.centres = bandCentres(nb, lo, hi); }

    g.save();
    g.scale(dpr, dpr);
    g.fillStyle = '#07080a';
    g.fillRect(0, 0, w, h);

    const padT = 26, padB = 20, padX = 10;
    const plotH = h - padT - padB;
    const plotW = w - padX * 2;
    const slot = plotW / nb;
    const barW = Math.max(2, slot * 0.62);
    const gap = (slot - barW) / 2;
    const baseY = padT + plotH;

    // ---- horizontal dB rules
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    g.font = '9px "JetBrains Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (const db of [-12, -24, -36, -48]) {
      const y = Math.round(baseY - ((db - DB_FLOOR) / (DB_TOP - DB_FLOOR)) * plotH) + 0.5;
      g.beginPath(); g.moveTo(padX, y); g.lineTo(w - padX, y); g.stroke();
      g.fillText(String(db), 2, y - 2);
    }

    const freeze = store.get('freeze') >= 0.5;
    const voicing = vis[V.voicing] || 0;

    const trackGrad = g.createLinearGradient(0, baseY, 0, padT);
    trackGrad.addColorStop(0, 'rgba(255,255,255,0.052)');
    trackGrad.addColorStop(0.35, 'rgba(255,255,255,0.022)');
    trackGrad.addColorStop(1, 'rgba(255,255,255,0.008)');

    // Baseline the bars sit on.
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(padX, baseY, plotW, 1);

    for (let b = 0; b < nb; b++) {
      const x = padX + b * slot + gap;
      const target = toUnit(vis[V.env + b]);
      const outTarget = toUnit(vis[V.out + b] * OUT_DISPLAY_GAIN);

      // Attack fast, fall smooth: reads as a level meter rather than noise.
      this.smooth[b] = target > this.smooth[b]
        ? target : this.smooth[b] + (target - this.smooth[b]) * 0.28;
      this.outSmooth[b] = outTarget > this.outSmooth[b]
        ? outTarget : this.outSmooth[b] + (outTarget - this.outSmooth[b]) * 0.28;
      this.peaks[b] = Math.max(this.smooth[b], this.peaks[b] - 0.006);

      const v = this.smooth[b];
      const bh = Math.max(0, v * plotH);
      const y = baseY - bh;

      // Track fades out upward so it reads as a slot, never as a value.
      g.fillStyle = trackGrad;
      g.fillRect(x, padT, barW, plotH);

      if (bh > 0.5) {
        // glow
        g.fillStyle = freeze ? 'rgba(61,219,255,0.10)' : 'rgba(255,157,61,0.11)';
        g.fillRect(x - gap * 0.7, y, barW + gap * 1.4, bh);

        const grad = g.createLinearGradient(0, baseY, 0, padT);
        if (freeze) {
          grad.addColorStop(0, '#1b6b86');
          grad.addColorStop(0.55, '#3ddbff');
          grad.addColorStop(1, '#cdf4ff');
        } else {
          grad.addColorStop(0, '#8a4a12');
          grad.addColorStop(0.5, '#ff9d3d');
          grad.addColorStop(1, '#ffd9a3');
        }
        g.fillStyle = grad;
        g.fillRect(x, y, barW, bh);
      }

      // Output contribution: a cyan cap, so you can see the carrier answering.
      const oh = this.outSmooth[b] * plotH;
      if (oh > 1) {
        g.fillStyle = 'rgba(61,219,255,0.18)';
        g.fillRect(x - 1, baseY - oh - 2.5, barW + 2, 4);
        g.fillStyle = '#7fe8ff';
        g.fillRect(x, baseY - oh - 1.5, barW, 2);
      }

      // peak hold
      if (this.peaks[b] > 0.012) {
        g.fillStyle = 'rgba(255,255,255,0.42)';
        g.fillRect(x, baseY - this.peaks[b] * plotH - 1, barW, 1);
      }
    }

    // ---- frequency axis: label as many bands as comfortably fit
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.font = '8.5px "JetBrains Mono", ui-monospace, monospace';
    g.textAlign = 'center';
    const every = slot < 26 ? Math.ceil(26 / slot) : 1;
    for (let b = 0; b < nb; b += every) {
      const f = this.centres[b] || 0;
      const t = f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k' : f.toFixed(0);
      g.fillText(t, padX + b * slot + slot / 2, h - 7);
    }
    g.textAlign = 'left';

    // ---- unvoiced / sibilance strip
    const sw = plotW * voicing;
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(padX, 10, plotW, 3);
    if (sw > 0.5) {
      g.fillStyle = voicing > 0.5 ? '#eaf6ff' : 'rgba(61,219,255,0.75)';
      g.fillRect(padX, 10, sw, 3);
    }
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.font = '8.5px "Space Grotesk", system-ui, sans-serif';
    g.fillText('UNVOICED', padX, 7);

    if (freeze) {
      g.fillStyle = '#3ddbff';
      g.font = '600 9px "Space Grotesk", system-ui, sans-serif';
      g.textAlign = 'right';
      g.fillText('SPECTRUM FROZEN', w - padX, 7);
      g.textAlign = 'left';
      g.strokeStyle = 'rgba(61,219,255,0.35)';
      g.strokeRect(0.5, 0.5, w - 1, h - 1);
    }

    g.restore();
  }
}
