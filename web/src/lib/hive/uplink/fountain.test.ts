import { describe, expect, test } from "bun:test";
import { LtDecoder, encodeSymbol, neighbours, rng, splitBlocks } from "./fountain";

function payload(n: number, seed: number) {
	const r = rng(seed);
	return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
}

// Send symbols with sequential seeds, drop a share of them at random, feed the rest (optionally
// shuffled) and count how many the receiver needed.
function run(n: number, blockSize: number, drop: number, seed: number, shuffle = false) {
	const data = payload(n, seed);
	const blocks = splitBlocks(data, blockSize);
	const k = blocks.length;
	const r = rng(seed ^ 0xabcdef);
	const sent = Array.from({ length: k * 8 + 40 }, (_, s) => s).filter(() => r() >= drop);
	if (shuffle) {
		for (let i = sent.length - 1; i > 0; i--) {
			const j = Math.floor(r() * (i + 1));
			[sent[i], sent[j]] = [sent[j], sent[i]];
		}
	}
	const dec = new LtDecoder(k, blockSize);
	for (const s of sent) {
		dec.add(s, encodeSymbol(blocks, s));
		if (dec.done) {
			break;
		}
	}
	return { ok: dec.done && dec.bytes(n).every((b, i) => b === data[i]), k, used: dec.received };
}

describe("LT fountain code", () => {
	test("neighbours are deterministic, distinct and in range", () => {
		for (let s = 0; s < 500; s++) {
			const a = neighbours(s, 23);
			expect(a).toEqual(neighbours(s, 23));
			expect(new Set(a).size).toBe(a.length);
			expect(a.every((i) => i >= 0 && i < 23)).toBe(true);
		}
	});

	test("decodes without loss", () => {
		const { ok, k, used } = run(60, 8, 0, 1);
		expect(ok).toBe(true);
		expect(used).toBeLessThanOrEqual(k * 3);
	});

	for (const drop of [0.3, 0.4, 0.5]) {
		for (const [n, bs] of [[60, 8], [300, 16], [600, 16], [1600, 16]] as const) {
			test(`drop ${drop * 100}% of chunks, ${n} bytes in ${bs}-byte blocks`, () => {
				let total = 0;
				let k = 0;
				for (let trial = 0; trial < 20; trial++) {
					const r = run(n, bs, drop, trial * 7919 + n);
					expect(r.ok).toBe(true);
					total += r.used;
					k = r.k;
				}
				// Received symbols needed, on average: close to k (the drops cost airtime, not correctness).
				expect(total / 20).toBeLessThan(k * 1.6 + 4);
			});
		}
	}

	test("any order works: shuffled arrival plus 40% loss", () => {
		for (let trial = 0; trial < 20; trial++) {
			expect(run(400, 16, 0.4, 100 + trial, true).ok).toBe(true);
		}
	});

	test("blocks become known progressively, not all at the end", () => {
		const blocks = splitBlocks(payload(160, 9), 8);
		const dec = new LtDecoder(blocks.length, 8);
		const firstSeen: number[] = [];
		for (let s = 0; !dec.done; s++) {
			if (dec.add(s, encodeSymbol(blocks, s)).length) {
				firstSeen.push(dec.received);
			}
		}
		expect(firstSeen[0]).toBeLessThan(blocks.length);
	});

	test("relay symbols (random high seeds) mix with the sender's", () => {
		const data = payload(120, 5);
		const blocks = splitBlocks(data, 8);
		const dec = new LtDecoder(blocks.length, 8);
		const r = rng(77);
		for (let i = 0; !dec.done && i < 500; i++) {
			const s = i % 2 ? i : 32768 + Math.floor(r() * 32767);
			dec.add(s, encodeSymbol(blocks, s));
		}
		expect(dec.bytes(120)).toEqual(data);
	});
});
