# Hive: 2-minute pitch and Q&A

Two people: a **Driver** (laptop: jams, kills, voice) and a **Speaker**. Before you start, the QR code is on screen, the radio audio is on, and the drones are flying.

## Script (≈ 2:00)

**0:00 Hook** (Speaker)
> "When a wildfire takes out the radio masts, drones that wait for orders from base just stop. Hive is a coordination layer for fleets that lose contact. There's no leader and no central map, and the job still gets done. Scan the QR code: your phone is about to become a drone."

**0:15 Common goal** (Driver points at the map)
> "Eight drones, each running its own brain in its own process. Each one sees only a few cells around it and can only talk to drones in radio range. Together they keep the fire's edge mapped. That's the number on the right."

**0:30 Resilience** (Driver drags a jam zone over the busiest drones and turns the loss slider to 70%)
> "Let's take their radio away." *(The voices cut to static: "Lost comms, continuing on last plan.")* "Jammed drones keep working on their last plan using local rules. The others route messages around the jam. The graph dips, then recovers."

**0:50 Independent decisions** (Driver clicks a drone, then shift-clicks two others)
> "This is what Echo-4 *believes*: its own map, built from gossip. It's partial, and it's different from the truth." *(Kill two drones.)* "Their tasks are freed when their heartbeats stop, and the others pick them up. Nobody reassigned anything."

**1:05 Voice** (Driver holds the talk button)
> *"Protect the village."* "That order reached one drone. Listen." *(The 'copy' replies spread from drone to drone, and stop at the jam zone.)* "It spreads by gossip, the way the maps do. Claude turns speech into a target; ElevenLabs gives every drone its own radio voice."

**1:25 The flock** (switch to the Phone light show tab)
> "Your phones are drones too. Each one claims a pixel, again with no leader." *(The picture forms.)* "Some of you, lock your phone." *(It re-forms at lower resolution.)* "The flock adapts to whoever is left."

**1:45 Proof** (point at the results panel)
> "We benchmarked against a central controller that has *perfect* information. With good comms it ties with us. At 90% packet loss it maps 45%; we map 82%. In a total blackout it maps zero; we map 67%. Hive: actors that work better together, even when they can't talk."

## Neptune North criteria → what to show

| Criterion | Show |
|---|---|
| Working towards a common goal | A shared fire-edge map; claiming tasks with no leader; the light-show picture |
| Independent decision-making | The agent's-eye view; every drone in its own Web Worker or phone; claims settled by score, never assigned |
| Resilience when comms fail | Jam, loss slider, kills; static on the radio; the benchmark panel (67% vs 0% in a blackout) |
| Something you're excited about | Phones as drones, and hearing an order spread through the swarm |

## Likely questions

- **"Isn't the server central?"** It's only the physics and the radio. Agents never get shared state: each gets only its own sensor view and whatever messages survive its simulated radio. Kill the laptop drones, and the phones keep going. The same brain runs offline in the browser.
- **"Where's the AI or learning?"** Every drone learns the wind from fire spread it sees itself, and the swarm reaches agreement on it with no central model. The estimate lands within about 40° of the true wind (cosine 0.69–0.82). We also tried using it to steer tasks, and the benchmark showed it didn't help, so we report it but don't use it to steer. Claude interprets spoken orders. The coordination is distributed algorithms, which is what multi-agent RL learns to approximate; ours is explainable and benchmarked.
- **"What happens at 100% loss?"** Every drone is isolated and follows local rules from its own map: 67% of the edge still mapped, against 0% for the central controller. When the link comes back, the maps merge automatically, because the newest observation always wins.
- **"How are conflicts resolved without a leader?"** Each claim is broadcast with a score. The lower score wins, and a tie goes to the lower id. Every drone applies the same rule, so they all agree without voting. The longest time two drones held the same task in our tests was 1.5 s.
- **"How does it scale?"** Gossip only sends changes and is capped per message. Relaying is limited by TTL and deduplicated by message id. Each drone's work depends on its neighbours, not on fleet size: 64 brains run at about 7 ms a tick in a browser tab.
- **"Real hardware?"** The brain is pure TypeScript with no network or DOM code. It takes a sensor view and returns an action, so it could run on a companion computer with a mesh radio such as LoRa or Wi-Fi mesh in place of our simulated one.
