// Browser radio player: WorldView chatter -> cached ElevenLabs clips through a gentle radio chain.
// Comfort rules (see docs/ENGINE_PLAN.md): half-duplex, even loudness (compressor + limiter),
// soft filtered static only under jammed speakers, short soft squelch, limited panning, ducking,
// mute / volume / critical-only, and a caption callback for every line.
//
//   const radio = new RadioPlayer({ audioBase: "/audio" });
//   button.onclick = () => radio.unlock();      // browsers need one user gesture
//   ws.onmessage = (e) => radio.update(JSON.parse(e.data).view);
import type { WorldView } from "../shared/types";
import { RadioQueue, type RadioLine } from "./queue";
import { DEFAULT_VOICES, voiceIndexFor } from "./voices";

export interface RadioOptions {
    /** Where voice/generate.ts output is served (default "/audio"). */
    audioBase?: string;
    /** Voice folder names, in the same order as generation (default alpha..delta). */
    voices?: string[];
    /** Called for every line heard (for the chatter feed / captions), even when muted. */
    onLine?: (line: RadioLine) => void;
    /** Called when a line starts/stops playing (for highlighting the speaking drone). */
    onSpeaking?: (agentId: string | null) => void;
}

const PAN_LIMIT = 0.6;
const STATIC_UNDER_DB = -24;
const FADE_S = 0.15;
const GAP_MS = 250; // breathing room between lines

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class RadioPlayer {
    readonly queue = new RadioQueue();
    private ctx: AudioContext | null = null;
    private master!: GainNode;
    private duckGain!: GainNode;
    private buffers = new Map<string, Promise<AudioBuffer | null>>();
    private noise: AudioBuffer | null = null;
    private playing = false;
    private muted = false;
    private volume = 0.8;
    private wasJammed = new Map<string, boolean>();
    private wasAlive = new Map<string, boolean>();
    private lastBurst = 0;
    private lastTone = 0;
    private readonly audioBase: string;
    private readonly voices: string[];

    constructor(private readonly opts: RadioOptions = {}) {
        this.audioBase = (opts.audioBase ?? "/audio").replace(/\/$/, "");
        this.voices = opts.voices ?? DEFAULT_VOICES.map((v) => v.name);
    }

    /** Call from a click/tap. Creates the audio graph. */
    async unlock(): Promise<void> {
        if (!this.ctx) {
            this.ctx = new AudioContext();
            this.buildGraph(this.ctx);
        }
        await this.ctx.resume();
    }

    private buildGraph(ctx: AudioContext): void {
        // voice chains -> duck -> compressor -> limiter -> master -> out
        this.duckGain = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -24;
        comp.knee.value = 12;
        comp.ratio.value = 4;
        comp.attack.value = 0.005;
        comp.release.value = 0.2;
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.1;
        this.master = ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.duckGain.connect(comp).connect(limiter).connect(this.master).connect(ctx.destination);
        this.noise = pinkNoise(ctx, 2);
    }

    setMuted(muted: boolean): void {
        this.muted = muted;
        this.rampMaster();
    }

    setVolume(v: number): void {
        this.volume = Math.max(0, Math.min(1, v));
        this.rampMaster();
    }

    setCriticalOnly(on: boolean): void {
        this.queue.criticalOnly = on;
    }

    /** Duck chatter: "ptt" mutes it, "sitrep" drops it 15 dB, null restores. */
    duck(mode: "ptt" | "sitrep" | null): void {
        if (!this.ctx) {
            return;
        }
        const target = mode === "ptt" ? 0 : mode === "sitrep" ? dbToGain(-15) : 1;
        this.duckGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08);
        if (mode === "ptt") {
            this.queue.clear();
        }
    }

    private rampMaster(): void {
        if (!this.ctx) {
            return;
        }
        this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }

    /** Feed every WorldView here. */
    update(view: WorldView): void {
        const now = performance.now();
        for (const line of this.queue.ingest(view, now)) {
            this.opts.onLine?.(line);
        }
        this.edgeSounds(view, now);
        void this.pump();
    }

    /** Soft cues on state changes: short static burst entering a jam, gentle tone when a drone dies. */
    private edgeSounds(view: WorldView, now: number): void {
        let jamEntered = false;
        let died = false;
        for (const a of view.agents) {
            if (a.jammed && this.wasJammed.get(a.id) === false) {
                jamEntered = true;
            }
            if (!a.alive && this.wasAlive.get(a.id) === true) {
                died = true;
            }
            this.wasJammed.set(a.id, a.jammed);
            this.wasAlive.set(a.id, a.alive);
        }
        if (jamEntered && now - this.lastBurst > 2000) {
            this.lastBurst = now;
            this.staticBurst(0.4);
        }
        if (died && now - this.lastTone > 1500) {
            this.lastTone = now;
            this.signalLostTone();
        }
    }

    private async pump(): Promise<void> {
        if (this.playing || !this.ctx) {
            return;
        }
        const line = this.queue.next(performance.now());
        if (!line) {
            return;
        }
        this.playing = true;
        this.opts.onSpeaking?.(line.from);
        try {
            await this.playLine(line);
        } finally {
            this.opts.onSpeaking?.(null);
            await sleep(GAP_MS);
            this.playing = false;
            void this.pump();
        }
    }

    private clipUrl(line: RadioLine): string | null {
        if (!line.key) {
            return null;
        }
        const voice = this.voices[voiceIndexFor(line.from, this.voices.length)];
        return `${this.audioBase}/${voice}/${line.key}_${line.variant}.mp3`;
    }

    private load(url: string): Promise<AudioBuffer | null> {
        let p = this.buffers.get(url);
        if (!p) {
            p = fetch(url)
                .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
                .then((b) => this.ctx!.decodeAudioData(b))
                .catch(() => null);
            this.buffers.set(url, p);
        }
        return p;
    }

    private async playLine(line: RadioLine): Promise<void> {
        const ctx = this.ctx!;
        const url = this.clipUrl(line);
        const buf = url ? await this.load(url) : null;
        if (!buf) {
            await this.speakFallback(line.text);
            return;
        }
        await this.playBuffer(buf, { pan: (line.x * 2 - 1) * PAN_LIMIT, jammed: line.jammed });
        void ctx;
    }

    /** Plays any decoded buffer through the radio chain (also used by PTT replies and sitreps). */
    async playBuffer(buf: AudioBuffer, o: { pan?: number; jammed?: boolean; radio?: boolean } = {}): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) {
            return;
        }
        const t0 = ctx.currentTime + 0.01;
        await this.squelch(t0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const out = ctx.createGain();
        out.gain.setValueAtTime(0, t0);
        out.gain.linearRampToValueAtTime(1, t0 + 0.02);
        const pan = ctx.createStereoPanner();
        pan.pan.value = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, o.pan ?? 0));
        if (o.radio === false) {
            src.connect(out);
        } else {
            // Mild radio EQ: readable, not tinny.
            const hp = ctx.createBiquadFilter();
            hp.type = "highpass";
            hp.frequency.value = 300;
            const lp = ctx.createBiquadFilter();
            lp.type = "lowpass";
            lp.frequency.value = 3400;
            const shaper = ctx.createWaveShaper();
            shaper.curve = softClip(1.6);
            src.connect(hp).connect(lp).connect(shaper).connect(out);
        }
        out.connect(pan).connect(this.duckGain);
        let stopStatic: (() => void) | null = null;
        if (o.jammed) {
            stopStatic = this.staticBed(t0, buf.duration);
        }
        src.start(t0 + 0.06);
        await new Promise<void>((resolve) => {
            src.onended = () => resolve();
        });
        stopStatic?.();
    }

    private squelch(t: number): Promise<void> {
        const ctx = this.ctx!;
        if (!this.noise) {
            return Promise.resolve();
        }
        // ~50 ms band-limited noise blip, quiet.
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 2200;
        bp.Q.value = 1.2;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(dbToGain(-26), t + 0.008);
        g.gain.linearRampToValueAtTime(0, t + 0.05);
        src.connect(bp).connect(g).connect(this.duckGain);
        src.start(t);
        src.stop(t + 0.06);
        return Promise.resolve();
    }

    /** Filtered pink noise under a jammed speaker, ~24 dB down, 150 ms fades. */
    private staticBed(t: number, dur: number): () => void {
        const ctx = this.ctx!;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        src.loop = true;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 200;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 4000;
        const g = ctx.createGain();
        const level = dbToGain(STATIC_UNDER_DB + 10); // pink noise buffer is quiet; net ~-24 dB under voice
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(level, t + FADE_S);
        src.connect(hp).connect(lp).connect(g).connect(this.duckGain);
        src.start(t);
        const end = t + dur + 0.1;
        g.gain.setValueAtTime(level, end);
        g.gain.linearRampToValueAtTime(0, end + FADE_S);
        src.stop(end + FADE_S + 0.05);
        return () => {};
    }

    private staticBurst(seconds: number): void {
        const ctx = this.ctx;
        if (!ctx || !this.noise) {
            return;
        }
        const t = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 3500;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(dbToGain(-22), t + 0.08);
        g.gain.linearRampToValueAtTime(0, t + seconds);
        src.connect(lp).connect(g).connect(this.duckGain);
        src.start(t);
        src.stop(t + seconds + 0.05);
    }

    /** Two soft descending sine notes. */
    private signalLostTone(): void {
        const ctx = this.ctx;
        if (!ctx) {
            return;
        }
        const t = ctx.currentTime;
        [660, 440].forEach((f, i) => {
            const o = ctx.createOscillator();
            o.type = "sine";
            o.frequency.value = f;
            const g = ctx.createGain();
            const s = t + i * 0.18;
            g.gain.setValueAtTime(0, s);
            g.gain.linearRampToValueAtTime(dbToGain(-28), s + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, s + 0.25);
            o.connect(g).connect(this.duckGain);
            o.start(s);
            o.stop(s + 0.3);
        });
    }

    private speakFallback(text: string): Promise<void> {
        if (typeof speechSynthesis === "undefined" || this.muted) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const u = new SpeechSynthesisUtterance(text);
            u.rate = 1.05;
            u.volume = Math.min(this.volume, 0.6);
            u.onend = () => resolve();
            u.onerror = () => resolve();
            speechSynthesis.speak(u);
            setTimeout(resolve, 4000);
        });
    }

    /** Decode raw MP3 bytes (e.g. from POST /tts). */
    async decode(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
        if (!this.ctx) {
            return null;
        }
        try {
            return await this.ctx.decodeAudioData(bytes);
        } catch {
            return null;
        }
    }

    /** Play a cached clip for a given agent/key directly (used as PTT fallback). */
    async playClip(agentId: string, key: string, variant = 0): Promise<void> {
        const voice = this.voices[voiceIndexFor(agentId, this.voices.length)];
        const buf = await this.load(`${this.audioBase}/${voice}/${key}_${variant}.mp3`);
        if (buf) {
            await this.playBuffer(buf);
        }
    }

    voiceFor(agentId: string): string {
        return this.voices[voiceIndexFor(agentId, this.voices.length)]!;
    }
}

function pinkNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
    }
    return buf;
}

function softClip(amount: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const curve = new Float32Array(new ArrayBuffer(n * 4));
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
    }
    return curve;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
