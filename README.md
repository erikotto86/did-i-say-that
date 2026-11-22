# Did I Say That?

A party game for two teams built around backwards audio. Plain HTML/CSS/JS with no build step.

## Run it

**Easiest (Mac):** double-click **Play Did I Say That.command**. It starts a local server and opens Safari. If macOS says the file can't be opened, right-click it and choose **Open** instead.

The microphone only works on a secure page: `https://` or `http://localhost`.

```bash
cd ~/Developer/did-i-say-that && python3 -m http.server 8765
```

Then open http://localhost:8765.

To play on a phone you need an HTTPS URL. A plain LAN IP won't do, because iOS blocks the mic on `http://192.168…`. Any static host works, for example GitHub Pages or Netlify Drop.

## How a turn works

1. **Speaker**: someone from the team that is *not* guessing secretly records a phrase and types exactly what they said. They can't pass the device on until both are done.
2. **Echo**: someone from the guessing team plays the clip backwards as often as they like, then records an imitation.
3. **Flip it!**: the Echo's recording plays backwards, which should sound roughly like the original. Their team types a guess and locks it in. The original stays hidden until then.
4. **Reveal**: the game compares the guess with the phrase, ignoring capitals and punctuation. Nailed it **+2** means it matches, allowing a typo or two. Close **+1** means at least half the words are right, or most of the letters. Nope **0** otherwise. The original then plays forward. If the automatic score seems unfair, the host can change it before tapping **Next turn**.
5. The game saves itself after every step, so a reload or an accidental refresh picks up where you left off, recordings included. Saved data stays on the device. Starting a new game from the setup screen replaces it.
6. Teams take turns. The first team to reach the target wins (6, 10 or 16 points).

## Audio notes

- `MediaRecorder` mime type is chosen in this order: `audio/webm;codecs=opus` (Chrome/Firefox), then `audio/mp4` (Safari).
- `decodeAudioData` becomes an `AudioBuffer`. Each channel's `Float32Array` is reversed and played through an `AudioBufferSourceNode`.
- Leading and trailing silence is trimmed, so the reversed clip doesn't start with dead air.
- The mic tracks are stopped as soon as each recording ends. On iOS an open mic sends playback to the quiet earpiece.
- The `AudioContext` is created and resumed, and a silent buffer is played, on the first tap. This is the iOS autoplay unlock.
