// Benchmark: Hive vs a (generous) centralised controller as comms degrade. Data from
// engine/sim/benchmark.ts -> engine/sim/results.json (regenerate, rebuild, it updates here).
import results from "@mfc/engine/results";
import { twMerge } from "tailwind-merge";
import PanelBase from "./PanelBase";

type Row = { scenario: string; results: { hive: number; central: number } };

const round = (v: number) => Math.round(Math.max(0, Math.min(100, v)));

export default function () {
	const rows = (results as { rows: Row[] }).rows;
	// The headline: the harshest comms where the central controller still had a link to lose.
	const worst = rows.reduce((b, r) => (r.results.hive - r.results.central > b.results.hive - b.results.central ? r : b));

	return (
		<PanelBase index="05" title="Benchmark · % of the fire edge mapped (8 drones, 3 seeds, 60 s)" className="mx-[.75rem] mb-[.75rem]">
			<div className="flex flex-col lg:flex-row lg:items-end gap-[1.5rem] pb-[1.25rem] border-b border-line">
				<p className="font-display text-[4.5rem] leading-none tracking-[-0.04em] tabular-nums text-flock">
					{round(worst.results.hive)}
					<span className="text-[2rem] opacity-70">%</span>
				</p>
				<p className="font-display text-[2.5rem] leading-none tracking-[-0.03em] tabular-nums text-mute">
					vs {round(worst.results.central)}%
				</p>
				<p className="text-[1rem] text-white leading-relaxed text-pretty lg:max-w-[28rem]">
					With <span className="text-ember">{worst.scenario.toLowerCase()}</span>, the leaderless flock still maps{" "}
					{round(worst.results.hive)}% of the fire edge. A central controller with perfect information manages{" "}
					{round(worst.results.central)}%.
				</p>
			</div>
			<div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-[.75rem]">
				{rows.map((r) => {
					const delta = round(r.results.hive) - round(r.results.central);
					return (
						<div key={r.scenario} className="flex flex-col gap-[.5rem] p-[1rem] rounded-[1rem] bg-ink border border-line">
							<p className="text-[.875rem] text-mute leading-snug min-h-[2.5rem]">{r.scenario}</p>
							<p className="font-display text-[2.25rem] leading-none tracking-[-0.03em] tabular-nums text-flock">
								{round(r.results.hive)}
								<span className="text-[1rem] opacity-70">%</span>
							</p>
							<p className="text-[.875rem] text-mute tabular-nums">central {round(r.results.central)}%</p>
							<p className={twMerge("self-start px-[.6rem] py-[.1rem] rounded-full text-[.875rem] tabular-nums", delta > 0 ? "bg-flock text-ink" : "bg-line text-mute")}>
								{delta > 0 ? `+${delta}` : delta} pts
							</p>
						</div>
					);
				})}
			</div>
			<p className="text-[.875rem] text-mute">Hive is leaderless: no drone and no ground station is in charge. The central controller sees everything but loses its drones when the link drops.</p>
		</PanelBase>
	);
}
