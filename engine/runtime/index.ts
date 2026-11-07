// Browser-only exports (Web Workers, WebSocket, Wake Lock). Import from client components.
export { spawnAgentHost, type AgentHost, type HostOptions } from "./host";
export { startPhoneAgent, phoneCallsign, type PhoneAgent, type PhoneOptions } from "./phone";
export { connectAgent, resolveServerUrl, type AgentStatus, type ConnectOptions } from "./connection";
