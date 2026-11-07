"use client";

// Laptop side of Mission Uplink: fountain-codes the mission and plays one chunk per slot until the show starts.
import { useEffect, useMemo, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import PanelBase from "./PanelBase";
import PixelArt from "./PixelArt";
import Stat from "./Stat";
import TopBar from "./TopBar";
import { PICTURES } from "@/lib/hive/pixel";
import { SHOWS } from "@/lib/hive/shows";
import { BLOCK, FRAME_SIZE, PROTOCOLS, blockCount, createSound, encodeFrame, encodeMission, encodeSymbol, loadGgwave, nextSlot, payloadLength, splitBlocks, type Sound } from "@/lib/hive/uplink";
import { createModem } from "@/lib/hive/uplink/modem";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Laptop speaks at the start of each slot; with relay windows on, the second half is left for phones.
const slotFor = (airMs: number, relay: boolean) => Math.ceil((relay ? 2 * airMs + 900 : airMs + 400) / 100) * 100;

function Choice({ active, className, ...props }: React.JSX.IntrinsicElements["button"] & { active: boolean }) {
	return <ButtonBase className={twMerge(active && "border-flock text-flock", className)} {...props} />;
}

export default function () {
	const [picture, setPicture] = useState(0);
	const [showId, setShowId] = useState(0);
	const [protocol, setProtocol] = useState(2);
	const [volume, setVolume] = useState(60);
	const [delay, setDelay] = useState(75);
	const [relay, setRelay] = useState(true);
	const [airs, setAirs] = useState<number[] | null>(null);
	const [sending, setSending] = useState<{ startAt: number; slotMs: number; startedAt: number } | null>(null);
	const [sent, setSent] = useState(0);
	const [, setTick] = useState(0);
	const run = useRef(0);
	const sound = useRef<Sound | null>(null);

	// Airtime per frame for each protocol, measured from the real encoder output.
	useEffect(() => {
		loadGgwave()
			.then(() => createModem(48000))
			.then((m) => setAirs(PROTOCOLS.map((_, p) => m.encode(new Uint8Array(FRAME_SIZE), p).length / 48000)))
			.catch(() => {});
		const id = setInterval(() => setTick((t) => t + 1), 250);
		return () => {
			clearInterval(id);
			run.current++;
			sound.current?.close();
		};
	}, []);

	const art = PICTURES[picture].art;
	const w = art[0].length;
	const h = art.length;
	const bytes = payloadLength(w, h);
	const k = blockCount(w, h);
	const airMs = airs ? airs[protocol] * 1000 : null;
	const slotMs = airMs ? slotFor(airMs, relay) : null;

	const plan = useMemo(
		() => [
			{ label: "Payload", value: bytes, unit: `B · ${w}×${h} px` },
			{ label: "Blocks", value: k, unit: `× ${BLOCK} B` },
			{ label: "Frame on air", value: airMs ? (airMs / 1000).toFixed(2) : "–", unit: `s · ${FRAME_SIZE} B` },
			{ label: "Raw link", value: airMs ? ((FRAME_SIZE * 1000) / airMs).toFixed(1) : "–", unit: "B/s" },
			{ label: "Payload rate", value: slotMs ? ((BLOCK * 1000) / slotMs).toFixed(1) : "–", unit: "B/s" },
			{ label: "Expected delivery", value: slotMs ? Math.round((k * 1.3 * slotMs) / 1000) : "–", unit: "s" },
		],
		[bytes, k, w, h, airMs, slotMs],
	);

	const stop = () => {
		run.current++;
		setSending(null);
	};

	const start = async () => {
		const id = ++run.current;
		sound.current ??= await createSound();
		const s = sound.current;
		const msgId = 1 + Math.floor(Math.random() * 255);
		const startAt = Math.ceil(Date.now() / 1000) + Math.min(600, Math.max(10, delay));
		const startMs = startAt * 1000;
		const air = s.airtime(new Uint8Array(FRAME_SIZE), protocol) * 1000;
		const slot = slotFor(air, relay);
		const blocks = splitBlocks(encodeMission({ showId, protocol, relay, slotMs: slot, startAt, art }), BLOCK);
		setSent(0);
		setSending({ startAt: startMs, slotMs: slot, startedAt: Date.now() });

		for (let seed = 0; run.current === id; seed++) {
			const at = nextSlot(Date.now() + 1, startMs, slot);
			if (at + air >= startMs) {
				break;
			}
			await sleep(at - Date.now());
			if (run.current !== id) {
				return;
			}
			const frame = encodeFrame({ msgId, w, h, seed, countdownMs: startMs - (Date.now() + air), data: encodeSymbol(blocks, seed) });
			await s.send(frame, protocol, volume);
			setSent(seed + 1);
		}
		if (run.current === id) {
			setSending((v) => v && { ...v, slotMs: 0 });
		}
	};

	const now = Date.now();
	const done = sending?.slotMs === 0;

	return (
		<div className="flex flex-col min-h-screen bg-ink text-white">
			<TopBar crumbs={["Mission Uplink"]} />
			<div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-[1rem] p-[1.25rem]">
				<PanelBase index="01" title="Mission package">
					<div className="flex flex-row flex-wrap gap-[.5rem]">
						{PICTURES.map((p, i) => (
							<Choice key={p.name} active={picture === i} onClick={() => setPicture(i)} disabled={!!sending && !done}>
								<PixelArt art={p.art} size=".2rem" />
								{p.name}
							</Choice>
						))}
					</div>
					<p className="text-[.875rem] text-mute">Light show</p>
					<div className="flex flex-row flex-wrap gap-[.5rem]">
						{SHOWS.map((s, i) => (
							<Choice key={s.name} active={showId === i} onClick={() => setShowId(i)} disabled={!!sending && !done}>
								{s.name}
							</Choice>
						))}
					</div>
					<p className="text-[.875rem] text-mute">Sound</p>
					<div className="flex flex-row flex-wrap items-center gap-[.5rem]">
						{PROTOCOLS.map((p, i) => (
							<Choice key={p.name} active={protocol === i} onClick={() => setProtocol(i)} disabled={!!sending && !done}>
								{p.name}
							</Choice>
						))}
						<Choice active={relay} onClick={() => setRelay(!relay)} disabled={!!sending && !done}>
							Relay gaps {relay ? "on" : "off"}
						</Choice>
					</div>
					<div className="flex flex-row flex-wrap gap-[.5rem]">
						<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1rem] rounded-full border border-line text-[.875rem] text-mute">
							Show starts in
							<input type="number" min={10} max={600} value={delay} onChange={(e) => setDelay(Number(e.target.value))} className="w-[4rem] bg-transparent text-white text-[1rem]" />
							s
						</label>
						<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1rem] rounded-full border border-line text-[.875rem] text-mute">
							Volume
							<input type="range" min={10} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-[8rem] accent-[#ff5a1f]" />
						</label>
					</div>
				</PanelBase>

				<PanelBase index="02" title="Link budget" aside={<p className="text-[.875rem] text-mute">ggwave {PROTOCOLS[protocol].name.toLowerCase()}</p>}>
					<div className="grid grid-cols-2 md:grid-cols-3 gap-[.5rem]">
						{plan.map((p) => (
							<Stat key={p.label} label={p.label} value={p.value} unit={p.unit} />
						))}
					</div>
					<p className="text-[.875rem] leading-relaxed text-mute text-pretty">
						Rates here are airtime from the encoder. The real number is on the phones: their Link and Goodput tiles are measured from what the mic actually decoded, and Laptop loss shows how many chunks they missed.
					</p>
				</PanelBase>

				<PanelBase index="03" title="Uplink" className="lg:col-span-2">
					<div className="flex flex-col md:flex-row md:items-center gap-[1rem]">
						{sending && !done ? (
							<ButtonBase onClick={stop} className="min-h-[4rem] px-[2rem] text-[1.25rem]">
								Stop
							</ButtonBase>
						) : (
							<ButtonBase onClick={start} disabled={!airs} className="min-h-[4rem] px-[2rem] text-[1.25rem] bg-fire border-fire text-ink">
								Send over sound
							</ButtonBase>
						)}
						<div className="grid grid-cols-3 gap-[.5rem] grow">
							<Stat label="Chunks sent" value={sent} unit={sending ? `of ~${Math.ceil(k * 1.3)} needed` : undefined} />
							<Stat label={done ? "Show running" : "Show starts in"} value={sending ? Math.max(0, Math.ceil((sending.startAt - now) / 1000)) : "–"} unit="s" />
							<Stat label="Sending for" value={sending ? Math.round((now - sending.startedAt) / 1000) : "–"} unit="s" />
						</div>
					</div>
					<p className="text-[.875rem] leading-relaxed text-mute text-pretty">
						Phones open /uplink and tap Start listening before airplane mode. Every chunk is a random mix of blocks, so each phone fills in a different order; phones that finish relay chunks in the gaps, and at zero they all start the show together.
					</p>
				</PanelBase>
			</div>
		</div>
	);
}
