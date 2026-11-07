// bun run engine/sim/chatterReport.ts : what the audience would hear over 60 s of demo.
import { HiveBrain } from "../brain";
import { clipFor } from "../chatterLines";
import { SimWorld } from "./world";

export interface HeardLine { t: number; from: string; text: string; key: string }

export function recordChatter(opts: { jam: boolean; seed?: number; ticks?: number }): HeardLine[] {
    const seed = opts.seed ?? 2;
    const sim = new SimWorld({ lossPct: 50, sensorRadius: 5, seed, makeBrain: () => new HiveBrain({ seed }) });
    const lines: HeardLine[] = [];
    sim.onSend = (from, m) => {
        if (m.kind !== "chatter") return;
        const text = (m.body as { line: string }).line;
        lines.push({ t: sim.tick, from, text, key: clipFor(text)?.key ?? "?" });
    };
    for (let t = 1; t <= (opts.ticks ?? 600); t++) {
        if (t === 200 && opts.jam) {
            sim.cfg.jamZones = [{ center: { x: 40, y: 15 }, radius: 8 }];
            ["Echo-1", "Echo-2", "Echo-3"].forEach((id) => sim.kill(id));
        }
        if (t === 350) sim.injectGoal({ id: "g1", text: "protect the village", target: { x: 17, y: 28 }, radius: 8, priority: 3 });
        sim.step();
    }
    return lines;
}

if (import.meta.main) {
    for (const jam of [false, true]) {
        const lines = recordChatter({ jam });
        const gaps = lines.slice(1).map((l, i) => l.t - lines[i]!.t);
        console.log(`\n== ${jam ? "jam + kill 3 at 20s, goal at 35s" : "calm, goal at 35s"}: ${lines.length} lines / 60s, ` +
            `avg gap ${(600 / Math.max(lines.length, 1) / 10).toFixed(1)}s, gaps <1.5s: ${gaps.filter((g) => g < 15).length}`);
        console.log(lines.map((l) => `  ${(l.t / 10).toFixed(1).padStart(5)}s ${l.from.padEnd(7)} ${l.text}`).join("\n"));
    }
}
