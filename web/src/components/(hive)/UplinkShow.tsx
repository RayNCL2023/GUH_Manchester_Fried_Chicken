"use client";

// The offline light show. Every phone computes the same frame from (show, local start time), so
// a room of phones in airplane mode stays in step with no network at all.
import { useEffect, useRef } from "react";
import { ART_COLORS, C } from "@/lib/hive/pixel";
import { CENTRE, SHOWS } from "@/lib/hive/shows";
import type { Mission } from "@/lib/hive/uplink";

const BEAT = 1.2; // seconds

const mix = (a: string, b: string, k: number) => {
	const pa = parseInt(a.slice(1), 16);
	const pb = parseInt(b.slice(1), 16);
	const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
	return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
};

export default function ({ mission, localStart }: { mission: Mission; localStart: number }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const label = useRef<HTMLParagraphElement>(null);
	const show = SHOWS[mission.showId] ?? SHOWS[0];

	useEffect(() => {
		const el = canvas.current;
		const g = el?.getContext("2d");
		if (!el || !g) {
			return;
		}
		const colors = [...new Set(mission.art.join("").replace(/\./g, ""))].map((ch) => ART_COLORS[ch]);
		const palette = colors.length ? colors : [C.fire, C.amber, C.flock];
		const layout = show.layout(120);
		let raf = 0;

		const draw = () => {
			raf = requestAnimationFrame(draw);
			const dpr = window.devicePixelRatio || 1;
			const W = el.clientWidth;
			const H = el.clientHeight;
			if (el.width !== Math.round(W * dpr)) {
				el.width = Math.round(W * dpr);
				el.height = Math.round(H * dpr);
			}
			const t = (Date.now() - localStart) / 1000;
			const beat = Math.floor(t / BEAT);
			const pulse = Math.exp(-((t / BEAT) % 1) * 3.2);
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			g.fillStyle = mix(C.ink, palette[((beat % palette.length) + palette.length) % palette.length], 0.55 * pulse);
			g.fillRect(0, 0, W, H);

			const s = Math.min(W / 100, H / 60);
			layout.slots.forEach((slot, i) => {
				const p = show.move(slot, t);
				g.fillStyle = show.tint?.(slot, i, t) ?? slot.color;
				g.beginPath();
				g.arc(W / 2 + (p.x - CENTRE.x) * s, H / 2 + (p.y - CENTRE.y) * s, s * 1.15, 0, Math.PI * 2);
				g.fill();
			});
			if (label.current) {
				label.current.textContent = `${show.name} · T+${Math.max(0, t).toFixed(1)}s`;
			}
		};
		draw();
		return () => cancelAnimationFrame(raf);
	}, [mission, localStart, show]);

	return (
		<div className="fixed inset-0 flex flex-col justify-end bg-ink" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>
			<canvas ref={canvas} className="absolute inset-0 w-full h-full" />
			<p ref={label} className="relative p-[1.5rem] text-[.875rem] text-white/50 tabular-nums" />
		</div>
	);
}
