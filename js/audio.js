'use strict';

// Tiny WebAudio synth: no audio files to host.
const Sfx = (() => {
  let ctx = null, master = null;
  let muted = false;
  try { muted = localStorage.getItem('meridian.muted') === '1'; } catch { /* storage blocked */ }

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function tone(freq, dur, { type = 'sine', vol = 0.3, at = 0, slide = null } = {}) {
    if (muted || !ctx) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  return {
    unlock,
    isMuted: () => muted,
    toggle() {
      muted = !muted;
      try { localStorage.setItem('meridian.muted', muted ? '1' : '0'); } catch { /* ignore */ }
      return muted;
    },
    click() { tone(880, 0.06, { type: 'square', vol: 0.06 }); },
    tick() { tone(1320, 0.05, { type: 'square', vol: 0.07 }); },
    good() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { type: 'triangle', vol: 0.22, at: i * 0.055 })); },
    great() { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.2, { type: 'triangle', vol: 0.24, at: i * 0.05 })); tone(2093, 0.4, { vol: 0.08, at: 0.25 }); },
    bad() { tone(220, 0.32, { type: 'sawtooth', vol: 0.14, slide: 90 }); },
    soft() { tone(330, 0.15, { type: 'triangle', vol: 0.12, slide: 250 }); },
    count() { tone(660, 0.12, { type: 'triangle', vol: 0.18 }); },
    go() { tone(990, 0.3, { type: 'triangle', vol: 0.22 }); tone(1485, 0.3, { type: 'sine', vol: 0.1 }); },
    over() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.28, { type: 'triangle', vol: 0.2, at: i * 0.14 })); },
  };
})();
