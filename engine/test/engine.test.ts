import { describe, expect, test } from "bun:test";
import type { Msg, Sense } from "../../shared/types";
import { HiveBrain } from "../brain";
import { allClips, clipFor } from "../chatterLines";
import { LocalMap } from "../map";
import { RandomWalkBrain } from "../randomWalkBrain";
import { SimWorld } from "../sim/world";
import { claimBeats, LruSet, originOf } from "../util";

function sense(partial: Partial<Sense> & { tick: number }): Sense {
    return {
        scenario: "fire",
        self: { id: "Echo-1", pos: { x: 10, y: 10 }, alive: true, jammed: false, isPhone: false },
        nearbyCells: [],
        neighbours: ["Echo-2"],
        inbox: [],
        tasks: [],
        clockMs: 0,
        ...partial,
    };
}

describe("LocalMap", () => {
    test("higher ts wins", () => {
        const m = new LocalMap(5, 5);
        m.merge({ x: 1, y: 1, state: "clear", ts: 5, by: "B" });
        m.merge({ x: 1, y: 1, state: "fire", ts: 4, by: "Z" });
        expect(m.get(1, 1)).toBe("clear");
        m.merge({ x: 1, y: 1, state: "fire", ts: 6, by: "A" });
        expect(m.get(1, 1)).toBe("fire");
    });

    test("equal ts -> higher agent id wins", () => {
        const m = new LocalMap(5, 5);
        m.merge({ x: 0, y: 0, state: "clear", ts: 3, by: "Echo-2" });
        m.merge({ x: 0, y: 0, state: "fire", ts: 3, by: "Echo-1" });
        expect(m.get(0, 0)).toBe("clear");
        m.merge({ x: 0, y: 0, state: "fire", ts: 3, by: "Echo-3" });
        expect(m.get(0, 0)).toBe("fire");
    });

    test("merge is order-independent (CRDT)", () => {
        const obs = [
            { x: 2, y: 2, state: "clear" as const, ts: 1, by: "A" },
            { x: 2, y: 2, state: "fire" as const, ts: 2, by: "B" },
            { x: 2, y: 2, state: "burnt" as const, ts: 2, by: "C" },
        ];
        const a = new LocalMap(5, 5);
        const b = new LocalMap(5, 5);
        obs.forEach((o) => a.merge(o));
        [...obs].reverse().forEach((o) => b.merge(o));
        expect(a.get(2, 2)).toBe(b.get(2, 2));
        expect(a.get(2, 2)).toBe("burnt");
    });

    test("encode uses one char per cell", () => {
        const m = new LocalMap(3, 1);
        m.merge({ x: 1, y: 0, state: "fire", ts: 1, by: "A" });
        expect(m.encode()).toBe("ufu");
    });
});

describe("util", () => {
    test("claim tie-break: lower score, then lower id", () => {
        expect(claimBeats(1, "Echo-9", 2, "Echo-1")).toBe(true);
        expect(claimBeats(2, "Echo-1", 2, "Echo-2")).toBe(true);
        expect(claimBeats(2, "Echo-2", 2, "Echo-1")).toBe(false);
    });

    test("origin comes from msg id", () => {
        expect(originOf("Echo-3~17")).toBe("Echo-3");
    });

    test("LruSet evicts oldest", () => {
        const s = new LruSet(2);
        s.add("a");
        s.add("b");
        s.add("c");
        expect(s.has("a")).toBe(false);
        expect(s.has("c")).toBe(true);
    });
});

