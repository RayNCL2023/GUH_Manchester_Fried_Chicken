import { describe, expect, test } from "bun:test";
import { PICTURES, UPLINK_PICTURES } from "../pixel";
import { BLOCK, PICTURE_SHOW, blockCount, decodeMission, encodeFrame, encodeMission, nextSlot, parseFrame, payloadLength } from "./packet";
import { LtDecoder, encodeSymbol, splitBlocks } from "./fountain";

describe("mission packet", () => {
	test("every show picture survives the round trip", () => {
		for (const p of PICTURES) {
			const m = { showId: 2, protocol: 2, relay: true, slotMs: 3200, startAt: 1_794_000_000, art: p.art };
			const bytes = encodeMission(m);
			expect(bytes.length).toBe(payloadLength(p.art[0].length, p.art.length));
			expect(decodeMission(bytes, p.art[0].length, p.art.length)).toEqual(m);
		}
	});

	test("16×16 uplink pictures fit in 5 blocks and round trip", () => {
		for (const p of UPLINK_PICTURES) {
			const m = { showId: PICTURE_SHOW, protocol: 2, relay: true, slotMs: 4800, startAt: 1_794_000_000, art: p.art };
			expect(blockCount(16, 16)).toBe(5);
			const blocks = splitBlocks(encodeMission(m), BLOCK);
			const dec = new LtDecoder(blocks.length, BLOCK);
			for (let seed = 0; !dec.done && seed < 200; seed++) {
				if (seed % 3 === 1) {
					continue; // a third of the chunks lost
				}
				dec.add(seed, encodeSymbol(blocks, seed));
			}
			expect(decodeMission(dec.bytes(payloadLength(16, 16)), 16, 16)).toEqual(m);
		}
	});

	test("frames round trip and carry the countdown", () => {
		const f = { msgId: 9, w: 9, h: 11, seed: 40000, countdownMs: 61230, data: new Uint8Array(BLOCK).fill(7) };
		expect(parseFrame(encodeFrame(f))).toEqual({ ...f, countdownMs: 61230 });
		expect(parseFrame(encodeFrame({ ...f, countdownMs: null }))?.countdownMs).toBeNull();
		expect(parseFrame(new Uint8Array(3))).toBeNull();
	});

	test("mission over frames with 40% loss", () => {
		const art = PICTURES[0].art;
		const m = { showId: 0, protocol: 2, relay: true, slotMs: 3000, startAt: 1_794_000_123, art };
		const blocks = splitBlocks(encodeMission(m), BLOCK);
		const w = art[0].length;
		const h = art.length;
		const dec = new LtDecoder(blockCount(w, h), BLOCK);
		for (let seed = 0; !dec.done; seed++) {
			if (seed % 5 < 2) {
				continue;
			}
			const f = parseFrame(encodeFrame({ msgId: 1, w, h, seed, countdownMs: 1000, data: encodeSymbol(blocks, seed) }))!;
			dec.add(f.seed, f.data);
		}
		expect(decodeMission(dec.bytes(payloadLength(w, h)), w, h)).toEqual(m);
	});

	test("slots align backwards from the start", () => {
		expect(nextSlot(1000, 10_000, 3000)).toBe(1000);
		expect(nextSlot(1001, 10_000, 3000)).toBe(4000);
		expect(nextSlot(11_000, 10_000, 3000)).toBe(13_000);
	});
});
