import type { Chatter, StatItem } from "@/lib/hive/types";
import JoinPanel from "./JoinPanel";
import PanelBase from "./PanelBase";
import Sparkline from "./Sparkline";
import Stat from "./Stat";

// Shared shell for every live scenario: canvas left, numbers right, stat strip below.
export default function ({
	title,
	canvas,
	controls,
	headline,
	history,
	sideTitle,
	side,
	chatter,
	stats,
}: {
	title: React.ReactNode;
	canvas: React.ReactNode;
	controls: React.ReactNode;
	headline: { label: string; value: number };
	history: number[];
	sideTitle: string;
	side: React.ReactNode;
	chatter: Chatter[];
	stats: StatItem[];
}) {
	return (
		<div className="flex flex-col gap-[.75rem] p-[.75rem]">
			<div className="grid grid-cols-1 xl:grid-cols-[1fr_25rem] gap-[.75rem]">
				<PanelBase index="01" title={title}>
					{canvas}
					<div className="flex flex-row flex-wrap items-center gap-[.5rem]">{controls}</div>
				</PanelBase>

				<div className="flex flex-col gap-[.75rem]">
					<JoinPanel />
					<PanelBase index="02" title={headline.label}>
						<p className="font-display text-[4rem] leading-none tracking-[-0.04em] tabular-nums text-white">
							{headline.value}
							<span className="text-mute text-[1.75rem] ml-[.25rem]">%</span>
						</p>
						<Sparkline values={history} className="h-[4.5rem]" />
					</PanelBase>
					<PanelBase index="03" title={sideTitle}>
						{side}
					</PanelBase>
					<PanelBase index="04" title="Radio" className="flex-1">
						<ul className="flex flex-col gap-[.6rem]">
							{chatter.length === 0 && <li className="text-[.875rem] text-mute">Quiet on the net.</li>}
							{chatter.map((c, i) => (
								<li key={`${c.tick}-${i}`} className="grid grid-cols-[3.5rem_4rem_1fr] gap-[.5rem] text-[.875rem] leading-relaxed">
									<span className="text-mute tabular-nums">t{c.tick}</span>
									<span className="text-flock">{c.from}</span>
									<span className="text-white">{c.line}</span>
								</li>
							))}
						</ul>
					</PanelBase>
				</div>
			</div>

			<div className="grid grid-cols-2 md:grid-cols-4 2xl:grid-cols-8 gap-[.75rem]">
				{stats.map((s) => (
					<Stat key={s.label} {...s} />
				))}
			</div>
		</div>
	);
}
