// Pure, dependency-free goal parser (safe to bundle in the browser for offline mode).
import type { GoalBody, Vec } from "../shared/types";

/** What the LLM (and the keyword fallback) knows about the world. */
export interface WorldBrief {
    width: number;
    height: number;
    village: Vec | null;
    fireCentre: Vec | null;
    /** Plain-text summary (grid conventions, counts, wind, agents). */
    text: string;
}

export interface ParsedGoal extends GoalBody {
    source: "llm" | "keywords";
}

/** Deterministic parser: places by keyword, priority by urgency words. */
export function keywordGoal(id: string, text: string, world: WorldBrief): ParsedGoal {
    const t = text.toLowerCase();
    const { width: w, height: h } = world;
    const fire = world.fireCentre ?? { x: w / 2, y: h / 2 };
    let target: Vec | undefined;
    let radius = 8;
    if (/village|town|homes|houses|people|civilian/.test(t) && world.village) {
        target = world.village;
    } else if (/north/.test(t)) {
        target = { x: fire.x, y: Math.max(0, fire.y - 8) };
    } else if (/south/.test(t)) {
        target = { x: fire.x, y: Math.min(h - 1, fire.y + 8) };
    } else if (/east/.test(t)) {
        target = { x: Math.min(w - 1, fire.x + 8), y: fire.y };
    } else if (/west/.test(t)) {
        target = { x: Math.max(0, fire.x - 8), y: fire.y };
    } else if (/fire|front|flame|edge/.test(t)) {
        target = fire;
        radius = 12;
    }
    const urgent = /now|urgent|immediately|everyone|all units|priority|asap/.test(t);
    return { id, text: text || "Re-task", target, radius, priority: urgent ? 4 : 3, source: "keywords" };
}

