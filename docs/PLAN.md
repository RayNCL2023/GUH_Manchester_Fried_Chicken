# GUH26: Hive (team plan)

_Saved 7 Nov 2026, 13:15. GreatUniHack 2026, Nancy Rothwell Building, Manchester._

---

## 1. Event facts

- **Hacking:** 12:00 → **submissions close 18:00 (hard deadline, no late entries)**. Submissions open 16:00.
- **Judging:** in person, 18:30–20:00. **2-minute presentation** plus Q&A. Closing ceremony 20:30.
- One sponsor track, plus the overall challenge. The overall challenge mostly judges impact and how cool the project is.
- Overall prizes: £1,750 / £1,050 / £700.
- Rules (2025, assume they still apply): no work done before the event, **disclose AI tool use** and label AI-generated content, all team members present. Max team size is 4.
- One listing calls GUH26 a "30+ hour, 7–8 Nov" event. We're working to the 18:00 deadline from the opening slides; double-check it on Discord.

### Our entries
- **Main:** overall "best projects" (impact and coolness).
- **Sponsor track: Neptune North**, multi-agent systems under failed communication.
- **Side track:** ElevenLabs (chosen over n8n because voice is part of the product).

### Neptune North brief
> Modern technology often relies on multiple systems collaborating on a common goal (drones in a light show, robots in fulfilment centres, LLMs solving parts of a large problem). When communication is unreliable or unavailable, each actor needs to operate without instructions from a central hub. Design an approach to a problem involving systems working together in a distributed fashion, even when communications are interrupted.

**Prizes:** 1st £1,000 in high-street vouchers (shared); 2nd and 3rd mechanical keyboards.

| Criterion | Weight | How Hive covers it |
|---|---|---|
| Working towards a common goal | 20% | Swarm maps the whole fire edge; phones rebuild the mission together |
| Independent decision-making | 20% | Every agent decides from its own sensors and inbox only |
| Resilience when comms fail | 20% | Jamming, killed drones, airplane mode, lossy audio channel |
| Something you're excited about | 10% | Physical audio demo, judges take part |
| Technical execution | 15% | Real distributed engine, fountain codes, data over sound |
| Design & experience | 5% | Scan a QR code and play, no explanation needed |
| Presentation | 10% | Clear 2-minute demo, **honest about what's simulated** |

The workshop "Coding teamwork without a leader" (16:45–17:15) suggests Neptune North values leaderless designs. They also mentioned distributed systems and gRPC at their stand, but **we are not using gRPC**.

---

## 2. What past winners had in common (GUH 2024–25 Devpost)
- Winners fitted the theme almost word for word (2024 "time", 2025 "When Worlds Collide"). This year the sponsor track is effectively our theme.
- Many small prizes: about 23+ of 55 projects in 2024 were marked as winners. Enter everything we qualify for.
- The closest past winner to our track: **TweakOS** (2025, Best Use of Gemini). Two AI agents with personalities sharing a desktop, using Gemini plus ElevenLabs. Judges here like theatrical agents that visibly interact.
- Visual, hands-on demos did well (Magicmath projector, Amphibian Engine browser pet).
- Ideas we rejected along the way: a simple rescue swarm, Murmur offline payments (unrealistic, since banks won't put agents on everyone's phone), plain voice-first concepts. The team wants something **visual, vibrant, live, realistic, and impressive within the 2-minute slot**.

---

## 3. The project: Hive

**Pitch line:** _"Every fleet of drones or robots relies on a central hub. Hive lets them keep working without one."_
**Closing line:** _"Same engine, any fleet."_

A coordination layer for fleets that lose contact, shown through scenarios that all run on one engine.

