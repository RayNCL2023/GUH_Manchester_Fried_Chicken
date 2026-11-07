import { describe, expect, test } from "bun:test";
import type { ServerToAgent, WorldView } from "../../shared/types";
import { keywordGoal } from "../../ai";
import { createBrain } from "../../engine/brains";
import { RadioQueue } from "../../voice/queue";
import { buildSlots, hiveLogo } from "../scenarios/lights";
import { World } from "../world";

function withBots(world: World, n: number, isPhone = false, prefix = "Echo") {
    for (let i = 1; i <= n; i++) {
        const id = `${prefix}-${i}`;
        const brain = createBrain("hive");
        let scenario = "";
        let lastTick = -1;
        world.addAgent(id, isPhone, (m: ServerToAgent) => {
            if (m.sense.scenario !== scenario || m.sense.tick < lastTick) {
                brain.init(id, m.sense.scenario);
                scenario = m.sense.scenario;
            }
            lastTick = m.sense.tick;
            world.applyAction(id, brain.step(m.sense));
        });
    }
}

function viewer(world: World) {
    const state: { view: WorldView | null; frames: number } = { view: null, frames: 0 };
    world.addViewer((m) => {
        state.view = m.view;
        state.frames++;
    });
    return state;
}

describe("world server", () => {
    test("fire scenario: swarm maps the edge through the real server loop", () => {
        const w = new World();
        withBots(w, 8);
        const v = viewer(w);
        w.control({ type: "setLoss", pct: 50 });
        let sum = 0;
        for (let t = 1; t <= 400; t++) {
            w.step();
            if (t > 100) {
                sum += v.view!.metrics.edgeMappedPct;
            }
        }
        const avg = sum / 300;
        console.log(`server loop @50% loss: avg edge mapped ${avg.toFixed(1)}%, gauge ${v.view!.metrics.msgLossPct.toFixed(0)}%`);
        expect(avg).toBeGreaterThan(70);
        expect(v.view!.metrics.msgLossPct).toBeGreaterThan(35);
        expect(v.view!.metrics.msgLossPct).toBeLessThan(65);
    });

    test("viewer gets full frames plus diffs that rebuild the same grid", () => {
        const w = new World();
        withBots(w, 2);
        let grid: string[] = [];
        let truth: string[] = [];
        w.addViewer((m) => {
            const view = m.view;
            if (view.cells.length) {
                grid = [...view.cells];
            } else {
                for (const [i, s] of view.cellDiff ?? []) {
                    grid[i] = s;
                }
            }
            truth = [...w.scenario.cells()];
        });
        for (let t = 0; t < 57; t++) {
            w.step();
        }
        expect(grid).toEqual(truth);
    });

    test("jam zone isolates agents inside it; kill removes from alive count", () => {
        const w = new World();
        withBots(w, 4);
        const v = viewer(w);
        w.step();
        w.control({ type: "addJam", center: { x: 3, y: 37 }, radius: 10 });
        w.control({ type: "killAgent", id: "Echo-1" });
        w.step();
        expect(v.view!.agents.every((a) => a.jammed)).toBe(true);
        expect(v.view!.links.length).toBe(0);
        expect(v.view!.metrics.aliveAgents).toBe(3);
        expect(v.view!.agents.find((a) => a.id === "Echo-1")!.mode).toBe("dead");
    });

    test("goal is injected into an unjammed agent and spreads to the others", () => {
        const w = new World();
        withBots(w, 6);
        const v = viewer(w);
        for (let t = 0; t < 5; t++) {
            w.step();
        }
        const first = w.injectGoal({ id: "g1", text: "protect the village", target: { x: 17, y: 28 }, radius: 8, priority: 4 });
        expect(first).not.toBeNull();
        for (let t = 0; t < 40; t++) {
            w.step();
        }
        const copies = v.view!.recentChatter.filter((c) => /copy|roger/i.test(c.line));
        expect(copies.length).toBeGreaterThanOrEqual(1);
    });

    test("inspect returns the agent's own map", () => {
        const w = new World();
        withBots(w, 2);
        const v = viewer(w);
        w.control({ type: "inspect", id: "Echo-2" });
        w.step();
        w.step();
        expect(v.view!.inspected?.id).toBe("Echo-2");
        expect(v.view!.inspected?.map.length).toBe(60 * 40);
    });

    test("light show forms, then re-forms at lower resolution when phones leave", () => {
        const w = new World();
        withBots(w, 12, true, "Echo-P");
        const v = viewer(w);
        w.control({ type: "switchScenario", scenario: "lights" });
        for (let t = 0; t < 120; t++) {
            w.step();
        }
        const before = v.view!.metrics.edgeMappedPct;
        for (let i = 1; i <= 6; i++) {
            w.disconnectAgent(`Echo-P-${i}`);
        }
        for (let t = 0; t < 150; t++) {
            w.step();
        }
        const after = v.view!.metrics.edgeMappedPct;
        console.log(`light show fill: 12 phones ${before.toFixed(0)}%, after 6 leave ${after.toFixed(0)}% (${v.view!.agents.length} left)`);
        expect(before).toBeGreaterThan(80);
        expect(after).toBeGreaterThan(80);
    });

    test("reset restores everything", () => {
        const w = new World();
        withBots(w, 3);
        w.control({ type: "addJam", center: { x: 1, y: 1 }, radius: 3 });
        w.control({ type: "killAgent", id: "Echo-1" });
        w.control({ type: "reset" });
        expect(w.jamZones.length).toBe(0);
        expect(w.liveAgents().length).toBe(3);
        expect(w.tick).toBe(0);
    });
});

