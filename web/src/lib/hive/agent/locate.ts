// Server only. Turns what the operator said into real coordinates:
//   1. a small model on the Vercel AI Gateway cleans up the spoken phrase into a search (and spots what3words),
//   2. Google Places text search, biased to the operating area,
//   3. what3words' API for ///word.word.word (needs W3W_API_KEY), and Nominatim as the last resort.
const GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash-lite";
const PLACES = "https://places.googleapis.com/v1/places:searchText";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const BIAS_M = 3000;
const BOX = 0.012; // degrees of latitude (~1.3 km) either side of the area centre

export type Place = { name: string; address: string; lat: number; lon: number };
export type LocateResult = { ok: true; source: string; place: Place; alternatives: Place[] } | { ok: false; error: string };

type Near = { lat: number; lon: number; name?: string };

const W3W = /^\/{0,3}\s*([a-z]+)[.\s]+([a-z]+)[.\s]+([a-z]+)\s*$/i;

const SYSTEM = `You turn a radio operator's spoken place reference into a map search.
Reply with JSON only: {"search": string, "what3words": string | null}.
- "search": a Google Maps text query for the place itself, without words about fire, drones or actions, and with the city appended if it helps (e.g. "Kilburn Building, Manchester").
- "what3words": only when the operator clearly gave a what3words address (they say "what three words", "slash slash slash", or give exactly three unrelated dictionary words as an address). Format word.word.word. Otherwise null. Never make one up.`;

async function interpret(query: string, near: Near): Promise<{ search: string; what3words: string | null }> {
	const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY;
	const plain = { search: query, what3words: W3W.test(query.trim()) ? query.replace(/[/\s]+/g, ".").replace(/^\.+/, "") : null };
	if (!key) {
		return plain;
	}
	try {
		const res = await fetch(GATEWAY, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: MODEL,
				temperature: 0,
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: SYSTEM },
					{ role: "user", content: `Operating area: ${near.name ?? "unknown"} (around ${near.lat.toFixed(4)}, ${near.lon.toFixed(4)}).\nOperator said: "${query}"` },
				],
			}),
			signal: AbortSignal.timeout(6000),
		});
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const out = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as { search?: string; what3words?: string | null };
		return { search: out.search?.trim() || query, what3words: out.what3words?.trim() || plain.what3words };
	} catch {
		return plain;
	}
}

async function what3words(words: string): Promise<Place | null> {
	const key = process.env.W3W_API_KEY;
	if (!key) {
		return null;
	}
	const res = await fetch(`https://api.what3words.com/v3/convert-to-coordinates?words=${encodeURIComponent(words)}&key=${key}`, {
		signal: AbortSignal.timeout(5000),
	});
	const d = (await res.json()) as { coordinates?: { lat: number; lng: number }; nearestPlace?: string };
	return d.coordinates ? { name: `///${words}`, address: d.nearestPlace ?? "", lat: d.coordinates.lat, lon: d.coordinates.lng } : null;
}

// restrict = only inside a box around the area (so "Kilburn" finds the building, not Kilburn Avenue 8 km away).
async function places(search: string, near: Near, restrict: boolean): Promise<Place[]> {
	const key = process.env.GOOGLE_PLACES_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
	if (!key) {
		return [];
	}
	const res = await fetch(PLACES, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-Goog-Api-Key": key,
			"X-Goog-FieldMask": "places.displayName,places.location,places.formattedAddress",
		},
		body: JSON.stringify({
			textQuery: search,
			maxResultCount: 4,
			...(restrict
				? { locationRestriction: { rectangle: { low: { latitude: near.lat - BOX, longitude: near.lon - BOX * 1.6 }, high: { latitude: near.lat + BOX, longitude: near.lon + BOX * 1.6 } } } }
				: { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: BIAS_M } } }),
		}),
		signal: AbortSignal.timeout(6000),
	});
	if (!res.ok) {
		return [];
	}
	const d = (await res.json()) as { places?: { displayName?: { text: string }; formattedAddress?: string; location: { latitude: number; longitude: number } }[] };
	return (d.places ?? []).map((p) => ({
		name: p.displayName?.text ?? search,
		address: p.formattedAddress ?? "",
		lat: p.location.latitude,
		lon: p.location.longitude,
	}));
}

async function nominatim(search: string, near: Near): Promise<Place[]> {
	const d = 0.03;
	const url = `${NOMINATIM}?format=json&limit=3&q=${encodeURIComponent(search)}&viewbox=${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`;
	const res = await fetch(url, { headers: { "user-agent": "hive-ground-control/1.0" }, signal: AbortSignal.timeout(6000) });
	const rows = (await res.json()) as { display_name: string; lat: string; lon: string; name?: string }[];
	return rows.map((r) => ({ name: r.name || r.display_name.split(",")[0], address: r.display_name, lat: +r.lat, lon: +r.lon }));
}

export async function locate(query: string, near: Near): Promise<LocateResult> {
	const { search, what3words: words } = await interpret(query, near);
	if (words) {
		const hit = await what3words(words).catch(() => null);
		if (hit) {
			return { ok: true, source: "what3words", place: hit, alternatives: [] };
		}
		if (!process.env.W3W_API_KEY && W3W.test(query.trim())) {
			return { ok: false, error: "what3words lookups aren't configured on this server (W3W_API_KEY). Ask for a building or street name instead." };
		}
	}
	for (const [source, find] of [
		["google", (q: string, n: Near) => places(q, n, true)],
		["google", (q: string, n: Near) => places(q, n, false)],
		["openstreetmap", nominatim],
	] as const) {
		const hits = await find(search, near).catch(() => []);
		if (hits.length) {
			return { ok: true, source, place: hits[0], alternatives: hits.slice(1) };
		}
	}
	return { ok: false, error: `Couldn't find "${search}".` };
}
