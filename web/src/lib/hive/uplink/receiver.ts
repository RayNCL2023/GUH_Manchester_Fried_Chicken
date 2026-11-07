// Phone-side state: fountain decoder, sound-derived clock and link stats. No audio or React here.
import { LtDecoder } from "./fountain";
import { BLOCK, RELAY_SEED, blockCount, decodeMission, parseFrame, payloadLength, type Mission } from "./packet";

export type Stats = {
	frames: number; // frames decoded off the air
	hostFrames: number; // of those, from the laptop
	relayFrames: number; // from other phones
	hostSent: number; // laptop frames that must have been sent (from its seed counter)
	bytes: number; // raw frame bytes heard
	linkBps: number; // bytes/s heard, first frame to last
	goodputBps: number; // payload bytes/s, first frame to completion
	firstAt: number | null;
	doneAt: number | null;
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export class Receiver {
	msgId = -1;
	w = 0;
	h = 0;
	decoder: LtDecoder | null = null;
	order: number[] = []; // blocks in the order this phone learnt them
	mission: Mission | null = null;
	private starts: number[] = [];
	private hostSeeds = new Set<number>();
	private minSeed = Infinity;
	private maxSeed = -1;
	stats: Stats = { frames: 0, hostFrames: 0, relayFrames: 0, hostSent: 0, bytes: 0, linkBps: 0, goodputBps: 0, firstAt: null, doneAt: null };

	// Local time the show starts, learnt from the countdowns we heard (median beats one late decode).
	get localStart() {
		return this.starts.length ? median(this.starts) : null;
	}

	// Returns true if anything changed.
	push(bytes: Uint8Array, now = Date.now()) {
		const f = parseFrame(bytes);
		if (!f) {
			return false;
		}
		if (f.msgId !== this.msgId || f.w !== this.w || f.h !== this.h) {
			this.reset(f.msgId, f.w, f.h);
		}
		const s = this.stats;
		s.frames++;
		s.bytes += bytes.length;
		s.firstAt ??= now;
		const span = (now - s.firstAt) / 1000;
		s.linkBps = span > 0 ? s.bytes / span : 0;
		if (f.seed >= RELAY_SEED) {
			s.relayFrames++;
		} else if (!this.hostSeeds.has(f.seed)) {
			this.hostSeeds.add(f.seed);
			s.hostFrames = this.hostSeeds.size;
			this.minSeed = Math.min(this.minSeed, f.seed);
			this.maxSeed = Math.max(this.maxSeed, f.seed);
			s.hostSent = this.maxSeed - this.minSeed + 1;
		}
		if (f.countdownMs !== null) {
			this.starts.push(now + f.countdownMs);
			if (this.starts.length > 15) {
				this.starts.shift();
			}
		}
		const fresh = this.decoder!.add(f.seed, f.data);
		this.order.push(...fresh);
		if (this.decoder!.done && !this.mission) {
			this.mission = decodeMission(this.decoder!.bytes(payloadLength(this.w, this.h)), this.w, this.h);
			s.doneAt = now;
			const t = (now - s.firstAt) / 1000;
			s.goodputBps = t > 0 ? payloadLength(this.w, this.h) / t : 0;
		}
		return true;
	}

	private reset(msgId: number, w: number, h: number) {
		this.msgId = msgId;
		this.w = w;
		this.h = h;
		this.decoder = new LtDecoder(blockCount(w, h), BLOCK);
		this.order = [];
		this.mission = null;
		this.starts = [];
		this.hostSeeds.clear();
		this.minSeed = Infinity;
		this.maxSeed = -1;
		this.stats = { frames: 0, hostFrames: 0, relayFrames: 0, hostSent: 0, bytes: 0, linkBps: 0, goodputBps: 0, firstAt: null, doneAt: null };
	}

	payload() {
		return this.decoder ? this.decoder.bytes(payloadLength(this.w, this.h)) : new Uint8Array();
	}
}
