# Hive: Team Master Prompts (GreatUniHack 2026, 12:00–18:00)

Repo: https://github.com/RayNCL2023/GUH_Manchester_Fried_Chicken

## Paste this context block first, then your role's prompt

> **Context:** We're building **Hive**, a coordination layer for fleets that lose contact, at GreatUniHack 2026 (Manchester). It's a one-day hackathon with a **hard submission deadline at 18:00**. Judging is a 2-minute demo plus 1 minute of questions. We're a team of 4, and each person owns one folder (see `README.md`). `shared/types.ts` is the contract: never change it without telling the team.
>
> **Tracks:**
> - Neptune North: agents keep working toward a shared goal even when communication fails. Judged on common goal, independent decisions, resilience, technical execution, excitement, presentation and design. They pointed us to MARL as related reading.
> - GreatUniHack overall: impact, technical execution, creativity, design and the final demo.
> - ElevenLabs: voice has to be central to the product, with natural voices that work in the demo and audio that makes something new possible.
>
> **Scenarios:**
> - **Firebreak:** a drone swarm maps a spreading wildfire with no central controller. Each agent only sees nearby cells and can only message agents in range. Agents gossip their maps, claim tasks without a leader, relay messages over several hops and keep working when isolated. Judges draw jam zones, change the wind and kill drones live.
> - **Light show:** judges scan a QR code and their phone becomes an agent that claims a pixel. When phones leave, the rest re-form the picture at lower resolution.
> - **Voice:** every drone has its own ElevenLabs radio voice, which cuts to static when the drone is jammed. The swarm also takes spoken commands.
>
> **Priorities:** visual impact, live interaction, and behaviour that is really decentralised and holds up to technical questions. Scope is about 5 hours, so cut anything that isn't demo-visible. Use bun only (never npm or npx). API keys stay server-side.

## Ownership

| Folder | Owner | Notes |
|---|---|---|
| `/shared/types.ts` | Everyone | Change only after asking in the group chat |
| `/engine` | **Ray (Role 1: AI and swarm brain)** | Brain, runtime, sim, learned policy |
| `/ai` | **Ray** | Claude goal parser, sitrep |
| `/server` | Role 2 | Includes `/server/scenarios/lights.ts` |
| `/web` | Role 3 | Viewer, `/join`, `/lights` |
| `/voice` | Role 4 | ElevenLabs, pitch, Devpost |

Step 0 (workspace and contract) is done and already in the repo.

## Tie-break rules

- **Map cells:** the higher `ts` wins. If `ts` is equal, the higher agent id wins.
- **Claims:** the lower `score` wins. If scores are equal, the lower agent id wins.

---

## Checkpoints (everyone stops for 5 minutes at each)

| Time | Must be true |
|---|---|
| **13:45** | Server deployed on Railway. 8 random-walk workers move as dots on the viewer. One phone has joined. |
| **14:45** | Firebreak running with the real brain: gossip, claiming and the coverage graph work. |
| **15:45** | Jamming and wind controls work, chatter plays, the light show forms with 3 phones, a spoken goal works end to end, and the agent's-eye view works. |
| **16:30** | **Feature freeze.** Phones re-form the picture when some leave. Visuals are polished. Only bug fixes after this. |
| **16:30–17:30** | Backup video recorded, Devpost drafted, pitch rehearsed 3 times on the real setup. |
| **17:45** | Submitted on Devpost. Do not leave this until 17:59. |

---

## The 2-minute demo (everyone builds toward this)

