# VOX MACHINA

A live-performance channel vocoder for Chrome. Microphone is the modulator, a
polyphonic MIDI synth is the carrier, and every sample of DSP runs on the audio
render thread.

```bash
node server.mjs
#   landing     http://localhost:5173/
#   instrument  http://localhost:5173/app
```

No build step, no dependencies. Chrome will ask for the microphone, then MIDI.
**Use headphones** — open speakers feed the vocoder back into itself.

```
/                     landing page
/app                  the instrument
/src                  main-thread code: engine, MIDI, UI
/worklet              the DSP, loadable in bare Node for testing
/styles  /assets      stylesheets, screenshot
server.mjs            dev server (sets the isolation headers)
vercel.json           the same headers for static hosting
```

### Hosting it

Two requirements beyond serving files. Microphone capture and Web MIDI need a
secure context, so HTTPS or `localhost`. And `SharedArrayBuffer` needs the
page to be **cross-origin isolated**, which means the instrument document must
be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

`vercel.json` sets these on `/app`; `server.mjs` does the same locally. Without
them the app still runs — it falls back to `postMessage` — and the `BUS` pill
in the header reads `MESSAGE` instead of `SHARED` so you can tell at a glance.

---

## Latency, honestly

The target was under 10 ms. Here is what is actually achievable, and why.

| Path | Realistic | Notes |
|---|---|---|
| MIDI in → audio out | **~6–10 ms** | one render quantum + output buffer |
| Mic in → audio out | **~15–25 ms** | bounded by Chrome's capture stack |

The synth path genuinely hits the target. The **microphone round trip does
not**, on any browser, and no amount of application code changes that — the
floor is set by Chrome's audio input path and the OS driver. What the app does
is take every lever that exists:

- **`latency: {ideal: 0}` on `getUserMedia`,** with `echoCancellation`,
  `noiseSuppression` and `autoGainControl` all off. This is the single biggest
  win: the default `{audio: true}` measures ~67 ms end to end in Chrome, and
  this combination brings it to ~19 ms. Those flags also wreck a vocoder's
  modulator, so they are off for signal reasons too.
- **No forced sample rate.** Pinning the `AudioContext` or the mic to a rate the
  device does not run at inserts a resampler on the hot path. The context adopts
  the hardware rate and the mic is requested to match it.
- **A three-node graph**: `MediaStreamSource → AudioWorklet → destination`.
  Gain, filtering, gating and limiting all happen inside the worklet rather than
  as extra nodes.
- **A selectable buffer** (MINIMUM / INTERACTIVE / BALANCED). A numeric
  `latencyHint` is only a *request*, so the app measures `baseLatency`,
  `outputLatency` and the track's reported input latency and shows you the real
  figures. Click the `RT` pill for the breakdown.

The displayed round trip is the sum of what Chrome reports. True acoustic round
trip is somewhat higher — converter and driver delay are not visible to a web
page. When Chrome reports no input latency at all, the panel says so rather
than quietly understating the number.

---

## Architecture

```
main thread                     │ audio render thread
                                │
 UI, MIDI, presets  ──SAB──────▶│  params  (lock-free, no messaging)
 Web MIDI  ─────────SAB ring───▶│  notes   (applied at the next quantum)
 meters, spectrum ◀──SAB────────│  telemetry
                                │
                                │  mic ─▶ analysis bank ─┐
                                │                        ├▶ per-band VCA ─┐
                                │  MIDI ─▶ synth ───────▶┘                │
                                │                                         ▼
                                │   voice bus ─▶ echo ─▶ reverb ─┐   vocoder bus
                                │                                ├─▶ ─▶ echo ─▶ reverb
                                │                                ▼
                                │                       sum ─▶ tilt ─▶ limiter ─▶ out
```

The dry voice and the vocoded signal are **separate busses all the way to the
summing point**, each with its own echo and reverb. Wet is *added* rather than
crossfaded, so raising ECHO or REVERB never ducks the source, and a mix of zero
is bit-identical to bypass.

The main thread never touches a sample. Control data moves through
`SharedArrayBuffer`, which is why `server.mjs` sets `Cross-Origin-Opener-Policy`
and `Cross-Origin-Embedder-Policy` — without cross-origin isolation
`SharedArrayBuffer` does not exist. The app detects this and falls back to
`postMessage`; the `BUS` pill in the header shows which transport is live.

### Inside the worklet

- **Filterbank** — 12–32 log-spaced bands. Each is two cascaded 2nd-order
  bandpasses; the per-section Q is widened by `sqrt(2^(1/2)-1)` so the cascade
  lands on the intended bandwidth rather than a narrower one.
- **Envelope followers** — full-wave rectify into a one-pole with separate
  attack and release.
- **Voicing detection** — high/low band energy ratio. Voiced speech sits low,
  sibilants and plosives spike it. This drives **noise substitution** in the
  high bands, which is what makes consonants legible instead of buzzy. It is
  the difference between a vocoder you can understand and one you cannot.
- **Formant shift** — synthesis reads envelopes from a fractionally offset band
  index, so the filterbank geometry stays on its grid.
- **Carrier** — 8-voice poly, up to 7 PolyBLEP oscillators per voice with a
  sub, plus noise. Poly / mono / legato, glide, velocity, bend, vibrato, hold.
- **Stereo** — a genuinely stereo carrier (detuned unison voices panned across
  the image) driving two synthesis banks from one set of mono envelopes. Width
  comes from the carrier, never from splitting bands left and right — that
  approach drags narrowband content to one side and makes the image swim.
- **Limiter** — instantaneous attack, exponential release. Without lookahead
  that is the only way to actually guarantee the ceiling, and lookahead would
  cost latency.
