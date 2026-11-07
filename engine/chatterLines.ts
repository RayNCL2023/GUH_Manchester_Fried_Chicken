// Fixed radio lines. Role 4 pre-generates one clip per (voice, key, variant).
// ChatterBody.line is always the exact `text` of one variant, so the player can look it up with clipFor().
// Clip path convention: /audio/{voice}/{key}_{variant}.mp3

export type Priority = 1 | 2 | 3; // 3 = critical, 2 = important, 1 = routine

export interface ChatterLine {
    key: string;
    priority: Priority;
    variants: string[];
}

const LOST_CONTACT: ChatterLine[] = Array.from({ length: 8 }, (_, i) => ({
    key: `lost_echo_${i + 1}`,
    priority: 2 as Priority,
    variants: [`Lost contact with Echo ${i + 1}.`],
}));

export const CHATTER_LINES: ChatterLine[] = [
    { key: "claim_north", priority: 1, variants: ["Taking the north flank.", "I've got the north side."] },
    { key: "claim_south", priority: 1, variants: ["Taking the south flank.", "I've got the south side."] },
    { key: "claim_east", priority: 1, variants: ["Taking the east flank.", "I've got the east side."] },
    { key: "claim_west", priority: 1, variants: ["Taking the west flank.", "I've got the west side."] },
    { key: "protect", priority: 1, variants: ["Moving to cover the village.", "Covering the village."] },
    { key: "yield", priority: 1, variants: ["You take it, I'm re-tasking.", "Yielding that one, moving on."] },
    { key: "fire_spotted", priority: 1, variants: ["New fire front spotted.", "Eyes on the fire line."] },
    { key: "relay_up", priority: 2, variants: ["Relay up, passing traffic.", "Relaying for the group."] },
    { key: "reconnected", priority: 2, variants: ["Back in contact, syncing map.", "Comms restored, catching up."] },
    { key: "lost_unit", priority: 2, variants: ["Lost contact with a unit."] },
    ...LOST_CONTACT,
    { key: "isolated", priority: 3, variants: ["Lost comms, continuing on last plan.", "No signal, working alone."] },
    { key: "goal_copy", priority: 3, variants: ["Copy, re-tasking.", "Copy that, moving now.", "Roger, on it."] },
    { key: "slot_locked", priority: 1, variants: ["Pixel locked."] },
];

const BY_KEY = new Map(CHATTER_LINES.map((l) => [l.key, l]));
const BY_TEXT = new Map<string, { key: string; variant: number; priority: Priority }>();
for (const l of CHATTER_LINES) {
    l.variants.forEach((text, variant) => BY_TEXT.set(text, { key: l.key, variant, priority: l.priority }));
}

export function lineByKey(key: string): ChatterLine | undefined {
    return BY_KEY.get(key);
}

/** For the voice player: text -> clip key/variant (undefined for unknown lines -> fall back to TTS). */
export function clipFor(text: string): { key: string; variant: number; priority: Priority } | undefined {
    return BY_TEXT.get(text);
}

/** Flat list for the clip generator script. */
export function allClips(): { key: string; variant: number; text: string; priority: Priority }[] {
    return CHATTER_LINES.flatMap((l) =>
        l.variants.map((text, variant) => ({ key: l.key, variant, text, priority: l.priority })),
    );
}
