# GUH Manchester Fried Chicken: Team Master Prompts (5-hour plan)

Repo: https://github.com/RayNCL2023/GUH_Manchester_Fried_Chicken

## Ownership

| Folder | Owner | Notes |
|---|---|---|
| `/shared/types.ts` | Everyone | Change only after asking in the group chat |
| `/engine` | **Ray (Role 1: AI and swarm brain)** | Brain, runtime, tests |
| `/ai` | **Ray** | LLM goal parser, sitrep summariser, wind learner |
| `/server` | Role 2 | Includes `/server/scenarios/lights.ts` (moved from Role 4) |
| `/web` | Role 3 | Viewer, `/join`, `/lights` |
| `/voice` | Role 4 | ElevenLabs clips, push-to-talk, pitch |

Use bun everywhere (`bun install`, `bun run`, `bunx`). Never use npm or npx.

## Step 0: DONE (already in this repo)

Commit these together:

1. A root `package.json` with `"workspaces": ["shared", "engine", "ai", "server", "web", "voice"]`, plus a root `tsconfig.base.json` with the path alias `@shared/*` pointing to `shared/*`.
2. `shared/types.ts`, with these amendments to the version you have. Without them, Roles 1 and 2 will each guess, and their code won't fit together:

```ts
// 1. Claims need a score so conflicts can be resolved (lower score wins, tie: lower agent id)
export interface ClaimBody { taskId: string; claimant: AgentId; ts: number; score: number }
// "release" messages reuse ClaimBody.

// 2. Heartbeat had no body type
export interface HeartbeatBody { pos: Vec; claim: string | null }

// 3. Goals need an id (for dedupe while spreading) and an optional radius
export interface GoalBody { id: string; text: string; target?: Vec; radius?: number; priority: number }

// 4. The server cannot see debug() inside the worker, so the agent must report it in Action
export interface Action {
  moveTo?: Vec;
  send?: Omit<Msg, "from">[];
  claimed?: string | null;
  display?: { color: string };
  status?: { mode: "normal" | "isolated" | "relay"; knownPct: number; windEstimate?: Vec };
}
```

Tie-break rules, written down once:
- **Map cells:** the higher `ts` wins. If `ts` is equal, the higher agent id wins (as in the contract).
- **Claims:** the lower `score` wins. If scores are equal, the lower agent id wins.

---

## Checkpoints (T = start of the 5 hours; everyone stops for 5 minutes at each)

| Time | Must be true |
|---|---|
| **T+0:45** | Server deployed on Railway. 8 random-walk workers move as dots on the viewer. One phone has joined. |
| **T+1:45** | Fire scenario running with the real brain: gossip, claiming and the coverage graph work. |
| **T+2:45** | Jamming and wind controls work, chatter plays, the light show forms with 3 phones, and an LLM goal works end to end. |
| **T+3:45** | **Feature freeze.** Phones re-form the picture when some leave. Visuals are polished. Only bug fixes after this. |
| **T+4:30** | Submitted on Devpost, backup video recorded, pitch rehearsed 3 times. |
| **T+5:00** | Buffer. |

---

## Role 1: Ray, AI and swarm brain (`/engine`, `/ai`)

