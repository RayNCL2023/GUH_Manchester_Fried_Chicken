"use client";

import { useEffect, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import type FireLive from "@/lib/hive/fireLive";
import type { FireSnap } from "@/lib/hive/fireLive";
import type { LoadedArea } from "@/lib/hive/osm";
import useGroundControl, { type ChatRow } from "@/lib/hive/agent/useGroundControl";
import PanelBase from "./PanelBase";
import PillBase from "@/components/(pills)/PillBase";

const QUICK = [
	"Status report",
	"Is anyone dark?",
	"There's a fire at the Alan Turing Building, send drones",
	"Send the water drones to the Kilburn Building",
	"Simulate a fire at the Schuster Building",
];

const ROLE: Record<ChatRow["role"], { who: string; tone: string }> = {
	user: { who: "You", tone: "text-white" },
	agent: { who: "Ground", tone: "text-flock" },
	tool: { who: "Tool", tone: "text-mute" },
	antenna: { who: "Antenna", tone: "text-amber" },
	system: { who: "·", tone: "text-mute" },
};

const LINK_TONE = { direct: "bg-flock text-ink", relay: "bg-amber text-ink", dark: "bg-line text-mute" };

function Chat({ rows }: { rows: ChatRow[] }) {
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		box.current?.scrollTo({ top: box.current.scrollHeight });
	}, [rows.length]);
	return (
		<div ref={box} data-lenis-prevent className="flex flex-col gap-[.6rem] h-[22rem] overflow-y-auto pr-[.5rem]">
			{rows.length === 0 && (
				<p className="text-[.875rem] text-mute leading-relaxed">
					Connect and talk to the antenna. It only knows what the drones radio down to it, and it can send orders back up through
					the mesh.
				</p>
			)}
			{rows.map((r) => (
				<p key={r.id} className={twMerge("grid grid-cols-[4.5rem_1fr] gap-[.5rem] text-[.875rem] leading-relaxed", r.role === "tool" && "opacity-70")}>
					<span className={ROLE[r.role].tone}>{ROLE[r.role].who}</span>
					<span className={r.role === "agent" || r.role === "user" ? "text-white" : ROLE[r.role].tone}>{r.text}</span>
				</p>
			))}
		</div>
	);
}

export default function ({
	area,
	snap,
	world,
	act,
}: {
	area: LoadedArea;
	snap: FireSnap | null;
	world: React.RefObject<FireLive | null>;
	act: (fn: (w: FireLive) => void) => void;
}) {
	const gc = useGroundControl({ area, snap, world, act });
	const [text, setText] = useState("");
	const st = snap?.station;
	const live = gc.status === "connected";

	if (!area.antenna) {
		return (
			<PanelBase index="02" title="Ground Control">
				<p className="text-[.875rem] text-mute">No ground station on searched maps. Pick a preset to put the antenna on a landmark roof.</p>
			</PanelBase>
		);
	}

	const submit = (t: string) => {
		gc.send(t);
		setText("");
	};

	return (
		<div className="grid grid-cols-1 xl:grid-cols-[1fr_25rem] gap-[.75rem]">
			<PanelBase
				index="02"
				title={`Ground Control · voice agent on the ${area.antenna.name} antenna`}
				aside={
					<div className="flex flex-row flex-wrap items-center gap-[.5rem]">
						<PillBase className={live ? "border-flock text-flock" : "text-mute"}>
							<span className={twMerge("size-[.5rem] rounded-full bg-mute", live && "bg-flock animate-pulse")} />
							{live ? (gc.mode === "speaking" ? "Speaking" : "Listening") : gc.status === "connecting" ? "Connecting" : "Offline"}
						</PillBase>
						{live ? (
							<>
								<ButtonBase onClick={gc.toggleMute} className={gc.muted ? "text-mute" : "border-flock"}>
									Mic {gc.muted ? "off" : "on"}
								</ButtonBase>
								<ButtonBase onClick={gc.stop}>End</ButtonBase>
							</>
						) : (
							<>
								<ButtonBase onClick={() => gc.start(false)} className="bg-white text-ink border-white">
									Talk to Ground Control
								</ButtonBase>
								<ButtonBase onClick={() => gc.start(true)}>Text only</ButtonBase>
							</>
						)}
					</div>
				}
			>
				<Chat rows={gc.rows} />
				{gc.error && <p className="text-[.875rem] text-ember">{gc.error}</p>}
				<div className="flex flex-row flex-wrap gap-[.5rem]">
					{QUICK.map((q) => (
						<button key={q} onClick={() => submit(q)} disabled={!live} className="min-h-[2.75rem] px-[1rem] rounded-full border border-line text-[.875rem] text-mute hover:text-white hover:border-mute disabled:opacity-40">
							{q}
						</button>
					))}
				</div>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit(text);
					}}
					className="flex flex-row gap-[.5rem]"
				>
					<input
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={live ? "Type to Ground Control, or just talk" : "Connect first"}
						className="flex-1 min-h-[2.75rem] px-[1.1rem] rounded-full border border-line bg-ink text-[1rem] text-white placeholder:text-mute outline-none focus:border-mute"
					/>
					<ButtonBase type="submit" disabled={!live}>
						Send
					</ButtonBase>
					<ButtonBase type="button" onClick={gc.clear} className="text-mute">
						Clear
					</ButtonBase>
				</form>
				<label className="flex flex-row items-center gap-[.5rem] text-[.875rem] text-mute">
					<input type="checkbox" checked={gc.autoReport} onChange={(e) => gc.setAutoReport(e.target.checked)} className="accent-[#5aa9ff]" />
					Speak up on its own when the antenna hears something urgent
				</label>
			</PanelBase>

			<PanelBase index="03" title={`Antenna · ${area.antenna.name}`}>
				{st && (
					<>
						<div className="flex flex-row items-end justify-between gap-[1rem]">
							<p className={twMerge("font-display text-[2.5rem] leading-none tracking-[-0.03em]", st.jammed ? "text-ember" : "text-white")}>
								{st.jammed ? "Jammed" : `${st.direct + st.relay}/${snap.view.agents.length}`}
							</p>
							<p className="text-[.875rem] text-mute text-right">
								{st.jammed ? "Hearing nothing. The flock keeps working on its own." : `${st.direct} direct · ${st.relay} via mesh relay`}
							</p>
						</div>
						<div className="flex flex-row flex-wrap gap-[.35rem]">
							{snap.view.agents.map((a) => {
								const l = st.links[a.id] ?? "dark";
								return (
									<span key={a.id} title={l} className={twMerge("px-[.5rem] py-[.15rem] rounded-full text-[.875rem] tabular-nums", LINK_TONE[l])}>
										{a.id}
									</span>
								);
							})}
						</div>
						<ul data-lenis-prevent className="flex flex-col gap-[.4rem] h-[12rem] overflow-y-auto">
							{st.events.length === 0 && <li className="text-[.875rem] text-mute">Quiet. Drop a jammer between the antenna and the flock.</li>}
							{[...st.events].reverse().map((e) => (
								<li key={e.n} className="grid grid-cols-[3.5rem_1fr] gap-[.5rem] text-[.875rem] leading-relaxed">
									<span className="text-mute tabular-nums">{Math.floor(e.tick / 10)}s</span>
									<span className={e.alert ? "text-amber" : "text-white"}>{e.text}</span>
								</li>
							))}
						</ul>
					</>
				)}
			</PanelBase>
		</div>
	);
}
