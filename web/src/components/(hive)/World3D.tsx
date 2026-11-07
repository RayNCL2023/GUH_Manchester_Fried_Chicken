"use client";

import { useEffect, useRef, useState } from "react";
import FireLive, { SENSOR } from "@/lib/hive/fireLive";
import useArea from "@/lib/hive/useArea";
import useLive from "@/lib/hive/useLive";
import type { LoadedArea } from "@/lib/hive/osm";
import { C, MODE_COLOR, agentState } from "@/lib/hive/pixel";
import Engine, { type CamMode, type GroundMode } from "@/lib/hive/three/engine";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import AreaBar from "./AreaBar";
import Segment from "./Segment";
import { MAP_CELL } from "./FireMap";

const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
const JAM_RADIUS = 8;

type Tool = "ignite" | "jam" | "look";

const TOOLS: { id: Tool; label: string }[] = [
	{ id: "ignite", label: "Start fire" },
	{ id: "jam", label: "Drop jammer" },
	{ id: "look", label: "Look" },
];

const GROUNDS: { id: GroundMode; label: string; disabled?: boolean }[] = [
	{ id: "photoreal", label: "Photoreal 3D", disabled: !GOOGLE_KEY },
	{ id: "blocks", label: "OSM blocks" },
];

const LEGEND = [
	{ label: "Fire", color: C.fire },
	{ label: "Flock", color: C.flock },
	{ label: "Isolated", color: C.mute },
	{ label: "Jammer", color: C.ember },
];

function Scene({ area, satellite }: { area: LoadedArea; satellite: HTMLCanvasElement | null }) {
	const { snap, act } = useLive(() => new FireLive(area));
	const host = useRef<HTMLDivElement>(null);
	const engine = useRef<Engine | null>(null);
	const [tool, setTool] = useState<Tool>("ignite");
	const [cam, setCam] = useState<CamMode>("orbit");
	const [ground, setGround] = useState<GroundMode>(GOOGLE_KEY ? "photoreal" : "blocks");
	const [selected, setSelected] = useState<string | null>(null);
	const [traffic, setTraffic] = useState(true);
	const [status, setStatus] = useState({ credits: "", groundError: "", heightsReady: false, cars: 0 });

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
			{ googleKey: GOOGLE_KEY, ground, satellite, sensorCells: SENSOR },
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
						act((w) => w.control({ type: "addJam", center: cell, radius: JAM_RADIUS }));
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
		// Ground mode switches in place below; the engine is per area.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [area]);

	useEffect(() => {
		if (snap) {
			engine.current?.setView(snap.view);
		}
	}, [snap]);

	useEffect(() => engine.current?.setGround(ground), [ground]);
	useEffect(() => engine.current?.setSatellite(satellite), [satellite]);
	useEffect(() => engine.current?.setSelected(selected), [selected]);
	useEffect(() => engine.current?.setTraffic(traffic), [traffic]);
	useEffect(() => engine.current?.setCamera(selected ? cam : "orbit"), [cam, selected]);

	// Photoreal failed (quota, key restrictions, offline): fall back to blocks.
	useEffect(() => {
		if (status.groundError && ground === "photoreal") {
			setGround("blocks");
		}
	}, [status.groundError, ground]);

	const view = snap?.view;
	const sel = view?.agents.find((a) => a.id === selected);
	const cams: { id: CamMode; label: string; disabled?: boolean }[] = [
		{ id: "orbit", label: "Orbit" },
		{ id: "follow", label: "Chase", disabled: !selected },
		{ id: "drone", label: "Drone's eye", disabled: !selected },
	];

	return (
		<div className="flex flex-col gap-[.75rem] p-[.75rem]">
			<div className="relative w-full h-[calc(100vh-15rem)] min-h-[28rem] rounded-[1.25rem] overflow-hidden border border-line bg-panel">
				<div ref={host} className="absolute inset-0" />
				<div className="absolute top-[1rem] left-[1rem] flex flex-row flex-wrap items-center gap-[1rem] px-[1rem] py-[.5rem] rounded-full bg-ink/80 text-[.875rem] pointer-events-none">
					<span>{area.name}</span>
					{LEGEND.map((l) => (
						<span key={l.label} className="flex flex-row items-center gap-[.4rem] text-mute">
							<span className="size-[.6rem] rounded-full" style={{ background: l.color }} />
							{l.label}
						</span>
					))}
					{!status.heightsReady && <span className="text-amber">Mapping terrain…</span>}
				</div>
				{sel && cam !== "drone" && (
					<p className="absolute top-[1rem] right-[1rem] px-[.75rem] py-[.25rem] rounded-full bg-ink/80 text-[.875rem] pointer-events-none">
						<span style={{ color: MODE_COLOR[agentState(sel)] }}>{sel.id}</span> · looking down · {sel.knownPct}% map known
					</p>
				)}
				<p className="absolute left-[1rem] bottom-[.75rem] max-w-[60%] text-[.875rem] text-white/80 [text-shadow:0_0_.4rem_#000] pointer-events-none">
					{status.credits}
					{status.groundError && ` · Photoreal unavailable: ${status.groundError}`}
				</p>
			</div>

			<div className="flex flex-row flex-wrap items-center gap-[.75rem]">
				<Segment items={TOOLS} value={tool} onChange={setTool} on="data-[on=true]:bg-fire data-[on=true]:text-ink" />
				<Segment items={GROUNDS} value={ground} onChange={setGround} />
				<Segment items={cams} value={selected ? cam : "orbit"} onChange={setCam} />
				<ButtonBase onClick={() => setTraffic((t) => !t)} className={traffic ? "border-flock" : "text-mute"}>
					Traffic {traffic ? `on · ${status.cars}` : "off"}
				</ButtonBase>
				<ButtonBase onClick={() => act((w) => w.protectBuildings())}>Protect the buildings</ButtonBase>
				<ButtonBase onClick={() => act((w) => w.rotateWind())}>Rotate wind 45°</ButtonBase>
				<ButtonBase onClick={() => act((w) => w.control({ type: "clearJams" }))}>Clear jams</ButtonBase>
				<ButtonBase
					onClick={() => {
						act((w) => w.control({ type: "reset" }));
						engine.current?.reset();
					}}
				>
					Reset
				</ButtonBase>
				<p className="text-[.875rem] text-mute xl:ml-auto">
					Click a drone to ride along · shift-click to kill · drag to orbit · {view?.metrics.aliveAgents ?? 0} drones up
				</p>
			</div>
		</div>
	);
}

export default function () {
	const { area, satellite, status, pick, search } = useArea(MAP_CELL);

	return (
		<>
			<AreaBar current={area?.id} status={status} onPreset={pick} onSearch={search} />
			{area && <Scene key={`${area.id}:${area.mPerCell}`} area={area} satellite={satellite} />}
		</>
	);
}
