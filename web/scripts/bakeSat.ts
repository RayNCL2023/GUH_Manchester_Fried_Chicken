/// <reference types="bun" />
// Pre-bakes satellite tiles for the presets: bun run scripts/bakeSat.ts
import { PRESETS } from "../src/lib/hive/osm";
import { tileUrl, tilesFor, zoomFor } from "../src/lib/hive/satellite";

const CELL_PX = 12; // must match FireMap's CELL

for (const a of PRESETS) {
	const z = zoomFor(a, CELL_PX);
	const tiles = tilesFor(a, z);
	let bytes = 0;
	for (const { x, y } of tiles) {
		const res = await fetch(tileUrl(z, x, y));
		if (!res.ok) {
			throw new Error(`${a.id} ${z}/${x}/${y}: ${res.status}`);
		}
		const buf = await res.arrayBuffer();
		bytes += buf.byteLength;
		await Bun.write(`public/sat/${a.id}/${z}/${x}/${y}.jpg`, buf);
	}
	console.log(`${a.id}: z${z}, ${tiles.length} tiles, ${(bytes / 1024).toFixed(0)} KB`);
}
