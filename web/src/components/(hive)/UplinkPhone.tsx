"use client";

// Phone side of Mission Uplink. Listens to the laptop speaker, rebuilds the mission from whichever
// fountain chunks it happens to catch, relays chunks to the phones around it, then plays the show.
import { useEffect, useRef, useState } from "react";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import Stat from "./Stat";
import UplinkImage from "./UplinkImage";
import UplinkShow from "./UplinkShow";
import { RELAY_SEED, blockCount, createSound, encodeFrame, encodeSymbol, loadGgwave, nextSlot, splitBlocks, BLOCK, type Sound } from "@/lib/hive/uplink";
import { Receiver } from "@/lib/hive/uplink/receiver";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const clock = (ms: number) => {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function () {
	const rx = useRef(new Receiver());
	const [sound, setSound] = useState<Sound | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [arming, setArming] = useState(false);
	const [relays, setRelays] = useState(0);
	const [, setTick] = useState(0);
	const level = useRef<HTMLDivElement>(null);

	useEffect(() => {
		loadGgwave().catch(() => {});
	}, []);

	// Repaint for countdowns, and drive the mic meter without re-rendering React every buffer.
	useEffect(() => {
		const id = setInterval(() => setTick((t) => t + 1), 250);
		let raf = 0;
		const meter = () => {
			raf = requestAnimationFrame(meter);
			if (level.current) {
				level.current.style.transform = `scaleX(${Math.min(1, (sound?.level() ?? 0) * 12)})`;
			}
		};
		meter();
		return () => {
			clearInterval(id);
			cancelAnimationFrame(raf);
		};
	}, [sound]);

	useEffect(() => () => sound?.close(), [sound]);

	const mission = rx.current.mission;
	const localStart = rx.current.localStart;

	// Finished: free the mic (iOS goes back to the loud speaker) and relay in the gaps the laptop leaves.
	useEffect(() => {
		if (!sound || !mission || localStart === null) {
			return;
		}
		sound.stopListening();
		if (!mission.relay) {
			return;
		}
		let alive = true;
		const r = rx.current;
		const blocks = splitBlocks(r.payload(), BLOCK);
		const probe = encodeFrame({ msgId: r.msgId, w: r.w, h: r.h, seed: 0, countdownMs: 0, data: blocks[0] });
		const air = sound.airtime(probe, mission.protocol) * 1000;
		(async () => {
			while (alive) {
				const slot = nextSlot(Date.now() + 1, localStart, mission.slotMs);
				const slack = Math.max(0, mission.slotMs - 2 * air - 600);
				const at = slot + air + 300 + Math.random() * slack;
				if (at + air >= localStart) {
					return;
				}
				await sleep(at - Date.now());
				// Coin flip per window, so a crowd of finished phones doesn't all talk at once.
				if (!alive || Math.random() < 0.5) {
					continue;
				}
				const seed = RELAY_SEED + Math.floor(Math.random() * 0x7fff);
				const frame = encodeFrame({ msgId: r.msgId, w: r.w, h: r.h, seed, countdownMs: localStart - (Date.now() + air), data: encodeSymbol(blocks, seed) });
				await sound.send(frame, mission.protocol, 60);
				setRelays((n) => n + 1);
			}
		})();
		return () => {
			alive = false;
		};
	}, [sound, mission, localStart]);

	const arm = async () => {
		setArming(true);
		setError(null);
		try {
			const s = await createSound({ mic: true });
			await s.listen((bytes) => {
				if (rx.current.push(bytes)) {
					setTick((t) => t + 1);
				}
			});
			setSound(s);
			(navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<unknown> } }).wakeLock?.request("screen").catch(() => {});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
		setArming(false);
	};

	const r = rx.current;
	const now = Date.now();

	if (mission && localStart !== null && now >= localStart) {
		return <UplinkShow mission={mission} localStart={localStart} />;
	}

	if (!sound) {
		return (
			<div className="flex flex-col justify-between min-h-screen p-[1.5rem] gap-[2rem] bg-ink text-white">
				<p className="text-[.875rem] text-mute">Hive · Mission Uplink</p>
				<div className="flex flex-col gap-[1rem]">
					<h1 className="font-display text-[3rem] leading-[1.05] tracking-[-0.03em] text-balance">Orders by sound.</h1>
					<p className="text-[1rem] leading-relaxed text-mute text-pretty">
						Tap below and allow the microphone. Then switch on airplane mode and keep this page open: the only link left is the laptop's speaker.
					</p>
				</div>
				<div className="flex flex-col gap-[.75rem]">
					<ButtonBase onClick={arm} disabled={arming} className="min-h-[4rem] text-[1.25rem] bg-fire border-fire text-ink">
						{arming ? "Starting the mic…" : "Start listening"}
					</ButtonBase>
					{error && <p className="text-[1rem] text-amber">{error}</p>}
				</div>
			</div>
		);
	}

	const k = r.decoder ? blockCount(r.w, r.h) : 0;
	const s = r.stats;
	const lost = s.hostSent ? Math.round((1 - s.hostFrames / s.hostSent) * 100) : 0;
	const status = mission
		? mission.relay
			? `Mission received in ${(((s.doneAt ?? 0) - (s.firstAt ?? 0)) / 1000).toFixed(1)} s. Relaying to the phones around you (${relays} sent).`
			: `Mission received in ${(((s.doneAt ?? 0) - (s.firstAt ?? 0)) / 1000).toFixed(1)} s.`
		: r.decoder
			? `Rebuilding: ${r.decoder.solved.size} of ${k} blocks`
			: "Listening for the laptop…";

	return (
		<div className="flex flex-col min-h-screen p-[1.5rem] gap-[1.5rem] bg-ink text-white">
			<header className="flex flex-row items-center justify-between gap-[1rem]">
				<p className="text-[.875rem] text-mute">Hive · Mission Uplink</p>
				<div className="w-[5rem] h-[.35rem] rounded-full bg-line overflow-hidden" title="Microphone level">
					<div ref={level} className="h-full bg-flock origin-left" />
				</div>
			</header>

			<div className="flex flex-col items-center justify-center gap-[1rem] grow">
				{r.decoder ? (
					<UplinkImage w={r.w} h={r.h} payload={r.payload()} solved={r.decoder.solved} cell={`min(2rem, ${80 / r.w}vw)`} />
				) : (
					<p className="font-display text-[2rem] tracking-tight text-mute text-center text-balance">Waiting for the first chunk</p>
				)}
				<p className={mission ? "text-[1rem] text-flock text-center text-pretty" : "text-[1rem] text-mute text-center"}>{status}</p>
				{r.decoder && (
					<div className="flex flex-row flex-wrap justify-center gap-[.25rem]" aria-label="Blocks in the order this phone learnt them">
						{Array.from({ length: k }, (_, i) => (
							<span key={i} className={r.decoder!.solved.has(i) ? "w-[.6rem] h-[.6rem] rounded-full bg-fire" : "w-[.6rem] h-[.6rem] rounded-full bg-line"} />
						))}
					</div>
				)}
			</div>

			<div className="grid grid-cols-2 gap-[.5rem]">
				<Stat label="Chunks heard" value={s.frames} unit={s.relayFrames ? `${s.relayFrames} via phones` : undefined} />
				<Stat label="Laptop loss" value={s.hostSent ? lost : "–"} unit={s.hostSent ? `% of ${s.hostSent}` : undefined} />
				<Stat label="Link" value={s.linkBps ? s.linkBps.toFixed(1) : "–"} unit="B/s" />
				<Stat label={mission ? "Goodput" : "Show in"} value={mission ? s.goodputBps.toFixed(1) : localStart ? clock(localStart - now) : "–"} unit={mission ? "B/s" : undefined} />
			</div>
			{mission && localStart !== null && <p className="text-[1rem] text-mute text-center tabular-nums">Light show in {clock(localStart - now)}</p>}
		</div>
	);
}
