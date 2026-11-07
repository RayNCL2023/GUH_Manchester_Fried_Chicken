"use client";

import SkyLive from "@/lib/hive/skyLive";
import useLive from "@/lib/hive/useLive";
import { SHOWS } from "@/lib/hive/shows";
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
			<ButtonBase onClick={() => act((w) => w.launch(snap.show + 1))}>Send next show</ButtonBase>
			<ButtonBase
				onClick={() => act((w) => (w.autoplay = !w.autoplay))}
				className={snap.autoplay ? "border-flock text-white" : "text-mute"}
			>
				Autoplay {snap.autoplay ? "on" : "off"}
			</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.clearJams())}>Clear jams</ButtonBase>
			<ButtonBase onClick={() => act((w) => w.reset())}>Relaunch</ButtonBase>
			<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1.1rem] rounded-full border border-line text-[.875rem] text-mute">
				Loss
				<input
					type="range"
					min={0}
					max={90}
					step={10}
					value={snap.lossPct}
					onChange={(e) => act((w) => (w.lossPct = Number(e.target.value)))}
					className="accent-[#5aa9ff]"
				/>
			</label>
			<p className="text-[.875rem] text-mute leading-relaxed xl:ml-auto xl:max-w-[30rem] xl:text-right">
				Drag to jam, click a drone to take it down. New shows spread drone to drone. Jammed drones only whisper to close neighbours,
				and keep dancing their last show on the shared clock (dashed ring).
			</p>
		</>
	);

	const shows = (
		<div className="grid grid-cols-3 gap-[.5rem]">
			{SHOWS.map((s, i) => (
				<button
					key={s.name}
					onClick={() => act((w) => w.launch(i))}
					className="flex flex-col items-center justify-between gap-[.75rem] p-[1rem] rounded-[1rem] bg-ink border border-line hover:border-mute data-[on=true]:border-flock"
					data-on={i === snap.show}
				>
					<PixelArt art={s.thumb} size=".3rem" />
					<span className="text-[.875rem] text-white">{s.name}</span>
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
			headline={{ label: "Show formed", value: snap.headline }}
			history={snap.history}
			sideTitle="Shows · click to send"
			side={shows}
			chatter={snap.chatter}
			stats={snap.stats}
		/>
	);
}
