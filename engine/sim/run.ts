// bun run engine/sim/run.ts [--loss 50] [--ticks 600] [--agents 8] [--seed 1] [--brain hive|random]
import { createBrain, type BrainKind } from "../brains";
import { SimWorld } from "./world";

function arg(name: string, fallback: number): number {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const kindIdx = process.argv.indexOf("--brain");
const kind = (kindIdx >= 0 ? process.argv[kindIdx + 1] : "hive") as BrainKind;
const ticks = arg("ticks", 600);
const sim = new SimWorld({
    lossPct: arg("loss", 50),
    agents: arg("agents", 8),
    seed: arg("seed", 1),
    makeBrain: () => createBrain(kind, { seed: arg("seed", 1) }),
});

for (let t = 1; t <= ticks; t++) {
    sim.step();
    if (t % 60 !== 0) {
        continue;
    }
    const m = sim.metrics();
    console.log(
        `t=${String(t).padStart(4)}  edge=${m.edgeMappedPct.toFixed(1).padStart(5)}% of ${String(m.edgeCells).padStart(3)}  ` +
            `known=${m.avgKnownPct.toFixed(1).padStart(5)}%  dupNow=${m.duplicateClaims}  maxDupRun=${m.maxDuplicateRun}`,
    );
}
