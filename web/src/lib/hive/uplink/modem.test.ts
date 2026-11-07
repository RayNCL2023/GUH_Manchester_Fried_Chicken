// End to end without speakers: mission -> fountain frames -> ggwave audio -> decode -> image.
import { describe, expect, test } from "bun:test";
import { PICTURES } from "../pixel";
import { LtDecoder, encodeSymbol, splitBlocks } from "./fountain";
import { createModem, PROTOCOLS } from "./modem";
import { BLOCK, FRAME_SIZE, blockCount, decodeMission, encodeFrame, encodeMission, parseFrame, payloadLength } from "./packet";

const RATE = 48000;

describe("ggwave loopback", () => {
	test("a frame survives encode/decode in every protocol", async () => {
		const modem = await createModem(RATE);
		for (let p = 0; p < PROTOCOLS.length; p++) {
			const bytes = Uint8Array.from({ length: FRAME_SIZE }, (_, i) => (i * 53 + p) & 255);
			const audio = modem.encode(bytes, p);
			const padded = new Float32Array(audio.length + RATE);
			padded.set(audio, 2048);
			let got: Uint8Array | null = null;
			for (let i = 0; i + 1024 <= padded.length && !got; i += 1024) {
				got = modem.decode(padded.slice(i, i + 1024));
			}
			expect(got).toEqual(bytes);
		}
	});

	test("the flame rebuilds from audio with every other chunk lost", async () => {
		const modem = await createModem(RATE);
		const art = PICTURES[0].art;
		const w = art[0].length;
		const h = art.length;
		const mission = { showId: 0, protocol: 2, relay: true, slotMs: 3000, startAt: 1_794_000_000, art };
		const blocks = splitBlocks(encodeMission(mission), BLOCK);
		const dec = new LtDecoder(blockCount(w, h), BLOCK);
		for (let seed = 1; !dec.done && seed < 200; seed += 2) {
			const audio = modem.encode(encodeFrame({ msgId: 3, w, h, seed, countdownMs: 5000, data: encodeSymbol(blocks, seed) }), 2);
			const padded = new Float32Array(audio.length + 8192);
			padded.set(audio);
			for (let i = 0; i + 1024 <= padded.length; i += 1024) {
				const got = modem.decode(padded.slice(i, i + 1024));
				const f = got && parseFrame(got);
				if (f) {
					dec.add(f.seed, f.data);
				}
			}
		}
		expect(decodeMission(dec.bytes(payloadLength(w, h)), w, h).art).toEqual(art);
	});
});
