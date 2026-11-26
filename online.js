/* Did I Say That? — multi-phone play with an invite code.
 *
 * The host's phone owns the game. It keeps the one true copy of the game
 * state and broadcasts it over a Supabase Realtime channel named after the
 * invite code; every other phone sends the host "actions" and paints whatever
 * state comes back. Recordings travel over the same channel as 24 kHz mono
 * 16-bit audio, base64, in small chunks. Nothing is stored on a server.
 */
(() => {
  'use strict';
  const api = window.__didISayThat;
  if (!api) return;
  const { $, $$, state, toast, show } = api;

  const SUPABASE_URL = 'https://dvmhwmdavwpzxjfhyfyo.supabase.co';
  // Publishable key: meant to be shipped in the page.
  const SUPABASE_KEY = 'sb_publishable_siMncGF3msSAFb1sTkkilg_jBxPiIP5';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  const MSG_KEY = 'did-i-say-that:msg';
  const NET_RATE = 24000;   // sample rate recordings are sent at
  const CHUNK = 30000;      // base64 characters per message
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O (look like 1 and 0)
  const WHICH = ['original', 'imitation'];

  let client = null;
  let channel = null;
  let code = '';
  let me = null;            // { id, name, team }
  let isHost = false;
  let online = false;       // true once we are in a room
  let confirmed = false;    // the host has us on the player list
  let G = null;             // shared game state (the host's copy is the truth)
  let lastStateAt = 0;
  let lastKey = '';
  let lastTurn = null;
  let lastLobby = '';
  let prevLocked = false;
  let prevScores = null;
  let iLocked = false;      // this phone locked in the guess
  let sending = false;
  let ticks = 0;
  let pool = {};            // clip id -> { which, clip, enc, mine }
  let incoming = {};        // clip id -> chunks received so far
  const have = { original: null, imitation: null }; // ids of the clips in state.clips
  const pre = { original: null, imitation: null }; // recordings already on their way: { id, clip, done }
  const lastAsk = {};
  const lastResend = {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('');
  const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => LETTERS[b % LETTERS.length]).join('');
  const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 14);
  const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const nameOf = (id) => { const p = G && G.players.find((x) => x.id === id); return p ? p.name : 'Someone'; };

  function persist() {
    try {
      localStorage.setItem(api.ONLINE_KEY, JSON.stringify({ code, me, isHost, G: isHost ? G : null, have }));
    } catch (_) { /* storage unavailable */ }
  }

  // ---------- connection ----------
  let sdkPromise = null;
  function loadSdk() {
    if (window.supabase) return Promise.resolve(window.supabase);
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SDK_URL;
        s.onload = () => (window.supabase ? resolve(window.supabase) : reject(new Error('SDK missing')));
        s.onerror = () => { sdkPromise = null; reject(new Error('Could not load the connection library')); };
        document.head.appendChild(s);
      });
    }
    return sdkPromise;
  }

  async function connect() {
    const sb = await loadSdk();
    if (!client) {
      client = sb.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 20 } },
      });
    }
    await disconnect();
    const ch = client.channel(`disaythat-${code}`, { config: { broadcast: { self: false, ack: true } } });
    ch.on('broadcast', { event: 'state' }, (m) => guard(() => onState(m.payload)))
      .on('broadcast', { event: 'act' }, (m) => guard(() => { if (isHost) handle(m.payload); }))
      .on('broadcast', { event: 'clip' }, (m) => guard(() => onChunk(m.payload)))
      .on('broadcast', { event: 'need' }, (m) => guard(() => onNeed(m.payload)));
    channel = ch;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out connecting')), 10000);
      ch.subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        clearTimeout(t);
        resolve();
        // also runs after the connection drops and comes back
        if (isHost) { if (G) send('state', G); } else hello();
      });
    });
  }

  async function disconnect() {
    if (!channel || !client) return;
    const ch = channel; channel = null;
    try { await client.removeChannel(ch); } catch (_) { /* ignore */ }
  }

  function guard(fn) {
    try { fn(); } catch (err) { console.error('[did-i-say-that] online', err); }
  }

  async function send(event, payload) {
    if (!channel) return false;
    try { return (await channel.send({ type: 'broadcast', event, payload })) === 'ok'; } catch (_) { return false; }
  }

  // An action goes to the host; the host applies its own directly.
  function act(a) {
    a.from = me.id;
    if (isHost) { handle(a); return Promise.resolve(true); }
    return send('act', a);
  }

  const hello = () => send('act', { type: 'hello', from: me.id, name: me.name });

  // ---------- recordings over the wire ----------
  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromB64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function encodeClip(buf) {
    const d = buf.getChannelData(0);
    let out = d; let rate = buf.sampleRate;
    if (rate > NET_RATE * 1.05) {
      // downsample by averaging each run of input samples
      const r = rate / NET_RATE;
      const n = Math.floor(d.length / r);
      out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * r); const b = Math.max(a + 1, Math.floor((i + 1) * r));
        let s = 0;
        for (let j = a; j < b; j++) s += d[j];
        out[i] = s / (b - a);
      }
      rate = NET_RATE;
    }
    const pcm = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, out[i])) * 32767);
    return { rate, b64: toB64(new Uint8Array(pcm.buffer)) };
  }

  function decodeClip(rate, b64) {
    const u8 = fromB64(b64);
    const pcm = new Int16Array(u8.buffer, 0, u8.length >> 1);
    const buf = api.makeBuffer(1, Math.max(1, pcm.length), rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32767;
    return buf;
  }

  async function sendClip(id) {
    const item = pool[id];
    if (!item) return false;
    await sleep(0); // let the tap that started this finish painting first
    if (!item.enc) item.enc = encodeClip(item.clip.fwd);
    const { rate, b64 } = item.enc;
    const n = Math.max(1, Math.ceil(b64.length / CHUNK));
    for (let i = 0; i < n; i++) {
      if (pool[id] !== item) return false; // re-recorded or the turn moved on
      const payload = { id, which: item.which, i, n, rate, d: b64.slice(i * CHUNK, (i + 1) * CHUNK) };
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        ok = await send('clip', payload);
        if (!ok) await sleep(300);
      }
      if (!ok) return false;
      await sleep(15);
    }
    return true;
  }

  function onChunk(c) {
    if (!c || typeof c.id !== 'string' || pool[c.id] || !WHICH.includes(c.which)) return;
    if (!(c.n >= 1 && c.n <= 60 && c.i >= 0 && c.i < c.n) || !(c.rate >= 8000 && c.rate <= 96000)) return;
    const inc = incoming[c.id] || (incoming[c.id] = { parts: new Array(c.n), got: 0, at: 0 });
    if (inc.parts.length !== c.n) return;
    if (inc.parts[c.i] === undefined) { inc.parts[c.i] = String(c.d); inc.got += 1; }
    inc.at = Date.now();
    if (inc.got < c.n) return;
    delete incoming[c.id];
    const b64 = inc.parts.join('');
    pool[c.id] = { which: c.which, clip: api.clipFrom(decodeClip(c.rate, b64), false), enc: { rate: c.rate, b64 } };
    if (G && online) { reconcile(); render(); }
  }

  // Someone is missing a recording. The host answers; if it is the host that
  // is missing it, the phone that recorded it answers.
  function onNeed(n) {
    if (!G || !n || !pool[n.id]) return;
    if (!(isHost || (pool[n.id].mine && n.from === G.hostId))) return;
    const now = Date.now();
    if (now - (lastResend[n.id] || 0) < 1500) return;
    lastResend[n.id] = now;
    sendClip(n.id);
  }

  // Line state.clips up with the clip ids in the shared state.
  function reconcile() {
    WHICH.forEach((w) => {
      const want = G.clips[w];
      if (want) {
        if (have[w] === want) return;
        if (pool[want]) {
          state.clips[w] = pool[want].clip;
          have[w] = want;
          if (w === 'original' && me.id === G.echoId) api.prepareSlow(state.clips[w]); // only the Echo needs the slow versions
          api.clipStore.put(w, state.clips[w].fwd);
        } else {
          const now = Date.now();
          const busy = incoming[want] && now - incoming[want].at < 1500;
          if (!busy && now - (lastAsk[want] || 0) > 2000) {
            lastAsk[want] = now;
            send('need', { id: want, from: me.id });
          }
        }
      } else if (have[w]) {
        state.clips[w] = null;
        have[w] = null;
      }
    });
  }

  function wipeTurn() {
    state.clips.original = null;
    state.clips.imitation = null;
    have.original = null;
    have.imitation = null;
    pool = {};
    incoming = {};
    pre.original = null;
    pre.imitation = null;
    state.secret = '';
    state.guess = '';
    state.revPlays = 0;
    iLocked = false;
    api.clipStore.clear();
  }

  // ---------- host: the rules ----------
  const teamPlayers = (t) => G.players.filter((p) => p.team === t);
  function pick(t) {
    const list = teamPlayers(t);
    return list.length ? list[G.rot[t] % list.length].id : null;
  }
  function assign() {
    G.speakerId = pick(1 - G.guessing);
    G.echoId = pick(G.guessing);
  }
  function beginTurn() {
    G.turn += 1;
    G.phase = 'speaker';
    G.secret = '';
    G.guess = '';
    G.guessLocked = false;
    G.pendingScore = null;
    G.clips = { original: null, imitation: null };
    assign();
  }
  function removePlayer(id) {
    if (id === G.hostId) return;
    G.players = G.players.filter((p) => p.id !== id);
    if (G.phase === 'speaker' && id === G.speakerId) { G.clips.original = null; assign(); }
    else if (G.phase === 'echo' && id === G.echoId) assign();
  }

  function handle(a) {
    if (!isHost || !G || !a || typeof a.from !== 'string') return;
    const p = G.players.find((x) => x.id === a.from);
    const fromHost = a.from === G.hostId;
    switch (a.type) {
      case 'hello':
        if (p) { if (cleanName(a.name)) p.name = cleanName(a.name); }
        else {
          const team = teamPlayers(0).length <= teamPlayers(1).length ? 0 : 1;
          G.players.push({ id: a.from, name: cleanName(a.name) || 'Player', team });
          if (['speaker', 'echo'].includes(G.phase) && (!G.speakerId || !G.echoId)) assign();
        }
        break;
      case 'team':
        if (!p || G.phase !== 'lobby' || ![0, 1].includes(a.team)) return;
        p.team = a.team;
        break;
      case 'leave': removePlayer(a.from); break;
      case 'kick': if (!fromHost) return; removePlayer(a.id); break;
      case 'start':
        if (!fromHost || !['lobby', 'winner'].includes(G.phase)) return;
        if (!teamPlayers(0).length || !teamPlayers(1).length) return;
        G.teams.forEach((t) => { t.score = 0; });
        G.guessing = 0;
        G.winner = null;
        if (G.phase === 'lobby') G.rot = [0, 0];
        beginTurn();
        break;
      case 'speakerDone': {
        const secret = String(a.secret || '').trim().slice(0, 80);
        if (G.phase !== 'speaker' || a.from !== G.speakerId || typeof a.clipId !== 'string' || !secret) return;
        G.secret = secret;
        G.clips.original = a.clipId;
        G.phase = 'echo';
        break;
      }
      case 'echoDone':
        if (G.phase !== 'echo' || a.from !== G.echoId || typeof a.clipId !== 'string') return;
        G.clips.imitation = a.clipId;
        G.phase = 'reveal';
        break;
      case 'guess': {
        const text = String(a.text || '').trim().slice(0, 80);
        if (G.phase !== 'reveal' || G.guessLocked || !p || p.team !== G.guessing || !text) return;
        G.guess = text;
        G.guessLocked = true;
        G.pendingScore = api.judgeGuess(G.secret, G.guess);
        break;
      }
      case 'override':
        if (!fromHost || G.phase !== 'reveal' || !G.guessLocked || ![0, 1, 2].includes(a.n)) return;
        G.pendingScore = a.n;
        break;
      case 'next': {
        if (!fromHost || G.phase !== 'reveal' || !G.guessLocked) return;
        const g = G.guessing;
        G.teams[g].score += G.pendingScore || 0;
        G.rot[0] += 1; G.rot[1] += 1;
        if (G.teams[g].score >= G.target) { G.winner = g; G.phase = 'winner'; }
        else { G.guessing = 1 - g; beginTurn(); }
        break;
      }
      case 'skip':
        if (!fromHost) return;
        if (G.phase === 'speaker') { G.rot[1 - G.guessing] += 1; G.clips.original = null; assign(); }
        else if (G.phase === 'echo') { G.rot[G.guessing] += 1; assign(); }
        else return;
        break;
      default: return;
    }
    push();
  }

  function push() {
    G.v += 1;
    send('state', G);
    applyState();
  }

  // ---------- everyone: receive and paint ----------
  function onState(s) {
    if (isHost || !me || !s || s.code !== code || !Array.isArray(s.players)) return;
    if (G && s.hostId === G.hostId && s.v < G.v) return; // older than what we have
    if (s.phase === 'ended') { if (confirmed) exit('The host ended the game.'); return; }
    if (!s.players.some((p) => p.id === me.id)) {
      if (confirmed) exit('You were removed from the game.');
      return; // not on the list yet: our hello is still on its way
    }
    G = s;
    lastStateAt = Date.now();
    if (!confirmed) { confirmed = true; goOnline(); }
    applyState();
  }

  function applyState() {
    const mine = G.players.find((p) => p.id === me.id);
    if (mine) { me.team = mine.team; me.name = mine.name; }
    if (lastTurn !== null && G.turn !== lastTurn) wipeTurn();
    lastTurn = G.turn;
    reconcile();
    render();
    persist();
  }

  function screenFor() {
    switch (G.phase) {
      case 'speaker': return me.id === G.speakerId ? 'speaker' : 'wait';
      case 'echo': return me.id === G.echoId ? 'echo' : 'wait';
      case 'reveal': return 'reveal';
      case 'winner': return 'winner';
      default: return 'lobby';
    }
  }

  function render() {
    state.teams = G.teams.map((t) => ({ name: t.name, score: t.score }));
    state.target = G.target;
    state.guessing = G.guessing;
    state.guessLocked = G.guessLocked;
    state.pendingScore = G.pendingScore;
    state.winner = G.winner;
    if (G.guessLocked) { state.secret = G.secret; state.guess = G.guess; }

    const scr = screenFor();
    const key = `${G.turn}|${G.phase}|${scr}`;
    if (key !== lastKey) {
      lastKey = key;
      if (state.recording) state.recording.stop();
      api.paintTurn();
      if (scr === 'winner') api.showWinner(); else show(scr);
    } else {
      api.paintTeams();
      api.paintGuess();
    }
    paintNet();

    if (G.guessLocked && !prevLocked) {
      if (iLocked && state.clips.original) api.playBuffer(state.clips.original.fwd, $$('[data-play="original-fwd"]'));
      if (scr === 'reveal') $('#result').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    prevLocked = G.guessLocked;

    const scores = G.teams.map((t) => t.score);
    if (prevScores) {
      scores.forEach((sc, i) => {
        if (sc <= prevScores[i]) return;
        const chip = $(`.team-chip[data-team="${i}"] .tscore`);
        chip.classList.remove('bump'); void chip.offsetWidth; chip.classList.add('bump');
        toast(`${G.teams[i].name} +${sc - prevScores[i]}!`, 1500);
      });
    }
    prevScores = scores;
  }

  function paintRoom() {
    const stale = !isHost && confirmed && Date.now() - lastStateAt > 10000;
    const room = $('#room');
    room.hidden = false;
    room.textContent = stale ? `Room ${code} · reconnecting…` : `Room ${code}`;
    room.classList.toggle('stale', stale);
  }

  function paintLobby() {
    const sig = JSON.stringify([G.players, G.teams.map((t) => t.name), me.team, isHost]);
    if (sig === lastLobby) return;
    lastLobby = sig;
    $('#lobby-code').textContent = code;
    [0, 1].forEach((t) => {
      const box = $(`.lobby-team[data-team="${t}"]`);
      $('.lt-name', box).textContent = G.teams[t].name;
      const list = $('.lt-list', box);
      list.textContent = '';
      const players = teamPlayers(t);
      if (!players.length) {
        const empty = document.createElement('div');
        empty.className = 'lt-empty';
        empty.textContent = 'No one yet';
        list.append(empty);
      }
      players.forEach((p) => {
        const row = document.createElement('div');
        row.className = `player${p.id === me.id ? ' me' : ''}`;
        const label = document.createElement('span');
        label.textContent = p.id === G.hostId ? `${p.name} ★` : p.name;
        row.append(label);
        if (isHost && p.id !== me.id) {
          const kick = document.createElement('button');
          kick.type = 'button';
          kick.className = 'kick';
          kick.dataset.kick = p.id;
          kick.setAttribute('aria-label', `Remove ${p.name}`);
          kick.textContent = '✕';
          row.append(kick);
        }
        list.append(row);
      });
      box.classList.toggle('mine', me.team === t);
      $('[data-join-team]', box).hidden = me.team === t;
    });
    const ready = teamPlayers(0).length > 0 && teamPlayers(1).length > 0;
    $('#btn-net-start').hidden = !isHost;
    $('#btn-net-start').disabled = !ready;
    $('#lobby-note').textContent = !isHost ? 'Waiting for the host (★) to start…'
      : ready ? 'Start when everyone is in.' : 'Each team needs at least one player.';
  }

  function paintWait() {
    const g = G.guessing;
    const actor = G.phase === 'speaker' ? G.speakerId : G.echoId;
    let emoji = '⏳'; let title = 'Waiting for players…'; let text = '';
    if (actor && G.phase === 'speaker') {
      emoji = '🎤';
      title = `${nameOf(actor)} is recording a secret phrase`;
      text = me.team === g ? 'No listening in! Your team has to work out what it is.' : `${G.teams[g].name} will have to work out what it is.`;
    } else if (actor && G.phase === 'echo') {
      emoji = '🎧';
      title = `${nameOf(actor)} is copying it backwards`;
      text = 'They hear the phrase backwards and record their best copy. The flip comes next!';
    } else if (!actor) {
      text = 'A team has no players right now.';
    }
    $('#wait-emoji').textContent = emoji;
    $('#wait-title').textContent = title;
    $('#wait-text').textContent = text;
    const skip = $('#btn-skip');
    skip.hidden = !(isHost && actor && ['speaker', 'echo'].includes(G.phase));
    skip.textContent = `Skip ${nameOf(actor)}`;
  }

  function paintNet() {
    paintRoom();
    $('#btn-newgame').textContent = isHost ? '✕ End game' : '✕ Leave game';
    if (G.phase === 'lobby') paintLobby(); else lastLobby = '';
    if (state.screen === 'wait') paintWait();

    // reveal: only the guessing team types; only the host scores and moves on
    const guessers = me.team === G.guessing;
    $('#guess-box').hidden = G.guessLocked || !guessers;
    const gw = $('#net-guess-wait');
    gw.hidden = G.guessLocked || guessers;
    gw.textContent = `${G.teams[G.guessing].name} is working out a guess…`;
    $('.override').hidden = !isHost;
    $('#btn-next').hidden = !isHost;
    $('#net-next-wait').hidden = isHost;
    $('#btn-again').hidden = !isHost;
    $('#btn-newteams').hidden = true;
    $('#net-winner-wait').hidden = isHost;

    // play buttons wait for the recording to arrive
    $$('#screen-echo [data-play^="original"], #screen-reveal [data-play^="original"]').forEach((b) => { b.disabled = !state.clips.original; });
    $$('#screen-reveal [data-play^="imitation"]').forEach((b) => { b.disabled = !state.clips.imitation; });
  }

  // ---------- this phone's moves ----------
  // Start sending a recording the moment it is made, so by the time its
  // owner taps Done the other phones usually have it already.
  function presend(which) {
    const old = pre[which];
    if (old) delete pool[old.id]; // stops a send still in progress
    pre[which] = null;
    const clip = state.clips[which];
    if (!clip) return;
    const id = rid();
    pool[id] = { which, clip, mine: true };
    pre[which] = { id, clip, done: sendClip(id) };
  }

  async function finishClip(which, btn, makeAction) {
    const clip = state.clips[which];
    if (!clip || sending) return;
    sending = true;
    btn.disabled = true;
    const keyThen = lastKey;
    if (!pre[which] || pre[which].clip !== clip) presend(which);
    const p = pre[which];
    let ok = await p.done;
    if (!ok && pre[which] === p) { p.done = sendClip(p.id); ok = await p.done; } // one more try
    ok = ok && pre[which] === p && (await act(makeAction(p.id)));
    sending = false;
    if (!ok) {
      btn.disabled = false;
      toast("Couldn't send that. Check your connection and try again.", 4500);
      return;
    }
    // If the host never answers, let them try again.
    setTimeout(() => { if (lastKey === keyThen) btn.disabled = false; }, 6000);
  }

  const net = {
    onClip(which) { have[which] = null; persist(); presend(which); },
    speakerDone() {
      finishClip('original', $('#btn-to-echo'), (id) => ({ type: 'speakerDone', clipId: id, secret: state.secret.trim() }));
    },
    echoDone() {
      finishClip('imitation', $('#btn-to-reveal'), (id) => ({ type: 'echoDone', clipId: id }));
    },
    guess(text) { iLocked = true; act({ type: 'guess', text }); },
    override(n) { act({ type: 'override', n }); },
    next() { act({ type: 'next' }); },
    rematch() { act({ type: 'start' }); },
    async leave() {
      if (isHost) {
        if (!window.confirm('End the game for everyone?')) return;
        G.phase = 'ended';
        G.v += 1;
        await send('state', G);
      } else {
        if (!window.confirm('Leave this game?')) return;
        await send('act', { type: 'leave', from: me.id });
      }
      exit('');
    },
  };

  function goOnline() {
    if (online) return;
    online = true;
    api.setNet(net);
    document.body.classList.add('online');
    persist();
    setInterval(() => {
      if (!online || !me) return;
      ticks += 1;
      if (G && confirmed) { reconcile(); paintNet(); } // ask again for a recording that hasn't arrived
      if (isHost) { if (G && ticks % 2 === 0) send('state', G); return; }
      if (!confirmed || Date.now() - lastStateAt > 10000) hello();
      paintRoom();
    }, 2000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !online) return;
      if (isHost) { if (G) send('state', G); } else hello();
    });
  }

  // Back to a clean single-phone page.
  async function exit(msg) {
    online = false;
    try { localStorage.removeItem(api.ONLINE_KEY); } catch (_) { /* ignore */ }
    try { if (msg) sessionStorage.setItem(MSG_KEY, msg); } catch (_) { /* ignore */ }
    await Promise.race([Promise.all([api.clipStore.clear(), disconnect()]), sleep(1500)]);
    location.replace(location.pathname);
  }

  // ---------- host / join buttons ----------
  function needName(input) {
    const name = cleanName(input.value);
    if (!name) { toast('Type your name first.'); input.focus(); }
    return name;
  }

  $('#btn-host').addEventListener('click', async (e) => {
    const name = needName($('#net-name'));
    if (!name) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    code = makeCode();
    me = { id: rid(), name, team: 0 };
    isHost = true;
    try {
      await connect();
    } catch (err) {
      console.error(err);
      isHost = false; me = null; code = '';
      btn.disabled = false;
      toast("Couldn't connect. Check your internet and try again.", 4500);
      return;
    }
    G = {
      v: 0, code, hostId: me.id,
      teams: [
        { name: $('#team0').value.trim() || 'Team 1', score: 0 },
        { name: $('#team1').value.trim() || 'Team 2', score: 0 },
      ],
      target: state.target,
      players: [{ id: me.id, name, team: 0 }],
      phase: 'lobby', turn: 0, guessing: 0, rot: [0, 0],
      speakerId: null, echoId: null,
      secret: '', guess: '', guessLocked: false, pendingScore: null, winner: null,
      clips: { original: null, imitation: null },
    };
    confirmed = true;
    goOnline();
    push();
  });

  $('#btn-join').addEventListener('click', () => {
    $('#join-name').value = $('#net-name').value;
    show('join');
    $('#join-code').focus();
  });
  $('#btn-join-back').addEventListener('click', () => show('setup'));
  $('#join-code').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });
  $('#join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join-go').click(); });

  $('#btn-join-go').addEventListener('click', async (e) => {
    const c = cleanCode($('#join-code').value);
    if (c.length !== 4) { toast('The invite code is 4 letters.'); $('#join-code').focus(); return; }
    const name = needName($('#join-name'));
    if (!name) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Joining…';
    code = c;
    me = { id: rid(), name, team: null };
    isHost = false;
    let problem = '';
    try {
      await connect();
      const t0 = Date.now();
      while (!confirmed && Date.now() - t0 < 8000) { await hello(); await sleep(1200); }
      if (!confirmed) problem = `No game found with the code ${c}. Check it with the host.`;
    } catch (err) {
      console.error(err);
      problem = "Couldn't connect. Check your internet and try again.";
    }
    btn.disabled = false;
    btn.textContent = 'Join';
    if (!confirmed) {
      await disconnect();
      me = null; code = '';
      toast(problem, 5000);
    }
  });

  // ---------- lobby / waiting buttons ----------
  document.addEventListener('click', (e) => {
    if (!online || !G) return;
    const join = e.target.closest('[data-join-team]');
    if (join) { act({ type: 'team', team: Number(join.dataset.joinTeam) }); return; }
    const kick = e.target.closest('[data-kick]');
    if (kick && window.confirm(`Remove ${nameOf(kick.dataset.kick)} from the game?`)) act({ type: 'kick', id: kick.dataset.kick });
  });
  $('#btn-net-start').addEventListener('click', () => act({ type: 'start' }));
  $('#btn-skip').addEventListener('click', () => act({ type: 'skip' }));

  $('#btn-share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?join=${code}`;
    const text = `Join my game of Did I Say That? The code is ${code}.`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Did I Say That?', text, url }); return; }
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.');
    } catch (err) {
      if (err && err.name === 'AbortError') return; // closed the share sheet
      window.prompt('Copy this invite link:', url);
    }
  });

  // ---------- on load: resume a game, or open an invite link ----------
  async function resume(s) {
    code = s.code; me = s.me; isHost = !!s.isHost;
    G = isHost ? s.G : null;
    confirmed = isHost;
    goOnline();
    // recordings saved on this phone
    for (const w of WHICH) {
      const id = s.have && s.have[w];
      if (!id) continue;
      const rec = await api.clipStore.get(w);
      if (!rec || !rec.data || !rec.data.length) continue;
      const buf = api.makeBuffer(1, rec.data.length, rec.rate);
      buf.getChannelData(0).set(rec.data);
      pool[id] = { which: w, clip: api.clipFrom(buf, false) };
    }
    if (isHost) applyState();
    else {
      $('#wait-emoji').textContent = '⏳';
      $('#wait-title').textContent = 'Getting back into the game…';
      $('#wait-text').textContent = `Room ${code}`;
      show('wait');
      paintRoom();
    }
    for (;;) {
      try { await connect(); return; } catch (err) { console.warn('[did-i-say-that] reconnect failed', err); await sleep(3000); }
      if (!online) return;
    }
  }

  (async () => {
    let msg = '';
    try { msg = sessionStorage.getItem(MSG_KEY) || ''; sessionStorage.removeItem(MSG_KEY); } catch (_) { /* ignore */ }
    if (msg) toast(msg, 4500);

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(api.ONLINE_KEY) || 'null'); } catch (_) { /* ignore */ }
    const link = cleanCode(new URLSearchParams(location.search).get('join'));
    const usable = saved && saved.code && saved.me && saved.me.id && (!saved.isHost || saved.G);
    if (usable && (link.length !== 4 || link === saved.code)) { resume(saved); return; }
    if (saved) { try { localStorage.removeItem(api.ONLINE_KEY); } catch (_) { /* ignore */ } }
    if (link.length === 4) {
      await api.ready;
      $('#join-code').value = link;
      show('join');
    }
  })();
})();
