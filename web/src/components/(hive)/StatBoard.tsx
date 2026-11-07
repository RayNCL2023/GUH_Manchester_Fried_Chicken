import { twMerge } from "tailwind-merge";
import type { StatItem, StatTone } from "@/lib/hive/types";
import Stat from "./Stat";

const TONE: Record<StatTone, { text: string; bar: string }> = {
	flock: { text: "text-flock", bar: "bg-flock" },
	good: { text: "text-water", bar: "bg-water" },
	bad: { text: "text-ember", bar: "bg-ember" },
	warn: { text: "text-amber", bar: "bg-amber" },
};

// Headline numbers big, the rest as a compact strip. Percentages get a meter under the number.
function Hero({ label, value, unit, tone = "flock", hint }: StatItem) {
	const t = TONE[tone];
	const pct = unit === "%" && typeof value === "number" ? Math.max(0, Math.min(100, value)) : null;
	return (
		<div className="flex flex-col gap-[.75rem] p-[1.25rem] rounded-[1.25rem] bg-panel border border-line">
			<p className="text-[.875rem] text-mute">{label}</p>
			<p className={twMerge("font-display text-[3.5rem] leading-none tracking-[-0.04em] tabular-nums", t.text)}>
				{value}
				{unit && <span className="text-[1.5rem] ml-[.2rem] opacity-70">{unit}</span>}
			</p>
			{pct !== null && (
				<div className="h-[.35rem] rounded-full bg-line overflow-hidden">
					<div className={twMerge("h-full rounded-full transition-[width] duration-500", t.bar)} style={{ width: `${pct}%` }} />
				</div>
			)}
			{hint && <p className="text-[.875rem] text-mute leading-relaxed text-pretty">{hint}</p>}
		</div>
	);
}

export default function ({ stats, className }: { stats: StatItem[]; className?: string }) {
	const heroes = stats.filter((s) => s.hero);
	const rest = stats.filter((s) => !s.hero);
	return (
		<div className={twMerge("flex flex-col gap-[.75rem]", className)}>
			<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-[.75rem]">
				{heroes.map((s) => (
					<Hero key={s.label} {...s} />
				))}
			</div>
			<div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-[.75rem]">
				{rest.map((s) => (
					<Stat key={s.label} label={s.label} value={s.value} unit={s.unit} />
				))}
			</div>
		</div>
	);
}
