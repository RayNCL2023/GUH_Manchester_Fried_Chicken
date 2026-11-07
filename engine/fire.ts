// Shared fire physics (used by engine/sim and the world server so they behave identically).
import type { CellState, Vec } from "../shared/types";
import type { Rng } from "./util";

export interface FireParams {
    width: number;
    height: number;
    /** Spread probability per burning neighbour per tick, before wind. */
    spread: number;
    /** Ticks a cell burns before turning to burnt. */
    burnTicks: number;
}

export const DEFAULT_FIRE: FireParams = { width: 60, height: 40, spread: 0.02, burnTicks: 60 };

const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
] as const;

/** Fresh map: a 3x3 village south-west, a 2x2 ignition north-east of centre. */
export function initFireMap(width: number, height: number): CellState[] {
    const cells = new Array<CellState>(width * height).fill("clear");
    const vx = Math.round(width * 0.27);
    const vy = Math.round(height * 0.68);
    for (let y = vy; y < vy + 3; y++) {
        for (let x = vx; x < vx + 3; x++) {
            cells[y * width + x] = "village";
        }
    }
    const fx = Math.round(width * 0.5);
    const fy = Math.round(height * 0.3);
    for (let y = fy; y < fy + 2; y++) {
        for (let x = fx; x < fx + 2; x++) {
            cells[y * width + x] = "fire";
        }
    }
    return cells;
}

export function cellAt(cells: CellState[], width: number, height: number, x: number, y: number): CellState {
    if (x < 0 || y < 0 || x >= width || y >= height) {
        return "unknown";
    }
    return cells[y * width + x]!;
}

/** A burning cell next to a clear or village cell. */
export function isEdge(cells: CellState[], width: number, height: number, x: number, y: number): boolean {
    if (cellAt(cells, width, height, x, y) !== "fire") {
        return false;
    }
    return DIRS.some(([dx, dy]) => {
        const s = cellAt(cells, width, height, x + dx, y + dy);
        return s === "clear" || s === "village";
    });
}

/** One cellular-automaton step, biased by wind. Mutates burnAge, returns the new cells array. */
export function stepFire(cells: CellState[], burnAge: Int32Array, p: FireParams, wind: Vec, rng: Rng): CellState[] {
    const { width, height, spread, burnTicks } = p;
    const next = cells.slice();
    const wl = Math.hypot(wind.x, wind.y);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (cells[i] !== "fire") {
                continue;
            }
            burnAge[i]!++;
            if (burnAge[i]! >= burnTicks) {
                next[i] = "burnt";
            }
            for (const [dx, dy] of DIRS) {
                const s = cellAt(cells, width, height, x + dx, y + dy);
                if (s !== "clear" && s !== "village") {
                    continue;
                }
                const along = wl ? (dx * wind.x + dy * wind.y) / wl : 0;
                const prob = spread * Math.max(0.15, 1 + along * Math.min(wl, 2));
                if (rng() < prob) {
                    next[(y + dy) * width + (x + dx)] = "fire";
                }
            }
        }
    }
    return next;
}
