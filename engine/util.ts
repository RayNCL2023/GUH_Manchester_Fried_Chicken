import type { AgentId, Vec } from "../shared/types";

export type Rng = () => number;

export function hashString(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function mulberry32(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Message ids are `${origin}~${seq}`; the server rewrites `from` on relay, so origin lives in the id. */
export function makeMsgId(origin: AgentId, seq: number): string {
    return `${origin}~${seq}`;
}

export function originOf(msgId: string): AgentId {
    const i = msgId.lastIndexOf("~");
    if (i < 0) {
        return msgId;
    }
    return msgId.slice(0, i);
}

/** Lower score wins; equal score -> lower agent id wins. */
export function claimBeats(scoreA: number, idA: AgentId, scoreB: number, idB: AgentId): boolean {
    if (scoreA !== scoreB) {
        return scoreA < scoreB;
    }
    return idA < idB;
}

export function dist(a: Vec, b: Vec): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export class LruSet {
    private set = new Set<string>();
    private queue: string[] = [];
    private head = 0;

    constructor(private readonly capacity: number) {}

    has(key: string): boolean {
        return this.set.has(key);
    }

    add(key: string): void {
        if (this.set.has(key)) {
            return;
        }
        this.set.add(key);
        this.queue.push(key);
        if (this.set.size <= this.capacity) {
            return;
        }
        const old = this.queue[this.head++];
        if (old !== undefined) {
            this.set.delete(old);
        }
        if (this.head > this.capacity) {
            this.queue = this.queue.slice(this.head);
            this.head = 0;
        }
    }

    get size(): number {
        return this.set.size;
    }
}
