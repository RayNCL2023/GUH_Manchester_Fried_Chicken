"use client";

import { Fragment } from "react";
import FireLive from "@/lib/hive/fireLive";
import useLive from "@/lib/hive/useLive";
import { C, MODE_COLOR, agentState } from "@/lib/hive/pixel";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import DemoLayout from "./DemoLayout";
import FireMap from "./FireMap";

const LEGEND = [
	{ label: "Fire", color: C.fire },
	{ label: "Burnt", color: "#3a1f16" },
	{ label: "Village", color: "#e9e4d8" },
	{ label: "Flock", color: C.flock },
	{ label: "Relay", color: C.text },
	{ label: "Isolated", color: C.mute },
];

export default function () {
	const { snap, act } = useLive(() => new FireLive());
	if (!snap) {
		return null;
	}

	const { view } = snap;
	const selected = view.inspected?.id ?? null;
	const inspect = (id: string | null) => act((w) => w.control({ type: "inspect", id }));

	const controls = (
		<>
			<ButtonBase onClick={() => act((w) => w.protectVillage())}>Protect the village</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.rotateWind())}>Rotate wind 45°</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.control({ type: "clearJams" }))}>Clear jams</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.control({ type: "reset" }))}>Reset</ButtonBase>
			<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1rem] border border-line text-[.875rem] text-mute">
				Loss
				<input
					type="range"
					min={0}
					max={90}
					step={10}
					value={view.metrics.msgLossPct}
					onChange={(e) => act((w) => w.control({ type: "setLoss", pct: Number(e.target.value) }))}
					className="accent-[#5aa9ff]"
				/>
				<span className="text-white tabular-nums">{view.metrics.msgLossPct}%</span>
			</label>
			<p className="text-[.875rem] text-mute xl:ml-auto">Drag to jam · click a drone for its view · shift-click to kill</p>
		</>
	);

	const roster = (
		<div className="grid grid-cols-[1fr_auto_auto] gap-x-[1.5rem] gap-y-[.4rem] text-[.875rem] tabular-nums">
			<span className="text-mute">Callsign</span>
			<span className="text-mute">State</span>
			<span className="text-mute text-right">Map known</span>
			{view.agents.map((a) => (
				<Fragment key={a.id}>
					<button onClick={() => inspect(a.id === selected ? null : a.id)} className="text-left bg-transparent text-white hover:text-flock">
						{a.id === selected ? `▸ ${a.id}` : a.id}
					</button>
					<span style={{ color: MODE_COLOR[agentState(a)] }}>{agentState(a)}</span>
					<span className="text-right">{a.knownPct}%</span>
				</Fragment>
			))}
		</div>
	);

	return (
		<DemoLayout
			title={
				<span className="flex flex-row flex-wrap gap-x-[1.5rem] gap-y-[.5rem]">
					{selected ? `What ${selected} believes · unknown cells dimmed` : "Firebreak · Saddleworth Moor"}
					{LEGEND.map((l) => (
						<span key={l.label} className="flex flex-row items-center gap-[.4rem]">
							<span className="size-[.6rem]" style={{ background: l.color }} />
							{l.label}
						</span>
					))}
				</span>
			}
			canvas={
				<FireMap
					view={view}
					selected={selected}
					onSelect={inspect}
					onKill={(id) => act((w) => w.control({ type: "killAgent", id }))}
					onJam={(center, radius) => act((w) => w.control({ type: "addJam", center, radius }))}
					className="max-h-[calc(100vh-13rem)] w-auto self-center"
				/>
			}
			controls={controls}
			headline={{ label: "Fire edge mapped", value: snap.headline }}
			history={snap.history}
			sideTitle="Flock"
			side={roster}
			chatter={snap.chatter}
			stats={snap.stats}
		/>
	);
}
