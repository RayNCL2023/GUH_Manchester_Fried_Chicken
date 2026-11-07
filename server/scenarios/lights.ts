// Light show: a target image becomes an N-slot grid of `slot` tasks (N = live participants).
// When phones leave, the grid is rebuilt at lower resolution and the picture re-forms.
import type { CellState, Task } from "../../shared/types";
import type { ServerAgent, World } from "../world";
import type { Scenario, ScenarioMetrics } from "./types";

const OFF = "#05060a";

/** Resolution-independent target: an amber hexagon with a cream "H" (Hive). u, v in [0, 1]. */
export function hiveLogo(u: number, v: number): string {
    // Work in a 16:10 frame so the hexagon isn't squashed.
    const dx = (u - 0.5) * 16;
    const dy = (v - 0.5) * 10;
    const r = 4.8;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const inHex = ax <= (r * Math.sqrt(3)) / 2 && ay <= r - ax / Math.sqrt(3);
    if (!inHex) {
        return OFF;
    }
    const stem = ax >= 1.3 && ax <= 2.3 && ay <= 2.6;
    const bar = ax <= 2.3 && ay <= 0.45;
    if (stem || bar) {
        return "#fff4d6";
    }
    return dy < 0 ? "#ffb000" : "#ff8a00";
}

export interface SlotGrid {
    cols: number;
    rows: number;
    tasks: Task[];
}

/** Largest cols x rows <= n with roughly 16:10 aspect. Spare participants show black. */
export function buildSlots(n: number, width: number, height: number, image = hiveLogo): SlotGrid {
    if (n <= 0) {
        return { cols: 0, rows: 0, tasks: [] };
    }
    let cols = Math.max(1, Math.round(Math.sqrt(n * 1.6)));
    let rows = Math.floor(n / cols);
    if (rows < 1) {
        rows = 1;
        cols = n;
    }
    const tasks: Task[] = [];
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const u = (i + 0.5) / cols;
            const v = (j + 0.5) / rows;
            tasks.push({
                id: `slot:${i}:${j}`,
                pos: { x: u * (width - 1), y: v * (height - 1) },
                kind: "slot",
                value: 1,
                color: image(u, v),
            });
        }
    }
    return { cols, rows, tasks };
}

export function createLightsScenario(width: number, height: number): Scenario {
    const blank = new Array<CellState>(width * height).fill("clear");
    let grid: SlotGrid = { cols: 0, rows: 0, tasks: [] };
    let participants = -1;
    let pendingSince = -1;

    const members = (world: World): ServerAgent[] => {
        const alive = world.liveAgents();
        const phones = alive.filter((a) => a.isPhone);
        return phones.length > 0 ? phones : alive;
    };

    return {
        id: "lights",
        init() {
            grid = { cols: 0, rows: 0, tasks: [] };
            participants = -1;
            pendingSince = -1;
        },
        step(world: World) {
            const n = members(world).length;
            if (n === participants) {
                pendingSince = -1;
                return;
            }
            // Debounce 1 s so a burst of joins/leaves rebuilds once.
            if (pendingSince < 0) {
                pendingSince = world.tick;
            }
            if (participants >= 0 && world.tick - pendingSince < 10) {
                return;
            }
            participants = n;
            pendingSince = -1;
            grid = buildSlots(n, width, height);
        },
        cell: () => "clear",
        cells: () => blank,
        tasksFor(agent: ServerAgent, world: World): Task[] {
            const isMember = members(world).some((a) => a.id === agent.id);
            return isMember ? grid.tasks : [];
        },
        metrics(world: World): ScenarioMetrics {
            if (!grid.tasks.length) {
                return { edgeMappedPct: 0 };
            }
            const filled = new Set(world.liveAgents().map((a) => a.claim).filter((c): c is string => !!c));
            const n = grid.tasks.filter((t) => filled.has(t.id)).length;
            return { edgeMappedPct: (100 * n) / grid.tasks.length };
        },
        spawn() {
            return { x: Math.random() * (width - 1), y: Math.random() * (height - 1) };
        },
    };
}
