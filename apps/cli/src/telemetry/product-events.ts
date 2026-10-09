// Content-free product telemetry shared by the launcher and bundled extensions.
// Never pass prompts, paths, URLs, credentials, free-text reasons or tool payloads here.
export const PRODUCT_EVENT_CHANNEL = "axon:telemetry";
export const PRODUCT_STAGES = {
  recommender: [
    "eligible",
    "request",
    "assessed",
    "recommended",
    "shown",
    "decision",
    "apply",
    "override",
  ],
  backup: ["consent", "capture", "upload", "commit"],
  restore: ["request", "download", "verify", "fork"],
  startup: ["prepare", "spawn", "ready"],
  auth: ["preflight", "verify", "login", "refresh", "recovery"],
  config: ["fetch"],
  compaction: ["trigger", "request", "summarize", "complete"],
  update: ["check", "install"],
  release: ["launch"],
} as const;
export type ProductCategory = keyof typeof PRODUCT_STAGES;
export type CompactionTrigger = "manual" | "threshold" | "overflow" | "extension_threshold";
export type ProductOutcome =
  | "success"
  | "failed"
  | "skipped"
  | "cancelled"
  | "pending"
  | "selected"
  | "auto_selected"
  | "kept_current"
  | "dismissed";
export interface ProductEvent {
  category: ProductCategory;
  stage: string;
  outcome: ProductOutcome;
  reason?: string | undefined;
  trigger?: CompactionTrigger;
  durationMs?: number;
  bytes?: number;
  candidateCount?: number;
  rank?: number;
  model?: string;
  previousModel?: string;
  policyVersion?: string;
  version?: string;
  recommendationId?: string;
  complexity?: number;
  confidence?: number;
  highComplexityProbability?: number;
  needsDeepReasoning?: number;
  prioritizesSpeed?: number;
}
export type ProductEventObserver = (event: ProductEvent) => void;
const outcomes = new Set<ProductOutcome>([
  "success",
  "failed",
  "skipped",
  "cancelled",
  "pending",
  "selected",
  "auto_selected",
  "kept_current",
  "dismissed",
]);
const reasons = new Set([
  "disabled",
  "resumed_session",
  "no_candidates",
  "not_configured",
  "policy_disabled",
  "timeout",
  "network",
  "http_4xx",
  "http_5xx",
  "invalid_response",
  "application_failed",
  "consent",
  "account_changed",
  "origin_changed",
  "login_required",
  "no_session",
  "unchanged",
  "conflict",
  "validation",
  "unsafe_storage",
  "unavailable",
  "cancelled",
  "up_to_date",
  "unsupported",
  "missing_session",
  "present",
  "rotation_failed",
  "expired",
  "invalid_session",
  "below_threshold",
  "busy",
  "cooldown",
]);
const compactionTriggers = new Set<CompactionTrigger>([
  "manual",
  "threshold",
  "overflow",
  "extension_threshold",
]);
const textFields = ["model", "previousModel", "policyVersion", "version"] as const;
const numericBounds = {
  durationMs: 24 * 60 * 60 * 1000,
  bytes: 1024 * 1024 * 1024,
  candidateCount: 250,
  rank: 8,
  complexity: 3,
  confidence: 1,
  highComplexityProbability: 1,
  needsDeepReasoning: 1,
  prioritizesSpeed: 1,
} as const;

/** Project incoming events onto a small allowlist, including inter-extension bus events. */
export function sanitizeProductEvent(value: unknown): ProductEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source["category"] !== "string" || !Object.hasOwn(PRODUCT_STAGES, source["category"]))
    return undefined;
  const category = source["category"] as ProductCategory;
  if (
    typeof source["stage"] !== "string" ||
    !(PRODUCT_STAGES[category] as readonly string[]).includes(source["stage"])
  )
    return undefined;
  if (!outcomes.has(source["outcome"] as ProductOutcome)) return undefined;
  const event: ProductEvent = {
    category,
    stage: source["stage"],
    outcome: source["outcome"] as ProductOutcome,
  };
  if (typeof source["reason"] === "string" && reasons.has(source["reason"]))
    event.reason = source["reason"];
  // Trigger metadata is content-free and belongs only to compaction events.
  if (category === "compaction" && compactionTriggers.has(source["trigger"] as CompactionTrigger))
    event.trigger = source["trigger"] as CompactionTrigger;
  for (const field of textFields) {
    const value = source[field];
    if (typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,159}$/.test(value))
      event[field] = value;
  }
  if (
    typeof source["recommendationId"] === "string" &&
    /^[a-f0-9-]{36}$/i.test(source["recommendationId"])
  )
    event.recommendationId = source["recommendationId"];
  for (const [field, maximum] of Object.entries(numericBounds)) {
    const value = source[field];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= maximum &&
      (!(field === "rank" || field === "candidateCount" || field === "bytes") ||
        Number.isSafeInteger(value)) &&
      (field !== "rank" || value >= 1)
    )
      Object.assign(event, { [field]: value });
  }
  return event;
}

const pending: ProductEvent[] = [];
let observer: ProductEventObserver | undefined;
export function emitProductEvent(value: ProductEvent): void {
  const event = sanitizeProductEvent(value);
  if (!event) return;
  try {
    if (observer) observer(event);
    else {
      if (pending.length === 128) pending.shift();
      pending.push(event);
    }
  } catch {
    /* Telemetry cannot affect the observed operation. */
  }
}
export function subscribeProductEvents(next: ProductEventObserver): () => void {
  observer = next;
  for (const event of pending.splice(0)) {
    try {
      next(event);
    } catch {
      /* Best effort. */
    }
  }
  return () => {
    if (observer === next) observer = undefined;
  };
}
export function takeProductEvents(): ProductEvent[] {
  return pending.splice(0);
}
export function hasProductEvents(): boolean {
  return pending.length > 0;
}
export function productFailureReason(error: unknown): string {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number")
    return error.status === 409
      ? "conflict"
      : error.status === 422
        ? "validation"
        : error.status >= 500
          ? "http_5xx"
          : "http_4xx";
  return error instanceof Error && /abort|timeout/i.test(error.name) ? "timeout" : "unavailable";
}
export function observeProductEvent(observer: ProductEventObserver, event: ProductEvent): void {
  try {
    observer(event);
  } catch {
    /* Observers are never allowed to fail the operation. */
  }
}
export async function measureProductOperation<T>(
  event: Omit<ProductEvent, "outcome" | "durationMs">,
  work: () => Promise<T>,
  observer: ProductEventObserver = emitProductEvent,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await work();
    observeProductEvent(observer, { ...event, outcome: "success", durationMs: Date.now() - start });
    return result;
  } catch (error) {
    observeProductEvent(observer, {
      ...event,
      outcome: "failed",
      reason: productFailureReason(error),
      durationMs: Date.now() - start,
    });
    throw error;
  }
}
