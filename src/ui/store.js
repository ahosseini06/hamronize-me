// Thin bridge between widgets and the engine. Widgets never touch the engine
// directly, so preset loads and MIDI CC can drive them through one path.

import { PARAM_BY_ID, quantise } from '../engine/params.js';

export const bus = new EventTarget();

let engine = null;
const widgets = new Map();   // param id -> Set of widgets with update(value)

export function attachEngine(e) {
  engine = e;
  // Widgets upgrade when their module is imported, which happens before this
  // runs. Re-sync so none of them keep a provisional value.
  for (const [id, set_] of widgets) for (const w of set_) w.update(get(id));
}

export function register(id, widget) {
  if (!widgets.has(id)) widgets.set(id, new Set());
  widgets.get(id).add(widget);
  // Always seed with a real number: get() falls back to the declared default
  // when no engine is attached yet, which would otherwise leave the widget
  // holding undefined and render NaN into its SVG geometry.
  widget.update(get(id));
}

export function unregister(id, widget) {
  const s = widgets.get(id);
  if (s) s.delete(widget);
}

export function get(id) {
  if (engine) {
    const v = engine.getParam(id);
    if (Number.isFinite(v)) return v;
  }
  const def = PARAM_BY_ID[id];
  return def ? def.value : 0;
}

// `origin` lets the widget that initiated a change skip its own redraw.
export function set(id, value, origin = null) {
  const def = PARAM_BY_ID[id];
  if (!def) return;
  const v = quantise(def, value);
  if (engine) engine.setParam(id, v);
  const s = widgets.get(id);
  if (s) for (const w of s) if (w !== origin) w.update(v);
  bus.dispatchEvent(new CustomEvent('param', { detail: { id, value: v, origin } }));
}

export function setAll(values) {
  if (!engine) return;
  engine.setAll(values);
  for (const [id, set_] of widgets) {
    const v = engine.getParam(id);
    for (const w of set_) w.update(v);
  }
  bus.dispatchEvent(new CustomEvent('paramsreplaced'));
}

export function touch(id) {
  bus.dispatchEvent(new CustomEvent('touch', { detail: { id } }));
}