describe("HiveBrain", () => {
    const edgeTask = { id: "edge:12:10", pos: { x: 12, y: 10 }, kind: "edge" as const, value: 1 };

    test("claims a task and broadcasts it", () => {
        const b = new HiveBrain();
        b.init("Echo-1", "fire");
        const a = b.step(sense({ tick: 1, tasks: [edgeTask] }));
        expect(a.claimed).toBe("edge:12:10");
        expect(a.send?.some((m) => m.kind === "claim")).toBe(true);
    });

    test("yields to a better claim, keeps a worse one", () => {
        const b = new HiveBrain();
        b.init("Echo-5", "fire");
        b.step(sense({ tick: 1, tasks: [edgeTask] }));
        const worse: Msg = { id: "Echo-2~1", from: "Echo-2", kind: "claim", ttl: 2, ts: 1, body: { taskId: edgeTask.id, claimant: "Echo-2", ts: 1, score: 999 } };
        const a2 = b.step(sense({ tick: 2, tasks: [edgeTask], inbox: [worse] }));
        expect(a2.claimed).toBe(edgeTask.id);
        const better: Msg = { id: "Echo-3~1", from: "Echo-3", kind: "claim", ttl: 2, ts: 2, body: { taskId: edgeTask.id, claimant: "Echo-3", ts: 2, score: 0.001 } };
        const a3 = b.step(sense({ tick: 3, tasks: [edgeTask], inbox: [better] }));
        expect(a3.claimed).not.toBe(edgeTask.id);
    });

    test("relays once with ttl-1, dedupes repeats", () => {
        const b = new HiveBrain();
        b.init("Echo-1", "fire");
        const hb: Msg = { id: "Echo-7~4", from: "Echo-2", kind: "heartbeat", ttl: 2, ts: 1, body: { pos: { x: 0, y: 0 }, claim: null } };
        const a1 = b.step(sense({ tick: 1, inbox: [hb] }));
        const relayed = a1.send?.filter((m) => m.id === "Echo-7~4") ?? [];
        expect(relayed.length).toBe(1);
        expect(relayed[0]!.ttl).toBe(1);
        const a2 = b.step(sense({ tick: 2, inbox: [hb] }));
        expect(a2.send?.some((m) => m.id === "Echo-7~4")).toBe(false);
    });

    test("does not relay ttl 0", () => {
        const b = new HiveBrain();
        b.init("Echo-1", "fire");
        const hb: Msg = { id: "Echo-7~5", from: "Echo-2", kind: "heartbeat", ttl: 0, ts: 1, body: { pos: { x: 0, y: 0 }, claim: null } };
        const a = b.step(sense({ tick: 1, inbox: [hb] }));
        expect(a.send?.some((m) => m.id === "Echo-7~5")).toBe(false);
    });

    test("goes isolated after 10 ticks without neighbours", () => {
        const b = new HiveBrain();
        b.init("Echo-1", "fire");
        b.step(sense({ tick: 1 }));
        let mode = "";
        for (let t = 2; t <= 13; t++) {
            mode = b.step(sense({ tick: t, neighbours: [] })).status!.mode;
        }
        expect(mode).toBe("isolated");
    });

    test("goal is adopted and forwarded exactly once", () => {
        const b = new HiveBrain();
        b.init("Echo-1", "fire");
        const goal: Msg = { id: "control~1", from: "control", kind: "goal", ttl: 0, ts: 1, body: { id: "g1", text: "protect village", target: { x: 17, y: 28 }, priority: 3 } };
        const a1 = b.step(sense({ tick: 1, inbox: [goal] }));
        expect(a1.send?.filter((m) => m.kind === "goal").length).toBe(1);
        const again: Msg = { ...goal, id: "Echo-2~9" };
        const a2 = b.step(sense({ tick: 2, inbox: [again] }));
        expect(a2.send?.filter((m) => m.kind === "goal").length ?? 0).toBe(0);
        expect(a2.moveTo).toEqual({ x: 17, y: 28 });
    });

    test("returns local map only when inspected", () => {
        const b = new HiveBrain({ width: 4, height: 2 });
        b.init("Echo-1", "fire");
        expect(b.step(sense({ tick: 1 })).localMap).toBeUndefined();
        expect(b.step(sense({ tick: 2, inspect: true })).localMap?.length).toBe(8);
    });

    test("lights: shows slot colour once on the slot", () => {
        const b = new HiveBrain();
        b.init("Echo-40", "lights");
        const slot = { id: "slot:0:0", pos: { x: 10, y: 10 }, kind: "slot" as const, value: 1, color: "#ff0055" };
        const a = b.step(sense({ tick: 1, scenario: "lights", tasks: [slot] }));
        expect(a.claimed).toBe("slot:0:0");
        expect(a.display?.color).toBe("#ff0055");
    });
});

describe("chatter lines", () => {
    test("every variant text maps back to its clip", () => {
        for (const c of allClips()) {
            expect(clipFor(c.text)).toEqual({ key: c.key, variant: c.variant, priority: c.priority });
        }
    });
});

describe("sim", () => {
    function avgCoverage(lossPct: number, seed: number) {
        const sim = new SimWorld({ lossPct, seed, sensorRadius: 5, makeBrain: () => new HiveBrain({ seed }) });
        let sum = 0;
        let n = 0;
        let lines = 0;
        for (let t = 1; t <= 600; t++) {
            sim.step();
            if (t >= 100) {
                sum += sim.metrics().edgeMappedPct;
                n++;
            }
        }
        return { avg: sum / n, maxDup: sim.metrics().maxDuplicateRun, lines };
    }

    test("8 agents at 50% loss keep the fire edge mapped", () => {
        const runs = [1, 2, 3].map((s) => avgCoverage(50, s));
        const avg = runs.reduce((a, r) => a + r.avg, 0) / runs.length;
        console.log(`avg edge coverage @50% loss: ${avg.toFixed(1)}%, max duplicate-claim run: ${Math.max(...runs.map((r) => r.maxDup))} ticks`);
        expect(avg).toBeGreaterThan(75);
        for (const r of runs) {
            expect(r.maxDup).toBeLessThanOrEqual(15);
        }
    });

    test("random-walk brain runs without errors", () => {
        const sim = new SimWorld({ makeBrain: () => new RandomWalkBrain() });
        for (let t = 0; t < 50; t++) {
            sim.step();
        }
        expect(sim.metrics().aliveAgents).toBe(8);
    });

    test("swarm survives losing half its agents", () => {
        const sim = new SimWorld({ lossPct: 50, seed: 4, sensorRadius: 5, makeBrain: () => new HiveBrain({ seed: 4 }) });
        for (let t = 1; t <= 600; t++) {
            if (t === 200) {
                ["Echo-1", "Echo-3", "Echo-5", "Echo-7"].forEach((id) => sim.kill(id));
            }
            sim.step();
        }
        const m = sim.metrics();
        console.log(`after killing 4/8: edge coverage ${m.edgeMappedPct.toFixed(1)}%`);
        expect(m.aliveAgents).toBe(4);
        expect(m.edgeMappedPct).toBeGreaterThan(30);
    });
});
