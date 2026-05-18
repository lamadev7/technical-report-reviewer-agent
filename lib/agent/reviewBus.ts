// In-memory pub/sub for live review progress events. Each reportId gets a
// short-lived Set of subscribers consumed by the SSE endpoint. Clients that
// reconnect after a server restart fall back to the DB-stored snapshot on
// `reviewProgress` so progress survives even if this map gets wiped.

export type ReviewProgress = {
  stage:
    | "starting"
    | "rules-done"
    | "agent-running"
    | "agent-done"
    | "marking-running"
    | "reviewed"
    | "failed";
  ruleCount?: number;
  agentCount?: number;
  startedAt?: string;
  message?: string;
  error?: string;
};

type Subscriber = (evt: ReviewProgress) => void;

// Stash on globalThis so HMR in dev doesn't fragment subscribers across module
// reloads. Without this, the route handler and reviewer end up writing to
// different Map instances after a hot-reload.
const KEY = Symbol.for("@app/reviewBus");
const g = globalThis as unknown as { [KEY]?: Map<string, Set<Subscriber>> };
const subscribers: Map<string, Set<Subscriber>> = g[KEY] || (g[KEY] = new Map());

export function publish(reportId: string, evt: ReviewProgress): void {
  const set = subscribers.get(reportId);
  if (!set) return;
  for (const cb of set) {
    try { cb(evt); } catch { /* ignore subscriber errors */ }
  }
}

export function subscribe(reportId: string, cb: Subscriber): () => void {
  let set = subscribers.get(reportId);
  if (!set) {
    set = new Set();
    subscribers.set(reportId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(reportId);
  };
}

export function isTerminal(stage: ReviewProgress["stage"]): boolean {
  return stage === "reviewed" || stage === "failed";
}
