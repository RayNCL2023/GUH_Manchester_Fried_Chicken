// Mission package and the on-air frame around each fountain symbol.
//
// Mission payload (fountain-coded):
//   0  version
//   1  show id (index into SHOWS)
//   2  protocol (low 7 bits) | relay windows on (bit 7)
//   3  slot period, deciseconds
//   4  start time, unix seconds (u32, host clock)
//   8  pixels, 4 bits each (index into PALETTE), row-major
//
// Frame (one ggwave transmission):
//   0  message id   1  width   2  height   3  seed (u16)   5  countdown to start, centiseconds (u16)
//   7  BLOCK bytes of fountain symbol
// Width and height ride in every frame so a phone can draw the empty canvas from the first chunk.
// The countdown makes the sound itself the clock: phones never need their wall clocks to agree.
import { ART_COLORS } from "../pixel";

// 32 B blocks: a 16×16 picture is 5 blocks, each frame ~1.9 s on air (Fastest).
export const BLOCK = 32;
export const FRAME_HEADER = 7;
export const FRAME_SIZE = FRAME_HEADER + BLOCK;
export const PAYLOAD_HEAD = 8;
export const PALETTE = Object.keys(ART_COLORS); // 16 entries: one nibble per pixel
export const PICTURE_SHOW = 255; // show id meaning "play the picture itself"
export const RELAY_SEED = 0x8000; // seeds at or above this were sent by a phone, not the laptop
export const NO_COUNTDOWN = 0xffff;

export type Mission = {
	showId: number;
	protocol: number;
	relay: boolean;
	slotMs: number;
	startAt: number; // unix seconds, host clock
	art: string[];
};

export type Frame = {
	msgId: number;
	w: number;
	h: number;
	seed: number;
	countdownMs: number | null;
	data: Uint8Array;
};

export const payloadLength = (w: number, h: number) => PAYLOAD_HEAD + Math.ceil((w * h) / 2);
export const blockCount = (w: number, h: number) => Math.ceil(payloadLength(w, h) / BLOCK);

export function encodeMission(m: Mission) {
	const w = m.art[0].length;
	const h = m.art.length;
	const out = new Uint8Array(payloadLength(w, h));
	const view = new DataView(out.buffer);
	out[0] = 1;
	out[1] = m.showId;
	out[2] = (m.protocol & 0x7f) | (m.relay ? 0x80 : 0);
	out[3] = Math.min(255, Math.round(m.slotMs / 100));
	view.setUint32(4, m.startAt);
	[...m.art.join("")].forEach((ch, i) => {
		const v = Math.max(0, PALETTE.indexOf(ch));
		out[PAYLOAD_HEAD + (i >> 1)] |= i & 1 ? v : v << 4;
	});
	return out;
}

// Palette index of pixel i, read straight from the (possibly partial) payload bytes.
export const pixelAt = (payload: Uint8Array, i: number) => {
	const b = payload[PAYLOAD_HEAD + (i >> 1)];
	return i & 1 ? b & 15 : b >> 4;
};

// Which fountain block holds pixel i.
export const blockOfPixel = (i: number) => Math.floor((PAYLOAD_HEAD + (i >> 1)) / BLOCK);

export function decodeMission(payload: Uint8Array, w: number, h: number): Mission {
	const view = new DataView(payload.buffer, payload.byteOffset);
	return {
		showId: payload[1],
		protocol: payload[2] & 0x7f,
		relay: (payload[2] & 0x80) !== 0,
		slotMs: payload[3] * 100,
		startAt: view.getUint32(4),
		art: Array.from({ length: h }, (_, y) =>
			Array.from({ length: w }, (_, x) => PALETTE[pixelAt(payload, y * w + x)] ?? ".").join(""),
		),
	};
}

export function encodeFrame(f: Frame) {
	const out = new Uint8Array(FRAME_SIZE);
	const view = new DataView(out.buffer);
	out[0] = f.msgId;
	out[1] = f.w;
	out[2] = f.h;
	view.setUint16(3, f.seed);
	view.setUint16(5, f.countdownMs === null ? NO_COUNTDOWN : Math.max(0, Math.min(NO_COUNTDOWN - 1, Math.round(f.countdownMs / 10))));
	out.set(f.data.subarray(0, BLOCK), FRAME_HEADER);
	return out;
}

export function parseFrame(bytes: Uint8Array): Frame | null {
	if (bytes.length !== FRAME_SIZE || !bytes[1] || !bytes[2]) {
		return null;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset);
	const cd = view.getUint16(5);
	return {
		msgId: bytes[0],
		w: bytes[1],
		h: bytes[2],
		seed: view.getUint16(3),
		countdownMs: cd === NO_COUNTDOWN ? null : cd * 10,
		data: bytes.slice(FRAME_HEADER),
	};
}

// Slots are aligned backwards from the start time, so everyone who knows the start knows the slots.
// The laptop speaks at the start of each slot; finished phones may relay in the second half.
export function nextSlot(now: number, start: number, slotMs: number) {
	return start - Math.floor((start - now) / slotMs) * slotMs;
}