describe("lights image", () => {
    test("slot grid never exceeds participants and keeps ~16:10", () => {
        for (const n of [1, 3, 5, 12, 24, 40]) {
            const g = buildSlots(n, 60, 40);
            expect(g.tasks.length).toBeLessThanOrEqual(n);
            expect(g.tasks.length).toBeGreaterThan(0);
        }
        expect(hiveLogo(0.5, 0.5)).toBe("#fff4d6"); // centre of the H
        expect(hiveLogo(0.02, 0.02)).toBe("#05060a"); // outside hexagon
    });
});

describe("ai fallback", () => {
    const brief = { width: 60, height: 40, village: { x: 17, y: 28 }, fireCentre: { x: 35, y: 12 }, text: "" };
    test("village order targets the village", () => {
        const g = keywordGoal("g", "everyone protect the village now", brief);
        expect(g.target).toEqual({ x: 17, y: 28 });
        expect(g.priority).toBe(4);
    });
    test("north flank is north of the fire", () => {
        const g = keywordGoal("g", "cover the north flank", brief);
        expect(g.target!.y).toBeLessThan(12);
    });
});

describe("radio queue (player comfort rules)", () => {
    const view = (lines: { from: string; line: string; tick: number }[]): WorldView => ({
        tick: 1,
        scenario: "fire",
        width: 60,
        height: 40,
        cells: [],
        agents: lines.map((l) => ({ id: l.from, pos: { x: 30, y: 20 }, alive: true, jammed: false, isPhone: false, claim: null, mode: "normal", knownPct: 0 })),
        links: [],
        jamZones: [],
        wind: { x: 1, y: 0 },
        metrics: { edgeMappedPct: 0, msgLossPct: 0, aliveAgents: 1 },
        recentChatter: lines,
    });

    test("holds at most 2, critical first, each line once", () => {
        const q = new RadioQueue();
        const v = view([
            { from: "Echo-1", line: "Taking the north flank.", tick: 1 },
            { from: "Echo-2", line: "I've got the south side.", tick: 1 },
            { from: "Echo-3", line: "Lost comms, continuing on last plan.", tick: 1 },
        ]);
        q.ingest(v, 0);
        q.ingest(v, 0); // same chatter again: ignored
        expect(q.length).toBe(2);
        expect(q.next(10)!.text).toBe("Lost comms, continuing on last plan.");
    });

    test("drops stale lines and honours critical-only", () => {
        const q = new RadioQueue();
        q.ingest(view([{ from: "Echo-1", line: "Taking the north flank.", tick: 1 }]), 0);
        expect(q.next(3000)).toBeNull();
        q.criticalOnly = true;
        q.ingest(view([{ from: "Echo-2", line: "Taking the west flank.", tick: 2 }, { from: "Echo-3", line: "Copy, re-tasking.", tick: 2 }]), 0);
        expect(q.length).toBe(1);
    });
});
