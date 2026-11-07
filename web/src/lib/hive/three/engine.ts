// The 3D world: renderer, cameras (orbit / chase / drone's-eye), ground, fire, flock and traffic.
import {
	ACESFilmicToneMapping,
	Clock,
	Color,
	DirectionalLight,
	Fog,
	HemisphereLight,
	PerspectiveCamera,
	Raycaster,
	Scene,
	Vector2,
	Vector3,
	WebGLRenderer,
} from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import type { WorldView } from "../../../../../shared/types";
import type { LoadedArea } from "../osm";
import { DroneFX } from "./drones";
import { FireFX } from "./fire";
import { Frame, Heightmap } from "./geo";
import { BlocksGround, GoogleGround, type Ground } from "./ground";
import { loadModels } from "./models";
import { Traffic } from "./traffic";

export type CamMode = "orbit" | "follow" | "drone";
export type GroundMode = "photoreal" | "blocks";

export type EngineEvents = {
	pickDrone: (id: string, shift: boolean) => void;
	pickGround: (cell: { x: number; y: number }) => void;
	status: (s: { credits: string; groundError?: string; heightsReady: boolean; loading: number; cars: number }) => void;
};

const SKY = new Color("#a9c1d6");
const INSET = { w: 0.3, aspect: 4 / 3, pad: 16 };

export default class Engine {
	private renderer: WebGLRenderer;
	private scene = new Scene();
	private camera: PerspectiveCamera;
	private eye: PerspectiveCamera; // drone's-eye, looking straight down
	private controls: MapControls;
	private frame: Frame;
	private ground!: Ground;
	private heights: Heightmap;
	private fire: FireFX;
	private drones: DroneFX | null = null;
	private traffic: Traffic | null = null;
	private lastView: WorldView | null = null;
	private trafficOn = true;
	private disposed = false;
	private clock = new Clock();
	private raf = 0;
	private resize: ResizeObserver;
	private cam: CamMode = "orbit";
	private groundMode: GroundMode = "blocks";
	private framed = false;
	private settledPass = -1; // heightmap pass count when the ground finished loading
	private statusAt = 0;
	private down = new Vector2();
	private ray = new Raycaster();

	constructor(
		private host: HTMLElement,
		area: LoadedArea,
		private opts: { googleKey?: string; ground: GroundMode; satellite: HTMLCanvasElement | null; sensorCells: number },
		private on: EngineEvents,
	) {
		this.frame = new Frame(area);
		this.renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
		this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.setScissorTest(false);
		host.appendChild(this.renderer.domElement);
		this.renderer.domElement.style.display = "block";
		this.renderer.domElement.style.touchAction = "none";

		this.scene.background = SKY;
		this.scene.fog = new Fog(SKY, 2500, 9000);
		this.scene.add(new HemisphereLight(0xdfe9f5, 0x4a4438, 1.6));
		const sun = new DirectionalLight(0xfff1dc, 2.2);
		sun.position.set(-300, 600, -200);
		this.scene.add(sun);

		this.camera = new PerspectiveCamera(50, 1, 1, 30000);
		this.eye = new PerspectiveCamera(70, INSET.aspect, 0.5, 30000);
		// Google Maps-style: left-drag pans the ground, right/ctrl-drag tilts and turns, wheel zooms to the cursor.
		const span = Math.max(this.frame.w, this.frame.h) * this.frame.m;
		this.controls = new MapControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.12;
		this.controls.screenSpacePanning = false;
		this.controls.zoomToCursor = true;
		this.controls.zoomSpeed = 1.4;
		this.controls.rotateSpeed = 0.6;
		this.controls.minPolarAngle = 0;
		this.controls.maxPolarAngle = Math.PI * 0.42;
		this.controls.minDistance = 25;
		this.controls.maxDistance = span * 1.1;

		this.heights = new Heightmap(this.frame, this.scene);
		this.setGround(opts.ground);

		this.fire = new FireFX(this.frame, this.heights);
		this.fire.addTo(this.scene);
		// Vehicles and drones wait for the GLBs so they're built from the real models.
		loadModels().then(() => {
			if (this.disposed) {
				return;
			}
			this.drones = new DroneFX(this.frame, this.heights, opts.sensorCells);
			this.drones.addTo(this.scene);
			this.traffic = new Traffic(this.frame, this.heights, this.fire);
			this.traffic.addTo(this.scene);
			this.traffic.setEnabled(this.trafficOn);
			this.drones.selected = this.selected;
			if (this.lastView) {
				this.drones.setView(this.lastView);
			}
		});

		this.resize = new ResizeObserver(() => this.fit());
		this.resize.observe(host);
		this.fit();
		this.frameCamera();

		const el = this.renderer.domElement;
		el.addEventListener("pointerdown", this.onDown);
		el.addEventListener("pointerup", this.onUp);
		// The page must never scroll under the map, whatever camera mode is active.
		host.addEventListener("wheel", this.onWheel, { passive: false });
		el.addEventListener("contextmenu", this.onContext);
		this.loop();
	}

