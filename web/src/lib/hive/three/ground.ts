// The world under the sim: Google Photorealistic 3D Tiles (the Google Earth mesh).
import { BufferGeometry, Mesh, type Camera, type Object3D, type WebGLRenderer } from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TilesFadePlugin } from "3d-tiles-renderer/plugins";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { Frame } from "./geo";

// BVH-accelerated raycasts: the heightmap fires thousands of rays at the tiles.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

export interface Ground {
	readonly object: Object3D;
	update(cameras: Camera[], renderer: WebGLRenderer): void;
	// 0..1 while the first view is still streaming in; ready once it has settled.
	readonly progress: number;
	readonly ready: boolean;
	credits(): string;
	dispose(): void;
}

const GOOGLE_ROOT = "https://tile.googleapis.com/v1/3dtiles/root.json";
const DRACO = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";
// Tiles load coarse-to-fine: each finished level queues the next, so "idle once" is not "loaded".
// Ready = nothing in flight for this long, or the cap runs out.
const SETTLE_MS = 600;
const READY_CAP_MS = 15000;

export class GoogleGround implements Ground {
	readonly object: Object3D;
	private tiles: TilesRenderer;
	private draco = new DRACOLoader().setDecoderPath(DRACO);
	private models = 0;
	private born = performance.now();
	private quietSince = 0;
	ready = false;
	progress = 0;

	constructor(
		frame: Frame,
		key: string,
		on: { change: () => void; model: (scene: Object3D) => void; error: (msg: string) => void },
	) {
		const tiles = new TilesRenderer(GOOGLE_ROOT);
		tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
		tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco }));
		tiles.registerPlugin(new TilesFadePlugin());
		tiles.registerPlugin(
			new ReorientationPlugin({ lat: (frame.area.lat * Math.PI) / 180, lon: (frame.area.lon * Math.PI) / 180, height: 0, recenter: true }),
		);

		tiles.addEventListener("load-model", ({ scene }) => {
			scene.traverse((o) => {
				if (o instanceof Mesh) {
					o.geometry.computeBoundsTree();
				}
			});
			on.model(scene);
			this.models++;
			on.change();
		});
		tiles.addEventListener("dispose-model", ({ scene }) => {
			scene.traverse((o) => {
				if (o instanceof Mesh) {
					o.geometry.disposeBoundsTree();
				}
			});
		});
		tiles.addEventListener("load-error", ({ error }: { error: Error }) => {
			if (!tiles.root) {
				on.error(error?.message ?? "Google 3D Tiles failed to load");
			}
		});

		// Keep the tile cache well under the browser's budget (BVHs roughly double each tile's footprint).
		tiles.lruCache.minBytesSize = 0.15 * 2 ** 30;
		tiles.lruCache.maxBytesSize = 0.25 * 2 ** 30;
		tiles.lruCache.maxSize = 3000;
		tiles.lruCache.minSize = 2000;
		this.tiles = tiles;
		this.object = tiles.group;
	}

	update(cameras: Camera[], renderer: WebGLRenderer) {
		for (const cam of cameras) {
			this.tiles.setCamera(cam);
			this.tiles.setResolutionFromRenderer(cam, renderer);
		}
		this.tiles.update();
		this.settle();
	}

	private settle() {
		if (this.ready) {
			return;
		}
		const now = performance.now();
		// `stats` exists at runtime but is missing from the typings.
		const { queued, downloading, parsing } = (this.tiles as unknown as { stats: Record<string, number> }).stats;
		const busy = queued + downloading + parsing > 0 || this.models === 0;
		this.progress = Math.max(this.progress, Math.min(0.99, this.tiles.loadProgress));
		if (busy) {
			this.quietSince = now;
		}
		if ((!busy && now - this.quietSince > SETTLE_MS) || now - this.born > READY_CAP_MS) {
			this.ready = true;
			this.progress = 1;
		}
	}

	credits() {
		const names = this.tiles
			.getAttributions()
			.filter((a) => a.type === "string")
			.map((a) => String(a.value));
		return `Google${names.length ? ` · ${names.join(" · ")}` : ""}`;
	}

	dispose() {
		this.tiles.dispose();
		this.draco.dispose();
	}
}
