/// <reference types="bun" />
// Pre-bakes the preset areas so the demo works offline: bun run scripts/bakeOsm.ts
import { PRESETS, fetchOverpass } from "../src/lib/hive/osm";

for (const a of PRESETS) {
	const data = await fetchOverpass(a);
	await Bun.write(`public/osm/${a.id}.json`, JSON.stringify(data));
	console.log(`${a.id}: ${data.elements.length} features`);
	await Bun.sleep(1500); // be polite to the public Overpass server
}
