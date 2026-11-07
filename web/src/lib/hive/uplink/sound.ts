// Browser transport: send(bytes) plays through the speaker, listen(onChunk) decodes from the mic.
// Call createSound() from a tap: iOS only starts audio and the mic inside a user gesture.
import { createModem } from "./modem";

export type Sound = {
	sampleRate: number;
	airtime: (bytes: Uint8Array, protocol: number) => number; // seconds on air
	send: (bytes: Uint8Array, protocol: number, volume?: number) => Promise<number>; // resolves when played
	listen: (onChunk: (bytes: Uint8Array) => void) => Promise<void>;
	stopListening: () => void;
	level: () => number; // mic RMS of the last buffer, 0..1
	listening: () => boolean;
	close: () => void;
};

export async function createSound(opts: { mic?: boolean } = {}): Promise<Sound> {
	const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
	const ctx = new AC();
	// Kick both off before any await so they still count as part of the tap.
	const resumed = ctx.resume();
	const micPromise = opts.mic
		? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
		: null;
	await resumed;
	const modem = await createModem(ctx.sampleRate);

	let stream = micPromise ? await micPromise : null;
	let source: MediaStreamAudioSourceNode | null = null;
	let proc: ScriptProcessorNode | null = null;
	let rms = 0;

	const stopListening = () => {
		proc?.disconnect();
		source?.disconnect();
		stream?.getTracks().forEach((t) => t.stop()); // frees the mic so iOS routes back to the loud speaker
		proc = null;
		source = null;
		stream = null;
		rms = 0;
	};

	return {
		sampleRate: ctx.sampleRate,
		airtime: (bytes, protocol) => modem.encode(bytes, protocol).length / ctx.sampleRate,
		send: (bytes, protocol, volume = 50) => {
			const samples = modem.encode(bytes, protocol, volume);
			const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
			buf.getChannelData(0).set(samples);
			const node = ctx.createBufferSource();
			node.buffer = buf;
			node.connect(ctx.destination);
			return new Promise((resolve) => {
				node.onended = () => resolve(buf.duration);
				node.start();
			});
		},
		listen: async (onChunk) => {
			if (!stream) {
				stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
			}
			source = ctx.createMediaStreamSource(stream);
			// ScriptProcessor is deprecated but it is the one path that works on every phone browser.
			proc = ctx.createScriptProcessor(1024, 1, 1);
			proc.onaudioprocess = (e) => {
				const samples = new Float32Array(e.inputBuffer.getChannelData(0));
				let sum = 0;
				for (const s of samples) {
					sum += s * s;
				}
				rms = Math.sqrt(sum / samples.length);
				const got = modem.decode(samples);
				if (got) {
					onChunk(got);
				}
			};
			source.connect(proc);
			proc.connect(ctx.destination); // must reach the graph to run; it outputs silence
		},
		stopListening,
		level: () => rms,
		listening: () => !!proc,
		close: () => {
			stopListening();
			ctx.close().catch(() => {});
		},
	};
}
