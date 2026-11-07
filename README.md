# Hive

A coordination layer for fleets that lose contact (GreatUniHack 2026). In **Firebreak**, a leaderless drone swarm maps a spreading wildfire; in **Light show**, judges' phones form a picture. Both keep working through jamming, packet loss and agent loss, and every drone has its own ElevenLabs radio voice.

## Layout

| Folder | Owner | What |
|---|---|---|
| `shared/types.ts` | Everyone | **The contract.** Change only after agreeing in the group chat. |
| `engine/` | Ray (Role 1) | Agent brain, Web Worker runtime, sim, learned policy, wind learner |
| `ai/` | Ray (Role 1) | Claude goal parser, sitrep |
| `server/` | Role 2 | World sim, radio, scenarios (fire + lights), Railway deploy |
| `web/` | Role 3 | Viewer, `/join` phone lobby, `/lights` |
| `voice/` | Role 4 | ElevenLabs clips, radio FX, push-to-talk |

Full briefs: [docs/TEAM_PROMPTS.md](docs/TEAM_PROMPTS.md)

## Setup

```bash
bun install
bun run typecheck
```

Use **bun** only (no npm/npx). Copy `.env.example` to `.env`; API keys are server-side only.

Import the contract with `import type { Sense, Action } from "@shared/types"` (or a relative path).
