/* Did I Say That? — reverse-audio party game.
 * Plain JS, no build step. Audio: getUserMedia + MediaRecorder -> decodeAudioData
 * -> reverse each channel's Float32Array -> AudioBufferSourceNode.
 */
(() => {
  'use strict';

  const MAX_SECONDS = 10;          // auto-stop long recordings
  const ONLINE_KEY = 'did-i-say-that:online'; // set while in a multi-phone game
  let net = null;                  // multi-phone controller (online.js), else null

  // ---------- tiny helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let toastTimer;
  function toast(msg, ms = 3200) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------- audio engine ----------
  let ctx = null;
  let currentSource = null;
  let currentPlayBtns = [];

  async function ensureCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx || ctx.state === 'closed') ctx = new AC();
    if (ctx.state !== 'running') await resumeWithTimeout(ctx);
    if (ctx.state !== 'running') {
      // Safari can leave a context stuck "suspended"/"interrupted" (e.g. one
      // made before any tap, or after the audio session changed). Start a
      // fresh one; AudioBuffers work with any context.
      try { ctx.close(); } catch (_) { /* ignore */ }
      ctx = new AC();
      await resumeWithTimeout(ctx);
    }
    return ctx;
  }

  // resume() can hang forever in Safari when it isn't allowed to start.
  function resumeWithTimeout(c, ms = 400) {
    return Promise.race([
      c.resume().catch(() => {}),
      new Promise((r) => setTimeout(r, ms)),
    ]);
  }

  // Make an AudioBuffer without needing an AudioContext (so restoring a saved
  // game never creates one before the user taps).
  function makeBuffer(channels, length, sampleRate) {
    try {
      return new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
    } catch (_) {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; ctx = new AC(); }
      return ctx.createBuffer(channels, length, sampleRate);
    }
  }


  // iOS Safari only lets audio start inside a user gesture; play one silent
  // sample the first time the user taps anything so later playback works.
  let unlocked = false;
  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    ensureCtx().then((c) => {
      const b = c.createBuffer(1, 1, c.sampleRate);
      const s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    });
  }
  document.addEventListener('touchend', unlockAudio, { once: false, passive: true });
  document.addEventListener('click', unlockAudio);

  function pickMimeType() {
    if (!window.MediaRecorder) return null;
    const candidates = [
      'audio/webm;codecs=opus', // Chrome, Firefox, Edge
      'audio/mp4',              // Safari (desktop + iOS)
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  // decodeAudioData: older Safari only supports the callback form.
  function decode(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  function reverseBuffer(buf) {
    const out = makeBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c).slice(); // copy
      data.reverse();
      out.getChannelData(c).set(data);
    }
    return out;
  }

  // Trim leading/trailing silence so the reversed clip doesn't start with
  // a long dead gap (the tap-to-stop delay would otherwise lead the clip).
  // Works on 10 ms RMS windows (not single samples) so one click/pop from the
  // encoder or mic start-up can't dominate, and ignores the first 80 ms.
  function trimSilence(buf) {
    const d = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const win = Math.max(1, Math.floor(sr * 0.01));
    const n = Math.floor(d.length / win);
    let peak = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    if (n < 4) return { buffer: buf, peak, loud: peak };
    const rms = new Float32Array(n);
    for (let w = 0; w < n; w++) {
      let s = 0;
      for (let i = w * win; i < (w + 1) * win; i++) s += d[i] * d[i];
      rms[w] = Math.sqrt(s / win);
    }
    const skip = Math.min(n - 1, 8); // 80 ms
    const sorted = Array.from(rms.subarray(skip)).sort((a, b) => a - b);
    const loud = sorted[Math.floor((sorted.length - 1) * 0.95)] || 0;
    const noise = sorted[Math.floor((sorted.length - 1) * 0.1)] || 0;
    if (loud < 0.002 || loud < noise * 2) return { buffer: buf, peak, loud };
    const thresh = noise + (loud - noise) * 0.1;
    let s = skip; while (s < n && rms[s] < thresh) s++;
    let e = n - 1; while (e > s && rms[e] < thresh) e--;
    const pad = Math.floor(sr * 0.12);
    const start = Math.max(skip * win, s * win - pad);
    const end = Math.min(d.length - 1, (e + 1) * win + pad);
    const len = end - start + 1;
    if (len <= 0 || len >= buf.length - 1) return { buffer: buf, peak, loud };
    const out = makeBuffer(buf.numberOfChannels, len, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      out.getChannelData(c).set(buf.getChannelData(c).subarray(start, end + 1));
    }
    return { buffer: out, peak, loud };
  }

  // Recording stats for debugging. Add ?debug to the URL to also send them to
  // the local dev server's access log (the request 404s; the query string is
  // what shows up in the log).
  function devLog(stats) {
    console.log('[did-i-say-that]', stats);
    if (!new URLSearchParams(location.search).has('debug')) return;
    const q = new URLSearchParams(Object.entries(stats).map(([k, v]) => [k, String(v)]));
    fetch(`/__log?${q}`, { cache: 'no-store' }).catch(() => {});
  }

  // Start a recording. Returns { analyser, stop(), done: Promise<{buffer, peak}> }.
  // iOS 17+ (Safari): after the mic has been used the page stays in a
  // "play-and-record" session that routes output to the quiet earpiece.
  // Switch the session type explicitly around recording vs playback.
  function setAudioSession(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) { /* ignore */ }
  }

  async function startRecording() {
    setAudioSession('play-and-record');
    await ensureCtx();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    const mime = pickMimeType();
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);

    const done = new Promise((resolve, reject) => {
      rec.onstop = async () => {
        // Release the mic right away: on iOS an open mic routes playback to
        // the quiet earpiece / ducks the volume.
        stream.getTracks().forEach((t) => t.stop());
        try { src.disconnect(); } catch (_) { /* ignore */ }
        try {
          if (!chunks.length) throw new Error('No audio captured');
          const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
          const ab = await blob.arrayBuffer();
          const decoded = await decode(ab);
          const result = trimSilence(decoded);
          // where is the loudest sample? (seconds from start)
          const ch = decoded.getChannelData(0);
          let pi = 0; for (let i = 1; i < ch.length; i++) if (Math.abs(ch[i]) > Math.abs(ch[pi])) pi = i;
          devLog({
            mime: rec.mimeType || mime, bytes: blob.size, chunks: chunks.length,
            ctxRate: ctx.sampleRate, bufRate: decoded.sampleRate, ch: decoded.numberOfChannels,
            rawDur: decoded.duration.toFixed(2), rawPeak: Math.abs(ch[pi]).toFixed(3), peakAt: (pi / decoded.sampleRate).toFixed(2),
            loudRms: (result.loud || 0).toFixed(4), trimDur: result.buffer.duration.toFixed(2),
            ua: navigator.userAgent.replace(/[^A-Za-z0-9./ ]/g, '').slice(0, 120),
          });
          resolve(result);
        } catch (err) { reject(err); }
      };
      rec.onerror = (e) => {
        stream.getTracks().forEach((t) => t.stop());
        reject(e.error || e);
      };
    });

    rec.start();
    return {
      analyser,
      stop: () => { if (rec.state !== 'inactive') rec.stop(); },
      done,
    };
  }

  function stopPlayback() {
    if (currentSource) {
      currentSource.onended = null;
      try { currentSource.stop(); } catch (_) { /* ignore */ }
      currentSource = null;
    }
    currentPlayBtns.forEach((b) => b.classList.remove('playing'));
    currentPlayBtns = [];
  }

  // rate < 1 plays slower (and lower, like a slowed-down tape).
  async function playBuffer(buffer, btns = [], rate = 1) {
    setAudioSession('playback');
    await ensureCtx();
    stopPlayback();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(ctx.destination);
    currentSource = src;
    currentPlayBtns = btns;
    btns.forEach((b) => b.classList.add('playing'));
    return new Promise((resolve) => {
      src.onended = () => {
        if (currentSource === src) { currentSource = null; }
        btns.forEach((b) => b.classList.remove('playing'));
        resolve();
      };
      src.start(0);
    });
  }

  // ---------- game state ----------
  const state = {
    teams: [{ name: 'Team Rewind', score: 0 }, { name: 'Team Backspin', score: 0 }],
    target: 10,
    guessing: 0,           // index of the team guessing this turn (Echo's team)
    screen: 'setup',
    secret: '',
    revPlays: 0,
    revSpeed: 1,           // playback speed for the backwards original (kept across turns)
    guess: '',
    guessLocked: false,
    pendingScore: null,  // auto score (0/1/2), host can override before Next turn
    winner: null,
    clips: { original: null, imitation: null }, // { fwd, rev }
    recording: null,       // active recorder controller (never saved)
  };

  function clipFrom(buffer, doNormalize = true) {
    if (doNormalize) normalize(buffer);
    return { fwd: buffer, rev: reverseBuffer(buffer), slow: {} };
  }

  // ---------- slow down without lowering the pitch ----------
  // WSOLA time-stretch: chop the clip into overlapping 40 ms windows and lay
  // them out further apart, nudging each window (±12 ms) to where it lines
  // up best with the previous one so the voice stays smooth. Output is
  // 1/rate times longer at the same pitch. Mono (recordings are mono anyway).
  function timeStretch(buf, rate) {
    const x = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const N = Math.round(sr * 0.04) & ~1;   // window length (even)
    const Hs = N / 2;                       // output hop (50% overlap)
    const Ha = Hs * rate;                   // input hop
    const tol = Math.round(sr * 0.012);     // search range for best alignment
    const outLen = Math.ceil(x.length / rate);
    const y = new Float32Array(outLen + N);
    const wsum = new Float32Array(outLen + N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const at = (i) => (i >= 0 && i < x.length ? x[i] : 0);

    let prev = 0;
    for (let k = 0; ; k++) {
      const ideal = Math.round(k * Ha);
      if (ideal >= x.length) break;
      let pos = ideal;
      if (k > 0) {
        const target = prev + Hs; // where the previous window naturally continues
        // coarse search (every 2nd offset, every 4th sample) ...
        let best = -Infinity; let bestOff = 0;
        for (let off = -tol; off <= tol; off += 2) {
          const c = ideal + off; let s = 0;
          for (let i = 0; i < N; i += 4) s += at(c + i) * at(target + i);
          if (s > best) { best = s; bestOff = off; }
        }
        // ... then refine around the winner at full resolution
        let best2 = -Infinity; let fine = bestOff;
        for (let off = Math.max(-tol, bestOff - 2); off <= Math.min(tol, bestOff + 2); off++) {
          const c = ideal + off; let s = 0;
          for (let i = 0; i < N; i++) s += at(c + i) * at(target + i);
          if (s > best2) { best2 = s; fine = off; }
        }
        pos = ideal + fine;
      }
      const o0 = k * Hs;
      for (let i = 0; i < N; i++) { y[o0 + i] += at(pos + i) * win[i]; wsum[o0 + i] += win[i]; }
      prev = pos;
    }
    const out = makeBuffer(1, outLen, sr);
    const d = out.getChannelData(0);
    for (let i = 0; i < outLen; i++) d[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : 0;
    return out;
  }

  // The backwards clip at a given speed (1 = as recorded). Cached per clip.
  function revAtSpeed(clip, speed) {
    if (speed === 1) return clip.rev;
    if (!clip.slow[speed]) clip.slow[speed] = timeStretch(clip.rev, speed);
    return clip.slow[speed];
  }

  // Work out the slow versions in the background so a tap plays instantly.
  function prepareSlow(clip) {
    [0.75, 0.5].forEach((sp, i) => setTimeout(() => { if (clip) revAtSpeed(clip, sp); }, 150 + i * 150));
  }

  // Boost quiet mic recordings so the loudest moment hits ~-0.5 dBFS.
  // Gain is capped so a near-silent take doesn't become pure hiss.
  function normalize(buf) {
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    if (peak <= 0) return 1;
    const gain = Math.min(0.95 / peak, 40);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= gain;
    }
    return gain;
  }

  // ---------- saving (survives reload / refresh) ----------
  // Game state -> localStorage. Recordings -> IndexedDB (raw samples of the
  // forward clip; the reversed copy is rebuilt on load). Everything is
  // best-effort: private browsing or blocked storage just means no resume.
  const SAVE_KEY = 'did-i-say-that:v1';

  function save() {
    if (net) return; // multi-phone games are saved by online.js
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        teams: state.teams, target: state.target, guessing: state.guessing,
        screen: state.screen, secret: state.secret, revPlays: state.revPlays, revSpeed: state.revSpeed,
        guess: state.guess, guessLocked: state.guessLocked,
        pendingScore: state.pendingScore, winner: state.winner,
      }));
    } catch (_) { /* storage unavailable */ }
  }

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (_) { return null; }
  }

  const clipStore = (() => {
    let dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          const req = indexedDB.open('did-i-say-that', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('clips');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return dbp;
    }
    async function run(mode, fn) {
      try {
        const db = await open();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('clips', mode);
          const req = fn(tx.objectStore('clips'));
          tx.oncomplete = () => resolve(req && req.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch (err) {
        console.warn('[did-i-say-that] clip storage unavailable', err);
        return undefined;
      }
    }
    return {
      put: (which, buf) => run('readwrite', (s) => s.put({ rate: buf.sampleRate, data: buf.getChannelData(0).slice() }, which)),
      get: (which) => run('readonly', (s) => s.get(which)),
      del: (which) => run('readwrite', (s) => s.delete(which)),
      clear: () => run('readwrite', (s) => s.clear()),
    };
  })();

  // ---------- screens ----------
  function show(id) {
    stopPlayback();
    state.screen = id;
    save();
    $$('.screen').forEach((s) => { s.hidden = s.id !== `screen-${id}`; });
    $('#scoreboard').hidden = ['setup', 'join', 'lobby'].includes(id);
    $('#btn-newgame').hidden = id === 'setup' || id === 'join';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function paintTeams() {
    const g = state.guessing; const o = 1 - g;
    $$('.active-team').forEach((el) => { el.textContent = state.teams[g].name; el.className = `active-team t${g}`; });
    $$('.other-team').forEach((el) => { el.textContent = state.teams[o].name; el.className = `other-team t${o}`; });
    $$('.team-chip').forEach((chip) => {
      const i = Number(chip.dataset.team);
      $('.tname', chip).textContent = state.teams[i].name;
      $('.tscore', chip).textContent = state.teams[i].score;
      chip.classList.toggle('active', i === g);
    });
  }

  // ---------- recorder widgets ----------
  function setupRecorder(rootSel, which, labels) {
    const root = $(rootSel);
    const btn = $('[data-role="rec"]', root);
    const label = $('.label', btn);
    const fill = $('.meter-fill', root);
    const timer = $('.timer', root);
    const after = $(`#after-${which}`);

    function reset() {
      btn.classList.remove('recording', 'done');
      btn.disabled = false;
      label.textContent = labels.idle;
      fill.style.width = '0%';
      timer.textContent = '0.0s';
      after.hidden = true;
    }

    function markDone(duration) {
      btn.classList.remove('recording');
      btn.classList.add('done');
      btn.disabled = false;
      label.textContent = 'Got it ✓';
      fill.style.width = '0%';
      timer.textContent = `${duration.toFixed(1)}s`;
      after.hidden = false;
    }

    btn.addEventListener('click', async () => {
      if (state.recording && state.recording.which === which) {
        state.recording.stop();
        return;
      }
      if (state.recording) return; // another recorder busy
      if (btn.classList.contains('done')) {
        // tapping the green "done" button = redo
        discardClip(which);
      }
      stopPlayback();

      let ctl;
      try {
        ctl = await startRecording();
      } catch (err) {
        console.error(err);
        toast(micErrorMessage(err), 5000);
        return;
      }

      btn.classList.add('recording');
      label.textContent = 'Stop';
      const t0 = performance.now();
      const data = new Uint8Array(ctl.analyser.fftSize);
      let raf = 0; let autoStop = 0;

      const tick = () => {
        ctl.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        fill.style.width = `${Math.min(100, rms * 400)}%`;
        timer.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
        raf = requestAnimationFrame(tick);
      };
      tick();
      autoStop = setTimeout(() => { if (state.recording) state.recording.stop(); }, MAX_SECONDS * 1000);

      state.recording = {
        which,
        stop: () => {
          cancelAnimationFrame(raf);
          clearTimeout(autoStop);
          btn.disabled = true;
          label.textContent = '…';
          ctl.stop();
        },
      };

      try {
        const { buffer, peak } = await ctl.done;
        state.recording = null;
        if (peak < 0.01) toast('Hmm, that was really quiet. Check the mic and maybe redo it.', 4000);
        state.clips[which] = clipFrom(buffer);
        clipStore.put(which, state.clips[which].fwd);
        if (net) net.onClip(which);
        if (which === 'original') prepareSlow(state.clips.original);
        markDone(buffer.duration);
        refreshPassBtn();
        if (which === 'imitation') $('#btn-to-reveal').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) {
        console.error(err);
        state.recording = null;
        reset();
        toast(`Couldn't process that recording (${err && err.message ? err.message : err}). Try again.`, 5000);
      }
    });

    return { reset, markDone };
  }

  function micErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Mic access was blocked. Allow the microphone for this page (address-bar / Settings › Safari › Microphone) and try again.';
    if (name === 'NotFoundError') return 'No microphone found on this device.';
    if (!navigator.mediaDevices) return 'Mic needs a secure page — open it via https:// or http://localhost.';
    return `Couldn't start the mic: ${err && err.message ? err.message : err}`;
  }

  const recorders = {
    original: setupRecorder('#rec-original', 'original', { idle: 'Record' }),
    imitation: setupRecorder('#rec-imitation', 'imitation', { idle: 'Record copy' }),
  };

  function discardClip(which) {
    state.clips[which] = null;
    clipStore.del(which);
    if (net) net.onClip(which);
    recorders[which].reset();
    refreshPassBtn();
  }

  // ---------- play / redo buttons (delegated) ----------
  document.addEventListener('click', (e) => {
    const playBtn = e.target.closest('[data-play]');
    if (playBtn) {
      const [which, dir] = playBtn.dataset.play.split('-');
      const clip = state.clips[which];
      if (!clip) { toast('Nothing recorded yet.'); return; }
      if (state.recording) { toast('Finish recording first.'); return; }
      if (playBtn.classList.contains('playing')) { stopPlayback(); return; }
      if (which === 'original' && dir === 'rev' && state.screen === 'echo') {
        state.revPlays += 1;
        $('#rev-count').textContent = `(${state.revPlays}×)`;
        save();
      }
      // pulse every button that plays the same thing
      const twins = $$(`[data-play="${playBtn.dataset.play}"]`);
      // The speed choice only slows the backwards original (the hard one to
      // follow), using the pitch-preserving stretch.
      if (which === 'original' && dir === 'rev') {
        ensureCtx(); // start audio inside the tap, before any stretching work
        playBuffer(revAtSpeed(clip, state.revSpeed), twins);
      } else {
        playBuffer(dir === 'rev' ? clip.rev : clip.fwd, twins);
      }
      return;
    }
    const redoBtn = e.target.closest('[data-redo]');
    if (redoBtn) {
      stopPlayback();
      discardClip(redoBtn.dataset.redo);
    }
  });

  // ---------- backwards-clip speed ----------
  function paintSpeed() {
    $$('#speed button').forEach((x) => x.classList.toggle('on', Number(x.dataset.speed) === state.revSpeed));
  }
  $$('#speed button').forEach((b) => b.addEventListener('click', () => {
    state.revSpeed = Number(b.dataset.speed);
    paintSpeed();
    save();
    // If the clip is playing, restart it at the new speed.
    const playBtn = $('#screen-echo [data-play="original-rev"]');
    if (playBtn.classList.contains('playing') && state.clips.original) {
      ensureCtx();
      playBuffer(revAtSpeed(state.clips.original, state.revSpeed), $$('[data-play="original-rev"]'));
    }
  }));

  // ---------- setup screen ----------
  function paintTarget() {
    $$('#target button').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === state.target));
  }
  $$('#target button').forEach((b) => b.addEventListener('click', () => {
    state.target = Number(b.dataset.v);
    paintTarget();
  }));

  function resetTurnState() {
    state.clips.original = null;
    state.clips.imitation = null;
    state.revPlays = 0;
    state.secret = '';
    state.guess = '';
    state.guessLocked = false;
    state.pendingScore = null;
    state.winner = null;
    clipStore.clear();
  }

  // Paint the turn screens from state (used for new turns and after a reload).
  function paintTurn() {
    $('#rev-count').textContent = state.revPlays ? `(${state.revPlays}×)` : '';
    $('#secret').value = state.secret;
    $('#guess').value = state.guess;
    ['original', 'imitation'].forEach((w) => {
      recorders[w].reset();
      if (state.clips[w]) recorders[w].markDone(state.clips[w].fwd.duration);
    });
    refreshPassBtn();
    paintGuess();
    paintTeams();
  }

  function startTurn() {
    resetTurnState();
    paintTurn();
    show('speaker');
  }

  function showWinner() {
    const w = state.teams[state.winner];
    $('#winner-text').textContent = `${w.name} wins!`;
    $('#winner-score').textContent = `${state.teams[0].name} ${state.teams[0].score} – ${state.teams[1].score} ${state.teams[1].name}`;
    paintTeams();
    show('winner');
  }

  $('#btn-start').addEventListener('click', async () => {
    await ensureCtx();
    state.teams[0].name = $('#team0').value.trim() || 'Team 1';
    state.teams[1].name = $('#team1').value.trim() || 'Team 2';
    state.teams.forEach((t) => { t.score = 0; });
    state.guessing = 0;
    startTurn();
  });

  $('#secret').addEventListener('input', (e) => {
    state.secret = e.target.value;
    save();
    refreshPassBtn();
  });
  $('#secret').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $('#btn-to-echo').addEventListener('click', () => {
    if (!state.clips.original) return;
    if (!state.secret.trim()) { toast('Type the phrase first.'); $('#secret').focus(); return; }
    $('#secret').blur();
    if (net) { net.speakerDone(); return; }
    show('echo');
  });

  $('#btn-to-reveal').addEventListener('click', () => {
    if (!state.clips.imitation) return;
    if (net) { net.echoDone(); return; }
    show('reveal');
  });

  // ---------- guessing & automatic scoring ----------
  function norm(str) {
    return String(str).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/['’`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // 2 = nailed it: same phrase ignoring case, punctuation and spacing, with
  //     a typo or two allowed (90%+ of the letters match).
  // 1 = close: at least half the words (small typos OK in longer words),
  //     or 60%+ of the letters match.
  // 0 = nope.
  function judgeGuess(phrase, guess) {
    const p = norm(phrase); const g = norm(guess);
    if (!p || !g) return 0;
    const ps = p.replace(/ /g, ''); const gs = g.replace(/ /g, '');
    const sim = 1 - lev(ps, gs) / Math.max(ps.length, gs.length);
    if (sim >= 0.9) return 2;
    const pw = p.split(' '); const gw = g.split(' ');
    const used = new Set(); let hits = 0;
    for (const w of pw) {
      const i = gw.findIndex((x, j) => !used.has(j) && (x === w || (w.length >= 4 && lev(x, w) <= 1)));
      if (i >= 0) { used.add(i); hits++; }
    }
    if (hits / pw.length >= 0.5 || sim >= 0.6) return 1;
    return 0;
  }

  const VERDICTS = { 2: 'Nailed it! +2', 1: 'Close! +1', 0: 'Nope — 0 points' };

  function refreshPassBtn() {
    const hasClip = !!state.clips.original;
    const hasPhrase = !!state.secret.trim();
    $('#btn-to-echo').disabled = !(hasClip && hasPhrase);
    $('#secret-hint').hidden = !hasClip || hasPhrase;
  }

  function paintGuess() {
    const locked = state.guessLocked;
    $('#guess-box').hidden = locked;
    $('#result').hidden = !locked;
    $('#replay-original-fwd').hidden = !locked; // no peeking at the original before guessing
    $('#btn-guess').disabled = !state.guess.trim();
    $('#btn-next').disabled = false;
    if (!locked) return;
    const pts = state.pendingScore ?? 0;
    const v = $('#verdict');
    v.textContent = VERDICTS[pts];
    v.className = `verdict v${pts}`;
    $('#answer-text').textContent = state.secret;
    $('#guess-text').textContent = state.guess;
    $$('[data-override]').forEach((b) => b.classList.toggle('on', Number(b.dataset.override) === pts));
  }

  function lockGuess() {
    if (state.guessLocked || !state.guess.trim()) return;
    if (net) { $('#guess').blur(); net.guess(state.guess); return; }
    state.guessLocked = true;
    state.pendingScore = judgeGuess(state.secret, state.guess);
    save();
    $('#guess').blur();
    paintGuess();
    playBuffer(state.clips.original.fwd, $$('[data-play="original-fwd"]'));
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('#guess').addEventListener('input', (e) => {
    state.guess = e.target.value;
    $('#btn-guess').disabled = !state.guess.trim();
    save();
  });
  $('#guess').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lockGuess(); } });
  $('#btn-guess').addEventListener('click', lockGuess);

  $$('[data-override]').forEach((b) => b.addEventListener('click', () => {
    if (net) { net.override(Number(b.dataset.override)); return; }
    state.pendingScore = Number(b.dataset.override);
    save();
    paintGuess();
  }));

  $('#btn-next').addEventListener('click', () => {
    if (net) { net.next(); return; }
    commitScore(state.pendingScore ?? 0);
  });

  function commitScore(pts) {
    $('#btn-next').disabled = true;
    const g = state.guessing;
    const team = state.teams[g];
    team.score += pts;
    $(`.team-chip[data-team="${g}"] .tscore`).textContent = team.score;
    if (pts) {
      const chip = $(`.team-chip[data-team="${g}"] .tscore`);
      chip.classList.remove('bump'); void chip.offsetWidth; chip.classList.add('bump');
      toast(`${team.name} +${pts}!`, 1500);
    }
    // Commit the outcome now, so a reload during the celebration can't
    // score the same turn twice.
    const won = team.score >= state.target;
    if (won) {
      state.winner = g;
      state.screen = 'winner';
    } else {
      state.guessing = 1 - g;
      resetTurnState();
      state.screen = 'speaker';
    }
    save();
    setTimeout(() => {
      if (won) { showWinner(); return; }
      paintTurn();
      show('speaker');
    }, pts ? 1100 : 400);
  }

  $('#btn-again').addEventListener('click', () => {
    if (net) { net.rematch(); return; }
    state.teams.forEach((t) => { t.score = 0; });
    state.guessing = 0;
    startTurn();
  });
  $('#btn-newteams').addEventListener('click', () => show('setup'));

  // Abandon the current game: back to setup (team names stay filled in).
  $('#btn-newgame').addEventListener('click', () => {
    if (state.recording) { toast('Finish recording first.'); return; }
    if (net) { net.leave(); return; }
    if (state.screen !== 'winner' && !window.confirm('Start a new game? Scores and recordings from this game will be lost.')) return;
    resetTurnState();
    state.teams.forEach((t) => { t.score = 0; });
    state.guessing = 0;
    $('#team0').value = state.teams[0].name;
    $('#team1').value = state.teams[1].name;
    paintTarget();
    show('setup');
  });

  // ---------- resume after reload ----------
  async function restore() {
    try { if (localStorage.getItem(ONLINE_KEY)) return; } catch (_) { /* ignore */ } // online.js resumes it
    const s = loadSaved();
    if (!s || !Array.isArray(s.teams) || s.teams.length !== 2) return;
    state.teams = s.teams.map((t, i) => ({ name: String(t.name || `Team ${i + 1}`), score: Number(t.score) || 0 }));
    state.target = [6, 10, 16].includes(s.target) ? s.target : 10;
    state.guessing = s.guessing === 1 ? 1 : 0;
    state.secret = typeof s.secret === 'string' ? s.secret : '';
    state.revPlays = Number(s.revPlays) || 0;
    state.revSpeed = [1, 0.75, 0.5].includes(s.revSpeed) ? s.revSpeed : 1;
    paintSpeed();
    state.guess = typeof s.guess === 'string' ? s.guess : '';
    state.guessLocked = !!s.guessLocked;
    state.pendingScore = [0, 1, 2].includes(s.pendingScore) ? s.pendingScore : null;
    state.winner = s.winner === 0 || s.winner === 1 ? s.winner : null;
    $('#team0').value = state.teams[0].name;
    $('#team1').value = state.teams[1].name;
    paintTarget();

    let screen = s.screen;
    if (!['speaker', 'echo', 'reveal', 'winner'].includes(screen)) return; // stay on setup

    if (screen === 'winner') {
      if (state.winner === null) screen = 'speaker';
      else { showWinner(); toast('Game restored'); return; }
    }

    // Rebuild recordings. No AudioContext here: Safari won't play through a
    // context created before the user taps (see makeBuffer / ensureCtx).
    for (const which of ['original', 'imitation']) {
      const rec = await clipStore.get(which);
      if (rec && rec.data && rec.data.length) {
        const buf = makeBuffer(1, rec.data.length, rec.rate);
        buf.getChannelData(0).set(rec.data);
        state.clips[which] = clipFrom(buf, false); // already normalized
        if (which === 'original') prepareSlow(state.clips.original);
      }
    }
    // Fall back to the furthest screen the saved recordings support.
    if (!state.clips.original) screen = 'speaker';
    else if (screen === 'reveal' && !state.clips.imitation) screen = 'echo';
    // Saves from before the phrase was required may have no phrase yet.
    if (!state.secret.trim()) screen = 'speaker';
    if (screen !== 'reveal' || state.pendingScore === null) state.guessLocked = false;

    paintTurn();
    show(screen);
    toast('Game restored');
  }

  // ---------- capability check ----------
  const problems = [];
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) problems.push('microphone access (open this page over https:// or http://localhost)');
  if (!window.MediaRecorder) problems.push('audio recording (MediaRecorder) — update your browser');
  if (!(window.AudioContext || window.webkitAudioContext)) problems.push('Web Audio');
  if (problems.length) {
    const w = $('#support-warn');
    w.textContent = `Heads up: this browser is missing ${problems.join(', ')}.`;
    w.hidden = false;
  }

  const ready = restore().catch((err) => console.warn('[did-i-say-that] restore failed', err));

  // exposed for debugging / automated checks
  window.__didISayThat = {
    state, reverseBuffer, get ctx() { return ctx; },
    // used by online.js (multi-phone play)
    $, $$, toast, show, paintTeams, paintTurn, paintGuess, showWinner, clipFrom, makeBuffer,
    prepareSlow, clipStore, judgeGuess, playBuffer, stopPlayback, ONLINE_KEY,
    ready, setNet(n) { net = n; },
  };
})();
