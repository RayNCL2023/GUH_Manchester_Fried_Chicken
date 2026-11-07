import { locate } from "@/lib/hive/agent/locate";

// Place lookup for the voice agent's locate_place tool.
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { query?: string; near?: { lat: number; lon: number; name?: string } } | null;
	if (!body?.query || !body.near) {
		return Response.json({ ok: false, error: "Send { query, near: { lat, lon } }." }, { status: 400 });
	}
	return Response.json(await locate(body.query, body.near));
}