1. **0:00** The QR code is already on screen. "Scan it now." The swarm is mapping the fire while judges' phones join.
2. **0:15** A judge draws a jam zone. Drones inside it go grey, their voices cut to static, and the rest route around it. The coverage graph dips and then recovers.
3. **0:40** Kill 3 drones. Their claims are freed and other drones pick them up. Click one agent to show its own map (the agent's-eye view): it decides from partial knowledge.
4. **1:00** Spoken command: "Protect the village." You hear the order pass from drone to drone, and it stops at the jam zone.
5. **1:20** Switch to the light show. The phones form the picture. Ask a few judges to put their phones down, and the picture re-forms.
6. **1:45** One line on how it works: decentralised execution, a policy trained in simulation, no leader.

---

## Role 1: Ray, AI and swarm brain (`/engine`, `/ai`)

> Read `shared/types.ts` first. It is the contract. I own `/engine` and `/ai` only.
>
> **Part A: `/engine/brain.ts`, implementing `AgentBrain`. Must be pure: no DOM, no network, deterministic given a seed.**
> - Local map of `CellObs`, merged last-writer-wins (higher `ts`; tie goes to the higher agent id). Track a "dirty" set and gossip only the changes as a `map` message every 5 ticks (cap 200 cells, ttl 3).
> - Exploring: with no claim, move toward the nearest `unknown` frontier (pick randomly among the nearest few so agents spread out).
> - Leaderless claiming: score = a weighted feature sum (see Part F; start with distance / value). Claim the best task nobody else holds and broadcast `claim` with `score`. If a claim for the same task comes in, the lower score wins (tie: lower id) and the loser picks again. Send `release` when a task is done or abandoned.
> - Send a `heartbeat` every 3 ticks. If a claimant is silent for 20 ticks, treat its claims as free.
> - Relay: re-broadcast any message with ttl > 0 after decrementing ttl. Dedupe by `Msg.id` with an LRU set of 2000 ids.
> - Modes: `isolated` after 10 ticks with no neighbours (keep the last plan and use local rules), `relay` when it has relayed more than it originated recently, `normal` otherwise. Report the mode in `Action.status`.
> - Goals: a `goal` message multiplies the value of tasks within `radius` (default 8) of `target` by `priority`, then gets forwarded (dedupe by goal id). **When an agent first hears a goal, it emits a `chatter` "copy" line.** That's what lets the audience hear the order spread hop by hop.
> - Chatter: event-driven only (claim won, contact lost, relay up, isolated, goal copied), limited to one line per 30 ticks per agent, except goal copies. Lines come from a fixed list in `engine/chatterLines.ts`. **Send that list to Role 4 by 12:45.**
> - Agent's-eye view: when `sense.inspect` is true, set `Action.localMap` to this agent's map as a row-major string (one char per cell: `u` unknown, `c` clear, `f` fire, `b` burnt, `v` village).
> - Lights: claim `slot` tasks the same way and set `display.color` to the slot's colour once on the slot.
>
> **Part B: `/engine/runtime`.** `worker.ts` is a Web Worker that runs a brain over WebSocket (`ClientHello` → `ServerToAgent` / `AgentToServer`) and reconnects with the same id. `host.ts` spawns N workers (default 8). `phone.ts` is the same runtime with `isPhone: true`, a Wake Lock, and the id kept in localStorage. **Export `randomWalkBrain` by 12:30** so Roles 2 and 3 are unblocked.
>
> **Part C: `/engine/sim`.** A headless, in-process copy of the world (60×40 fire grid with wind, radio range 8, configurable loss % and jam zones) that runs N brains as fast as possible (no 10 Hz throttle). `bun test`: 8 brains, 50% loss, 600 ticks. Pass: over 80% of the edge mapped and no task held by 2 agents for more than 15 ticks. Print coverage over time.
>
> **Part D: `/ai`, LLM layer (`@anthropic-ai/sdk`, model `claude-haiku-5-5`).**
> - `parseGoal(transcript, worldSummary) → GoalBody`: speech-to-text output → a grid `target`, `radius` and `priority`, using structured output. Validate the result, and fall back to a keyword parser after 2 s or on any error.
> - `sitrep(view) → string`: a 2-sentence spoken summary (fire extent, village risk, isolated agents).
> - Plain async functions. Role 2 mounts them as `POST /ai/goal` and `GET /ai/sitrep`.
>
> **Part E: wind learner (`/engine/windModel.ts`).** Each agent estimates the wind from fire spread it observes: when a cell turns to fire, record the vector from the nearest burning neighbour, and keep an exponentially weighted mean. Agents gossip their estimates in heartbeats and average them with neighbours'. In isolated mode an agent moves toward the predicted edge 10 ticks ahead. Report the estimate in `status.windEstimate`.
>
> **Part F: learned claiming policy, trained in simulation (the MARL piece).** Start only after the 14:45 checkpoint passes. Hard stop at 16:00, keeping the hand-tuned weights if training isn't better.
> - Every agent shares one parameter vector `w` (parameter sharing). Claim score = `w · features`, with features: distance, task value, number of known claims within 4 cells (crowding), predicted ticks until the fire reaches the task (using the wind estimate), goal boost, and hops since the last neighbour contact.
> - Train `w` with the cross-entropy method in the Part C sim: about 30 candidates per generation, each scored over 4 random episodes with loss between 0% and 70%, random jam zones and random agent kills. Fitness = the area under the edge-coverage curve minus a duplicate-claim penalty. That takes minutes on a laptop CPU, with no GPU.
> - Save to `engine/policy.json`; the brain loads it and falls back to the hand-tuned weights.
> - Output `engine/sim/results.json` for the pitch and Devpost: learned vs hand-tuned coverage at 0%, 30%, 50% and 70% loss.
> - Pitch framing: centralised training, decentralised execution (the standard MARL setup). The weights are learned once offline; at runtime each agent acts on local information only.
>
> Order: random-walk brain (12:30) → runtime → brain → sim test (14:45) → `/ai` → wind learner → learned policy → tuning. Commit after each one.

---

## Role 2: World server and network (`/server`)

> Read `shared/types.ts`. I own `/server`, including `/server/scenarios/lights.ts`.
>
> - Express serves `/web/dist`. The `ws` package handles WebSockets, routing by the first `ClientHello`. Health check at `GET /health`.
> - **Deploy a skeleton to Railway by 13:15** (railway.json, start command `bun run server/index.ts`, `PORT` from env). Test from a phone on the venue wifi. A hotspot is the backup.
> - 10 Hz tick loop, 60×40 grid. Each tick, for each agent: build a `Sense` (sensor radius 3, `neighbours` within radio range 8 and not jammed, `inbox` = messages routed last tick that survived range, jam zones and global loss %). Apply the `Action`: clamp `moveTo` to 1 cell per tick, store `claimed` and `status`, and queue `send` for routing to in-range neighbours.
> - Use Ray's `randomWalkBrain` from `/engine` until the real brain lands.
> - Scenario interface: `{ init(world), step(world), tasksFor(agent, world), metrics(world) }`. If Ray asks, share the fire step function with `/engine/sim`, so the sim and the server behave the same.
> - Firebreak: cellular-automaton fire spread, biased by wind, one village, `edge` tasks from burning cells next to clear ones, and `protect` tasks around the village. `edgeMappedPct` = the share of true edge cells that some alive agent has reported correctly in its map.
> - Lights (`scenarios/lights.ts`): a small target image (a PNG decoded at startup, or a hard-coded 16×10 pixel array as the fallback), downsampled to N slots where N = live phones. Produces `slot` tasks with `color`. Rebuild when phones join or leave so the picture re-forms.
> - Implement every `Control`. `goal` goes to ONE random alive agent's inbox (it must spread by gossip). `inspect` sets `inspect: true` in that agent's `Sense`; copy its `Action.localMap` into `WorldView.inspected`.
> - Broadcast a `WorldView` at 10 Hz: the full `cells` array once a second, otherwise `cells: []` plus `cellDiff`. Keep the last 20 chatter lines in `recentChatter`.
> - Mount Ray's `/ai` as `POST /ai/goal` (body `{ transcript }`, then injects a goal control) and `GET /ai/sitrep`. Add `POST /stt` (proxies to ElevenLabs speech-to-text) and `POST /tts` (`{ text, voiceId }` → audio), using `ELEVENLABS_API_KEY`. No keys reach the browser.

---

## Role 3: Visuals and interaction (`/web`)

> Read `shared/types.ts`. Use Vite, TypeScript and PixiJS. I own `/web`. Create the Vite app inside the existing `/web` folder and keep the package name `@mfc/web`.
>
> - **Build against a local mock `WorldView` first** (`src/mock.ts`, switched on with `?mock=1`), so you're not blocked on the server.
> - `/` viewer: fire cells glow (additive blend plus a flicker), burnt cells are dark, and the village is highlighted. Drones have callsign labels and are coloured by `mode` (normal, isolated, relay); dead or jammed drones are grey with static. Radio `links` flicker near jam zones. Draw each drone's `windEstimate` as a small arrow.
> - **Agent's-eye view:** click a drone to send `inspect`, then render `WorldView.inspected.map` as an overlay ("what Echo-4 believes" vs the real fire). This is our main answer to "independent decisions" and to technical questions.
> - Controls: drag to draw a jam zone, a wind dial, a loss slider, shift-click a drone to kill it, reset, and a Firebreak / Light show toggle.
> - Panels: a live `edgeMappedPct` line graph, a chatter feed, the agent count, and a big QR code to `/join`, visible from the start.
> - Push-to-talk button (uses Role 4's `voice/ptt.ts`). Show the parsed goal as a pulsing target ring.
> - `/join`: phone lobby with two big buttons (Firebreak / Light show). Starts Ray's `engine/runtime/phone.ts` and shows "You are Echo-7" and the current mode.
> - `/lights`: full-screen colour from `display.color`, with a Wake Lock and a tap to go fullscreen.
> - Style: dark, neon, cinematic. Record the backup demo video at 16:30.

---

## Role 4: Voice, pitch and Devpost (`/voice`)

> Read `shared/types.ts`. I own `/voice`. For the ElevenLabs track, voice has to be central to the product, not decoration.
>
> - `voice/generate.ts`: pre-generates clips with the ElevenLabs API into `web/public/audio/{voice}/{lineKey}.mp3`. That's 4 distinct voices × every line in Ray's `engine/chatterLines.ts` (including "copy" acknowledgements for goals), plus callsigns. Generate a static loop and a radio squelch with the ElevenLabs Sound Effects API. Commit the audio; the demo must work if the API is down.
> - `voice/radio.ts` (browser module for Role 3): watches `recentChatter`, maps each agent id to a voice, and plays the cached clips through WebAudio with a radio EQ (bandpass 300–3000 Hz plus light distortion). Plays a squelch before each line. Crossfades to static when the speaker is jammed. Pans each voice by the drone's x position, so the audience can hear where it is. Uses a queue that drops stale lines.
> - `voice/ptt.ts`: hold to record with MediaRecorder → `POST /stt` → `POST /ai/goal`. The agent that first receives the goal replies with a live line via `POST /tts` ("Echo-3 copies, protecting the village"), falling back to a cached "copy" clip.
> - Sitrep button: `GET /ai/sitrep` → `/tts` → play, falling back to speechSynthesis.
> - Pitch: own the 2-minute script, following the demo above. Prepare answers for the likely questions: "Isn't the server central?" (it's only the physics and the radio; agents never get shared state). "Where's the learning?" (a parameter-shared policy trained with CEM under random loss; show Ray's `results.json`). "What happens at 100% loss?" (every agent goes isolated, follows local rules and the wind prediction, and re-syncs by gossip on reconnect).
> - Devpost draft by 16:30 and submitted by 17:45. Higgsfield intro: 45 minutes maximum, only after 16:30, and drop it if rehearsals aren't done. Lead 3 rehearsals.
