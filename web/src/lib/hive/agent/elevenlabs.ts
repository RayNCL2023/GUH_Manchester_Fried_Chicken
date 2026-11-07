// Server only. Provisions the "Hive Ground Control" ElevenLabs agent (its client tools and prompt) on first
// use, then hands out signed conversation URLs so the API key never reaches the browser.
// Bump AGENT_NAME's version whenever the prompt or tools change: a fresh agent gets created.
const BASE = "https://api.elevenlabs.io/v1";
const AGENT_NAME = "Hive Ground Control v1";
const VOICE_ID = "onwK4e9ZLuTAKqWW03F9"; // Daniel: steady British broadcaster
const LLM = "gemini-2.5-flash";

const PROMPT = `You are GROUND CONTROL, the voice of the ground-station antenna on the roof of {{antenna_name}}, in {{area_name}}.
A leaderless swarm of firefighting drones works the area: Echo scouts that map the fire edge, Sky high-altitude scouts, and Water drones that spray.

What you know is ONLY what the drones radio down to your antenna. A drone is "direct" when it has a clear path to the antenna, "relay" when its path is jammed but other drones pass its data on over the mesh, and "dark" when nobody can hear it (jammed, out of range, or destroyed: you cannot tell which). If the antenna itself is jammed you hear nothing and can send nothing, so say so plainly.

You will receive context lines starting with [ANTENNA]. Lines starting with [ANTENNA ALERT] are urgent: report them to the operator straight away, in one short sentence.

Your job, in order:
1. Report. Keep it like radio traffic: short, calm, specific. Numbers, drone call-signs, distance and compass direction from the antenna. Never invent drones, fires or positions.
2. Take orders. When the operator names a place (a building, a street, an address, or a what3words address like "filled count soap"), call locate_place first, then dispatch_drones with the coordinates it returns. If the place is outside the operating area, say so and do not dispatch.
3. Read back. After a dispatch, confirm which drones were tasked and which drone relayed the order. If the uplink fails, say why.

Call get_status before answering any question about the fleet, the fire or the link. Only call simulate_fire when the operator explicitly asks you to start, simulate or drill a fire. Spell what3words addresses with dots between the words when you pass them to locate_place, prefixed with three slashes.
Never read out raw coordinates unless asked; use landmark names and "metres north-east of the antenna" style directions.`;

type ToolParam = { type: "string" | "number" | "integer" | "boolean"; description: string };
type ToolDef = { name: string; description: string; params: Record<string, ToolParam>; required: string[] };

export const TOOLS: ToolDef[] = [
	{
		name: "get_status",
		description:
			"Read the ground station's current picture: which drones are reporting (direct, via mesh relay, dark), known fires with distance and direction from the antenna, active orders and how many drones are on scene, packet loss, and the latest events.",
		params: {},
		required: [],
	},
	{
		name: "locate_place",
		description:
			"Find the real-world location of a place the operator mentions: a building, landmark, street, address, or a what3words address (///word.word.word). Returns its name, latitude, longitude, and whether it is inside the drones' operating area.",
		params: { query: { type: "string", description: "What the operator said, e.g. 'Kilburn Building', 'Oxford Road and Booth Street', '///filled.count.soap'" } },
		required: ["query"],
	},
	{
		name: "dispatch_drones",
		description:
			"Uplink an order from the antenna to the swarm: send drones to a location. The order leaves the antenna to one drone with a clear path and floods drone to drone. Fails if the antenna is jammed or no drone can hear it.",
		params: {
			lat: { type: "number", description: "Latitude of the target (from locate_place or get_status)" },
			lon: { type: "number", description: "Longitude of the target" },
			task: { type: "string", description: "Short order text, e.g. 'Fire reported at Kilburn Building, investigate'" },
			crew: { type: "integer", description: "How many drones to send (default 4)" },
			role: { type: "string", description: "Which drones: 'echo' (scouts, default), 'water' (firefighters), 'sky', or 'any'" },
		},
		required: ["lat", "lon", "task"],
	},
	{
		name: "simulate_fire",
		description: "TRAINING ONLY. Start a simulated fire at a location so the operator can watch the swarm respond. Use only when explicitly asked to start, simulate or drill a fire.",
		params: {
			lat: { type: "number", description: "Latitude" },
			lon: { type: "number", description: "Longitude" },
		},
		required: ["lat", "lon"],
	},
];

function key() {
	return process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY || "";
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "xi-api-key": key(), "content-type": "application/json", ...(init.headers ?? {}) },
		signal: AbortSignal.timeout(15000),
	});
	if (!res.ok) {
		throw new Error(`ElevenLabs ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
	}
	return res.json() as Promise<T>;
}

async function createTool(t: ToolDef) {
	const { id } = await api<{ id: string }>("/convai/tools", {
		method: "POST",
		body: JSON.stringify({
			tool_config: {
				type: "client",
				name: t.name,
				description: t.description,
				parameters: { type: "object", properties: t.params, required: t.required },
				expects_response: true,
				response_timeout_secs: 20,
			},
		}),
	});
	return id;
}

async function findAgent(): Promise<string | null> {
	const { agents } = await api<{ agents: { agent_id: string; name: string }[] }>(
		`/convai/agents?page_size=30&search=${encodeURIComponent(AGENT_NAME)}`,
	);
	return agents.find((a) => a.name === AGENT_NAME)?.agent_id ?? null;
}

async function createAgent() {
	const toolIds = await Promise.all(TOOLS.map(createTool));
	const { agent_id } = await api<{ agent_id: string }>("/convai/agents/create", {
		method: "POST",
		body: JSON.stringify({
			name: AGENT_NAME,
			tags: ["hive"],
			conversation_config: {
				agent: {
					first_message: "Ground Control on {{antenna_name}}. Antenna is up and listening to the flock. Go ahead.",
					language: "en",
					dynamic_variables: { dynamic_variable_placeholders: { antenna_name: "the antenna", area_name: "the area" } },
					prompt: { prompt: PROMPT, llm: LLM, temperature: 0.3, tool_ids: toolIds },
				},
				tts: { voice_id: VOICE_ID },
			},
		}),
	});
	return agent_id;
}

let agent: Promise<string> | null = null;

export function elevenLabsReady() {
	return key() !== "";
}

// One lookup per server instance; a failed attempt is retried on the next request.
export function agentId(): Promise<string> {
	const fixed = process.env.ELEVENLABS_AGENT_ID;
	if (fixed) {
		return Promise.resolve(fixed);
	}
	agent ??= (async () => (await findAgent()) ?? (await createAgent()))().catch((e) => {
		agent = null;
		throw e;
	});
	return agent;
}

export async function signedUrl() {
	const id = await agentId();
	const { signed_url } = await api<{ signed_url: string }>(`/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(id)}`);
	return signed_url;
}
