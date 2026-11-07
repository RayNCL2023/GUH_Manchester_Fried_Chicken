# Demo runbook

## One-time setup
1. **Server on Railway:** create a project from the GitHub repo. Add `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` and `BOTS=0`, then Settings → Networking → Generate domain. Check that `https://<domain>/health` shows `"ok": true`.
2. **Voice clips:** run `ELEVENLABS_API_KEY=... bun run voice/generate.ts`, then commit `web/public/audio/`. Without clips, the radio falls back to the browser's speech voice.
3. **Web:** deploy `web/` (nitLix: `bun run deploy:site`, or `bun run build:bun` if `bun run build` fails on Node). Optionally set `NEXT_PUBLIC_HIVE_SERVER=<domain>` at build time.

## Before the demo (5 minutes)
1. Open the viewer on the big screen at `https://<web>/?server=<domain>`. The setting is remembered, and the title should read **● Live**.
2. In a second tab, open `https://<web>/host?server=<domain>` and press **Launch drones** (8 Web Workers).
3. Click **Turn on radio audio** on the viewer, and check the volume.
4. Scan the QR code with one phone and press **Become a drone**. Check that it shows a callsign.
5. Rehearse the order once: hold the talk button and say "protect the village", or type it.
6. Press **Reset** just before you start.

## If something breaks
| Problem | Do this |
|---|---|
| Venue wifi or the server is down | The viewer switches to **○ Offline sim** after 3 s. The same brains run in the tab, so keep going. Voice orders use browser speech plus keywords. |
| The `/host` tab won't launch workers | Set `BOTS=8` on Railway and redeploy: the server runs 8 drones itself. |
| The mic doesn't work or the room is noisy | Use the **type an order** box. It goes through the same pipeline. |
| The Claude key fails | Goals fall back to keyword parsing automatically: "village", "north flank", "fire front". |
| No ElevenLabs clips | Captions still show every line, and the browser voice speaks them quietly. |
| Phones can't connect | Use a phone hotspot for the laptop and phones. The light show also runs offline in the Flock show tab. |

## Useful commands
```bash
BOTS=8 bun run server/index.ts                 # local server with 8 drones
bun run engine/sim/benchmark.ts                # regenerate docs/RESULTS.md
bun run engine/sim/chatterReport.ts            # what the audience will hear over 60 s
bun test engine server                         # 34 tests
curl -X POST <server>/control -d '{"type":"reset"}'
```
