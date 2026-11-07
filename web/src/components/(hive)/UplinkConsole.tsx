"use client";

// Master speaker for Sound Uplink: draw a 16×16 picture, fountain-code it and play one chunk per
// slot until the show starts. Phones on /uplink rebuild it, relay it, then all play it at zero.
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { twMerge } from "tailwind-merge";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import PanelBase from "./PanelBase";
import PixelArt from "./PixelArt";
import PixelEditor from "./PixelEditor";
import Stat from "./Stat";
import { BLANK_ART, C, UPLINK_PICTURES } from "@/lib/hive/pixel";
import { phoneJoinUrl } from "@/lib/hive/server";
import { SHOWS } from "@/lib/hive/shows";
import { BLOCK, FRAME_SIZE, PICTURE_SHOW, PROTOCOLS, blockCount, createSound, encodeFrame, encodeMission, encodeSymbol, loadGgwave, nextSlot, payloadLength, splitBlocks, type Sound } from "@/lib/hive/uplink";
import { createModem } from "@/lib/hive/uplink/modem";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Laptop speaks at the start of each slot. Relay off: frames go nearly back to back (200 ms so the
// decoder sees each end marker). Relay on: the second half of each slot is left for phones.
const slotFor = (airMs: number, relay: boolean) => Math.ceil((relay ? 2 * airMs + 900 : airMs + 200) / 100) * 100;

const SHOW_CHOICES = [{ id: PICTURE_SHOW, name: "The picture" }, ...SHOWS.map((s, id) => ({ id, name: s.name }))];

function Choice({ active, className, ...props }: React.JSX.IntrinsicElements["button"] & { active: boolean }) {
	return <ButtonBase className={twMerge(active && "border-flock text-flock", className)} {...props} />;
}

function PhoneQR() {
	const [link, setLink] = useState<{ url: string; lan: boolean } | null>(null);
	useEffect(() => {
		void phoneJoinUrl("/uplink").then(setLink);
	}, []);

	return (
		<div className="flex flex-row items-center gap-[1.25rem]">
			<div className="p-[.6rem] bg-white rounded-[.9rem] shrink-0">{link && <QRCode value={link.url} size={104} bgColor="#ffffff" fgColor={C.ink} />}</div>
			<div className="flex flex-col gap-[.4rem] min-w-0">
				<p className="font-display text-[1.5rem] leading-[1.1] tracking-tight text-white">Scan, allow the mic, go offline.</p>
				<p className="text-[.875rem] leading-relaxed text-mute">After that the only link is this laptop's speaker.</p>
				{link && <p className="text-[.875rem] text-mute break-all">{link.url.replace(/^https?:\/\//, "")}</p>}
			</div>
		</div>
	);
}

export default function () {
	const [art, setArt] = useState(UPLINK_PICTURES[0].art);
	const [showId, setShowId] = useState(PICTURE_SHOW);
	const [protocol, setProtocol] = useState(2);
	const [volume, setVolume] = useState(60);
	const [delay, setDelay] = useState(45);
	// Off by default: in one room the laptop reaches everyone, and relay gaps double the airtime.
	const [relay, setRelay] = useState(false);
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

	const w = art[0].length;
	const h = art.length;
	const bytes = payloadLength(w, h);
	const k = blockCount(w, h);
	const airMs = airs ? airs[protocol] * 1000 : null;
	const slotMs = airMs ? slotFor(airMs, relay) : null;
	const now = Date.now();
	const done = sending?.slotMs === 0;
	const locked = !!sending && !done;

	const plan = useMemo(
		() => [
			{ label: "Payload", value: bytes, unit: `B · ${w}×${h} · 4-bit` },
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

	return (
		<div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-[1rem] p-[1.25rem]">
			<PanelBase index="01" title="Draw the picture" aside={<p className="text-[.875rem] text-mute">16 colours · {bytes} B</p>}>
				<PixelEditor art={art} onChange={setArt} disabled={locked} />
				<div className="flex flex-row flex-wrap gap-[.5rem]">
					{UPLINK_PICTURES.map((p) => (
						<Choice key={p.name} active={art === p.art} onClick={() => setArt(p.art)} disabled={locked}>
							<PixelArt art={p.art} size=".1rem" />
							{p.name}
						</Choice>
					))}
					<Choice active={false} onClick={() => setArt(BLANK_ART)} disabled={locked}>
						Clear
					</Choice>
				</div>
			</PanelBase>

			<div className="flex flex-col gap-[1rem] min-w-0">
				<PanelBase index="02" title="Phones">
					<PhoneQR />
				</PanelBase>

				<PanelBase index="03" title="Broadcast">
					<p className="text-[.875rem] text-mute">At zero, every phone plays</p>
					<div className="flex flex-row flex-wrap gap-[.5rem]">
						{SHOW_CHOICES.map((s) => (
							<Choice key={s.id} active={showId === s.id} onClick={() => setShowId(s.id)} disabled={locked}>
								{s.name}
							</Choice>
						))}
					</div>
					<div className="flex flex-row flex-wrap items-center gap-[.5rem]">
						{PROTOCOLS.map((p, i) => (
							<Choice key={p.name} active={protocol === i} onClick={() => setProtocol(i)} disabled={locked}>
								{p.name}
							</Choice>
						))}
						<Choice active={relay} onClick={() => setRelay(!relay)} disabled={locked}>
							Relay gaps {relay ? "on" : "off"}
						</Choice>
						<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1rem] rounded-full border border-line text-[.875rem] text-mute">
							Starts in
							<input type="number" min={10} max={600} value={delay} onChange={(e) => setDelay(Number(e.target.value))} className="w-[3.5rem] bg-transparent text-white text-[1rem]" />s
						</label>
						<label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1rem] rounded-full border border-line text-[.875rem] text-mute">
							Volume
							<input type="range" min={10} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-[7rem] accent-[#ff5a1f]" />
						</label>
					</div>
					<div className="flex flex-col md:flex-row md:items-center gap-[1rem]">
						{locked ? (
							<ButtonBase onClick={stop} className="min-h-[4rem] px-[2rem] text-[1.25rem]">
								Stop
							</ButtonBase>
						) : (
							<ButtonBase onClick={start} disabled={!airs} className="min-h-[4rem] px-[2rem] text-[1.25rem] bg-fire border-fire text-ink">
								Send over sound
							</ButtonBase>
						)}
						<div className="grid grid-cols-3 gap-[.5rem] grow">
							<Stat label="Chunks sent" value={sent} unit={sending ? `of ~${Math.ceil(k * 1.3)}` : undefined} />
							<Stat label={done ? "Show running" : "Show in"} value={sending ? Math.max(0, Math.ceil((sending.startAt - now) / 1000)) : "–"} unit="s" />
							<Stat label="Sending for" value={sending ? Math.round((now - sending.startedAt) / 1000) : "–"} unit="s" />
						</div>
					</div>
				</PanelBase>

				<PanelBase index="04" title="Link budget" aside={<p className="text-[.875rem] text-mute">ggwave {PROTOCOLS[protocol].name.toLowerCase()}</p>}>
					<div className="grid grid-cols-2 md:grid-cols-3 gap-[.5rem]">
						{plan.map((p) => (
							<Stat key={p.label} label={p.label} value={p.value} unit={p.unit} />
						))}
					</div>
					<p className="text-[.875rem] leading-relaxed text-mute text-pretty">
						Every chunk is a random mix of blocks, so each phone fills the picture in a different order. Phones that finish relay chunks in the gaps, and at zero they all play together. Real link rates are on the phones, measured from what their mics decoded.
					</p>
				</PanelBase>
			</div>
		</div>
	);
}
