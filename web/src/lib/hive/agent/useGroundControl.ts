"use client";

// Ground Control: the ElevenLabs real-time voice agent wired to the ground-station antenna.
// - Everything the antenna hears is fed to the agent as context; urgent events are pushed as alerts it reports.
// - Its client tools act on the live sim: read status, look up places (server: AI gateway + Google Places),
//   uplink orders to the swarm through the antenna, and start drill fires.
import { Conversation, type Mode, type Status } from "@elevenlabs/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { cellToLatLon, latLonToCell } from "../antenna";
import type FireLive from "../fireLive";
import type { FireSnap } from "../fireLive";
import type { LoadedArea } from "../osm";

export type ChatRow = { id: number; role: "user" | "agent" | "tool" | "antenna" | "system"; text: string; at: number };

const HISTORY_KEY = "hive.groundControl.history";
const MAX_ROWS = 120;
const CONTEXT_EVERY_MS = 5000;
const SUMMARY_EVERY_MS = 20000;
const ALERT_GAP_MS = 9000;

type Conv = Awaited<ReturnType<typeof Conversation.startSession>>;
type Act = (fn: (w: FireLive) => void) => void;

function loadHistory(): ChatRow[] {
	try {
		return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as ChatRow[];
	} catch {
		return [];
	}
}

