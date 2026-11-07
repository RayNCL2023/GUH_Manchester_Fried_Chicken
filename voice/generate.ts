// Pre-generate every radio clip so the demo never depends on live TTS.
//   ELEVENLABS_API_KEY=... bun run voice/generate.ts [--force]
// Writes web/public/audio/{voice}/{key}_{variant}.mp3 plus manifest.json. Skips files that exist.
// If ffmpeg is on PATH, clips are loudness-normalised to -20 LUFS so no voice jumps out.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allClips } from "../engine/chatterLines";
import { soundEffect, textToSpeech } from "../server/elevenlabs";
import { voicesFromEnv } from "./voices";

const OUT = join(import.meta.dir, "..", "web", "public", "audio");
const force = process.argv.includes("--force");
const voices = voicesFromEnv(process.env.HIVE_VOICES);
const clips = allClips();

if (!process.env.ELEVENLABS_API_KEY) {
    console.error("Set ELEVENLABS_API_KEY first.");
    process.exit(1);
}

const hasFfmpeg = Bun.spawnSync(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

async function normalise(path: string): Promise<void> {
    if (!hasFfmpeg) {
        return;
    }
    const tmp = `${path}.tmp.mp3`;
    const p = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-af", "loudnorm=I=-20:TP=-2:LRA=7", tmp]);
    if (p.exitCode === 0) {
        await Bun.write(path, Bun.file(tmp));
    }
    Bun.spawnSync(["rm", "-f", tmp]);
}

let made = 0;
let skipped = 0;
for (const v of voices) {
    const dir = join(OUT, v.name);
    mkdirSync(dir, { recursive: true });
    for (const c of clips) {
        const file = join(dir, `${c.key}_${c.variant}.mp3`);
        if (existsSync(file) && !force) {
            skipped++;
            continue;
        }
        try {
            writeFileSync(file, Buffer.from(await textToSpeech(c.text, v.voiceId)));
            await normalise(file);
            made++;
            console.log(`  ${v.name}/${c.key}_${c.variant}  "${c.text}"`);
        } catch (err) {
            console.error(`  FAILED ${v.name}/${c.key}_${c.variant}:`, err instanceof Error ? err.message : err);
        }
    }
}

const sfx = [
    { file: "squelch.mp3", prompt: "very short soft radio squelch click, walkie talkie key-up, clean, quiet", seconds: 0.5 },
    { file: "static.mp3", prompt: "gentle soft radio static hiss, low and warm, steady, no crackles or pops", seconds: 4 },
];
for (const s of sfx) {
    const file = join(OUT, s.file);
    if (existsSync(file) && !force) {
        continue;
    }
    try {
        writeFileSync(file, Buffer.from(await soundEffect(s.prompt, s.seconds)));
        await normalise(file);
        console.log(`  sfx ${s.file}`);
    } catch (err) {
        console.error(`  FAILED sfx ${s.file}:`, err instanceof Error ? err.message : err);
    }
}

writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify({ voices: voices.map((v) => v.name), clips: clips.map(({ key, variant, text }) => ({ key, variant, text })) }, null, 2),
);
console.log(`done: ${made} generated, ${skipped} already present, ffmpeg normalisation ${hasFfmpeg ? "on" : "off (player compressor still evens levels)"}`);
