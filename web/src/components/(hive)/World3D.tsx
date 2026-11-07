"use client";

import { useEffect, useRef, useState } from "react";
import FireLive, { JAM_M } from "@/lib/hive/fireLive";
import useArea from "@/lib/hive/useArea";
import useLive from "@/lib/hive/useLive";
import type { LoadedArea } from "@/lib/hive/osm";
import { C, MODE_COLOR, agentState } from "@/lib/hive/pixel";
import Engine, { type CamMode } from "@/lib/hive/three/engine";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import AreaBar from "./AreaBar";
import GroundControl from "./GroundControl";
import Segment from "./Segment";
import StatBoard from "./StatBoard";
import { MAP_CELL } from "./FireMap";

const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;

type Tool = "ignite" | "jam" | "look";

const TOOLS: { id: Tool; label: string }[] = [
	{ id: "ignite", label: "Start fire" },
	{ id: "jam", label: "Drop jammer" },
	{ id: "look", label: "Look" },
];

const LEGEND = [
	{ label: "Fire", color: C.fire },
	{ label: "Echo flock", color: C.flock },
	{ label: "Sky scouts", color: C.glow },
	{ label: "Water", color: C.water },
	{ label: "Isolated", color: C.mute },
	{ label: "Jammer", color: C.ember },
	{ label: "Goal msg", color: C.amber },
];
const ANTENNA_LEGEND = { label: "Antenna", color: C.flock };

