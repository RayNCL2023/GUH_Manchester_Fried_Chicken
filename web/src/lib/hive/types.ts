export type StatItem = { label: string; value: string | number; unit?: string };
export type Chatter = { from: string; line: string; tick: number };

export interface Live<S> {
	step(): void;
	snapshot(): S;
}
