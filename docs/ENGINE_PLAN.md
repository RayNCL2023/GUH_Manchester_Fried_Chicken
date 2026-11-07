# Engine plan (Ray, Role 1)

## Build order

| # | Piece | File(s) | Unblocks |
|---|---|---|---|
| 1 | Seeded RNG, msg ids, LRU dedupe | `engine/util.ts` | everything |
| 2 | Local map (LWW merge, dirty set, encode) | `engine/map.ts` | brain, sim |
| 3 | Chatter line list + speech planner | `engine/chatterLines.ts`, `engine/chatter.ts` | **Role 4 (clips)** |
| 4 | `RandomWalkBrain` | `engine/randomWalkBrain.ts` | **Roles 2 + 3** |
| 5 | Runtime: WS connection, worker, host, phone | `engine/runtime/*` | **Roles 2 + 3** |
| 6 | `HiveBrain` | `engine/brain.ts` | real demo |
| 7 | Headless sim + `bun test` | `engine/sim/*`, `engine/test/*` | tuning, CEM |
| 8 | `/ai` goal parser + sitrep | `ai/*` | voice goal |
| 9 | Wind learner | `engine/windModel.ts` | isolated mode |
| 10 | CEM-trained policy weights | `engine/sim/train.ts` → `engine/policy.json` | MARL story |

## Status (sim, 8 agents, 60×40, sensor radius 5, averaged over ticks 100–600 and 3 seeds)

| Loss | Edge coverage | Longest duplicate claim |
|---|---|---|
| 0% | ~85% | 2 ticks |
| 50% | ~84% | 11 ticks |
| 70% | ~85% | 15 ticks |

After killing 4 of 8 agents at tick 200, coverage is still 69% at tick 600. **Ask Role 2 to use sensor radius 5**: with 3, coverage caps at around 55–65% whatever the brain does.

## Conventions the server and web must know

- **Message ids** are `${origin}~${seq}`. The server overwrites `from` with whoever relayed a message, so the original sender is taken from the id.
- **Task ids** are `edge:${x}:${y}`, `protect:${x}:${y}` and `slot:${i}:${j}`. The brain also derives `edge:` tasks from its own map, so those ids must match the server's format.
- **TTLs:** `map` and `chatter` messages have ttl 0 and are never relayed. `map` spreads over multiple hops anyway, because merged cells become dirty and get gossiped again. `claim`, `release` and `heartbeat` have ttl 2. `goal` messages flood: every agent forwards a goal once, the first time it sees it.
- **Chatter:** `ChatterBody.line` is the exact text of one variant in `CHATTER_LINES`. The voice layer looks up the clip with `clipFor(text)`. The server should record chatter **when it is sent**, even if the sender is jammed, so the audience hears it under static.

## HiveBrain per tick

1. Stamp nearby cells into the local map (`ts = tick`, `by = me`).
2. Process the inbox, deduped by msg id: merge maps, resolve claims, refresh heartbeats, adopt and forward goals, note any chatter heard.
3. Relay any message with ttl > 0 (ttl − 1).
4. Expire claims from agents that have been silent for more than 20 ticks.
5. Keep the current claim, or pick a new one: score = `(1 + w.dist·d) / value^w.value · (1 + w.crowd·nearbyClaims)`, divided by the goal boost. The lower score wins; on a tie, the lower id wins.
6. Move toward the claimed task, otherwise toward an unknown frontier, otherwise toward stale cells.
7. Gossip: heartbeat every 3 ticks, claim refresh every 10, dirty map cells every 5, a random sample of the map every 50 (anti-entropy), active goals every 40.
8. Mode: `isolated` after 10 ticks with no neighbours, `relay` when relayed > 1.5 × originated over the last 30 ticks, `normal` otherwise.

## Audio: how it stays pleasant rather than tiring

The risk is 8 to 30 radio voices, static and squelch all at once: a wall of noise that annoys judges and hides the story. The fix sits at two layers.

### Layer 1: engine decides *who may speak* (decentralised floor control)

Speaking works like real radio etiquette, handled by each agent with no coordinator:
- **Listen before talk (carrier sense).** An agent only speaks if it hasn't heard chatter from a neighbour recently. The quiet window depends on priority: 5 ticks for critical lines, 15 for important, 30 for routine.
- **Personal cooldown.** At most one line per 4 s per agent (2 s for critical lines).
- **Random backoff.** A random delay before speaking, so two agents don't start in the same tick.
- **Stale drop.** A line not spoken within 2 s is dropped, never queued.
- **Event-driven only.** There's no idle chatter. Lines are tied to things the audience should notice: lost comms, back in contact, relay up, a claim conflict, a goal copied, new fire spotted.
- **Goal "copy" is self-limiting.** Each agent says "copy" only if its neighbourhood is quiet, so a few voices ripple outward across the map, not 8 at once.
- **The light show is silent**, apart from critical lines; it's a visual moment.

Net effect: about one line every 1.5–3 s across the whole swarm, and every line means something.

### Layer 2: voice player decides *how it sounds* (Role 4, `voice/radio.ts`)

- **One voice at a time.** Half-duplex, like a real radio. The queue holds at most 2 lines, and anything older than 2.5 s is dropped.
- **Even loudness.** Clips are normalised to about −20 LUFS when generated. The master chain has a compressor and a limiter, so no clip jumps out.
- **Gentle static.** Use filtered pink noise (high-pass 200 Hz, low-pass 4 kHz), never full-band white noise. It sits about 24 dB under the voice with 150 ms fades. It plays only under a jammed agent's line, plus one short (≤400 ms) burst when an agent enters a jam zone. No continuous hiss loop.
- **Short, soft squelch** (≤60 ms) at the start of each line, not a harsh click or beep.
- **Mild radio EQ** (bandpass 300–3400 Hz, light saturation). Readable, not tinny.
- **Limited panning.** Pan by drone x position, capped at ±0.6, so nothing is hard-left or hard-right.
- **Ducking.** Chatter mutes while someone holds push-to-talk, and drops 15 dB under the sitrep.
- **Calm voices.** Higher stability setting, normal speaking rate, no shouting or alarm tones. A drone dying gets a soft "signal lost" tone, not an explosion.
- **Controls and captions.** On-screen mute, a volume slider and a "critical only" toggle. Every line also appears as a caption in the chatter feed, so it works when muted and for anyone hard of hearing.
