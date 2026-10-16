import {
  BorderedLoader,
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/**
 * Offers a task-appropriate model before the first prompt of a session runs.
 *
 * Ranking comes from Axon's Jev-backed routing API
 * (`PI_MODEL_RECOMMENDER_URL`). The backend owns task assessment and model
 * policy; this extension only validates available recommendations and presents
 * the picker once per session. Axon applies backend MODEL_RECOMMENDER preferences
 * to the launch environment ahead of local values; /reload does not refresh them.
 * ENABLED is inverted to PI_MODEL_RECOMMENDER_DISABLED. AUTO_SELECT_MS is a positive
 * millisecond countdown, not a boolean or a zero/off sentinel. Server 204 still wins.
 *
 * The model type is derived from `ExtensionContext` rather than imported from
 * `@earendil-works/pi-ai` so this file has no dependency the CLI does not
 * already declare.
 */
type AnyModel = NonNullable<ExtensionContext["model"]>;

type RankedModel = {
  model: AnyModel;
  reason: string;
  confidence?: number;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_LIMIT = 4;
const DEFAULT_API_TIMEOUT_MS = 5_000;
const DEFAULT_AUTO_SELECT_MS = 10_000;
const KEEP_CURRENT_VALUE = "__keep_current__";

const URL_ENVIRONMENT_VARIABLE = "PI_MODEL_RECOMMENDER_URL";
const API_KEY_ENVIRONMENT_VARIABLE = "PI_MODEL_RECOMMENDER_API_KEY";
const AUTO_SELECT_ENVIRONMENT_VARIABLE = "PI_MODEL_RECOMMENDER_AUTO_SELECT_MS";
const DISABLED_ENVIRONMENT_VARIABLE = "PI_MODEL_RECOMMENDER_DISABLED";
const TIMEOUT_ENVIRONMENT_VARIABLE = "PI_MODEL_RECOMMENDER_TIMEOUT_MS";

interface RecommenderConfig {
  readonly apiKey: string | undefined;
  readonly autoSelectMs: number;
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly url: string | undefined;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Read on every use rather than at load time so tests and wrapper scripts can
 * change the environment after the extension is registered.
 */
function readConfig(): RecommenderConfig {
  const url = process.env[URL_ENVIRONMENT_VARIABLE]?.trim();
  return {
    apiKey: process.env[API_KEY_ENVIRONMENT_VARIABLE]?.trim() || undefined,
    autoSelectMs: positiveNumber(
      process.env[AUTO_SELECT_ENVIRONMENT_VARIABLE],
      DEFAULT_AUTO_SELECT_MS,
    ),
    enabled: !isTruthy(process.env[DISABLED_ENVIRONMENT_VARIABLE]),
    timeoutMs: positiveNumber(process.env[TIMEOUT_ENVIRONMENT_VARIABLE], DEFAULT_API_TIMEOUT_MS),
    url: url || undefined,
  };
}

function modelKey(model: AnyModel): string {
  return `${model.provider}/${model.id}`;
}

function acceptsImages(model: AnyModel): boolean {
  return model.input?.includes("image") ?? false;
}

// ---------------------------------------------------------------------------
// Routing API
// ---------------------------------------------------------------------------

type ApiRecommendation = {
  confidence?: unknown;
  id?: unknown;
  model?: unknown;
  provider?: unknown;
  reason?: unknown;
};

type RemoteRecommendationResult =
  | {
      kind: "success";
      ranked: RankedModel[];
      assessment?: Record<string, unknown>;
      policyVersion?: string;
    }
  | { kind: "cancelled" }
  | { kind: "disabled" }
  | { kind: "failed"; message: string; reason: string };

function clampConfidence(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(0, Math.min(1, raw))
    : undefined;
}

function recommendationId(recommendation: ApiRecommendation): string | undefined {
  if (typeof recommendation.model === "string") return recommendation.model;
  if (typeof recommendation.id === "string") return recommendation.id;
  return undefined;
}

/**
 * Turn an API payload into a ranking, dropping anything that does not name a
 * model this session can actually use. Throws when nothing usable is left so the
 * caller can keep the current model and report why.
 */
function parseRecommendations(payload: unknown, candidates: readonly AnyModel[]): RankedModel[] {
  const recommendations = (payload as { recommendations?: unknown })?.recommendations;
  if (!Array.isArray(recommendations)) {
    throw new Error("API response has no recommendations array");
  }

  const availableByKey = new Map(candidates.map((model) => [modelKey(model), model]));
  const seen = new Set<string>();
  const ranked: RankedModel[] = [];

  for (const raw of recommendations) {
    if (!raw || typeof raw !== "object") continue;
    const recommendation = raw as ApiRecommendation;
    const id = recommendationId(recommendation);
    if (typeof recommendation.provider !== "string" || id === undefined) continue;

    const key = `${recommendation.provider}/${id}`;
    const model = availableByKey.get(key);
    if (!model || seen.has(key)) continue;
    seen.add(key);

    const confidence = clampConfidence(recommendation.confidence);
    const apiReason =
      typeof recommendation.reason === "string" && recommendation.reason.trim() !== ""
        ? recommendation.reason.trim()
        : "Recommended by routing API";

    ranked.push({
      model,
      ...(confidence !== undefined ? { confidence } : {}),
      reason:
        confidence !== undefined
          ? `${apiReason} (${Math.round(confidence * 100)}% match)`
          : apiReason,
    });
    if (ranked.length === MODEL_LIMIT) break;
  }

  if (ranked.length === 0) {
    throw new Error("API recommended no available models");
  }
  return ranked;
}

async function requestRemoteRecommendations(
  ctx: ExtensionContext,
  config: RecommenderConfig,
  prompt: string,
  hasImages: boolean,
  candidates: readonly AnyModel[],
  requestId: string,
): Promise<RemoteRecommendationResult | undefined> {
  const url = config.url;
  if (!url) return undefined;

  return ctx.ui.custom<RemoteRecommendationResult>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, "Finding the best model for this task...");
    const controller = new AbortController();
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let failureReason = "network";

    const finish = (result: RemoteRecommendationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      done(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);

    loader.onAbort = () => {
      cancelled = true;
      controller.abort();
      finish({ kind: "cancelled" });
    };

    const headers = config.apiKey
      ? { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }
      : { "content-type": "application/json" };

    void fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        prompt,
        requestId,
        hasImages,
        currentModel: ctx.model ? modelKey(ctx.model) : null,
        availableModels: candidates.map((model) => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: model.input,
          contextWindow: model.contextWindow,
          cost: model.cost,
        })),
      }),
    })
      .then(async (response) => {
        if (response.status === 204) {
          finish({ kind: "disabled" });
          return;
        }
        if (!response.ok) {
          failureReason = response.status >= 500 ? "http_5xx" : "http_4xx";
          throw new Error(`API returned HTTP ${response.status}`);
        }
        failureReason = "invalid_response";
        const raw = await response.json();
        const payload = (raw && typeof raw === "object" ? raw : {}) as {
          assessment?: Record<string, unknown>;
          policyVersion?: string;
        };
        finish({
          kind: "success",
          ranked: parseRecommendations(raw, candidates),
          ...(payload.assessment && typeof payload.assessment === "object"
            ? { assessment: payload.assessment }
            : {}),
          ...(typeof payload.policyVersion === "string"
            ? { policyVersion: payload.policyVersion }
            : {}),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = timedOut
          ? `API timed out after ${config.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
        finish({ kind: "failed", message, reason: timedOut ? "timeout" : failureReason });
      });

    return loader;
  });
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

/**
 * pi-provider-litellm appends this sentinel to model names when a deployment's
 * metadata is partial. It is internal diagnostics, not picker copy.
 */
const INCOMPLETE_METADATA_SUFFIX = " (incomplete metadata)";

/**
 * Human-friendly primary label. Model keys (`litellm/openrouter/...`) are far
 * longer than SelectList's primary column, so they belong in the description
 * where there is room; the label uses the registry display name instead.
 */
function displayName(model: AnyModel): string {
  const raw = model.name?.trim() || model.id;
  return raw.endsWith(INCOMPLETE_METADATA_SUFFIX)
    ? raw.slice(0, -INCOMPLETE_METADATA_SUFFIX.length)
    : raw;
}

function buildItems(ranked: readonly RankedModel[], current: AnyModel | undefined): SelectItem[] {
  const items: SelectItem[] = ranked.map((entry, index) => {
    const name = displayName(entry.model);
    const reason = index === 0 ? `Recommended — ${entry.reason}` : entry.reason;
    return {
      value: modelKey(entry.model),
      label: `${index === 0 ? "★ " : "  "}${name}`,
      // When the display name already is the model id (litellm names models by
      // id), repeating the full key is redundant; the provider alone completes
      // the identity. Friendly names still get the full key for disambiguation.
      description:
        name === entry.model.id
          ? `${entry.model.provider} · ${reason}`
          : `${modelKey(entry.model)} · ${reason}`,
    };
  });

  if (current) {
    items.push({
      value: KEEP_CURRENT_VALUE,
      label: "Keep current",
      description: `Continue with ${modelKey(current)}`,
    });
  }

  return items;
}

async function showModelSelector(
  ctx: ExtensionContext,
  config: RecommenderConfig,
  ranked: readonly RankedModel[],
): Promise<{
  model?: AnyModel | undefined;
  outcome: "selected" | "auto_selected" | "kept_current" | "dismissed";
}> {
  let automaticallySelected = false;
  const byKey = new Map(ranked.map((entry) => [modelKey(entry.model), entry.model]));
  const items = buildItems(ranked, ctx.model);

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    let remainingSeconds = Math.ceil(config.autoSelectMs / 1_000);
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      done(value);
    };

    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Choose a model for this task")), 1, 0),
    );

    const list = new SelectList(
      items,
      Math.min(items.length, 8),
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
      // Display names are short, but let the column grow past the 32-char
      // default so longer names are not truncated.
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 40 },
    );
    list.onSelect = (item) => finish(item.value);
    list.onCancel = () => finish(null);
    container.addChild(list);

    const help = new Text("", 1, 0);
    const updateHelp = () => {
      help.setText(
        theme.fg(
          "dim",
          `↑↓ navigate • enter select • esc keep current • auto-select in ${remainingSeconds}s`,
        ),
      );
    };
    updateHelp();
    container.addChild(help);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    timer = setInterval(() => {
      remainingSeconds -= 1;
      if (remainingSeconds <= 0) {
        automaticallySelected = true;
        finish(items[0]?.value ?? null);
        return;
      }
      updateHelp();
      tui.requestRender();
    }, 1_000);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => {
        container.invalidate();
        updateHelp();
      },
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!result) return { outcome: "dismissed" };
  if (result === KEEP_CURRENT_VALUE) return { model: ctx.model, outcome: "kept_current" };
  return {
    model: byKey.get(result),
    outcome: automaticallySelected ? "auto_selected" : "selected",
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export function createModelRecommender(
  overrides: {
    request?: typeof requestRemoteRecommendations;
    select?: typeof showModelSelector;
  } = {},
): (pi: ExtensionAPI) => void {
  return function modelRecommender(pi: ExtensionAPI): void {
    let shouldOfferRecommendation = false;
    let recommendationOffered = false;
    let appliedModel: string | undefined;
    let appliedRequestId: string | undefined;
    const emit = (stage: string, outcome: string, details: Record<string, unknown> = {}): void => {
      try {
        pi.events.emit("axon:telemetry", {
          category: "recommender",
          stage,
          outcome,
          ...details,
        });
      } catch {
        /* Observability must never affect routing. */
      }
    };
    pi.on("model_select", (event) => {
      const selected = modelKey(event.model);
      if (appliedModel && event.source !== "restore" && selected !== appliedModel) {
        emit("override", "success", {
          model: selected,
          previousModel: appliedModel,
          recommendationId: appliedRequestId,
        });
        appliedModel = undefined;
      }
    });

    pi.on("session_start", (_event, ctx) => {
      const alreadyHasTask = ctx.sessionManager
        .getBranch()
        .some((entry) => entry.type === "message" && entry.message.role === "user");
      shouldOfferRecommendation = !alreadyHasTask;
      recommendationOffered = false;
      appliedModel = undefined;
      appliedRequestId = undefined;
      if (alreadyHasTask) emit("eligible", "skipped", { reason: "resumed_session" });
    });

    pi.on("input", async (event, ctx) => {
      const config = readConfig();
      if (
        !shouldOfferRecommendation ||
        recommendationOffered ||
        ctx.mode !== "tui" ||
        event.source !== "interactive" ||
        event.streamingBehavior !== undefined ||
        event.text.trim() === ""
      ) {
        return { action: "continue" };
      }

      // Mark it before opening UI so duplicate submissions cannot open two pickers.
      recommendationOffered = true;
      if (!config.enabled) {
        emit("eligible", "skipped", { reason: "disabled" });
        return { action: "continue" };
      }
      const recommendationId = crypto.randomUUID();
      const previousModel = ctx.model ? modelKey(ctx.model) : undefined;
      emit("eligible", "success", { recommendationId, previousModel });

      const availableModels =
        ctx.scopedModels.length > 0
          ? ctx.scopedModels.map((entry) => entry.model)
          : ctx.modelRegistry.getAvailable();
      const hasImages = (event.images?.length ?? 0) > 0;
      const candidates = hasImages ? availableModels.filter(acceptsImages) : availableModels;

      if (candidates.length === 0) {
        emit("request", "skipped", { reason: "no_candidates", recommendationId });
        ctx.ui.notify("No compatible models available; keeping the current model", "warning");
        return { action: "continue" };
      }

      const requestStartedAt = Date.now();
      const remote = await (overrides.request ?? requestRemoteRecommendations)(
        ctx,
        config,
        event.text,
        hasImages,
        candidates,
        recommendationId,
      );
      const requestDetails = {
        recommendationId,
        candidateCount: candidates.length,
        durationMs: Date.now() - requestStartedAt,
      };
      if (remote?.kind === "cancelled" || remote?.kind === "disabled") {
        emit("request", remote.kind === "cancelled" ? "cancelled" : "skipped", {
          ...requestDetails,
          reason: remote.kind === "disabled" ? "policy_disabled" : "cancelled",
        });
        return { action: "continue" };
      }
      if (!remote) {
        emit("request", "skipped", { ...requestDetails, reason: "not_configured" });
        ctx.ui.notify(
          "Model recommendation API is not configured; keeping the current model",
          "warning",
        );
        return { action: "continue" };
      }
      if (remote.kind === "failed") {
        emit("request", "failed", { ...requestDetails, reason: remote.reason });
        ctx.ui.notify(
          `Model recommendation API failed (${remote.message}); keeping the current model`,
          "warning",
        );
        return { action: "continue" };
      }

      emit("request", "success", requestDetails);
      const details = { recommendationId, policyVersion: remote.policyVersion, previousModel };
      if (remote.assessment)
        emit("assessed", "success", {
          ...details,
          complexity: remote.assessment["complexity"],
          confidence: remote.assessment["complexityConfidence"],
          highComplexityProbability: remote.assessment["highComplexityProbability"],
          needsDeepReasoning: remote.assessment["needsDeepReasoning"],
          prioritizesSpeed: remote.assessment["prioritizesSpeed"],
        });
      emit("recommended", "success", {
        ...details,
        model: remote.ranked[0] ? modelKey(remote.ranked[0].model) : undefined,
        candidateCount: remote.ranked.length,
      });
      emit("shown", "success", details);
      const decisionStartedAt = Date.now();
      const decision = await (overrides.select ?? showModelSelector)(ctx, config, remote.ranked);
      const selected = decision.model;
      const rank = selected
        ? remote.ranked.findIndex((entry) => modelKey(entry.model) === modelKey(selected)) + 1
        : undefined;
      const selectedDetails = {
        ...details,
        model: selected ? modelKey(selected) : undefined,
        rank: rank && rank > 0 ? rank : undefined,
        durationMs: Date.now() - decisionStartedAt,
      };
      emit("decision", decision.outcome, selectedDetails);
      if (!selected) return { action: "continue" };
      if (ctx.model && modelKey(selected) === modelKey(ctx.model)) {
        emit("apply", "kept_current", selectedDetails);
        return { action: "continue" };
      }
      const applyStartedAt = Date.now();
      try {
        if (await pi.setModel(selected)) {
          emit("apply", "success", { ...selectedDetails, durationMs: Date.now() - applyStartedAt });
          appliedModel = modelKey(selected);
          appliedRequestId = recommendationId;
          ctx.ui.notify(`Using ${modelKey(selected)} for this task`, "info");
        } else {
          emit("apply", "failed", {
            ...selectedDetails,
            durationMs: Date.now() - applyStartedAt,
            reason: "application_failed",
          });
          ctx.ui.notify(
            `Could not use ${modelKey(selected)}; keeping the current model`,
            "warning",
          );
        }
      } catch {
        emit("apply", "failed", {
          ...selectedDetails,
          durationMs: Date.now() - applyStartedAt,
          reason: "application_failed",
        });
        ctx.ui.notify(
          "Could not apply the recommended model; keeping the current model",
          "warning",
        );
      }

      // The original user message now continues through pi using the selected model.
      return { action: "continue" };
    });
  };
}

export default createModelRecommender();
