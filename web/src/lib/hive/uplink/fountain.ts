// LT fountain code. The payload is cut into k blocks; every encoded symbol is the XOR of a random
// set of blocks picked from its seed (robust soliton degrees). Any ~k symbols, in any order, rebuild it.
// The decoder is incremental Gauss-Jordan over GF(2): it does everything peeling does, never stalls
// on small k, and reports each block the moment it becomes known.

export function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const cdfs = new Map<number, number[]>();

// Robust soliton CDF: cdf[d] = P(degree <= d).
function solitonCdf(k: number, c = 0.1, delta = 0.5) {
	const cached = cdfs.get(k);
	if (cached) {
		return cached;
	}
	const r = Math.max(1, c * Math.log(k / delta) * Math.sqrt(k));
	const pivot = Math.min(k, Math.max(1, Math.round(k / r)));
	const mu = Array.from({ length: k + 1 }, (_, d) => {
		if (d === 0) {
			return 0;
		}
		const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
		const tau = d < pivot ? r / (d * k) : d === pivot ? (r * Math.log(r / delta)) / k : 0;
		return rho + Math.max(0, tau);
	});
	const total = mu.reduce((a, b) => a + b, 0);
	let acc = 0;
	const cdf = mu.map((m) => (acc += m / total));
	cdfs.set(k, cdf);
	return cdf;
}

// The blocks a symbol covers. Sender and receiver derive the same set from (seed, k) alone.
export function neighbours(seed: number, k: number) {
	const next = rng(Math.imul(seed + 1, 2654435761) ^ k);
	const u = next();
	const cdf = solitonCdf(k);
	let degree = 1;
	while (degree < k && cdf[degree] < u) {
		degree++;
	}
	const pool = Array.from({ length: k }, (_, i) => i);
	for (let i = 0; i < degree; i++) {
		const j = i + Math.floor(next() * (k - i));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, degree);
}

export function splitBlocks(data: Uint8Array, size: number) {
	const k = Math.max(1, Math.ceil(data.length / size));
	return Array.from({ length: k }, (_, i) => {
		const b = new Uint8Array(size);
		b.set(data.subarray(i * size, (i + 1) * size));
		return b;
	});
}

export function encodeSymbol(blocks: Uint8Array[], seed: number) {
	const out = new Uint8Array(blocks[0].length);
	for (const i of neighbours(seed, blocks.length)) {
		for (let j = 0; j < out.length; j++) {
			out[j] ^= blocks[i][j];
		}
	}
	return out;
}

type Row = { mask: Uint32Array; data: Uint8Array };

const bit = (m: Uint32Array, i: number) => (m[i >>> 5] >>> (i & 31)) & 1;
const xorInto = (a: Uint32Array | Uint8Array, b: Uint32Array | Uint8Array) => {
	for (let i = 0; i < a.length; i++) {
		a[i] ^= b[i];
	}
};
const popcount = (m: Uint32Array) => m.reduce((n, w) => {
	let x = w - ((w >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return n + ((Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24));
}, 0);

export class LtDecoder {
	readonly rows = new Map<number, Row>(); // pivot block -> row, kept fully reduced
	readonly solved = new Set<number>();
	received = 0;

	constructor(readonly k: number, readonly blockSize: number) {}

	get done() {
		return this.solved.size === this.k;
	}

	// Feed one symbol. Returns the blocks that just became known (empty if it added nothing).
	add(seed: number, symbol: Uint8Array): number[] {
		this.received++;
		if (this.done) {
			return [];
		}
		const mask = new Uint32Array(Math.ceil(this.k / 32));
		for (const i of neighbours(seed, this.k)) {
			mask[i >>> 5] |= 1 << (i & 31);
		}
		const data = symbol.slice(0, this.blockSize);
		for (const [p, row] of this.rows) {
			if (bit(mask, p)) {
				xorInto(mask, row.mask);
				xorInto(data, row.data);
			}
		}
		let pivot = -1;
		for (let i = 0; i < this.k && pivot < 0; i++) {
			if (bit(mask, i)) {
				pivot = i;
			}
		}
		if (pivot < 0) {
			return [];
		}
		for (const row of this.rows.values()) {
			if (bit(row.mask, pivot)) {
				xorInto(row.mask, mask);
				xorInto(row.data, data);
			}
		}
		this.rows.set(pivot, { mask, data });

		const fresh: number[] = [];
		for (const [p, row] of this.rows) {
			if (!this.solved.has(p) && popcount(row.mask) === 1) {
				this.solved.add(p);
				fresh.push(p);
			}
		}
		return fresh;
	}

	block(i: number) {
		return this.solved.has(i) ? this.rows.get(i)!.data : null;
	}

	bytes(length = this.k * this.blockSize) {
		const out = new Uint8Array(this.k * this.blockSize);
		for (const i of this.solved) {
			out.set(this.rows.get(i)!.data, i * this.blockSize);
		}
		return out.slice(0, length);
	}
}
