// Conventional centralised baseline, deliberately generous:
// a ground station with a long-range mast reaches EVERY drone (no range limit), knows the TRUE
// fire map and every drone's TRUE position, and assigns targets every 5 ticks. Its link suffers
// the same packet loss and jamming as everything else. Drones that haven't heard the station
// for 15 ticks do the standard failsafe: hold position.
import type { Action, AgentBrain, AgentId, Msg, ScenarioId, Sense, Vec } from "../../shared/types";
import { LocalMap } from "../map";
import { dist } from "../util";
import type { SimWorld } from "./world";

type Assign = { target: Vec };

export class CentralBrain implements AgentBrain {
    readonly map: LocalMap;
    private id: AgentId = "";
    private tick = 0;
    private target: Vec | null = null;
    private heardAt = -1e9;

    constructor(w = 60, h = 40) {
        this.map = new LocalMap(w, h);
    }

    init(id: AgentId, _scenario: ScenarioId): void {
        this.id = id;
    }

    debug() {
        return { knownCells: this.map.known, claim: null, mode: this.lost ? ("isolated" as const) : ("normal" as const) };
    }

    private get lost(): boolean {
        return this.tick - this.heardAt > 15;
    }

    step(sense: Sense): Action {
        this.tick = sense.tick;
        if (!sense.self.alive) {
            return {};
        }
        for (const c of sense.nearbyCells) {
            this.map.observe(c.x, c.y, c.state, this.tick, this.id);
        }
        for (const m of sense.inbox) {
            if (m.from === "station") {
                this.target = (m.body as Assign).target;
                this.heardAt = this.tick;
            }
        }
        return {
            moveTo: this.lost || !this.target ? sense.self.pos : this.target,
            status: { mode: this.lost ? "isolated" : "normal", knownPct: this.map.knownPct() },
        };
    }
}

/** Ground-station step: plan with perfect information, deliver over the lossy/jammable link. */
export function stationStep(sim: SimWorld, rng: () => number): void {
    if (sim.tick % 5 !== 0) {
        return;
    }
    const edges: Vec[] = [];
    for (let y = 0; y < sim.cfg.height; y++) {
        for (let x = 0; x < sim.cfg.width; x++) {
            if (sim.isEdge(x, y)) {
                edges.push({ x, y });
            }
        }
    }
    const drones = sim.agents.filter((a) => a.alive);
    for (const a of drones) {
        let best = -1;
        let bd = Infinity;
        edges.forEach((e, i) => {
            const d = dist(e, a.pos);
            if (d < bd) {
                bd = d;
                best = i;
            }
        });
        if (best < 0) {
            continue;
        }
        const target = edges[best]!;
        // Spread drones along the perimeter: remove nearby edges once assigned.
        for (let i = edges.length - 1; i >= 0; i--) {
            if (dist(edges[i]!, target) < 6) {
                edges.splice(i, 1);
            }
        }
        if (sim.jammed(a.pos) || rng() * 100 < sim.cfg.lossPct) {
            continue;
        }
        const msg: Msg = { id: `station~${sim.tick}~${a.id}`, from: "station", kind: "goal", ttl: 0, ts: sim.tick, body: { target } satisfies Assign };
        a.inbox.push(msg);
    }
}