> Read `shared/types.ts` first. It is the contract; don't change it without telling the team. Use bun and TypeScript. I own `/engine` and `/ai` only.
>
> **Part A: `/engine/brain.ts`, implementing `AgentBrain`. Must be pure: no DOM, no network, deterministic given a seed.**
> - Local map of `CellObs`, merged last-writer-wins (higher `ts`; tie goes to the higher agent id). Track a "dirty" set and gossip only the changes as a `map` message every 5 ticks (cap 200 cells per message, ttl 3).
> - Exploring: if no task is claimed, move toward the nearest `unknown` frontier in the local map (pick randomly among the nearest few so agents spread out).
> - Leaderless claiming: score = distance / value (lower is better). Claim the best task not claimed by someone else and broadcast `claim` with `score`. If a claim for the same task comes in, the lower score wins (tie: lower id) and the loser drops it and picks again. Broadcast `release` when a task is done or abandoned.
> - Send a `heartbeat` every 3 ticks. If a claimant is silent for 20 ticks, treat its claims as free.
> - Relay: re-broadcast any message with ttl > 0 after decrementing ttl. Dedupe by `Msg.id`, using an LRU set of the last 2000 ids.
> - Modes: `isolated` when there are no neighbours for 10 ticks (keep the last claim, use local rules only); `relay` when this agent has relayed more than it originated recently; `normal` otherwise. Report the mode in `Action.status`, along with `knownPct`.
> - Goals: a `goal` message raises the value of tasks within `radius` (default 8) of `target` by × `priority`, then gets forwarded (dedupe by goal id).
> - Chatter: emit `chatter` messages on events only (claim won, contact lost, relay up, entered isolation, goal received), rate-limited to one per 30 ticks per agent. Use short lines from a fixed list so Role 4's pre-generated clips match. Export that list as `engine/chatterLines.ts` and send it to Role 4 by T+0:30.
> - Lights scenario: claim `slot` tasks the same way and set `display.color` to the slot's colour once on the slot.
>
> **Part B: wind learner, the online-learning piece (`/engine/windModel.ts`).** Each agent estimates the wind from what it sees: when a cell turns `fire`, record the vector from the nearest previously burning neighbour cell. Keep an exponentially weighted mean of those vectors as `windEstimate`, report it in `status`, and use it to predict where the fire edge will be about 10 ticks ahead. In `isolated` mode, move toward the predicted edge rather than the last known one. Gossip the estimate inside heartbeats and blend it with neighbours' estimates (consensus averaging). That gives the pitch line "the swarm learns the wind with no central model."
>
> **Part C: `/engine/runtime`.** `worker.ts` is a Web Worker that creates a brain and connects to the server over WebSocket (`ClientHello` → `ServerToAgent` / `AgentToServer`), auto-reconnecting with the same id. `host.ts` is the laptop "agent host" page logic that spawns N workers (default 8). `phone.ts` is the same runtime for phones, with `isPhone: true`, a Wake Lock, and the id stored in localStorage so a reconnect keeps the callsign. Export a tiny `randomWalkBrain` first, by T+0:20, so Roles 2 and 3 are unblocked.
>
> **Part D: `/ai`, LLM layer (Claude API via `@anthropic-ai/sdk`, model `claude-haiku-5-5` for low latency).**
> - `parseGoal(transcript, worldSummary) → GoalBody`: turn speech-to-text output like "prioritise the village, the fire is coming from the west" into a `GoalBody` with a grid `target`, `radius` and `priority`. Use tool use or a JSON schema for structured output, validate the result, and fall back to a keyword parser if the API fails or takes longer than 2 s.
> - `sitrep(view: WorldView) → string`: a 2-sentence spoken summary of the merged map (fire extent, village risk, how many agents are isolated). Role 4 sends it to ElevenLabs.
> - Expose both as plain async functions. Role 2 mounts them as `POST /ai/goal` and `GET /ai/sitrep`. The API key stays server-side in `ANTHROPIC_API_KEY`.
>
> **Part E: `/engine/test/sim.test.ts`.** Run 8 brains against a fake in-process server (grid 60×40, radio range 8, 50% loss) for 600 ticks. Print coverage over time and the number of duplicate claims. Pass: over 80% of the edge mapped and no task held by 2 agents for more than 15 ticks. Run with `bun test`.
>
> Order: random-walk brain → runtime → brain (map + claims) → sim test → `/ai` → wind learner → tuning. Commit after each one.

---

## Role 2: World server and network (`/server`)

