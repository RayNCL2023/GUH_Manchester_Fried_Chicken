export type StatTone = "good" | "bad" | "warn" | "flock";
// hero = a big headline tile; the rest render as a compact strip under them.
export type StatItem = { label: string; value: string | number; unit?: string; tone?: StatTone; hint?: string; hero?: boolean };
export type Chatter = { from: string; line: string; tick: number };

export interface Live<S> {
	step(): void;
	snapshot(): S;
}