function Scene({ area, googleKey }: { area: LoadedArea; googleKey: string }) {
	const { snap, act, world } = useLive(() => new FireLive(area));
	const host = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLDivElement>(null);
	const engine = useRef<Engine | null>(null);
	const [tool, setTool] = useState<Tool>("ignite");
	const [cam, setCam] = useState<CamMode>("orbit");
	const [selected, setSelected] = useState<string | null>(null);
	const [traffic, setTraffic] = useState(true);
	const [status, setStatus] = useState({ credits: "", groundError: "", heightsReady: false, loading: 0, cars: 0 });

	// The engine's click handlers outlive renders; read the latest tool through a ref.
	const toolRef = useRef(tool);
	toolRef.current = tool;

	useEffect(() => {
		if (!host.current) {
			return;
		}
		const e = new Engine(
			host.current,
			area,
			googleKey,
			{
				pickDrone: (id, shift) => {
					if (shift) {
						act((w) => w.control({ type: "killAgent", id }));
						return;
					}
					setSelected((s) => (s === id ? null : id));
				},
				pickGround: (cell) => {
					if (toolRef.current === "ignite") {
						act((w) => w.ignite(cell));
					} else if (toolRef.current === "jam") {
						act((w) => w.control({ type: "addJam", center: cell, radius: JAM_M / area.mPerCell }));
					}
				},
				status: (s) =>
					setStatus((prev) => ({ ...prev, ...s, groundError: s.groundError ?? prev.groundError })),
			},
		);
		engine.current = e;
		return () => {
			e.dispose();
			engine.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [area]);

	// The whole map frame (canvas, overlays, loading cover) swallows the wheel so the page never scrolls.
	// Lenis drives page scroll from window wheel events and ignores preventDefault, hence data-lenis-prevent
	// on the frame; the native listener covers plain browser scroll. (React's onWheel is passive.)
	useEffect(() => {
		const el = frame.current;
		if (!el) {
			return;
		}
		const block = (e: WheelEvent) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		return () => el.removeEventListener("wheel", block);
	}, []);

	useEffect(() => {
		if (snap) {
			engine.current?.setView(snap.view, snap.units, snap.radio);
			engine.current?.setAntennaJammed(!!snap.station?.jammed);
		}
	}, [snap]);

	useEffect(() => engine.current?.setSelected(selected), [selected]);
	useEffect(() => engine.current?.setTraffic(traffic), [traffic]);
	useEffect(() => engine.current?.setCamera(selected ? cam : "orbit"), [cam, selected]);

	const view = snap?.view;
	const sel = view?.agents.find((a) => a.id === selected);
	const selUnit = selected ? snap?.units[selected] : undefined;
	const cams: { id: CamMode; label: string; disabled?: boolean }[] = [
		{ id: "orbit", label: "Orbit" },
		{ id: "follow", label: "Chase", disabled: !selected },
		{ id: "drone", label: "Drone's eye", disabled: !selected },
	];

	return (
		<div className="flex flex-col gap-[.75rem] p-[.75rem]">
			<div ref={frame} data-lenis-prevent className="relative w-full h-[calc(100vh-15rem)] min-h-[28rem] rounded-[1.25rem] overflow-hidden overscroll-contain border border-line bg-panel">
				<div ref={host} className="absolute inset-0" />
				{!status.heightsReady && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-[.5rem] bg-panel text-mute">
						<p className="text-white">{status.groundError ? "Google 3D tiles unavailable" : "Loading 3D world…"}</p>
						<p className="text-[.875rem]">{status.groundError || `Streaming Google 3D tiles · ${Math.round(status.loading * 100)}%`}</p>
					</div>
				)}
				<div className="absolute top-[1rem] left-[1rem] flex flex-row flex-wrap items-center gap-[1rem] px-[1rem] py-[.5rem] rounded-full bg-ink/80 text-[.875rem] pointer-events-none">
					<span>{area.name}</span>
					{(area.antenna ? [...LEGEND, ANTENNA_LEGEND] : LEGEND).map((l) => (
						<span key={l.label} className="flex flex-row items-center gap-[.4rem] text-mute">
							<span className="size-[.6rem] rounded-full" style={{ background: l.color }} />
							{l.label}
						</span>
					))}
				</div>
				{sel && cam !== "drone" && (
					<p className="absolute top-[1rem] right-[1rem] px-[.75rem] py-[.25rem] rounded-full bg-ink/80 text-[.875rem] pointer-events-none">
						<span style={{ color: MODE_COLOR[agentState(sel)] }}>{sel.id}</span>
						{selUnit?.phase ? ` · ${selUnit.phase}` : " · looking down"}
						{selUnit?.tank !== undefined && ` · tank ${Math.round(selUnit.tank * 100)}%`} · {sel.knownPct}% map known
					</p>
				)}
				<p className="absolute left-[1rem] bottom-[.75rem] max-w-[60%] text-[.875rem] text-white/80 [text-shadow:0_0_.4rem_#000] pointer-events-none">
					{status.credits} · Vehicles: Kenney (CC0) · Drones: NateGazzard, sftwr314r8 (CC-BY)
				</p>
			</div>

			<div className="flex flex-row flex-wrap items-center gap-[.75rem]">
				<Segment items={TOOLS} value={tool} onChange={setTool} on="data-[on=true]:bg-fire data-[on=true]:text-ink" />
				<Segment items={cams} value={selected ? cam : "orbit"} onChange={setCam} />
				<ButtonBase onClick={() => setTraffic((t) => !t)} className={traffic ? "border-flock" : "text-mute"}>
					Traffic {traffic ? `on · ${status.cars}` : "off"}
				</ButtonBase>
				<ButtonBase onClick={() => act((w) => w.rotateWind())}>Rotate wind 45°</ButtonBase>
				<ButtonBase onClick={() => act((w) => w.control({ type: "clearJams" }))}>Clear jams</ButtonBase>
				<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1.1rem] rounded-full border border-line text-[.875rem] text-mute">
					Noise loss {snap?.lossPct ?? 0}%
					<input
						type="range"
						min={0}
						max={90}
						step={10}
						value={snap?.lossPct ?? 0}
						onChange={(e) => act((w) => w.control({ type: "setLoss", pct: Number(e.target.value) }))}
						className="accent-[#5aa9ff]"
					/>
				</label>
				<ButtonBase
					onClick={() => {
						act((w) => w.control({ type: "reset" }));
						engine.current?.reset();
					}}
				>
					Reset
				</ButtonBase>
				<p className="text-[.875rem] text-mute xl:ml-auto">
					Click a drone to ride along · shift-click to kill · drag to pan · right-drag to tilt and turn · scroll to zoom · {view?.metrics.aliveAgents ?? 0} drones up
				</p>
			</div>

			<GroundControl area={area} snap={snap} world={world} act={act} />
			{snap && <StatBoard stats={snap.stats} />}
		</div>
	);
}

export default function () {
	const { area, status, pick, search } = useArea(MAP_CELL);

	return (
		<>
			<AreaBar current={area?.id} status={status} onPreset={pick} onSearch={search} />
			{!GOOGLE_KEY && (
				<p className="p-[.75rem] text-mute">The 3D world needs NEXT_PUBLIC_GOOGLE_MAPS_KEY (Google Map Tiles API) to stream photoreal tiles.</p>
			)}
			{area && GOOGLE_KEY && <Scene key={`${area.id}:${area.mPerCell}`} area={area} googleKey={GOOGLE_KEY} />}
		</>
	);
}
