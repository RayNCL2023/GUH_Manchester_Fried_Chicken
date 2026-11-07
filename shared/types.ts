// shared/types.ts — THE CONTRACT. Everyone imports from here. Change only with team agreement.
// Tick-based: world server runs at 10 ticks/sec. Each tick: server sends Sense -> agent returns Action.
//
// Tie-break rules (do not change without telling everyone):
//   Map cells: higher ts wins; equal ts -> HIGHER agent id wins.
//   Claims:    lower score wins; equal score -> LOWER agent id wins.

export type AgentId = string;
export type ScenarioId = "fire" | "lights";
export interface Vec { x: number; y: number }

// ---------- Messages between agents (routed by world server, subject to range/loss/jamming) ----------
export type MsgKind = "map" | "claim" | "release" | "goal" | "heartbeat" | "chatter";

export interface Msg {
  id: string;            // unique, for dedupe in multi-hop relay
  from: AgentId;
  kind: MsgKind;
  ttl: number;           // hops remaining; relay decrements, drop at 0
  ts: number;            // sender's tick when created
  body: unknown;         // see body types below (map->MapBody, claim/release->ClaimBody, ...)
}

// Mergeable map: last-writer-wins per cell (higher ts wins; tie -> higher agent id)
export interface CellObs { x: number; y: number; state: CellState; ts: number; by: AgentId }
export type CellState = "unknown" | "clear" | "fire" | "burnt" | "village";
export interface MapBody { cells: CellObs[] }

// Leaderless task claiming: task ids are scenario-defined strings ("edge:12:40", "slot:3:7")
// Used by both "claim" and "release" messages. Lower score wins; tie -> lower agent id.
export interface ClaimBody { taskId: string; claimant: AgentId; ts: number; score: number }
export interface HeartbeatBody { pos: Vec; claim: string | null; windEstimate?: Vec }
export interface GoalBody { id: string; text: string; target?: Vec; radius?: number; priority: number } // from voice command
export interface ChatterBody { line: string }                                // spoken by voice layer

// ---------- Server -> agent, every tick ----------
export interface Sense {
  tick: number;
  scenario: ScenarioId;
  self: { id: AgentId; pos: Vec; alive: boolean; jammed: boolean; isPhone: boolean };
  nearbyCells: CellObs[];        // only what this agent's sensors can see right now
  neighbours: AgentId[];         // agents currently within radio range (and not jammed)
  inbox: Msg[];                  // messages that survived range/loss/jamming this tick
  tasks: Task[];                 // tasks this agent can currently perceive
  clockMs: number;               // shared clock (light show sync)
}

export interface Task { id: string; pos: Vec; kind: "edge" | "protect" | "slot"; value: number;
  color?: string }               // color used by light show slots

// ---------- Agent -> server, every tick ----------
export type AgentMode = "normal" | "isolated" | "relay";

export interface Action {
  moveTo?: Vec;                  // server clamps to max speed
  send?: Omit<Msg, "from">[];    // broadcast within range
  claimed?: string | null;       // current task id (for viewer + metrics only; server never assigns)
  display?: { color: string };   // phone light-show colour
  status?: { mode: AgentMode; knownPct: number; windEstimate?: Vec }; // server can't see debug() in a worker
}

// ---------- Agent brain (Role 1). Pure: no network, no DOM. Runs in Web Worker or phone browser ----------
export interface AgentBrain {
  init(id: AgentId, scenario: ScenarioId): void;
  step(sense: Sense): Action;
  debug(): { knownCells: number; claim: string | null; mode: AgentMode };
}

// ---------- Viewer state (server -> main screen, ~10Hz) ----------
export interface WorldView {
  tick: number;
  scenario: ScenarioId;
  width: number; height: number;
  cells: CellState[];            // ground truth, row-major. Full array ~1/sec; may be [] in between
  cellDiff?: [index: number, state: CellState][]; // changed cells since last view (when cells is [])
  agents: { id: AgentId; pos: Vec; alive: boolean; jammed: boolean; isPhone: boolean;
            claim: string | null; mode: string; knownPct: number; color?: string;
            windEstimate?: Vec }[];
  links: [AgentId, AgentId][];   // radio links this tick (for drawing)
  jamZones: { center: Vec; radius: number }[];
  wind: Vec;
  metrics: { edgeMappedPct: number; msgLossPct: number; aliveAgents: number };
  recentChatter: { from: AgentId; line: string; tick: number }[];
}

// ---------- Control commands (main screen / judge -> server) ----------
export type Control =
  | { type: "addJam"; center: Vec; radius: number }
  | { type: "clearJams" }
  | { type: "setWind"; wind: Vec }
  | { type: "setLoss"; pct: number }          // global packet loss 0-100
  | { type: "killAgent"; id: AgentId }
  | { type: "goal"; body: GoalBody }          // injected to ONE random agent; must spread by gossip
  | { type: "switchScenario"; scenario: ScenarioId }
  | { type: "reset" };

// ---------- WebSocket envelopes ----------
export type ClientHello =
  | { role: "viewer" }
  | { role: "agent"; id: AgentId; isPhone: boolean };
export type ServerToAgent = { t: "sense"; sense: Sense };
export type AgentToServer = { t: "action"; action: Action };
export type ServerToViewer = { t: "view"; view: WorldView };
export type ViewerToServer = { t: "control"; control: Control };
