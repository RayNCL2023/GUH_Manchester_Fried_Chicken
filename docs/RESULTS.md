# Resilience benchmark

8 drones on a 60×40 map, sensor radius 5, radio range 8, wind-driven fire. Each cell is the average **% of the live fire edge mapped** by surviving drones over ticks 100–600, averaged over 3 seeds. Regenerate with `bun run engine/sim/benchmark.ts`.

- **Hive**: leaderless. Gossiped maps, claims without a leader, multi-hop relay. Each drone also learns the wind itself; using that estimate to steer tasks didn't improve coverage in this benchmark, so it's reported but not used for steering.
- **Centralised controller**: a deliberately generous baseline: a ground station with a long-range mast reaches every drone, knows the *true* fire map and every drone's true position, and assigns targets every 0.5 s. Its link suffers the same loss and jamming. Drones that lose the link for 1.5 s hold position, the standard failsafe.

| Scenario | Hive (leaderless) | Centralised controller |
|---|---|---|
| 0% loss | 89.2% | 90.0% |
| 30% loss | 88.1% | 88.0% |
| 50% loss | 89.3% | 85.8% |
| 70% loss | 85.0% | 78.0% |
| 90% loss | 82.1% | 45.1% |
| 100% loss (total blackout) | 66.9% | 0.0% |
| Jam between base and fire @20s | 88.1% | 76.0% |
| Lose half the drones @20s | 68.6% | 58.5% |

Wind learned with no central model: the cosine between the drones' estimated and true wind direction is 0.72, 0.78, 0.77, 0.75, 0.69, 0.69, 0.78, 0.82 across scenarios (1.0 means the same direction).