	// ---------- ground ----------

	setGround(mode: GroundMode, force = false) {
		if (this.ground && mode === this.groundMode && !force) {
			return;
		}
		this.groundMode = mode;
		if (this.ground) {
			this.scene.remove(this.ground.object);
			this.ground.dispose();
		}
		const useGoogle = mode === "photoreal" && !!this.opts.googleKey;
		this.ground = useGoogle
			? new GoogleGround(this.frame, this.opts.googleKey!, {
					change: () => this.heights.invalidate(),
					error: (msg) =>
						this.on.status({ credits: "", groundError: msg, heightsReady: false, loading: 0, cars: this.traffic?.count ?? 0 }),
				})
			: new BlocksGround(this.frame, this.opts.satellite);
		this.scene.add(this.ground.object);
		this.heights.setTarget(this.ground.object);
		this.framed = false;
		this.settledPass = -1;
	}

	// Close over the centre, tilted ~45° and facing north, like opening a 3D city in Google Maps.
	private frameCamera() {
		const g = this.heights.base;
		const span = Math.max(this.frame.w, this.frame.h) * this.frame.m;
		const dist = Math.min(700, span * 0.45);
		const tilt = Math.PI * 0.25;
		this.controls.target.set(0, g, 0);
		this.camera.position.set(0, g + Math.cos(tilt) * dist, -Math.sin(tilt) * dist);
		this.camera.lookAt(this.controls.target);
		this.controls.update();
	}

	// Keep the look-at point over the area and on the ground, so panning can't wander off into the void.
	private clampTarget() {
		const t = this.controls.target;
		const hx = (this.frame.w * this.frame.m) / 2;
		const hz = (this.frame.h * this.frame.m) / 2;
		const dx = Math.max(-hx, Math.min(hx, t.x)) - t.x;
		const dz = Math.max(-hz, Math.min(hz, t.z)) - t.z;
		const dy = this.heights.base - t.y;
		if (!dx && !dz && Math.abs(dy) < 0.01) {
			return;
		}
		t.x += dx;
		t.y += dy;
		t.z += dz;
		this.camera.position.x += dx;
		this.camera.position.y += dy;
		this.camera.position.z += dz;
	}

	// ---------- sim input ----------

	setView(view: WorldView) {
		this.fire.setCells(view.cells, view.wind);
		this.lastView = view;
		this.drones?.setView(view);
	}

	reset() {
		this.fire.reset();
	}

	// Satellite imagery arrives after the map; the blocks ground is rebuilt to show it.
	setSatellite(canvas: HTMLCanvasElement | null) {
		this.opts.satellite = canvas;
		if (this.groundMode === "blocks") {
			this.setGround("blocks", true);
		}
	}

	setCamera(mode: CamMode) {
		this.cam = mode;
		this.controls.enabled = mode === "orbit";
	}

	private selected: string | null = null;

	setSelected(id: string | null) {
		this.selected = id;
		if (this.drones) {
			this.drones.selected = id;
		}
	}

	setTraffic(on: boolean) {
		this.trafficOn = on;
		this.traffic?.setEnabled(on);
	}

