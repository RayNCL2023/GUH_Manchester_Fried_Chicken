// LLM layer: spoken command -> GoalBody, and world -> spoken sitrep.
// Claude is used only to *interpret* the operator; agents never call it and never get its output except
// as one injected goal that spreads by gossip. Every call has a deterministic fallback, so the demo
// works with no API key, no network, or a refusal.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Vec } from "../shared/types";

export const MODEL = "claude-opus-5-5";
const TIMEOUT_MS = 4000;

import { keywordGoal, type ParsedGoal, type WorldBrief } from "./keywords";
export { keywordGoal, type ParsedGoal, type WorldBrief };

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        return null;
    }
    client ??= new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 });
    return client;
}

const GoalSchema = z.object({
    summary: z.string().describe("Short restatement of the order for the radio log, max 8 words"),
    has_target: z.boolean().describe("True if the order refers to a place on the map"),
    target_x: z.number().describe("Target column, 0 = west edge"),
    target_y: z.number().describe("Target row, 0 = north edge"),
    radius: z.number().describe("Area of interest radius in cells, 3-20"),
    priority: z.number().describe("How strongly to re-prioritise, 1 (mild) to 5 (drop everything)"),
});

const GOAL_SYSTEM = `You translate a spoken order from a wildfire incident commander into a goal for a leaderless drone swarm.
The swarm maps the fire edge. A goal makes drones prefer tasks within "radius" cells of the target, weighted by "priority".
Use the world summary to resolve places ("the village", "the north flank", "the fire's front", "downwind") into grid coordinates.
If the order names no place, set has_target false and pick sensible defaults.
The transcript comes from speech-to-text and may be garbled; interpret the most likely intent.`;

export async function parseGoal(transcript: string, world: WorldBrief): Promise<ParsedGoal> {
    const id = `goal-${Date.now().toString(36)}`;
    const text = transcript.trim().slice(0, 300);
    const api = getClient();
    if (!api || !text) {
        return keywordGoal(id, text, world);
    }
    try {
        const response = await api.messages.parse({
            model: MODEL,
            max_tokens: 2000,
            output_config: { effort: "low", format: zodOutputFormat(GoalSchema) },
            system: GOAL_SYSTEM,
            messages: [{ role: "user", content: `World:\n${world.text}\n\nOrder (transcript): "${text}"` }],
        });
        const out = response.stop_reason === "refusal" ? null : response.parsed_output;
        if (!out) {
            return keywordGoal(id, text, world);
        }
        const target = out.has_target ? clampVec({ x: out.target_x, y: out.target_y }, world) : undefined;
        return {
            id,
            text: out.summary || text,
            target,
            radius: clamp(out.radius, 3, 20),
            priority: clamp(out.priority, 1, 5),
            source: "llm",
        };
    } catch (err) {
        console.warn("[ai] parseGoal fell back to keywords:", err instanceof Error ? err.message : err);
        return keywordGoal(id, text, world);
    }
}

const SITREP_SYSTEM = `You are the swarm's radio operator. Give a spoken situation report in exactly two short sentences
(under 35 words total) from the world summary: fire extent and direction, risk to the village, and how many drones
are isolated or lost. Plain words, no numbers with decimals, no markdown. It will be read aloud by a voice model.`;

export async function sitrep(world: WorldBrief): Promise<{ text: string; source: "llm" | "template" }> {
    const api = getClient();
    if (!api) {
        return { text: templateSitrep(world), source: "template" };
    }
    try {
        const response = await api.messages.create({
            model: MODEL,
            max_tokens: 2000,
            output_config: { effort: "low" },
            system: SITREP_SYSTEM,
            messages: [{ role: "user", content: world.text }],
        });
        if (response.stop_reason === "refusal") {
            return { text: templateSitrep(world), source: "template" };
        }
        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join(" ")
            .trim();
        return text ? { text, source: "llm" } : { text: templateSitrep(world), source: "template" };
    } catch (err) {
        console.warn("[ai] sitrep fell back to template:", err instanceof Error ? err.message : err);
        return { text: templateSitrep(world), source: "template" };
    }
}

export function templateSitrep(world: WorldBrief): string {
    const drones = world.alive !== undefined ? `${world.alive} drones up${world.isolated ? `, ${world.isolated} working alone` : ""}.` : "";
    if (!world.fireCentre) {
        return `${drones} No active fire. All units on patrol.`.trim();
    }
    const dir = world.wind ? compass(world.wind) : null;
    const v = world.village;
    const d = v ? Math.hypot(v.x - world.fireCentre.x, v.y - world.fireCentre.y) : null;
    const risk = d === null ? "The village is lost." : d < 10 ? "The village is under direct threat." : d < 18 ? "The fire is closing on the village." : "The village is clear for now.";
    const share = world.burning !== undefined ? world.burning / (world.width * world.height) : 0.05;
    const size = share < 0.03 ? "A small fire" : share < 0.15 ? "A large fire" : "A major fire";
    const fire = `${size} is burning${dir ? `, spreading ${dir}` : ""}.`;
    return `${drones} ${fire} ${risk}`.trim();
}

function compass(w: Vec): string {
    const names = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
    const a = Math.atan2(w.y, w.x); // y grows south
    return names[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]!;
}

function clamp(n: number, lo: number, hi: number): number {
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

function clampVec(p: Vec, world: WorldBrief): Vec {
    return { x: clamp(Math.round(p.x), 0, world.width - 1), y: clamp(Math.round(p.y), 0, world.height - 1) };
}
