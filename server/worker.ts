// Hive world server on Cloudflare: one Durable Object holds the World and ticks it at 10 Hz.
// Same API as server/index.ts (Bun). Deploy: bunx wrangler deploy -c server/wrangler.jsonc
import { DurableObject } from "cloudflare:workers";
import type { AgentToServer, ClientHello, Control, ViewerToServer } from "../shared/types";
import { parseGoal, sitrep } from "../ai";
import { createBrain } from "../engine/brains";
import { elevenLabsConfigured, speechToText, textToSpeech } from "./elevenlabs";
import { World } from "./world";

type Env = { HIVE: DurableObjectNamespace<Hive>; BOTS?: string; CORS_ORIGIN?: string; ANTHROPIC_API_KEY?: string };

const TICK_MS = 100;

function cors(env: Env) {
	return {
		"access-control-allow-origin": env.CORS_ORIGIN ?? "*",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type",
	};
}

export class Hive extends DurableObject<Env> {
	private world = new World();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.spawnBots(Number(env.BOTS ?? 0));
	}

	// In-process drones: each still only sees its own Sense, like a remote agent.
	private spawnBots(count: number) {
		for (let n = 1; n <= count; n++) {
			const id = `Echo-${n}`;
			let brain = createBrain("hive");
			let scenario = "";
			let lastTick = -1;
			this.world.addAgent(id, false, (msg) => {
				if (msg.t !== "sense") {
					return;
				}
				const s = msg.sense;
				if (s.scenario !== scenario || s.tick < lastTick) {
					brain = createBrain("hive");
					brain.init(id, s.scenario);
					scenario = s.scenario;
				}
				lastTick = s.tick;
				queueMicrotask(() => this.world.applyAction(id, brain.step(s)));
			});
		}
	}

	// Tick only while someone is connected (or bots exist); the DO can sleep otherwise.
	private ensureTicking() {
		if (this.timer) {
			return;
		}
		this.timer = setInterval(() => this.world.step(), TICK_MS);
	}

	private json(data: unknown, status = 200) {
		return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors(this.env) } });
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const world = this.world;
		this.ensureTicking();

		if (url.pathname === "/ws") {
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			const [client, ws] = Object.values(new WebSocketPair());
			ws.accept();
			this.bindSocket(ws);
			return new Response(null, { status: 101, webSocket: client });
		}
		if (url.pathname === "/lan") {
			// Public host: phones reach it directly, no LAN swap needed.
			return this.json({ best: null, ips: [] });
		}
		if (url.pathname === "/health") {
			const agents = world.allAgents();
			return this.json({
				ok: true,
				tick: world.tick,
				scenario: world.scenario.id,
				agents: agents.length,
				phones: agents.filter((a) => a.isPhone).length,
				ai: !!process.env.ANTHROPIC_API_KEY,
				elevenlabs: elevenLabsConfigured(),
			});
		}
		if (url.pathname === "/ai/goal" && req.method === "POST") {
			const body = (await req.json().catch(() => ({}))) as { transcript?: string };
			const { source, ...goalBody } = await parseGoal(body.transcript ?? "", world.brief());
			return this.json({ goal: goalBody, source, firstHop: world.injectGoal(goalBody) });
		}
		if (url.pathname === "/ai/sitrep" && req.method === "GET") {
			return this.json(await sitrep(world.brief()));
		}
		if (url.pathname === "/stt" && req.method === "POST") {
			try {
				const file = (await req.formData()).get("file");
				if (!(file instanceof Blob)) {
					return this.json({ error: "multipart field 'file' required" }, 400);
				}
				return this.json({ text: await speechToText(file) });
			} catch (err) {
				return this.json({ error: err instanceof Error ? err.message : String(err) }, 502);
			}
		}
		if (url.pathname === "/tts" && req.method === "POST") {
			try {
				const body = (await req.json()) as { text?: string; voiceId?: string };
				if (!body.text || !body.voiceId) {
					return this.json({ error: "text and voiceId required" }, 400);
				}
				const audio = await textToSpeech(body.text, body.voiceId);
				return new Response(audio, { headers: { "content-type": "audio/mpeg", ...cors(this.env) } });
			} catch (err) {
				return this.json({ error: err instanceof Error ? err.message : String(err) }, 502);
			}
		}
		if (url.pathname === "/control" && req.method === "POST") {
			world.control((await req.json()) as Control);
			return this.json({ ok: true });
		}
		return new Response("Hive server running. Open the web app with ?server=<this host>.", { headers: cors(this.env) });
	}

	private bindSocket(ws: WebSocket) {
		const world = this.world;
		let role: "pending" | "viewer" | "agent" = "pending";
		let id: string | undefined;
		let unsubscribe: (() => void) | undefined;
		const send = (m: unknown) => {
			try {
				ws.send(JSON.stringify(m));
			} catch {
				// socket already closing
			}
		};

		ws.addEventListener("message", (e) => {
			let msg: unknown;
			try {
				msg = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
			} catch {
				return;
			}
			if (role === "pending") {
				const hello = msg as ClientHello;
				if (hello.role === "viewer") {
					role = "viewer";
					unsubscribe = world.addViewer(send);
					return;
				}
				if (hello.role === "agent" && typeof hello.id === "string" && hello.id.length <= 32) {
					role = "agent";
					id = hello.id;
					world.addAgent(hello.id, !!hello.isPhone, send);
				}
				return;
			}
			if (role === "agent" && id) {
				const m = msg as AgentToServer;
				if (m.t === "action" && m.action) {
					world.applyAction(id, m.action);
				}
				return;
			}
			if (role === "viewer") {
				const m = msg as ViewerToServer;
				if (m.t === "control" && m.control) {
					world.control(m.control);
				}
			}
		});

		const close = () => {
			unsubscribe?.();
			unsubscribe = undefined;
			if (role === "agent" && id) {
				world.disconnectAgent(id);
				id = undefined;
			}
		};
		ws.addEventListener("close", close);
		ws.addEventListener("error", close);
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: cors(env) });
		}
		// One world for everyone.
		return env.HIVE.get(env.HIVE.idFromName("main")).fetch(req);
	},
} satisfies ExportedHandler<Env>;
