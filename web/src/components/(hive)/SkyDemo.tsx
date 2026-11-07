"use client";

import SkyLive from "@/lib/hive/skyLive";
import useLive from "@/lib/hive/useLive";
import { PICTURES } from "@/lib/hive/pixel";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import DemoLayout from "./DemoLayout";
import PixelArt from "./PixelArt";
import SkyCanvas from "./SkyCanvas";

export default function () {
	const { snap, act } = useLive(() => new SkyLive());
	if (!snap) {
		return null;
	}

	const controls = (
		<>
			<ButtonBase onClick={() => act((w) => w.setMission(snap.mission + 1))}>Next picture</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.clearJams())}>Clear jams</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.reset())}>Relaunch</ButtonBase>
			<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1rem] border border-line text-[.875rem] text-mute">
				Loss
				<input
					type="range"
					min={0}
					max={90}
					step={10}
					value={snap.stats.find((s) => s.label === "Message loss")?.value ?? 0}
					onChange={(e) => act((w) => (w.lossPct = Number(e.target.value)))}
					className="accent-[#5aa9ff]"
				/>
			</label>
			<p className="text-[.875rem] text-mute xl:ml-auto">
				Drag to jam · click a drone to take it down · jammed drones keep the last picture they heard
			</p>
		</>
	);

	const missions = (
		<div className="grid grid-cols-3 gap-[.5rem]">
			{PICTURES.map((p, i) => (
				<button
					key={p.name}
					onClick={() => act((w) => w.setMission(i))}
					className="flex flex-col items-center gap-[.75rem] p-[1rem] bg-transparent border border-line hover:border-mute data-[on=true]:border-flock"
					data-on={i === snap.mission}
				>
					<PixelArt art={p.art} size=".3rem" />
					<span className="text-[.875rem] text-white">{p.name}</span>
				</button>
			))}
		</div>
	);

	return (
		<DemoLayout
			title="Flock show · Manchester skyline"
			canvas={
				<SkyCanvas
					snap={snap}
					onKill={(id) => act((w) => w.kill(id))}
					onJam={(center, radius) => act((w) => w.addJam(center, radius))}
					className="max-h-[calc(100vh-13rem)] w-auto self-center"
				/>
			}
			controls={controls}
			headline={{ label: "Picture formed", value: snap.headline }}
			history={snap.history}
			sideTitle="Mission"
			side={missions}
			chatter={snap.chatter}
			stats={snap.stats}
		/>
	);
}