	// ---------- input ----------

	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
	};

	private onContext = (e: Event) => {
		e.preventDefault();
	};

	private onDown = (e: PointerEvent) => {
		this.down.set(e.clientX, e.clientY);
	};

	private onUp = (e: PointerEvent) => {
		if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) {
			return; // a drag, not a click
		}
		const rect = this.renderer.domElement.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		const inset = this.insetRect(rect.width, rect.height);
		let cam = this.cam === "drone" && this.selected ? this.eye : this.camera;
		let ndc = new Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
		if (inset && px >= inset.x && py >= rect.height - inset.y - inset.h && px <= inset.x + inset.w && py <= rect.height - inset.y) {
			cam = this.eye;
			ndc = new Vector2(((px - inset.x) / inset.w) * 2 - 1, -((py - (rect.height - inset.y - inset.h)) / inset.h) * 2 + 1);
		}
		this.ray.setFromCamera(ndc, cam);

		const drone = this.drones && this.ray.intersectObjects(this.drones.pickables(), false)[0];
		if (drone && this.drones) {
			const id = this.drones.idOf(drone.object);
			if (id) {
				this.on.pickDrone(id, e.shiftKey);
				return;
			}
		}
		const hit = this.ray.intersectObject(this.ground.object, true)[0];
		if (hit) {
			this.on.pickGround(this.frame.cellOf(hit.point));
		}
	};

	// ---------- render ----------

	private fit() {
		const w = this.host.clientWidth;
		const h = this.host.clientHeight;
		this.renderer.setSize(w, h);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	// Bottom-right picture-in-picture, in CSS pixels from the bottom-left (WebGL viewport space).
	private insetRect(w: number, h: number) {
		if (!this.selected || this.cam === "drone") {
			return null;
		}
		const iw = Math.round(Math.max(220, w * INSET.w));
		const ih = Math.round(iw / INSET.aspect);
		return { x: w - iw - INSET.pad, y: INSET.pad, w: iw, h: ih };
	}

	private placeEye(): boolean {
		const id = this.selected;
		const p = id && this.drones?.position(id);
		if (!p || !this.drones) {
			return false;
		}
		const yaw = this.drones.heading(id);
		this.eye.position.copy(p).setY(p.y - 1.5);
		// Straight down, with the top of the frame pointing where the drone is heading.
		this.eye.up.set(Math.sin(yaw), 0, Math.cos(yaw));
		this.eye.lookAt(p.x, p.y - 100, p.z);
		this.eye.updateMatrixWorld();
		return true;
	}

	private chase(dt: number) {
		const id = this.selected;
		const p = id && this.drones?.position(id);
		if (!p || !this.drones) {
			return;
		}
		const yaw = this.drones.heading(id);
		const want = new Vector3(p.x - Math.sin(yaw) * 45, p.y + 22, p.z - Math.cos(yaw) * 45);
		this.camera.position.lerp(want, Math.min(1, dt * 2.5));
		this.controls.target.lerp(p, Math.min(1, dt * 5));
		this.camera.lookAt(this.controls.target);
	}

	private loop = () => {
		this.raf = requestAnimationFrame(this.loop);
		const dt = Math.min(0.05, this.clock.getDelta());
		const now = this.clock.elapsedTime;

		this.heights.step(500);
		// Once the tiles settle, rescan heights over the full-detail mesh, then frame on that.
		if (this.settledPass < 0 && this.ground.ready) {
			this.settledPass = this.heights.passes;
			this.heights.invalidate();
		}
		if (!this.framed && this.settledPass >= 0 && this.heights.passes > this.settledPass && this.heights.ready) {
			this.framed = true;
			this.frameCamera();
			this.statusAt = -Infinity; // tell the UI straight away so the loading cover lifts
		}
		// Re-seat ground decals as the height map refines.
		if (Math.floor(now * 2) !== Math.floor((now - dt) * 2)) {
			this.fire.relayout();
		}

		this.fire.update(dt);
		this.drones?.update(dt, now);
		this.traffic?.update(dt);

		if (this.cam === "follow") {
			this.chase(dt);
		} else {
			this.controls.update();
			this.clampTarget();
		}
		const hasEye = this.placeEye();
		this.camera.updateMatrixWorld();

		const cams = hasEye ? [this.camera, this.eye] : [this.camera];
		this.ground.update(cams, this.renderer);

		const r = this.renderer;
		const size = r.getSize(new Vector2());
		if (this.cam === "drone" && hasEye) {
			this.eye.aspect = size.x / size.y;
			this.eye.updateProjectionMatrix();
			r.setViewport(0, 0, size.x, size.y);
			r.render(this.scene, this.eye);
		} else {
			r.setScissorTest(false);
			r.setViewport(0, 0, size.x, size.y);
			r.render(this.scene, this.camera);
			const inset = hasEye && this.insetRect(size.x, size.y);
			if (inset) {
				this.eye.aspect = INSET.aspect;
				this.eye.updateProjectionMatrix();
				r.setScissorTest(true);
				r.setScissor(inset.x, inset.y, inset.w, inset.h);
				r.setViewport(inset.x, inset.y, inset.w, inset.h);
				r.render(this.scene, this.eye);
				r.setScissorTest(false);
			}
		}

		if (now - this.statusAt > 1) {
			this.statusAt = now;
			this.on.status({
				credits: this.ground.credits(),
				heightsReady: this.framed,
				loading: this.ground.progress,
				cars: this.traffic?.count ?? 0,
			});
		}
	};

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.raf);
		this.resize.disconnect();
		const el = this.renderer.domElement;
		el.removeEventListener("pointerdown", this.onDown);
		el.removeEventListener("pointerup", this.onUp);
		el.removeEventListener("contextmenu", this.onContext);
		this.host.removeEventListener("wheel", this.onWheel);
		this.controls.dispose();
		this.ground.dispose();
		this.fire.dispose();
		this.drones?.dispose();
		this.traffic?.dispose();
		this.renderer.dispose();
		el.remove();
	}
}
