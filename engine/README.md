# /engine (Ray, Role 1)

Leaderless swarm brain, plus the browser runtime that runs it. The design and the audio-comfort plan are in [docs/ENGINE_PLAN.md](../docs/ENGINE_PLAN.md).

## Use it

The **server** (Node) can import the pure brains, which is handy for in-process bots:
```ts
import { createBrain, RandomWalkBrain, HiveBrain } from "@mfc/engine";
```

The **web** app (client components only) uses the runtime:
```ts
import { spawnAgentHost, startPhoneAgent } from "@mfc/engine/runtime";

const host = spawnAgentHost({ url: "wss://<server>/ws", count: 8, brain: "hive" }); // ids Echo-1..Echo-8
const phone = await startPhoneAgent({ url: "wss://<server>/ws", onStatus: (s) => setColor(s.color) }); // call from a tap
```
Pass `brain: "random"` to use the placeholder brain.

The **voice** layer looks up chatter clips with:
```ts
import { allClips, clipFor } from "@mfc/engine/chatterLines";
```
`allClips()` returns the list to generate. `clipFor(text)` returns `{ key, variant }`, and clips live at `/audio/{voice}/{key}_{variant}.mp3`.

## Test and sim
```bash
bun test engine
bun run engine/sim/run.ts --loss 50
```

## Conventions (server, read this)
- **Message ids** are `${origin}~${seq}`, so set `from` to the relayer. The original sender comes from the id.
- **Task ids** are `edge:x:y`, `protect:x:y` and `slot:i:j`.
- **Chatter** messages have ttl 0. Record them in `recentChatter` when they're sent, even if the sender is jammed.
- **Sensor radius 5** (not 3). With 3, eight drones can't watch a fire perimeter of more than 70 cells: coverage tops out around 55–65% for any brain. With 5 it holds above 80% even at 70% loss.
