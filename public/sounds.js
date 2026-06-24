// Lightweight synthesized sound effects via Web Audio (no asset files to load).
// Must be unlocked by a user gesture first (iOS/Chrome autoplay policy).
window.Sound = (function () {
  let ctx = null;
  function ac() {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; ctx = AC ? new AC() : null; }
    return ctx;
  }
  function unlock() { const c = ac(); if (c && c.state === 'suspended') c.resume(); }
  function tone(freq, start, dur, type, gain) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + start;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain || 0.2, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }
  function noise(start, dur, gain, freq) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + start;
    const n = c.createBufferSource();
    const buf = c.createBuffer(1, Math.max(1, (c.sampleRate * dur) | 0), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = buf;
    const g = c.createGain(); g.gain.value = gain || 0.15;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq || 1200;
    n.connect(f); f.connect(g); g.connect(c.destination);
    n.start(t0); n.stop(t0 + dur);
  }
  return {
    unlock,
    // ball rolling + settling
    draw() { unlock(); noise(0, 0.28, 0.10, 900); tone(280, 0.16, 0.14, 'triangle', 0.16); tone(540, 0.26, 0.14, 'sine', 0.16); },
    // marking a cell
    daub() { unlock(); tone(620, 0, 0.06, 'square', 0.11); tone(940, 0.04, 0.06, 'square', 0.09); },
    // one away from bingo — tension
    reach() { unlock(); tone(660, 0, 0.13, 'sine', 0.2); tone(990, 0.13, 0.2, 'sine', 0.22); },
    // winner fanfare
    win() { unlock(); [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.28, 'triangle', 0.22)); },
    // small pop for reactions
    pop() { unlock(); tone(800, 0, 0.05, 'sine', 0.08); }
  };
})();

// Shared voice caller (speech synthesis) — used by both host and player pages.
window.Voice = (function () {
  let on = true, voices = [];
  function load() { try { voices = speechSynthesis.getVoices(); } catch (e) {} }
  if ('speechSynthesis' in window) { load(); speechSynthesis.onvoiceschanged = load; }
  return {
    enabled(v) { if (v !== undefined) on = !!v; return on; },
    prime() { if ('speechSynthesis' in window) { try { speechSynthesis.resume(); } catch (e) {} } },
    speak(text) {
      if (!on || !('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      const en = voices.find(v => /en[-_]US/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang));
      if (en) u.voice = en;
      u.lang = en ? en.lang : 'en-US';
      u.rate = 0.92; u.pitch = 1.05;
      try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {}
    }
  };
})();