### Scenarios (in priority order)
1. **🔥 Firebreak (main).** Drones map a spreading wildfire's edge on Saddleworth Moor. It burned for weeks in 2018, about 20 minutes from campus, so it's real and local. Fire services already fly drones over wildfires; when they lose their link (smoke, hills, jamming) they currently fly home. Ours keep the job going.
2. **💡 Light show / Mission Uplink (physical demo).** Judges' phones act as the drones.
3. **📦 Warehouse (only if there's time).** Ocado-style grid robots, with a "kill the hub" button. **Cut this first.**

### Engine (shared core)
- Range-limited messaging, with packet loss and jamming zones
- Gossip plus a mergeable shared map (no conflicts on merge)
- Leaderless task claiming (claim a task; ties broken deterministically by agent ID)
- Multi-hop relay (data reaches base through any connected chain)
- Isolated fallback mode: keep following local rules from the last known plan and store findings
- Scenario plugins define only three things: world, tasks, and what an agent can sense

### Architecture (Cloudflare)
- **World Durable Object = "the sky, not the commander".** It simulates physics and radio only (fire spread with wind, positions, range, jamming) and applies judge actions over WebSockets. **It never makes decisions.**
- **Agent brains:** `decide(ownSensors, inbox)`. Each runs isolated and can't see world state. Host-side agents run in separate Web Workers or isolated calls. **A judge's phone that joins as a drone runs its own brain locally.**
- **Slides live in the same web app** as the simulation; a slide can be the live map, so there's no window switching.
- **Host visuals:** MapLibre + deck.gl, dark 3D map, glowing fire heatmap, drones, pulsing link arcs, grey drones when jammed, relay chains.
- **Phones:** QR-code lobby → controls (kill drone, draw jamming zone, change wind) or "become drone #N". PWA with a service worker so it works offline.

### Voice (ElevenLabs)
- **Radio chatter:** every agent has its own voice ("Echo-3, taking north flank"). When it's jammed, audio cuts to **static**, so you can hear the outage.
- **Voice command:** commander says "Prioritise Diggle". Speech-to-text turns it into a goal broadcast once. Agents that hear it pass it on; agents that don't keep doing their own work.
- **Spoken briefing:** an LLM summarises the merged map and ElevenLabs reads it out. _"North flank 300 m from Diggle. Drone 4 lost; coverage reassigned."_
- **Pre-generate and cache** repeated clips to avoid latency or rate limits during judging.
- Label AI-generated audio (rule).

### Physical demo: Mission Uplink (data over sound)
1. Judges are already joined (**mic permission granted and app cached before airplane mode**; iOS needs a tap to start the mic).
2. "Airplane mode on." The only link left is the laptop speaker.
3. The laptop broadcasts a **mission package**: a pixel-art image (about 300–600 bytes compressed), a light-show sequence and a start time.
4. It's sent with a **fountain code (LT codes, about 100 lines)**: the data goes out as random encoded chunks, and any sufficient set rebuilds it in any order. Each phone misses different chunks, and that's fine.
5. The image **assembles pixel by pixel on every phone at the same time**, in a different order on each.
6. **Phones that finish relay chunks to the others by sound**, so the back of the room completes through its neighbours (leaderless gossip, physically).
7. At the shared start time every phone plays the **same light show together, offline**.
- Line to say: _"That's how a drone that's lost its link would get new orders."_
- Transport: ggwave (WASM) data-over-sound, with error correction built in. Throughput is tens of bytes per second, so **measure it in the hall early**. It decides the payload size.
- **Stretch:** the payload is a tiny HTML/JS app (under 1 KB) run in a sandboxed iframe ("we shipped software to offline phones over sound"). Decide by 15:00 based on measured throughput.

---

## 4. The 2-minute presentation

Setup: a host laptop with slides and the live sim; judges join from their phones.

| Time | Segment |
|---|---|
| 0:00–0:15 | Problem: fleets depend on a central hub and fail when the link drops (fires, warehouses, light shows) |
| 0:15–0:55 | Live map. **Judges scan the QR code** and kill drones, draw jamming zones, change the wind. Radio chatter, static, relay chains, swarm re-tasks |
| 0:55–1:35 | **Mission Uplink:** airplane mode on, image assembles over sound, phones relay, synced light show |
| 1:35–2:00 | "Same engine, any fleet." Honest summary of what's real vs simulated, and next steps |

**Q&A answer to prepare:** _"The Durable Object simulates the world and the radio, the way the sky would. Every decision is made by the individual agent from its own sensors and messages. Phone drones literally run their brain on the phone."_

---

## 5. Team roles (new split, 13:15)

| Person | Allocation | Owns |
|---|---|---|
| **P1** | 80% engine | World Durable Object, radio model (range, loss, jamming), agent brains (edge splitting, gossip/merge, relay, isolated fallback), fire simulation |
| **P2 "bridge"** | 20% engine + 50% web | WebSocket protocol between engine and clients, phone "be a drone" brain running locally, judge controls wired to the Durable Object. _Suggested: also owns the acoustic uplink (ggwave + fountain code + relay)_ |
| **P3** | 50% web | Host screen (deck.gl map, visuals, built-in slides) and phone app UI (QR lobby, controls, reconstruction view, light show), PWA and service worker |
| **P4** | 100% voice + Devpost | ElevenLabs voices, radio chatter and static, voice command (speech-to-text), spoken briefing, cached clips; Devpost write-up (incl. AI disclosure), backup video, pitch rehearsal lead |

_Percentages were recorded as given. The acoustic uplink isn't explicitly assigned yet; decide its owner now._

---

## 6. Checkpoints
- **13:45:** sound throughput measured in the hall; engine ticks; a phone connects to the Durable Object.
- **15:00:** fire demo playable from phones; first image received over sound; decision on the app stretch goal.
- **16:30:** phone-to-phone relay, light show, voice. **Feature freeze.**
- **16:30–17:30:** polish; rehearse the 2 minutes at least 5 times in a noisy spot; record a backup video of the sound demo.
- **17:30:** submit (don't leave it to 17:59).

### What to cut, in order, if behind
1. Warehouse scenario
2. App-over-sound stretch
3. Voice commands (keep chatter and briefing)
4. **Never cut:** the fire map with judges' controls and Mission Uplink, because those are the judge-in-hand moments.

### Risks
- **Hall noise:** laptop at full volume, phones within about 2 m; the relay covers the back of the room; have the backup video ready.
- **iOS microphone:** needs a tap to start; get it at join time.
- **Mic needs HTTPS:** deploy to Cloudflare early.
- **App must load offline:** service worker is required before airplane mode.

---

## 7. Optional extra: MUDSAI poker bot
A Python heads-up no-limit Hold'em bot, £300 1st prize. Ask organisers whether it can run alongside the sponsor track. A simple rules-based bot takes about an hour.
