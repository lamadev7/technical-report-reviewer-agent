// In-memory pub/sub for live review progress events. Each reportId gets a
// short-lived Set of subscribers consumed by the SSE endpoint. Clients that
// reconnect after a server restart fall back to the DB-stored snapshot on
// `reviewProgress` so progress survives even if this map gets wiped.

export type ReviewStep = {
  name: string;
  status: "pending" | "pass" | "fail";
  detail?: string;
};

export type ReviewProgress = {
  stage:
    | "starting"
    | "rules-done"
    | "agent-running"
    | "agent-done"
    | "marking-running"
    | "reviewed"
    | "failed"
    | "cancelled";
  ruleCount?: number;
  agentCount?: number;
  startedAt?: string;
  message?: string;
  error?: string;
  steps?: ReviewStep[];
};

type Subscriber = (evt: ReviewProgress) => void;

// Stash on globalThis so HMR in dev doesn't fragment subscribers across module
// reloads. Without this, the route handler and reviewer end up writing to
// different Map instances after a hot-reload.
const KEY = Symbol.for("@app/reviewBus");
const ABORT_KEY = Symbol.for("@app/reviewAborts");
const g = globalThis as unknown as {
  [KEY]?: Map<string, Set<Subscriber>>;
  [ABORT_KEY]?: Map<string, AbortController>;
};
const subscribers: Map<string, Set<Subscriber>> = g[KEY] || (g[KEY] = new Map());
const aborts: Map<string, AbortController> = g[ABORT_KEY] || (g[ABORT_KEY] = new Map());

export function registerAbort(reportId: string): AbortController {
  // Replace any stale controller for the same report (defensive — should not
  // happen because runReview is one-at-a-time per report).
  aborts.get(reportId)?.abort();
  const ctrl = new AbortController();
  aborts.set(reportId, ctrl);
  return ctrl;
}

export function getAbortSignal(reportId: string): AbortSignal | undefined {
  return aborts.get(reportId)?.signal;
}

export function clearAbort(reportId: string): void {
  aborts.delete(reportId);
}

// Returns true if a controller existed and was aborted, false otherwise.
export function triggerAbort(reportId: string): boolean {
  const ctrl = aborts.get(reportId);
  if (!ctrl) return false;
  ctrl.abort();
  aborts.delete(reportId);
  return true;
}

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
  return stage === "reviewed" || stage === "failed" || stage === "cancelled";
}
