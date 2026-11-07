// Pure scheduling for the radio player (no WebAudio), so the comfort rules are testable.
// Rules: one voice at a time; queue holds at most 2; anything older than 2.5 s is dropped;
// critical lines jump the queue; "critical only" mode drops everything else.
import type { WorldView } from "../shared/types";
import { clipFor, type Priority } from "../engine/chatterLines";

export interface RadioLine {
    from: string;
    text: string;
    key: string | null;
    variant: number;
    priority: Priority;
    /** Agent x in [0, 1] across the map, for panning. */
    x: number;
    jammed: boolean;
    enqueuedAt: number;
}

export const MAX_QUEUE = 2;
export const STALE_MS = 2500;

export class RadioQueue {
    private queue: RadioLine[] = [];
    private seen = new Set<string>();
    criticalOnly = false;
    dropped = 0;

    /** Pull new chatter out of a WorldView. Returns lines newly queued (for captions). */
    ingest(view: WorldView, nowMs: number): RadioLine[] {
        const added: RadioLine[] = [];
        for (const c of view.recentChatter) {
            const k = `${c.from}|${c.tick}|${c.line}`;
            if (this.seen.has(k)) {
                continue;
            }
            this.seen.add(k);
            const agent = view.agents.find((a) => a.id === c.from);
            const clip = clipFor(c.line);
            const line: RadioLine = {
                from: c.from,
                text: c.line,
                key: clip?.key ?? null,
                variant: clip?.variant ?? 0,
                priority: clip?.priority ?? 1,
                x: agent ? agent.pos.x / Math.max(view.width - 1, 1) : 0.5,
                jammed: agent?.jammed ?? false,
                enqueuedAt: nowMs,
            };
            added.push(line);
            this.push(line);
        }
        if (this.seen.size > 500) {
            this.seen = new Set([...this.seen].slice(-200));
        }
        return added;
    }

    push(line: RadioLine): void {
        if (this.criticalOnly && line.priority < 3) {
            this.dropped++;
            return;
        }
        this.queue.push(line);
        // Critical first, then oldest first.
        this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
        while (this.queue.length > MAX_QUEUE) {
            this.queue.pop();
            this.dropped++;
        }
    }

    /** Next line to play now, or null. Drops stale lines. */
    next(nowMs: number): RadioLine | null {
        while (this.queue.length) {
            const line = this.queue.shift()!;
            if (nowMs - line.enqueuedAt <= STALE_MS) {
                return line;
            }
            this.dropped++;
        }
        return null;
    }

    clear(): void {
        this.queue = [];
    }

    get length(): number {
        return this.queue.length;
    }
}
