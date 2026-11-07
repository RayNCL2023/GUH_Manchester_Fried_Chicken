"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import FireLive from "@/lib/hive/fireLive";
import ServerFireLive from "@/lib/hive/serverFireLive";
import { httpBase, serverUrl } from "@/lib/hive/server";
import type { WorldView } from "../../../../shared/types";
import VoiceBar from "./VoiceBar";
import useLive from "@/lib/hive/useLive";
import type { LoadedArea } from "@/lib/hive/osm";
import useArea from "@/lib/hive/useArea";
import { SEGMENT, SEGMENT_ITEM } from "@/lib/hive/ui";
import { C, MODE_COLOR, agentState } from "@/lib/hive/pixel";
import { LEGEND_COLORS } from "@/lib/hive/mapStyle";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import AreaBar from "./AreaBar";
import DemoLayout from "./DemoLayout";
import FireMap, { MAP_CELL, type Tool } from "./FireMap";
import { SAT_ATTRIBUTION } from "@/lib/hive/satellite";

const LEGEND = {
	pixel: [
		{ label: "Fire", color: C.fire },
		{ label: "Buildings", color: LEGEND_COLORS.buildings },
		{ label: "Roads", color: LEGEND_COLORS.roads },
		{ label: "Water", color: LEGEND_COLORS.water },
		{ label: "Green", color: LEGEND_COLORS.green },
		{ label: "Flock", color: C.flock },
		{ label: "Isolated", color: C.mute },
	],
	satellite: [
		{ label: "Fire", color: C.fire },
		{ label: "Road firebreak", color: "#f5d266" },
		{ label: "Water firebreak", color: "#6ec8ff" },
		{ label: "Flock", color: C.flock },
		{ label: "Isolated", color: C.mute },
	],
};

type MapView = "satellite" | "pixel";
const MAP_VIEWS: { id: MapView; label: string }[] = [
	{ id: "satellite", label: "Satellite" },
	{ id: "pixel", label: "Pixel map" },
];


function FireScene({ area, satellite }: { area: LoadedArea; satellite: HTMLCanvasElement | null }) {
	const { snap, act } = useLive(() => {
		const url = serverUrl();
		return url ? new ServerFireLive(url, area) : new FireLive(area);
	});
	const [tool, setTool] = useState<Tool>("ignite");
	const [mapView, setMapView] = useState<MapView>("satellite");
	const [showGrid, setShowGrid] = useState(true);
	const [http, setHttp] = useState<string | null>(null);
	useEffect(() => {
		const url = serverUrl();
		setHttp(url ? httpBase(url) : null);
	}, []);
	const viewRef = useRef<WorldView | null>(null);
	if (!snap) {
		return null;
	}
	viewRef.current = snap.view;
	const source = "source" in snap ? snap.source : "sim";

	const { view } = snap;
	const selected = view.inspected?.id ?? null;
	const inspect = (id: string | null) => act((w) => w.control({ type: "inspect", id }));
	// The server's world has no real geography, so satellite only applies to the offline sim.
	const sat = source === "sim" && mapView === "satellite" ? satellite : null;
	const legend = sat ? LEGEND.satellite : LEGEND.pixel;
	const tools: { id: Tool; label: string }[] = [
		{ id: "ignite", label: "Start fire" },
		{ id: "jam", label: "Draw jam" },
	];

	const controls = (
		<>
			<div className={SEGMENT}>
				{tools.map((t) => (
					<button
						key={t.id}
						onClick={() => setTool(t.id)}
						data-on={tool === t.id}
						className={`${SEGMENT_ITEM} data-[on=true]:bg-fire data-[on=true]:text-ink`}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className={SEGMENT}>
				{MAP_VIEWS.map((m) => (
					<button
						key={m.id}
						onClick={() => setMapView(m.id)}
						data-on={mapView === m.id}
						className={`${SEGMENT_ITEM} data-[on=true]:bg-white data-[on=true]:text-ink`}
					>
						{m.label}
					</button>
				))}
			</div>
			{sat && (
				<ButtonBase onClick={() => setShowGrid((g) => !g)} className={showGrid ? "border-flock" : "text-mute"}>
					Fire grid {showGrid ? "on" : "off"}
				</ButtonBase>
			)}
			<ButtonBase onClick={() => act((w) => w.protectBuildings())}>Protect the buildings</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.rotateWind())}>Rotate wind 45°</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.control({ type: "clearJams" }))}>Clear jams</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.control({ type: "reset" }))}>Reset</ButtonBase>
			<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1.1rem] rounded-full border border-line text-[.875rem] text-mute">
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
			<p className="text-[.875rem] text-mute xl:ml-auto">
				Click a drone for its view · shift-click to kill · map data © OpenStreetMap contributors
				{sat && ` · ${SAT_ATTRIBUTION}`}
			</p>
			<div className="w-full pt-[.5rem]">
				<VoiceBar
					getView={() => viewRef.current}
					http={source === "server" ? http : null}
					injectGoal={(body) => act((w) => w.control({ type: "goal", body }))}
				/>
			</div>
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
					<span className={source === "server" ? "text-flock" : "text-mute"}>
						{source === "server" ? "● Live · drones are separate devices" : "○ Offline sim · all drones in this tab"}
					</span>
					{selected
						? `What ${selected} believes · unknown cells dimmed`
						: source === "server"
							? "Server map"
							: `${area.name} · ${area.mPerCell.toFixed(1)} m per cell`}
					{legend.map((l) => (
						<span key={l.label} className="flex flex-row items-center gap-[.4rem]">
							<span className="size-[.6rem] rounded-full" style={{ background: l.color }} />
							{l.label}
						</span>
					))}
				</span>
			}
			canvas={
				<FireMap
					view={view}
					terrain={snap.terrain}
					satellite={sat}
					showGrid={showGrid}
					tool={tool}
					onIgnite={(at) => act((w) => w.ignite(at))}
					selected={selected}
					onSelect={inspect}
					onKill={(id) => act((w) => w.control({ type: "killAgent", id }))}
					onJam={(center, radius) => act((w) => w.control({ type: "addJam", center, radius }))}
					className="max-h-[calc(100vh-17rem)] w-auto self-center"
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

export default function () {
	const { area, satellite, status, pick, search } = useArea(MAP_CELL);

	return (
		<>
			<AreaBar current={area?.id} status={status} onPreset={pick} onSearch={search} />
			{area && <FireScene key={`${area.id}:${area.mPerCell}`} area={area} satellite={satellite} />}
		</>
	);
}
