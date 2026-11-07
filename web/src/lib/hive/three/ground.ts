// The world under the sim: Google Photorealistic 3D Tiles (the Google Earth mesh), or an offline
// fallback of satellite imagery + OSM buildings extruded to their tagged heights.
import {
	BufferGeometry,
	CanvasTexture,
	DoubleSide,
	ExtrudeGeometry,
	Group,
	Mesh,
	MeshLambertMaterial,
	PlaneGeometry,
	SRGBColorSpace,
	Shape,
	type Camera,
	type Object3D,
	type WebGLRenderer,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
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
	credits(): string;
	dispose(): void;
}

const GOOGLE_ROOT = "https://tile.googleapis.com/v1/3dtiles/root.json";
const DRACO = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";

export class GoogleGround implements Ground {
	readonly object: Object3D;
	private tiles: TilesRenderer;
	private draco = new DRACOLoader().setDecoderPath(DRACO);

	constructor(
		frame: Frame,
		key: string,
		on: { change: () => void; error: (msg: string) => void },
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

		this.tiles = tiles;
		this.object = tiles.group;
	}

	update(cameras: Camera[], renderer: WebGLRenderer) {
		for (const cam of cameras) {
			this.tiles.setCamera(cam);
			this.tiles.setResolutionFromRenderer(cam, renderer);
		}
		this.tiles.update();
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

const LEVEL_M = 3.2;

// Real height when OSM has it, else a stable per-building guess.
function buildingHeight(tags: Record<string, string>, seed: number) {
	const h = parseFloat(tags.height ?? "");
	if (h > 0) {
		return h;
	}
	const levels = parseFloat(tags["building:levels"] ?? "");
	if (levels > 0) {
		return levels * LEVEL_M + 1;
	}
	if (["house", "detached", "semidetached_house", "terrace", "garage", "shed"].includes(tags.building)) {
		return 6 + (seed % 3);
	}
	return 9 + (seed % 9);
}

export class BlocksGround implements Ground {
	readonly object = new Group();
	private disposables: { dispose(): void }[] = [];

	constructor(frame: Frame, satellite: HTMLCanvasElement | null) {
		const width = frame.w * frame.m;
		const depth = frame.h * frame.m;

		const groundMat = new MeshLambertMaterial({ color: satellite ? 0xffffff : 0x3a3d36 });
		if (satellite) {
			const tex = new CanvasTexture(satellite);
			tex.colorSpace = SRGBColorSpace;
			groundMat.map = tex;
			this.disposables.push(tex);
		}
		const plane = new PlaneGeometry(width, depth);
		plane.rotateX(-Math.PI / 2);
		// Image left (west) must land at +X and image top (north) at +Z.
		plane.rotateY(Math.PI);
		const groundMesh = new Mesh(plane, groundMat);
		groundMat.side = DoubleSide;
		this.object.add(groundMesh);
		this.disposables.push(plane, groundMat);

		const parts: BufferGeometry[] = [];
		frame.area.osm.elements.forEach((el, k) => {
			const tags = el.tags ?? {};
			if (!tags.building || !el.geometry || el.geometry.length < 4) {
				return;
			}
			const pts = el.geometry.map((p) => frame.latLonEN(p.lat, p.lon));
			if (!pts.some((p) => frame.inBounds(p.e, p.n))) {
				return;
			}
			// Shape (u, v) = (worldX, -worldZ); rotating -90° about X maps extrude depth to +Y.
			const shape = new Shape(pts.map((p) => ({ x: -p.e, y: -p.n }) as never));
			const g = new ExtrudeGeometry(shape, { depth: buildingHeight(tags, k), bevelEnabled: false });
			g.rotateX(-Math.PI / 2);
			parts.push(g);
		});

		if (parts.length) {
			const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
			parts.forEach((g) => g.dispose());
			merged.computeVertexNormals();
			merged.computeBoundsTree();
			const mat = new MeshLambertMaterial({ color: 0xd8d4cb, side: DoubleSide });
			this.object.add(new Mesh(merged, mat));
			this.disposables.push(merged, mat);
		}
		plane.computeBoundsTree();
	}

	update() {}

	credits() {
		return "© OpenStreetMap contributors · Imagery © Esri, Maxar, Earthstar Geographics";
	}

	dispose() {
		this.disposables.forEach((d) => d.dispose());
	}
}
