// Resilience benchmark: Hive vs a centralised controller vs Hive-without-learned-wind,
// across message loss 0..100%, plus jamming and drone-loss scenarios.
//   bun run engine/sim/benchmark.ts        -> prints a table, writes docs/RESULTS.md + engine/sim/results.json
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBrain, Vec } from "../../shared/types";
import { DEFAULT_WEIGHTS, HiveBrain } from "../brain";
import { CentralBrain, stationStep } from "./baselines";
import { mulberry32 } from "../util";
import { SimWorld } from "./world";

type Kind = "hive" | "central";
const KINDS: Kind[] = ["hive", "central"];
const LABEL: Record<Kind, string> = { hive: "Hive (leaderless)", central: "Centralised controller" };
const SEEDS = [1, 2, 3];
const TICKS = 600;

interface Scenario {
    name: string;
    loss: number;
    jam?: boolean;
    kill?: boolean;
}

function run(kind: Kind, sc: Scenario, seed: number): { coverage: number; windCos: number | null } {
    let sim!: SimWorld;
    const edges = (): Vec[] => {
        const out: Vec[] = [];
        for (let y = 0; y < sim.cfg.height; y++) {
            for (let x = 0; x < sim.cfg.width; x++) {
                if (sim.isEdge(x, y)) {
                    out.push({ x, y });
                }
            }
        }
        return out;
    };
    const make = (): AgentBrain => {
        if (kind === "central") {
            return new CentralBrain();
        }
        return new HiveBrain({ seed, weights: DEFAULT_WEIGHTS });
    };
    sim = new SimWorld({ lossPct: sc.loss, seed, sensorRadius: 5, makeBrain: make });
    const stationRng = mulberry32(seed * 7919);
    let sum = 0;
    let n = 0;
    for (let t = 1; t <= TICKS; t++) {
        if (t === 200 && sc.jam) {
            // Jam the band between base and fire: the classic "lost link" situation.
            sim.cfg.jamZones = [{ center: { x: 15, y: 25 }, radius: 9 }];
        }
        if (t === 200 && sc.kill) {
            ["Echo-2", "Echo-4", "Echo-6", "Echo-8"].forEach((id) => sim.kill(id));
        }
        if (kind === "central") {
            stationStep(sim, stationRng);
        }
        sim.step();
        if (t > 100) {
            sum += sim.metrics().edgeMappedPct;
            n++;
        }
    }
    let windCos: number | null = null;
    if (kind === "hive") {
        const w = sim.cfg.wind;
        const ests = sim.agents.filter((a) => a.alive).map((a) => (a.brain as HiveBrain).wind.direction()).filter((d): d is Vec => !!d);
        if (ests.length) {
            const wl = Math.hypot(w.x, w.y);
            windCos = ests.reduce((s, d) => s + (d.x * w.x + d.y * w.y) / wl, 0) / ests.length;
        }
    }
    return { coverage: sum / n, windCos };
}

const SCENARIOS: Scenario[] = [
    { name: "0% loss", loss: 0 },
    { name: "30% loss", loss: 30 },
    { name: "50% loss", loss: 50 },
    { name: "70% loss", loss: 70 },
    { name: "90% loss", loss: 90 },
    { name: "100% loss (total blackout)", loss: 100 },
    { name: "Jam between base and fire @20s", loss: 30, jam: true },
    { name: "Lose half the drones @20s", loss: 30, kill: true },
];

const rows: { scenario: string; results: Record<Kind, number>; windCos: number | null }[] = [];
const t0 = performance.now();
for (const sc of SCENARIOS) {
    const results = {} as Record<Kind, number>;
    let windCos: number | null = null;
    for (const k of KINDS) {
        const rs = SEEDS.map((s) => run(k, sc, s));
        results[k] = rs.reduce((a, r) => a + r.coverage, 0) / rs.length;
        if (k === "hive") {
            const ws = rs.map((r) => r.windCos).filter((x): x is number => x !== null);
            windCos = ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : null;
        }
    }
    rows.push({ scenario: sc.name, results, windCos });
    console.log(`${sc.name.padEnd(34)} ${KINDS.map((k) => `${LABEL[k]} ${results[k].toFixed(1)}%`).join("   ")}${windCos !== null ? `   wind est. accuracy cos=${windCos.toFixed(2)}` : ""}`);
}
console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);

const root = join(import.meta.dir, "..", "..");
writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), ticks: TICKS, seeds: SEEDS, rows }, null, 2));
const md = [
    "# Resilience benchmark",
    "",
    `8 drones on a 60×40 map, sensor radius 5, radio range 8, wind-driven fire. Each cell is the average **% of the live fire edge mapped** by surviving drones over ticks 100–${TICKS}, averaged over ${SEEDS.length} seeds. Regenerate with \`bun run engine/sim/benchmark.ts\`.`,
    "",
    "- **Hive**: leaderless. Gossiped maps, claims without a leader, multi-hop relay. Each drone also learns the wind itself; using that estimate to steer tasks didn't improve coverage in this benchmark, so it's reported but not used for steering.",
    "- **Centralised controller**: a deliberately generous baseline: a ground station with a long-range mast reaches every drone, knows the *true* fire map and every drone's true position, and assigns targets every 0.5 s. Its link suffers the same loss and jamming. Drones that lose the link for 1.5 s hold position, the standard failsafe.",
    "",
    `| Scenario | ${KINDS.map((k) => LABEL[k]).join(" | ")} |`,
    `|---|${KINDS.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.scenario} | ${KINDS.map((k) => `${r.results[k].toFixed(1)}%`).join(" | ")} |`),
    "",
    `Wind learned with no central model: the cosine between the drones' estimated and true wind direction is ${rows
        .map((r) => r.windCos)
        .filter((x): x is number => x !== null)
        .map((x) => x.toFixed(2))
        .join(", ")} across scenarios (1.0 means the same direction).`,
    "",
].join("\n");
writeFileSync(join(root, "docs", "RESULTS.md"), md);
