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

1. **Speaker**: someone from the team that is *not* guessing secretly records a phrase. They can also type the answer so the host can reveal it later.
2. **Echo**: someone from the guessing team plays the clip backwards as often as they like, then records an imitation.
3. **Flip it!**: the Echo's recording plays backwards, which should sound roughly like the original. Their team shouts a guess.
4. **Reveal**: the original plays forward and the secret answer appears. The host scores the guess: Nailed it **+2**, Close **+1**, Nope **0**.
5. Teams take turns. The first team to reach the target wins (6, 10 or 16 points).

## Audio notes

- `MediaRecorder` mime type is chosen in this order: `audio/webm;codecs=opus` (Chrome/Firefox), then `audio/mp4` (Safari).
- `decodeAudioData` becomes an `AudioBuffer`. Each channel's `Float32Array` is reversed and played through an `AudioBufferSourceNode`.
- Leading and trailing silence is trimmed, so the reversed clip doesn't start with dead air.
- The mic tracks are stopped as soon as each recording ends. On iOS an open mic sends playback to the quiet earpiece.
- The `AudioContext` is created and resumed, and a silent buffer is played, on the first tap. This is the iOS autoplay unlock.
