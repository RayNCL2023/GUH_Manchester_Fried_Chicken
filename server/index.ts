// Hive world server: one Bun process. HTTP API + WebSocket (/ws) for agents and viewers.
//   bun run server/index.ts            (PORT, BOTS, CORS_ORIGIN, ANTHROPIC_API_KEY, ELEVENLABS_API_KEY)
import type { ServerWebSocket } from "bun";
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { networkInterfaces } from "node:os";
import type { AgentToServer, ClientHello, Control, ViewerToServer } from "../shared/types";
import { parseGoal, sitrep } from "../ai";
import { createBrain } from "../engine/brains";
import { elevenLabsConfigured, speechToText, textToSpeech } from "./elevenlabs";
import { World } from "./world";

const PORT = Number(process.env.PORT ?? 3000);
const BOTS = Number(process.env.BOTS ?? 0);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const STATIC_DIR = normalize(join(import.meta.dir, "..", "web", "dist"));
const TICK_MS = 100;

const world = new World();

type SocketData = { role: "pending" | "viewer" | "agent"; id?: string; unsubscribe?: () => void };

// ---------- optional in-process bots (dev / fallback when no laptop host page is open) ----------
// Each bot is still an isolated agent: it only ever sees its own Sense, exactly like a remote one.
for (let n = 1; n <= BOTS; n++) {
    const id = `Echo-${n}`;
    let brain = createBrain("hive");
    let scenario = "";
    let lastTick = -1;
    world.addAgent(id, false, (msg) => {
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
        // Defer like a network hop so actions land after the tick finishes.
        queueMicrotask(() => world.applyAction(id, brain.step(s)));
    });
}

setInterval(() => world.step(), TICK_MS);

// ---------- HTTP helpers ----------
const cors = {
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
};

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors } });
}

function serveStatic(pathname: string): Response {
    if (!existsSync(STATIC_DIR)) {
        return new Response("Hive server running. Web build not found (web/dist).", { status: 200, headers: cors });
    }
    const safe = normalize(join(STATIC_DIR, pathname));
    if (!safe.startsWith(STATIC_DIR)) {
        return new Response("Not found", { status: 404 });
    }
    for (const candidate of [safe, join(safe, "index.html"), `${safe}.html`, join(STATIC_DIR, "index.html")]) {
        try {
            if (statSync(candidate).isFile()) {
                return new Response(Bun.file(candidate));
            }
        } catch {
            // not there, try the next candidate
        }
    }
    return new Response("Hive server running. Open the web app with ?server=<this host>.", { status: 200, headers: cors });
}

/** LAN IPv4s, best first. Skips loopback and virtual adapters (VirtualBox, WSL, Hyper-V, VMware, Docker). */
function lanAddresses(): { best: string | null; ips: { name: string; address: string }[] } {
    const virtual = /virtual|vbox|vmware|hyper-v|vethernet|wsl|docker|loopback|tailscale|zerotier/i;
    const ips: { name: string; address: string; score: number }[] = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
        for (const a of list ?? []) {
            if (a.family !== "IPv4" || a.internal) {
                continue;
            }
            let score = 0;
            if (virtual.test(name) || a.address.startsWith("192.168.56.") || a.address.startsWith("172.17.")) {
                score -= 10; // VirtualBox host-only / Docker bridge
            }
            if (/wi-?fi|wlan|wireless/i.test(name)) {
                score += 2;
            }
            if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
                score += 1;
            }
            ips.push({ name, address: a.address, score });
        }
    }
    ips.sort((a, b) => b.score - a.score);
    return { best: ips.find((x) => x.score >= 0)?.address ?? ips[0]?.address ?? null, ips: ips.map(({ name, address }) => ({ name, address })) };
}

// ---------- server ----------
const server = Bun.serve<SocketData, never>({
    port: PORT,
    async fetch(req, srv) {
        const url = new URL(req.url);
        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: cors });
        }
        if (url.pathname === "/ws") {
            if (srv.upgrade(req, { data: { role: "pending" } })) {
                return undefined;
            }
            return new Response("WebSocket upgrade failed", { status: 400 });
        }
        if (url.pathname === "/lan") {
            // Addresses phones on the same wifi can reach (QR codes can't use "localhost").
            return json(lanAddresses());
        }
        if (url.pathname === "/health") {
            const agents = world.allAgents();
            return json({
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
            const goal = await parseGoal(body.transcript ?? "", world.brief());
            const { source, ...goalBody } = goal;
            const firstHop = world.injectGoal(goalBody);
            return json({ goal: goalBody, source, firstHop });
        }
        if (url.pathname === "/ai/sitrep" && req.method === "GET") {
            return json(await sitrep(world.brief()));
        }
        if (url.pathname === "/stt" && req.method === "POST") {
            try {
                const form = await req.formData();
                const file = form.get("file");
                if (!(file instanceof Blob)) {
                    return json({ error: "multipart field 'file' required" }, 400);
                }
                return json({ text: await speechToText(file) });
            } catch (err) {
                return json({ error: err instanceof Error ? err.message : String(err) }, 502);
            }
        }
        if (url.pathname === "/tts" && req.method === "POST") {
            try {
                const body = (await req.json()) as { text?: string; voiceId?: string };
                if (!body.text || !body.voiceId) {
                    return json({ error: "text and voiceId required" }, 400);
                }
                const audio = await textToSpeech(body.text, body.voiceId);
                return new Response(audio, { headers: { "content-type": "audio/mpeg", ...cors } });
            } catch (err) {
                return json({ error: err instanceof Error ? err.message : String(err) }, 502);
            }
        }
        if (url.pathname === "/control" && req.method === "POST") {
            // HTTP fallback for controls (handy for scripts / curl during rehearsal).
            world.control((await req.json()) as Control);
            return json({ ok: true });
        }
        return serveStatic(url.pathname);
    },
    websocket: {
        maxPayloadLength: 256 * 1024,
        message(ws: ServerWebSocket<SocketData>, raw) {
            let msg: unknown;
            try {
                msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
            } catch {
                return;
            }
            const d = ws.data;
            if (d.role === "pending") {
                const hello = msg as ClientHello;
                if (hello.role === "viewer") {
                    d.role = "viewer";
                    d.unsubscribe = world.addViewer((m) => ws.send(JSON.stringify(m)));
                    return;
                }
                if (hello.role === "agent" && typeof hello.id === "string" && hello.id.length <= 32) {
                    d.role = "agent";
                    d.id = hello.id;
                    world.addAgent(hello.id, !!hello.isPhone, (m) => ws.send(JSON.stringify(m)));
                }
                return;
            }
            if (d.role === "agent" && d.id) {
                const m = msg as AgentToServer;
                if (m.t === "action" && m.action) {
                    world.applyAction(d.id, m.action);
                }
                return;
            }
            if (d.role === "viewer") {
                const m = msg as ViewerToServer;
                if (m.t === "control" && m.control) {
                    world.control(m.control);
                }
            }
        },
        close(ws: ServerWebSocket<SocketData>) {
            ws.data.unsubscribe?.();
            if (ws.data.role === "agent" && ws.data.id) {
                world.disconnectAgent(ws.data.id);
            }
        },
    },
});

console.log(`[hive] listening on :${server.port}  bots=${BOTS}  ai=${!!process.env.ANTHROPIC_API_KEY}  elevenlabs=${elevenLabsConfigured()}`);
