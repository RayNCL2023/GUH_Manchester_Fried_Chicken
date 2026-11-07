# /voice: radio voices, push-to-talk, sitrep

## 1. Generate the clips (once, then commit them)
```bash
ELEVENLABS_API_KEY=... bun run voice/generate.ts
```
This writes `web/public/audio/{alpha,bravo,charlie,delta}/{key}_{variant}.mp3`: 4 voices × every line in `engine/chatterLines.ts`, plus `squelch.mp3`, `static.mp3` and `manifest.json`. Files that already exist are skipped. If `ffmpeg` is installed, clips are loudness-normalised. To pick different voices, edit `voice/voices.ts` or set `HIVE_VOICES="alpha:<id>,bravo:<id>,..."`.

## 2. Use it in /web (client component)
```ts
import { RadioPlayer, PushToTalk } from "@mfc/voice";

const radio = new RadioPlayer({ audioBase: "/audio", onLine: (l) => addCaption(l), onSpeaking: (id) => highlight(id) });
startButton.onclick = () => radio.unlock();            // browsers need one tap before audio plays
ws.onmessage = (e) => radio.update(JSON.parse(e.data).view);

const ptt = new PushToTalk({ serverHttp: "https://<server>", radio });
talk.onpointerdown = () => ptt.start();
talk.onpointerup = async () => showGoal(await ptt.stop()); // speech-to-text → Claude goal → first drone replies live
sitrepButton.onclick = () => ptt.sitrep();
// Typed fallback for a noisy venue: ptt.sendGoal("protect the village")
// Controls: radio.setMuted(b), radio.setVolume(0..1), radio.setCriticalOnly(b)
```

## How it stays pleasant
- **One voice at a time.** The queue holds at most 2 lines (critical lines first) and drops anything older than 2.5 s.
- **Even levels.** A compressor and limiter even out loudness, and the radio EQ (300–3400 Hz plus a gentle soft-clip) is readable, not tinny.
- **Gentle static.** Filtered pink noise sits about 24 dB under the voice, and only under a jammed speaker. A ≤0.4 s burst plays when a drone enters a jam, at most once every 2 s.
- **Soft cues.** A short squelch plays before each line, and a quiet two-note tone when a drone dies.
- **Limited panning.** Each voice is panned by the drone's x position, capped at ±0.6.
- **Ducking.** Chatter mutes while push-to-talk is held, and drops 15 dB under the sitrep.
- **Captions.** Every line is reported through `onLine`, so captions work even when muted.
