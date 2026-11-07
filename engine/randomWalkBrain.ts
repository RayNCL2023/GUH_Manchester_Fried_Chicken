// Placeholder brain so the server and viewer can be built before HiveBrain lands.
import type { Action, AgentBrain, AgentId, ScenarioId, Sense, Vec } from "../shared/types";
import { dist, hashString, mulberry32, type Rng } from "./util";

export interface RandomWalkOptions {
    width?: number;
    height?: number;
    seed?: number;
}

export class RandomWalkBrain implements AgentBrain {
    private id: AgentId = "";
    private scenario: ScenarioId = "fire";
    private rng: Rng = Math.random;
    private target: Vec | null = null;
    private readonly w: number;
    private readonly h: number;
    private readonly seed: number;

    constructor(opts: RandomWalkOptions = {}) {
        this.w = opts.width ?? 60;
        this.h = opts.height ?? 40;
        this.seed = opts.seed ?? 0;
    }

    init(id: AgentId, scenario: ScenarioId): void {
        this.id = id;
        this.scenario = scenario;
        this.rng = mulberry32(hashString(id) ^ this.seed);
        this.target = null;
    }

    step(sense: Sense): Action {
        if (!sense.self.alive) {
            return {};
        }
        if (this.scenario === "lights") {
            return this.stepLights(sense);
        }
        if (!this.target || dist(this.target, sense.self.pos) < 1) {
            this.target = { x: Math.floor(this.rng() * this.w), y: Math.floor(this.rng() * this.h) };
        }
        return {
            moveTo: this.target,
            claimed: null,
            status: { mode: sense.neighbours.length ? "normal" : "isolated", knownPct: 0 },
        };
    }

    private stepLights(sense: Sense): Action {
        const slots = sense.tasks.filter((t) => t.kind === "slot");
        const slot = slots[hashString(this.id) % Math.max(slots.length, 1)];
        if (!slot) {
            return { display: { color: "#000000" }, status: { mode: "normal", knownPct: 0 } };
        }
        return {
            moveTo: slot.pos,
            claimed: slot.id,
            display: { color: slot.color ?? "#ffffff" },
            status: { mode: "normal", knownPct: 0 },
        };
    }

    debug() {
        return { knownCells: 0, claim: null, mode: "normal" as const };
    }
}