- **LFOs** — two, locked to TEMPO by rhythmic division (1/32 through 4 bars,
  with dotted and triplet values). Sine, triangle, saw, ramp, square, sample &
  hold, each with a phase offset so the two can run out of step.
- **Modulation routing** — an LFO moves its destination **in that parameter's
  own curve space**. Sweeping SIB FREQ therefore travels by musical interval
  rather than piling up at the top of its range, and the result is always
  clamped inside the parameter's limits. Routing is generic: the render thread
  is handed a destination-to-parameter table and knows nothing about the UI.
- **Echo** — tempo-synced, with a one-pole in the feedback path so each repeat
  lands darker, and optional ping-pong. The delay length *glides* to a new
  value instead of jumping, so changing tempo or division bends the repeats
  like tape rather than clicking.
- **Reverb** — Schroeder/Freeverb topology: eight damped combs in parallel into
  four allpasses in series, right channel offset for a stereo tail, with
  predelay, size and damping.

No allocation after construction: every buffer is sized for the maximum band
count up front, because a GC pause on the render thread is a dropout. Effect
settings travel into the delay and reverb through typed arrays rather than as
arguments — a double passed to a function V8 will not inline gets boxed into a
HeapNumber, and that boxing was measurably the only garbage this path produced.

---

## Playing it

- **Keys** — `Z`–`M` and `Q`–`P` play two octaves; `-` / `=` shift octave.
  Click and drag the on-screen keyboard to glissando.
- **Knobs** — drag vertically, `Shift` for fine, double-click to reset,
  scroll to nudge, arrow keys when focused.
- **MIDI learn** — right-click any control, then move a knob on your controller.
  Bindings persist. The `MIDI` pill lists inputs and the current CC map.
- **Presets** — eight factory patches; `SAVE` stores your own in `localStorage`.
- **Esc** — all notes off. So is the `PANIC` button.

### Modulation and space

Everything tempo-based follows one **TEMPO** control: both LFO rates and both
echo times. Set it once and the whole instrument locks together.

Pick an LFO **TARGET** from the dropdown, then raise **DEPTH** — zero depth
means the destination is left completely alone. **FORMANT** is the destination
worth reaching for first; a slow sine over it is where the classic sweeping,
talking vocoder movement comes from. A square wave on *Vocoder level* at 1/16
gives you a tempo-locked gate. LFOs can also target the effect mixes, so you
can swell reverb across a bar.

The two **SPACE** panels are independent: one processes the dry voice, the
other the vocoded signal. Reverb on the vocoder bus with the voice bus dry is
the usual starting point — it keeps consonants in front while the synthetic
part blooms behind them.

### Getting a good sound

Intelligibility comes mostly from three controls. Raise **SIBILANCE** until
consonants cut through. Keep vocoder **ATTACK** fast (1–3 ms) so plosives stay
sharp. Give the carrier harmonic content — **DRIVE**, **UNISON** and **SUB**
all help, because the vocoder can only reshape energy that is already there; a
pure sine carrier will vocode into near-silence.

Set **GATE** just above your room noise so the filterbank stays shut between
phrases. **FREEZE** holds the current spectral envelope indefinitely — play
chords underneath a held vowel.

---

## Tests

```bash
npm test
```

**101 numerical tests** (`test/dsp.test.mjs`) load the worklet in bare Node —
it has no imports and touches only `sampleRate`, `AudioWorkletProcessor` and
`registerProcessor`, so it runs headless. They verify filterbank selectivity
against band geometry, envelope timing, voicing separation, carrier pitch and
PolyBLEP alias rejection, limiter ceilings, stereo balance under narrowband
input, voice allocation, that no parameter combination can produce NaN or
exceed full scale, that nothing is allocated per block, and that the worst case
(32 bands, 8 voices × 7 unison, both effect busses wet, both LFOs running)
stays a few percent of one core. The effects get their own coverage: LFO cycle
length measured against tempo and division, every waveform's range, modulation
staying inside its destination's limits and moving symmetrically in ratio on
logarithmic targets, echo repeats landing on the beat, feedback decaying,
ping-pong alternating channels, reverb tails decaying and responding to size
and damping, predelay holding the onset back, and — importantly — that neither
bus leaks into the other.

**65 end-to-end tests** (`test/browser.test.mjs`) drive real Chrome over the
DevTools Protocol with a fake capture device, so the whole mic → DSP → output
path executes. They check the audio graph comes up, signal actually reaches the
bank, parameter changes land on the render thread, pointer drags and key
presses do the right thing, sheets and presets work, the buffer can be switched
without killing audio, the landing page serves and links through, the LFOs
actually run and their indicators move, both
effect busses stay finite and audible, reverb tails outlive the notes, nothing
overflows or is clipped by its layout, and the console stays clean.

These found real bugs during the build: a limiter that overshot its ceiling by
2 dB, a stereo scheme that collapsed narrowband content to one side, 489 B/block
of GC garbage on the audio thread, knobs initialising to `NaN`, a
canvas-in-grid feedback loop that grew the layout past the viewport, and
argument boxing in the effect hot path that cost 92 B per block.

A note on measuring allocation: `process.memoryUsage().heapUsed` deltas are a
coarse instrument at tens of bytes per block, and they disagreed with each
other until the measurement was isolated from the test harness, which was
itself allocating two large capture buffers and a fresh argument pair per
block. Treat the reported figure as an upper bound, not a precise count.

### Layout

The full instrument — 71 controls — fits a 1680×1020 window without scrolling.
Shorter viewports scroll rather than cram; the panels reflow at 1400 px and
again at 820 px.

---

## Browser support

Chrome/Edge only, by design. It needs AudioWorklet, Web MIDI (Chromium-only),
and cross-origin isolation for `SharedArrayBuffer`. Firefox and Safari have no
Web MIDI; Firefox ignores a numeric `latencyHint`.