// What the agent reads when it asks for status: only what the antenna knows.
export function statusText(snap: FireSnap, area: LoadedArea) {
	const st = snap.station;
	if (!st) {
		return "No ground station on this map.";
	}
	const stat = (label: string) => snap.stats.find((s) => s.label === label);
	const ids = (k: string) =>
		Object.entries(st.links)
			.filter(([, v]) => v === k)
			.map(([id]) => id);
	const all = snap.view.agents.map((a) => a.id);
	const dark = all.filter((id) => !st.links[id] || st.links[id] === "dark");
	const ant = cellToLatLon(area, st.pos.x, st.pos.y);
	const lines = [
		`Antenna on ${st.name} (lat ${ant.lat.toFixed(5)}, lon ${ant.lon.toFixed(5)}): ${st.jammed ? "JAMMED, hearing nothing" : "up"}.`,
		`Reporting: ${st.direct} direct [${ids("direct").join(", ")}], ${st.relay} via mesh relay [${ids("relay").join(", ")}], ${dark.length} dark [${dark.join(", ")}].`,
		`Packets lost on air: ${stat("Packets lost on air")?.value}%. Fire edge mapped: ${stat("Fire edge mapped")?.value}%. Fire put out: ${stat("Fire put out")?.value}%. Buildings saved: ${stat("Buildings saved")?.value}%.`,
		st.clusters.length
			? `Fires known to the antenna: ${st.clusters
					.map((c, i) => `#${i + 1} ${c.cells} cells, ${describe(st, area, c.x, c.y)} (lat ${c.lat.toFixed(5)}, lon ${c.lon.toFixed(5)})`)
					.join("; ")}.`
			: "No fire reported by the drones.",
		st.missions.length
			? `Orders: ${st.missions.map((m) => `"${m.text}" crew ${m.crew.join("/")}, ${m.onScene} on scene`).join("; ")}.`
			: "No active orders.",
		`Wind ${stat("Wind")?.value}°. Elapsed ${stat("Elapsed")?.value}s.`,
		`Recent: ${st.events
			.slice(-6)
			.map((e) => e.text)
			.join(" | ")}`,
	];
	return lines.join("\n");
}

function describe(st: NonNullable<FireSnap["station"]>, area: LoadedArea, x: number, y: number) {
	const dx = x - st.pos.x;
	const dy = y - st.pos.y;
	const m = Math.round((Math.hypot(dx, dy) * area.mPerCell) / 10) * 10;
	const dirs = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
	const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
	return m < 30 ? "at the antenna" : `${m} m ${dirs[Math.round(((deg + 360) % 360) / 45) % 8]} of the antenna`;
}

export default function useGroundControl({
	area,
	snap,
	world,
	act,
}: {
	area: LoadedArea;
	snap: FireSnap | null;
	world: React.RefObject<FireLive | null>;
	act: Act;
}) {
	const [rows, setRows] = useState<ChatRow[]>([]);
	const [status, setStatus] = useState<Status>("disconnected");
	const [mode, setMode] = useState<Mode>("listening");
	const [muted, setMuted] = useState(false);
	const [error, setError] = useState("");
	const [autoReport, setAutoReport] = useState(true);
	const conv = useRef<Conv | null>(null);
	const snapRef = useRef(snap);
	snapRef.current = snap;
	const modeRef = useRef(mode);
	modeRef.current = mode;
	const seq = useRef(0);
	const sentEvent = useRef(0);
	const pending = useRef<{ context: string[]; alerts: string[]; lastContext: number; lastAlert: number; lastSummary: number }>({
		context: [],
		alerts: [],
		lastContext: 0,
		lastAlert: 0,
		lastSummary: 0,
	});
	const lastTyped = useRef({ text: "", at: 0 });

	useEffect(() => {
		const h = loadHistory();
		seq.current = h.reduce((n, r) => Math.max(n, r.id), 0);
		setRows(h);
		return () => {
			conv.current?.endSession();
			conv.current = null;
		};
	}, []);

	const push = useCallback((role: ChatRow["role"], text: string) => {
		setRows((r) => {
			const next = [...r, { id: ++seq.current, role, text, at: Date.now() }].slice(-MAX_ROWS);
			try {
				localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
			} catch {
				// storage blocked: history just lives for this page
			}
			return next;
		});
	}, []);

	const clear = useCallback(() => {
		setRows([]);
		try {
			localStorage.removeItem(HISTORY_KEY);
		} catch {
			// ignore
		}
	}, []);

	const toCell = useCallback(
		(lat: number, lon: number) => {
			const c = latLonToCell(area, lat, lon);
			const inside = c.x >= 0 && c.y >= 0 && c.x < area.width && c.y < area.height;
			return { ...c, inside };
		},
		[area],
	);

	const tools = useCallback(
		() => ({
			get_status: () => {
				const s = snapRef.current;
				push("tool", "get_status");
				return s ? statusText(s, area) : "Ground station is starting up.";
			},
			locate_place: async ({ query }: { query: string }) => {
				push("tool", `locate_place "${query}"`);
				try {
					const res = await fetch("/api/agent/locate", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ query, near: { lat: area.lat, lon: area.lon, name: area.name } }),
					});
					const r = (await res.json()) as { ok: boolean; error?: string; source?: string; place?: { name: string; address: string; lat: number; lon: number } };
					if (!r.ok || !r.place) {
						push("tool", `→ ${r.error ?? "not found"}`);
						return JSON.stringify({ found: false, error: r.error });
					}
					const c = toCell(r.place.lat, r.place.lon);
					const st = snapRef.current?.station;
					const where = st && c.inside ? describe(st, area, c.x, c.y) : "outside the operating area";
					push("tool", `→ ${r.place.name} · ${where}`);
					return JSON.stringify({ found: true, ...r.place, insideOperatingArea: c.inside, fromAntenna: where, source: r.source });
				} catch {
					return JSON.stringify({ found: false, error: "Lookup failed (network)." });
				}
			},
			dispatch_drones: ({ lat, lon, task, crew, role }: { lat: number; lon: number; task: string; crew?: number; role?: string }) => {
				const c = toCell(Number(lat), Number(lon));
				push("tool", `dispatch_drones "${task}"`);
				if (!c.inside) {
					push("tool", "→ outside the operating area");
					return "Failed: that location is outside the drones' operating area.";
				}
				let out = "Failed: the simulation is not running.";
				act((w) => {
					const r = w.uplink(c, task, {
						crew: crew ? Number(crew) : undefined,
						role: role === "water" || role === "sky" || role === "any" ? role : "echo",
					});
					out = r.ok
						? `Uplinked via ${r.via}. Crew: ${r.crew.join(", ")}. The order is now flooding drone to drone.`
						: `Uplink failed: ${r.reason}`;
				});
				push("tool", `→ ${out}`);
				return out;
			},
			simulate_fire: ({ lat, lon }: { lat: number; lon: number }) => {
				const c = toCell(Number(lat), Number(lon));
				push("tool", "simulate_fire");
				if (!c.inside) {
					return "Failed: outside the operating area.";
				}
				act((w) => w.ignite(c));
				return "Drill fire started. The drones have to find it themselves; you will hear about it when they report it.";
			},
		}),
		[act, area, push, toCell],
	);

	const start = useCallback(
		async (textOnly = false) => {
			if (conv.current || status === "connecting") {
				return;
			}
			setError("");
			setStatus("connecting");
			try {
				const res = await fetch("/api/agent/session");
				const { signedUrl, error: err } = (await res.json()) as { signedUrl?: string; error?: string };
				if (!signedUrl) {
					throw new Error(err ?? "No session");
				}
				const st = snapRef.current?.station;
				sentEvent.current = st?.events.at(-1)?.n ?? 0;
				const c = await Conversation.startSession({
					signedUrl,
					connectionType: "websocket",
					textOnly,
					dynamicVariables: { antenna_name: st?.name ?? area.antenna?.name ?? "the antenna", area_name: area.name },
					clientTools: tools(),
					onStatusChange: ({ status: s }) => setStatus(s),
					onModeChange: ({ mode: m }) => setMode(m),
					onError: (m) => setError(String(m)),
					onDisconnect: () => {
						conv.current = null;
						setStatus("disconnected");
					},
					onMessage: ({ message, role }) => {
						const t = lastTyped.current;
						if (role === "user" && message.trim() === t.text && Date.now() - t.at < 8000) {
							return; // we already showed what was typed
						}
						push(role === "agent" ? "agent" : "user", message);
					},
				});
				conv.current = c;
				push("system", textOnly ? "Connected (text only)" : "Connected · microphone live");
				const s = snapRef.current;
				if (s) {
					c.sendContextualUpdate(`[ANTENNA] Current picture:\n${statusText(s, area)}`);
				}
			} catch (e) {
				setStatus("disconnected");
				setError(e instanceof Error ? e.message : "Could not connect");
			}
		},
		[area, push, status, tools],
	);

	const stop = useCallback(async () => {
		const c = conv.current;
		conv.current = null;
		await c?.endSession();
		setStatus("disconnected");
		push("system", "Disconnected");
	}, [push]);

	const send = useCallback(
		(text: string) => {
			const t = text.trim();
			if (!t) {
				return;
			}
			if (!conv.current) {
				push("system", "Connect Ground Control first.");
				return;
			}
			lastTyped.current = { text: t, at: Date.now() };
			push("user", t);
			conv.current.sendUserMessage(t);
		},
		[push],
	);

	const toggleMute = useCallback(() => {
		setMuted((m) => {
			conv.current?.setMicMuted(!m);
			return !m;
		});
	}, []);

	// Antenna → agent. New station events become context; urgent ones queue as alerts the agent reads out
	// when it next has the floor (never talking over itself or the operator).
	useEffect(() => {
		const st = snap?.station;
		const c = conv.current;
		if (!st || !c || status !== "connected") {
			return;
		}
		const p = pending.current;
		for (const e of st.events) {
			if (e.n <= sentEvent.current) {
				continue;
			}
			sentEvent.current = e.n;
			(e.alert && autoReport ? p.alerts : p.context).push(e.text);
		}
		const now = Date.now();
		if (p.context.length && now - p.lastContext > CONTEXT_EVERY_MS) {
			c.sendContextualUpdate(`[ANTENNA] ${p.context.splice(0).join(" | ")}`);
			p.lastContext = now;
		}
		if (now - p.lastSummary > SUMMARY_EVERY_MS && snap) {
			c.sendContextualUpdate(`[ANTENNA] Periodic picture:\n${statusText(snap, area)}`);
			p.lastSummary = now;
		}
		if (p.alerts.length && modeRef.current === "listening" && now - p.lastAlert > ALERT_GAP_MS) {
			const text = `[ANTENNA ALERT] ${p.alerts.splice(0).join(" | ")}`;
			p.lastAlert = now;
			push("antenna", text.replace("[ANTENNA ALERT] ", ""));
			lastTyped.current = { text, at: now };
			c.sendUserMessage(text);
		}
	}, [snap, status, autoReport, area, push]);

	return { rows, status, mode, muted, error, autoReport, setAutoReport, start, stop, send, toggleMute, clear };
}
