import { elevenLabsReady, signedUrl } from "@/lib/hive/agent/elevenlabs";

// Signed ElevenLabs conversation URL for the Ground Control voice agent.
export async function GET() {
	if (!elevenLabsReady()) {
		return Response.json({ error: "ELEVENLABS_API_KEY is not set on the server." }, { status: 503 });
	}
	try {
		return Response.json({ signedUrl: await signedUrl() }, { headers: { "cache-control": "no-store" } });
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : "Could not start the agent." }, { status: 502 });
	}
}
