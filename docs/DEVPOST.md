# Hive: actors that work better together, even when they can't talk

## Inspiration
When a wildfire takes out radio masts, the drones mapping it lose their link to base. Conventional fleets do the safe thing and hold position, which is exactly when you need them most. We wanted a fleet that keeps working toward the goal when communication fails, and that you could watch and hear doing it.

## What it does
**Hive** is a coordination layer for fleets that lose contact.

- **Firebreak:** a swarm of drones keeps a wind-driven wildfire's edge mapped with no central controller. Each drone sees only nearby cells and can only message drones in radio range. Judges draw jam zones, crank packet loss, change the wind and shoot drones down, and the swarm adapts in front of them.
- **Light show:** judges scan a QR code and their phone becomes a drone that claims one pixel of a picture. When phones leave, the rest re-form the picture at lower resolution.
- **Voice:** every drone has its own ElevenLabs radio voice. When a drone is jammed, you hear it under static. Hold a button and say "protect the village": Claude turns the order into a target, one drone receives it, and you hear "copy" spread from drone to drone until it hits the jam zone.

## How it works
- **Gossiped map:** each drone keeps its own map and sends only the cells that changed. Maps merge cell by cell, and the newest observation wins, so merging in any order gives the same result.
- **Claiming tasks with no leader:** a drone broadcasts a claim with a score. The lower score wins, and a tie goes to the lower id, so every drone resolves conflicts the same way without voting. Heartbeats free the tasks of drones that go silent.
- **Multi-hop relay:** messages travel several hops. A hop limit and deduplication by message id stop them circling forever.
- **Isolated mode:** a drone with no neighbours keeps its last plan and its own map, then merges back automatically when it reconnects.
- **Learned wind:** each drone estimates the wind from fire spread it watched itself, and neighbours average their estimates, so the swarm agrees on the wind with no central model.
- **Radio etiquette:** drones only speak if the channel is quiet. Airtime is shared out by swarm size, a drone stays silent if someone just said the same news, and stale lines are dropped. The swarm settles at about one meaningful line every two seconds.
- **Architecture:** one TypeScript brain runs everywhere, pure, with no network or DOM code: in Web Workers on a laptop (one per drone), on judges' phones, in a headless simulator and in the browser fallback. A Bun world server simulates only the physics and radio (range, jamming, loss). Agents never see shared state.

## Results
We benchmarked against a deliberately generous centralised controller. It has a long-range ground station that knows the *true* fire map and every drone's position, and its link suffers the same loss and jamming. Values are the % of the live fire edge mapped (8 drones, 3 seeds):

| Scenario | Hive | Central controller |
|---|---|---|
| 0% loss | 89% | 90% |
| 70% loss | 85% | 78% |
| 90% loss | 82% | 45% |
| 100% loss (blackout) | 67% | 0% |
| Jam between base and fire | 88% | 76% |
| Lose half the drones | 69% | 59% |

With good comms, perfect central information buys nothing. Once comms fail, leaderless coordination wins by a wide margin. We also tested steering drones with the learned wind and found it didn't help, so we report the estimate but don't use it to steer. The full table is in `docs/RESULTS.md`.

## Built with
TypeScript, Bun (world server and WebSockets), Next.js-on-Vite (vinext), Tailwind, Web Workers, the Wake Lock API, the Claude API (spoken order → structured goal; sitrep), and ElevenLabs (pre-generated per-drone radio voices, sound effects, speech-to-text, live text-to-speech replies).

## Challenges
- **Noise.** Our first radio played two lines a second. Neighbour-only listening can't limit the whole room, so we added fair-share airtime and deduplication of repeated news.
- **A fair baseline.** Our first centralised baseline was a strawman. We made it generous on purpose (perfect information, unlimited range) so the comparison means something.
- **Graceful degradation everywhere.** If venue wifi dies, the demo falls back to the same brains running in the browser. With no API keys, it falls back to keyword goals and browser speech.

## What's next
Put the brain on companion computers over a LoRa or Wi-Fi mesh radio, add heterogeneous agents (relay drones, ground units), and learn the claiming weights with centralised training and decentralised execution, using the simulator we already have.
