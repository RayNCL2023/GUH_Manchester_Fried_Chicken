// Online wind learner. No agent is told the wind: each one infers it from fire spread it has
// personally watched happen (a cell it saw clear, now burning, next to cells it saw burning).
// Estimates are averaged with neighbours' via heartbeats (decentralised consensus), so the
// swarm converges on the wind even if individual drones only saw a few ignitions.
import type { Vec } from "../shared/types";

const LEARN_RATE = 0.06;
const BLEND = 0.25;

export class WindModel {
    est: Vec = { x: 0, y: 0 };
    /** Own observations so far (confidence). */
    samples = 0;

    /** A spread event: fire moved from `from` into `to`. */
    observeSpread(from: Vec, to: Vec): void {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        this.est = {
            x: this.est.x * (1 - LEARN_RATE) + (dx / len) * LEARN_RATE,
            y: this.est.y * (1 - LEARN_RATE) + (dy / len) * LEARN_RATE,
        };
        this.samples++;
    }

    /** Consensus step with a neighbour's estimate. */
    blend(other: Vec | undefined): void {
        if (!other || !Number.isFinite(other.x) || !Number.isFinite(other.y)) {
            return;
        }
        // Trust neighbours more while we have few samples of our own.
        const w = this.samples < 10 ? 0.5 : BLEND;
        this.est = { x: this.est.x * (1 - w) + other.x * w, y: this.est.y * (1 - w) + other.y * w };
    }

    /** Unit downwind direction, or null when we have no idea yet. */
    direction(): Vec | null {
        const m = Math.hypot(this.est.x, this.est.y);
        if (m < 0.05) {
            return null;
        }
        return { x: this.est.x / m, y: this.est.y / m };
    }

    /** 0..1 how strongly a position is "downwind" of a point (where new fire will appear). */
    downwindness(from: Vec, pos: Vec): number {
        const d = this.direction();
        if (!d) {
            return 0;
        }
        const vx = pos.x - from.x;
        const vy = pos.y - from.y;
        const l = Math.hypot(vx, vy);
        if (l < 0.5) {
            return 0;
        }
        return Math.max(0, (vx * d.x + vy * d.y) / l);
    }
}
