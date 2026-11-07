# /server: Hive world server (Bun)

```bash
BOTS=8 bun run server/index.ts      # local dev with 8 in-process drones; open ws://localhost:3000/ws
bun test server                     # world, radio, lights, goal and queue tests
```

## Endpoints

| Path | What |
|---|---|
| `GET /ws` | WebSocket. The first message is a `ClientHello`: `{ role: "viewer" }` or `{ role: "agent", id, isPhone }`. |
| `GET /health` | Tick, scenario, agent and phone counts, and whether the AI and ElevenLabs keys are set. |
| `POST /ai/goal` | `{ transcript }` → Claude goal (keyword fallback) → injected into one unjammed drone. Returns `{ goal, source, firstHop }`. |
| `GET /ai/sitrep` | `{ text, source }`: a 2-sentence spoken summary. |
| `POST /stt` | Multipart `file` → ElevenLabs speech-to-text → `{ text }`. |
| `POST /tts` | `{ text, voiceId }` → `audio/mpeg`. |
| `POST /control` | Any `Control` as JSON. Same as sending it over the viewer socket; handy for curl during rehearsal. |

Rules: 10 Hz ticks on a 60×40 grid. Sensor radius 5, radio range 8, movement 1 cell per tick. Jam zones block both sending and receiving. Global loss is applied to each delivery. Chatter is recorded when it's sent, even from a jammed drone. The viewer gets a full `cells` frame once a second and `cellDiff` frames in between.

## Environment

`PORT`, `BOTS` (default 0), `CORS_ORIGIN` (default `*`), `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`. Everything works without the keys: goals fall back to keywords, the sitrep to a template, and voice to cached clips or browser speech.

## Deploy (Railway)

1. On railway.com, create a project from this GitHub repo. `railway.json` sets the start command and the `/health` check.
2. Add the variables: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, and `BOTS=0` (or `BOTS=8` as a fallback if the laptop host page fails).
3. Under Settings → Networking, generate a domain. Your WebSocket URL is then `wss://<domain>/ws`.

## For /web (Role 3)

```ts
// viewer
const ws = new WebSocket("wss://<server>/ws");
ws.onopen = () => ws.send(JSON.stringify({ role: "viewer" }));
ws.onmessage = (e) => {
    const { view } = JSON.parse(e.data); // WorldView. Apply view.cellDiff when view.cells is empty.
    radio.update(view);
};
const control = (c: Control) => ws.send(JSON.stringify({ t: "control", control: c }));

// laptop agent host (8 drones, one Web Worker each)
import { spawnAgentHost, startPhoneAgent } from "@mfc/engine/runtime";
spawnAgentHost({ url: "wss://<server>/ws" });
// phone (/join): call from a tap
await startPhoneAgent({ url: "wss://<server>/ws", onStatus: (s) => setColor(s.color) });
```
