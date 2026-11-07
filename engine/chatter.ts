// Decentralised floor control for radio chatter: listen-before-talk, cooldowns, backoff, stale drop.
// Keeps the room to roughly one meaningful line every 1.5-3 s, with no coordinator.
import { lineByKey, type Priority } from "./chatterLines";
import type { Rng } from "./util";

/** Ticks of channel silence needed before speaking, by priority. */
const QUIET: Record<Priority, number> = { 1: 30, 2: 15, 3: 5 };
/** Minimum ticks between this agent's own lines, by priority. */
const COOLDOWN: Record<Priority, number> = { 1: 40, 2: 40, 3: 20 };
/** Drop a line that couldn't be spoken within this many ticks. */
const STALE = 20;

interface Pending {
    key: string;
    priority: Priority;
    at: number;
}

export class ChatterPlanner {
    private pending: Pending | null = null;
    private lastSpoke = -1e9;
    private lastHeard = -1e9;
    /** Minimum priority allowed (lights scenario sets 3 = critical only). */
    minPriority: Priority = 1;

    propose(key: string, tick: number): void {
        const line = lineByKey(key);
        if (!line || line.priority < this.minPriority) {
            return;
        }
        if (this.pending && this.pending.priority > line.priority) {
            return;
        }
        this.pending = { key, priority: line.priority, at: tick };
    }

    heard(tick: number): void {
        this.lastHeard = tick;
    }

    /** True if the channel was quiet for at least `ticks` (used to self-limit goal "copy" ripples). */
    quietFor(tick: number, ticks: number): boolean {
        return tick - this.lastHeard >= ticks;
    }

    /** Returns the text to speak this tick, or null. */
    step(tick: number, rng: Rng): string | null {
        const p = this.pending;
        if (!p) {
            return null;
        }
        if (tick - p.at > STALE) {
            this.pending = null;
            return null;
        }
        if (tick - this.lastHeard < QUIET[p.priority]) {
            return null;
        }
        if (tick - this.lastSpoke < COOLDOWN[p.priority]) {
            return null;
        }
        // Random backoff so two agents that both see a quiet channel rarely start on the same tick.
        if (rng() < 0.5) {
            return null;
        }
        const line = lineByKey(p.key)!;
        this.pending = null;
        this.lastSpoke = tick;
        this.lastHeard = tick;
        return line.variants[Math.floor(rng() * line.variants.length)]!;
    }
}
