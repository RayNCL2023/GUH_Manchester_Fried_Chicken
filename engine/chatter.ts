// Decentralised floor control for radio chatter. No coordinator; each agent applies:
//  1. Fair-share airtime: its cooldown scales with the swarm size it has heard of, so the
//     whole swarm (which the audience hears at once) stays near one routine line every ~2.5 s.
//  2. Listen-before-talk: wait for neighbour silence (shorter wait for critical lines).
//  3. Don't repeat news: skip a line whose key someone was heard saying recently.
//  4. Random backoff + stale drop: never queue old news.
// The voice player still plays one line at a time and drops stale ones; this keeps the input sane.
import { clipFor, lineByKey, type Priority } from "./chatterLines";
import type { Rng } from "./util";

/** Ticks of neighbour silence needed before speaking. */
const QUIET: Record<Priority, number> = { 1: 30, 2: 15, 3: 5 };
/** Floor on ticks between this agent's own lines. */
const MIN_COOLDOWN: Record<Priority, number> = { 1: 60, 2: 50, 3: 25 };
/** Airtime share per known agent (ticks): cooldown = max(MIN, AIRTIME * swarmSize). */
const AIRTIME: Record<Priority, number> = { 1: 25, 2: 20, 3: 4 };
/** Don't say a key that anyone was heard saying within this many ticks. */
const DEDUPE_DEFAULT = 150;
const DEDUPE: Record<string, number> = { goal_copy: 20, isolated: 40, claim_north: 60, claim_south: 60, claim_east: 60, claim_west: 60 };
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
    private heardKeys = new Map<string, number>();
    /** Minimum priority allowed (lights scenario sets 3 = critical only). */
    minPriority: Priority = 1;
    /** Agents this one has heard from recently (incl. itself); set by the brain each tick. */
    swarmSize = 1;

    propose(key: string, tick: number): void {
        const line = lineByKey(key);
        if (!line || line.priority < this.minPriority) {
            return;
        }
        const heardAt = this.heardKeys.get(key);
        if (heardAt !== undefined && tick - heardAt < (DEDUPE[key] ?? DEDUPE_DEFAULT)) {
            return;
        }
        if (this.pending && this.pending.priority > line.priority) {
            return;
        }
        this.pending = { key, priority: line.priority, at: tick };
    }

    heard(tick: number, text?: string): void {
        this.lastHeard = tick;
        const key = text ? clipFor(text)?.key : undefined;
        if (!key) {
            return;
        }
        this.heardKeys.set(key, tick);
        if (this.pending?.key === key && key !== "goal_copy") {
            this.pending = null;
        }
    }

    /** True if the channel was quiet for at least `ticks`. */
    quietFor(tick: number, ticks: number): boolean {
        return tick - this.lastHeard >= ticks;
    }

    cooldown(p: Priority): number {
        return Math.max(MIN_COOLDOWN[p], AIRTIME[p] * this.swarmSize);
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
        if (tick - this.lastSpoke < this.cooldown(p.priority)) {
            return null;
        }
        if (rng() < 0.5) {
            return null;
        }
        const line = lineByKey(p.key)!;
        this.pending = null;
        this.lastSpoke = tick;
        this.lastHeard = tick;
        this.heardKeys.set(p.key, tick);
        return line.variants[Math.floor(rng() * line.variants.length)]!;
    }
}