> Read `shared/types.ts`. Use bun and TypeScript. I own `/server`, including `/server/scenarios/lights.ts`.
>
> - Express serves `/web/dist`. The `ws` package handles WebSockets, routing by the first `ClientHello`. Health check at `GET /health`.
> - **Deploy a skeleton to Railway by T+0:45** (railway.json, start command `bun run server/index.ts`, `PORT` from env). Test from a phone on the venue wifi. A hotspot is the backup.
> - 10 Hz tick loop, 60×40 grid. Each tick, for each agent: build a `Sense` (sensor radius 3, `neighbours` within radio range 8 and not jammed, `inbox` = messages routed last tick that survived range, jam zones and global loss %). Apply the `Action`: clamp `moveTo` to 1 cell per tick, store `claimed` and `status`, and queue `send` messages for routing to in-range neighbours.
> - Use Ray's `randomWalkBrain` from `/engine` until the real brain lands.
> - Scenario interface: `{ init(world), step(world), tasksFor(agent, world), metrics(world) }`.
> - Fire: cellular-automaton spread, biased by wind (probability higher downwind), one village, plus `edge` tasks from burning cells next to clear ones and `protect` tasks around the village. `edgeMappedPct` = the share of edge cells present, and correct, in the union of agents' maps (agents report `knownPct`; compute the true metric from the observations that were routed).
> - Lights (`scenarios/lights.ts`): load a small target image (a PNG decoded once at startup; a hard-coded 16×10 pixel array is fine as a fallback). Downsample it to an N-slot grid, where N = live phones, to produce `slot` tasks with `color`. When phones join or leave, rebuild at the new resolution so the picture re-forms.
> - Implement every `Control`. `goal` goes to ONE random alive agent's inbox (it must spread by gossip).
> - Broadcast a `WorldView` at 10 Hz. To keep bandwidth down, send the full `cells` array once a second and only changed cells in between (use the `cellDiff` field, which is already in the contract). Keep the last 20 chatter lines from `chatter` messages in `recentChatter`.
> - Mount Ray's `/ai` functions as `POST /ai/goal` (body `{ transcript }`, then injects a goal control) and `GET /ai/sitrep`. Add `POST /stt` to proxy audio to ElevenLabs speech-to-text with `ELEVENLABS_API_KEY`, so no keys reach the browser.

---

## Role 3: Visuals and interaction (`/web`)

> Read `shared/types.ts`. Use Vite, TypeScript and PixiJS, with bun. I own `/web`.
>
> - **Build against a local mock `WorldView` generator first** (`src/mock.ts`, random agents on a spreading fire), so you're not blocked on the server. Switch with `?mock=1`.
> - `/` viewer: connect as a viewer and render `WorldView`. Fire cells glow (additive blend plus a flicker), burnt cells are dark, and the village is highlighted. Agents are drones with callsign labels, coloured by `mode` (normal, isolated, relay); dead or jammed agents are grey with a static effect. Radio `links` are lines that flicker when near jam zones. Optionally draw each agent's `windEstimate` as a small arrow, which shows Ray's learning visually.
> - Controls: drag on the map to draw a jam zone, a wind dial, a loss slider, click an agent to kill it, a reset button, and a scenario toggle.
> - Panels: a live line graph of `edgeMappedPct` over time, a chatter feed, and the agent count.
> - Push-to-talk button: hold to record, `POST /stt`, then `POST /ai/goal`. Show the parsed goal as a target ring on the map. Role 4 provides the audio module; you place the button.
> - `/join` phone lobby: two big buttons (Fire / Light show). Starts Ray's `/engine/runtime/phone.ts`, then shows "You are Echo-7" and the current mode.
> - `/lights`: full-screen colour from the agent's `display.color`, with a Wake Lock and a tap to go fullscreen.
> - Big QR code on the viewer pointing to `/join`.
> - Style: dark, neon, cinematic. Record a screen-capture backup demo at T+3:45.

---

## Role 4: Voice, pitch and demo (`/voice`)

> Read `shared/types.ts`. Use bun and TypeScript. I own `/voice`.
>
> - `voice/generate.ts`: uses the ElevenLabs API to pre-generate clips into `web/public/audio/{voice}/{lineKey}.mp3`: 4 voices × every line in Ray's `engine/chatterLines.ts`, plus generic callsign lines ("Echo-3", and so on), plus a looping static clip. Run it once and commit the audio. Don't call TTS live during the demo.
> - `voice/radio.ts` (browser module, used by Role 3): watches `recentChatter`, maps each agent id to one of the 4 voices, and plays cached clips through WebAudio with a radio EQ (bandpass 300–3000 Hz plus light distortion). Mixes in static when the speaking agent is jammed. Queues clips and drops old ones so it never lags.
> - `voice/ptt.ts`: push-to-talk that records the mic with MediaRecorder and sends it to `POST /stt`, then `POST /ai/goal`.
> - Sitrep button: fetch `GET /ai/sitrep` and speak it. This one is generated live via ElevenLabs TTS through the server, falling back to the browser's speechSynthesis.
> - Pitch: a 2-minute script (problem → live demo: jam, kill agents, voice goal, light show → how it works → why it's decentralised). Include the answer to "isn't the server central?": the server is only the physics and radio; agents never get shared state, only what their simulated radio receives.
> - Devpost write-up by T+4:00. Higgsfield intro: 45 minutes maximum, only after the feature freeze. Lead 3 rehearsals.
