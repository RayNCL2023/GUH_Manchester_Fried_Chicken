# Hive

**Actors that work better together, even when they can't talk.** A coordination layer for fleets that lose contact, built at GreatUniHack 2026.

Live demo: **https://guh26.nitlix.com**

## Overview

When a wildfire knocks out radio masts, a normal drone fleet loses its link to base and holds position, right when it's needed most. Hive drones have no leader. Each one sees only nearby cells and can only talk to drones in radio range, but the swarm still keeps the job going through jamming, packet loss and losing drones.

The demo has three tabs:

| Tab | What you see |
|---|---|
| **Firebreak** | A 3D world (Google photoreal tiles) where a leaderless swarm maps a wind-driven wildfire. Scouts map the fire and water drones get sent to put it out. Draw jam zones, turn up packet loss, change the wind or shoot drones down, and watch the swarm adapt. Ground Control (a rooftop antenna with an ElevenLabs voice agent) shows which drones are direct, relayed over the mesh, or dark. |
| **Flock show** | The same brain flying a formation in the sky, re-forming when drones drop out. |
| **Sound uplink** | Sends data from the laptop speaker to a phone microphone using fountain codes. No network involved. |

Every drone has its own ElevenLabs radio voice. Jammed drones sound like they're under static, and spoken orders ("protect the village") are turned into goals by Claude and passed drone to drone over the radio.

### How it works

- **Gossiped maps:** each drone keeps its own map, sends only what changed, and merges cell by cell (newest observation wins).
- **Leaderless task claims:** a drone broadcasts a claim with a score. The lowest score wins and ties go to the lower id, so there's no voting and no leader.
- **Multi-hop relay** with hop limits and dedup, plus **isolated mode**: a drone that's cut off keeps working on its last plan and merges back when it reconnects.
- **One pure TypeScript brain** (no network or DOM code) runs in Web Workers, in the headless simulator and in the browser.

### Results

% of the live fire edge mapped, Hive vs a generous central controller that knows the true map (8 drones, 3 seeds):

| Scenario | Hive | Central |
|---|---|---|
| 0% loss | 89% | 90% |
| 90% loss | 82% | 45% |
| 100% loss (blackout) | 67% | 0% |
| Lose half the drones | 69% | 59% |

When comms are good, they're about even. When comms fail, Hive wins by a wide margin. The full table is in [docs/RESULTS.md](docs/RESULTS.md), and the write-up is in [docs/DEVPOST.md](docs/DEVPOST.md).

## Layout

| Folder | Owner | What |
|---|---|---|
| `shared/types.ts` | Everyone | **The contract.** Change only after agreeing in the group chat. |
| `engine/` | Ray (Role 1) | Agent brain, Web Worker runtime, sim, learned policy, wind learner |
| `ai/` | Ray (Role 1) | Claude goal parser, sitrep |
| `server/` | Role 2 | World sim, radio, scenarios. Runs on Bun or Cloudflare (`server/worker.ts`); the live demo doesn't need it |
| `web/` | Role 3 | Viewer, `/join` phone lobby, `/lights` |
| `voice/` | Role 4 | ElevenLabs clips, radio FX, push-to-talk |

Full briefs: [docs/TEAM_PROMPTS.md](docs/TEAM_PROMPTS.md)

## Setup

```bash
bun install
bun run typecheck
```

Use **bun** only (no npm/npx). Copy `.env.example` to `.env`; API keys are server-side only.

Run the web app with `cd web && bun run dev`. Deploy with `bun run deploy:site`.

Import the contract with `import type { Sense, Action } from "@shared/types"` (or a relative path).
