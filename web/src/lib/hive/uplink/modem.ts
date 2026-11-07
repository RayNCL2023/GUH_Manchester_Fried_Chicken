// ggwave (WASM) wrapped as a plain bytes <-> samples modem. No Web Audio here, so it also runs in bun tests.
import ggwaveFactory from "ggwave";

export const PROTOCOLS = [
	{ name: "Normal", id: "GGWAVE_PROTOCOL_AUDIBLE_NORMAL" },
	{ name: "Fast", id: "GGWAVE_PROTOCOL_AUDIBLE_FAST" },
	{ name: "Fastest", id: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST" },
] as const;

let lib: Promise<any> | null = null;

// Load once and keep it in memory: after airplane mode there is nothing to fetch from.
export const loadGgwave = () => (lib ??= ggwaveFactory({ print: () => {}, printErr: () => {} }));

export type Modem = {
	sampleRate: number;
	encode: (bytes: Uint8Array, protocol: number, volume?: number) => Float32Array;
	decode: (samples: Float32Array) => Uint8Array | null;
};

export async function createModem(sampleRate: number): Promise<Modem> {
	const gg = await loadGgwave();
	const p = gg.getDefaultParameters();
	p.sampleRateInp = sampleRate;
	p.sampleRateOut = sampleRate;
	p.sampleFormatInp = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
	p.sampleFormatOut = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
	const inst = gg.init(p);
	gg.disableLog();

	return {
		sampleRate,
		encode: (bytes, protocol, volume = 50) => {
			const raw: Int8Array = gg.encode(inst, bytes, gg.ProtocolId[PROTOCOLS[protocol].id], volume);
			// The view points into WASM memory that the next call reuses: copy out.
			return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
		},
		decode: (samples) => {
			const out: Int8Array = gg.decode(inst, new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength));
			return out && out.length ? new Uint8Array(out) : null;
		},
	};
}
