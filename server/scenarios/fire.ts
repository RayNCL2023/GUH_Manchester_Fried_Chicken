// Firebreak: wind-biased cellular-automaton fire, one village, edge + protect tasks.
import type { CellState, Task, Vec } from "../../shared/types";
import { initFireMap, isEdge, stepFire, type FireParams } from "../../engine/fire";
import { dist } from "../../engine/util";
import type { ServerAgent, World } from "../world";
import type { Scenario, ScenarioMetrics } from "./types";

export function createFireScenario(params: FireParams): Scenario {
    const { width, height } = params;
    let grid: CellState[] = initFireMap(width, height);
    let burnAge = new Int32Array(width * height);
    let village: Vec[] = [];

    const cell = (x: number, y: number): CellState => {
        if (x < 0 || y < 0 || x >= width || y >= height) {
            return "unknown";
        }
        return grid[y * width + x]!;
    };

    return {
        id: "fire",
        init() {
            grid = initFireMap(width, height);
            burnAge = new Int32Array(width * height);
            village = [];
            grid.forEach((s, i) => {
                if (s === "village") {
                    village.push({ x: i % width, y: Math.floor(i / width) });
                }
            });
        },
        step(world: World) {
            grid = stepFire(grid, burnAge, params, world.wind, world.rng);
            if (world.tick % 20 !== 0) {
                return;
            }
            // Keep the demo alive forever: relight when the fire dies, regrow when the map is spent.
            let burning = 0;
            let clear = 0;
            for (const c of grid) {
                if (c === "fire") {
                    burning++;
                } else if (c === "clear") {
                    clear++;
                }
            }
            // Map mostly spent and the fire nearly out: start a fresh scenario (new moor, new ignition).
            if (clear < grid.length * 0.35 && burning < 30) {
                grid = initFireMap(width, height);
                burnAge = new Int32Array(width * height);
                return;
            }
            if (burning >= 6) {
                return;
            }
            // New ignition ("lightning strike") on clear ground, away from the village.
            for (let tries = 0; tries < 50; tries++) {
                const x = 4 + Math.floor(world.rng() * (width - 8));
                const y = 3 + Math.floor(world.rng() * (height - 6));
                if (grid[y * width + x] !== "clear" || village.some((v) => dist(v, { x, y }) < 12)) {
                    continue;
                }
                for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
                    if (grid[(y + dy) * width + x + dx] === "clear") {
                        grid[(y + dy) * width + x + dx] = "fire";
                        burnAge[(y + dy) * width + x + dx] = 0;
                    }
                }
                break;
            }
        },
        cell,
        cells: () => grid,
        tasksFor(agent: ServerAgent, world: World): Task[] {
            const out: Task[] = [];
            const r = world.radioRange;
            const p = agent.pos;
            for (let y = Math.max(0, Math.floor(p.y - r)); y <= Math.min(height - 1, p.y + r); y++) {
                for (let x = Math.max(0, Math.floor(p.x - r)); x <= Math.min(width - 1, p.x + r); x++) {
                    if (Math.hypot(x - p.x, y - p.y) > r || !isEdge(grid, width, height, x, y)) {
                        continue;
                    }
                    const nearVillage = village.some((v) => dist(v, { x, y }) < 10);
                    out.push({ id: `edge:${x}:${y}`, pos: { x, y }, kind: "edge", value: nearVillage ? 2 : 1 });
                }
            }
            // Protect tasks appear once fire is within 12 cells of the village.
            const threatened = village.some((v) => {
                for (let dy = -12; dy <= 12; dy++) {
                    for (let dx = -12; dx <= 12; dx++) {
                        if (cell(v.x + dx, v.y + dy) === "fire") {
                            return true;
                        }
                    }
                }
                return false;
            });
            if (!threatened) {
                return out;
            }
            for (const v of village) {
                if (dist(v, p) <= r && grid[v.y * width + v.x] === "village") {
                    out.push({ id: `protect:${v.x}:${v.y}`, pos: v, kind: "protect", value: 2 });
                }
            }
            return out;
        },
        metrics(world: World): ScenarioMetrics {
            let edge = 0;
            let mapped = 0;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (!isEdge(grid, width, height, x, y)) {
                        continue;
                    }
                    edge++;
                    if (world.observedFire(x, y)) {
                        mapped++;
                    }
                }
            }
            return { edgeMappedPct: edge ? (100 * mapped) / edge : 100 };
        },
        spawn(agent: { isPhone: boolean; index: number }) {
            // Everyone launches from a base in the bottom-left corner, in radio contact.
            return { x: 2 + (agent.index % 4), y: height - 4 + (Math.floor(agent.index / 4) % 3) };
        },
    };
}
