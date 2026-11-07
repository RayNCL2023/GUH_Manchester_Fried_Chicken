import type { AgentId, CellObs, CellState } from "../shared/types";
import type { Rng } from "./util";

export const STATES: CellState[] = ["unknown", "clear", "fire", "burnt", "village"];
const STATE_INDEX: Record<CellState, number> = { unknown: 0, clear: 1, fire: 2, burnt: 3, village: 4 };
/** One char per cell for Action.localMap / WorldView.inspected. */
export const STATE_CHAR = "ucfbv";

/** Mergeable local map: last-writer-wins per cell (higher ts; tie -> higher agent id). */
export class LocalMap {
    readonly state: Uint8Array;
    readonly ts: Int32Array;
    readonly by: string[];
    readonly dirty = new Set<number>();
    known = 0;

    constructor(readonly w: number, readonly h: number) {
        this.state = new Uint8Array(w * h);
        this.ts = new Int32Array(w * h).fill(-1);
        this.by = new Array<string>(w * h).fill("");
    }

    inBounds(x: number, y: number): boolean {
        return x >= 0 && y >= 0 && x < this.w && y < this.h;
    }

    get(x: number, y: number): CellState {
        if (!this.inBounds(x, y)) {
            return "unknown";
        }
        return STATES[this.state[y * this.w + x]!]!;
    }

    /** Own observation. Same state: refresh ts silently (no gossip). Changed state: dirty. */
    observe(x: number, y: number, s: CellState, tick: number, me: AgentId): boolean {
        if (!this.inBounds(x, y) || s === "unknown") {
            return false;
        }
        const i = y * this.w + x;
        if (this.ts[i]! > tick) {
            return false;
        }
        const si = STATE_INDEX[s];
        if (this.state[i] === si) {
            this.ts[i] = tick;
            this.by[i] = me;
            return false;
        }
        this.write(i, si, tick, me);
        return true;
    }

    /** Merge someone else's observation. Returns true if it changed our map. */
    merge(o: CellObs): boolean {
        if (!this.inBounds(o.x, o.y) || o.state === "unknown") {
            return false;
        }
        const si = STATE_INDEX[o.state];
        if (si === undefined) {
            return false;
        }
        const i = o.y * this.w + o.x;
        const curTs = this.ts[i]!;
        if (o.ts < curTs) {
            return false;
        }
        if (o.ts === curTs && o.by <= this.by[i]!) {
            return false;
        }
        const changed = this.state[i] !== si;
        if (!changed) {
            this.ts[i] = o.ts;
            this.by[i] = o.by;
            return false;
        }
        this.write(i, si, o.ts, o.by);
        return true;
    }

    private write(i: number, si: number, ts: number, by: AgentId): void {
        if (this.state[i] === 0 && si !== 0) {
            this.known++;
        }
        this.state[i] = si;
        this.ts[i] = ts;
        this.by[i] = by;
        this.dirty.add(i);
    }

    obs(i: number): CellObs {
        return {
            x: i % this.w,
            y: Math.floor(i / this.w),
            state: STATES[this.state[i]!]!,
            ts: this.ts[i]!,
            by: this.by[i]!,
        };
    }

    takeDirty(max: number): CellObs[] {
        const out: CellObs[] = [];
        for (const i of this.dirty) {
            if (out.length >= max) {
                break;
            }
            out.push(this.obs(i));
            this.dirty.delete(i);
        }
        return out;
    }

    /** Random sample of known cells, for anti-entropy gossip (lets late joiners catch up). */
    sample(n: number, rng: Rng): CellObs[] {
        const out: CellObs[] = [];
        if (this.known === 0) {
            return out;
        }
        const size = this.w * this.h;
        for (let tries = 0; tries < n * 4 && out.length < n; tries++) {
            const i = Math.floor(rng() * size);
            if (this.state[i] === 0) {
                continue;
            }
            out.push(this.obs(i));
        }
        return out;
    }

    knownPct(): number {
        return (100 * this.known) / (this.w * this.h);
    }

    encode(): string {
        let s = "";
        for (let i = 0; i < this.state.length; i++) {
            s += STATE_CHAR[this.state[i]!];
        }
        return s;
    }
}
