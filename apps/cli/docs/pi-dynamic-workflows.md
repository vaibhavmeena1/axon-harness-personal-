# Pi dynamic workflows: orchestration and pipelines

This is a note on the optional `@quintinshaw/pi-dynamic-workflows` Pi extension (inspected at v3.13.0). It adds a `workflow` tool, background subagents, reusable scripts, built-in review/research patterns, and a `/workflows` run navigator. It is **not** a built-in Pi feature or a required Axon package.

## Getting started in Pi

1. **Install once** into the Pi profile you intend to use (third-party Pi packages execute code; review them first):

   ```sh
   pi install npm:@quintinshaw/pi-dynamic-workflows
   # If using Axon's separate Pi profile instead:
   axon pi install npm:@quintinshaw/pi-dynamic-workflows
   ```

   Normal `pi` and `axon pi` have different `PI_CODING_AGENT_DIR` directories, so installing in one does not install it in the other. Start Pi or run `/reload` in an already-open Pi session.

2. **Create an ad hoc workflow** by typing a request in Pi's chat. The explicit command is the most predictable option:

   ```text
   /workflows run Inspect apps/cli/src/harnesses/pi and apps/cli/src/launcher independently, verify each finding, then summarize.
   ```

   Or ask naturally: “Run a workflow to audit these two harnesses in parallel.” The word `workflow` arms the tool by default but does **not** force a run for a question or casual mention; `/workflows run` explicitly requests one. Use `/workflows-trigger status` to inspect the setting, `/workflows-trigger off` or `/workflows-trigger on` to toggle it, and `/workflows-trigger set <word>` to change the keyword.

3. **Watch or control it:** `/workflows` opens the navigator; `/workflows status <runId>` prints status/result; `/workflows pause <runId>`, `/workflows resume <runId>`, and `/workflows stop <runId>` control it. Runs are backgrounded by default and deliver their result to the conversation automatically. The navigator also shows phases, agent progress, and usage.

4. **Save a useful run as a defined workflow:** `/workflows save cli-risk-review [runId]` saves the selected run's script (without an ID, the latest run with a script). Invoke it later as `/cli-risk-review`, or select it by `name: "cli-risk-review"` with the `workflow` tool. Saved workflows are scoped to the project by default; the `/workflows` navigator can browse, rename, and delete them. A saved script is reusable, but its original run's results are **not** the inputs to later runs—supply `args` again when needed.

5. **Author your own script:** ask Pi to create one, or give the `workflow` tool raw JavaScript via its `script` input. Start with `export const meta = { name: "...", description: "..." }`, call `agent()` at least once, and return a result. The examples below show `pipeline()` and a more detailed script. **A `.md` or `.js` file in this repo is documentation/source, not an automatically registered workflow**: send its script to Pi first, then save a run if you want a slash command. `/workflows save` saves the script that actually ran, not whatever was last edited in this Markdown file.

The extension also includes `/deep-research <question>`, `/adversarial-review <task>`, `/multi-perspective <topic>`, `/code-review [range|file|PR number]`, and `/codebase-audit <scope> "<check>" ...`. These are ready-made patterns; a saved workflow of the same name takes precedence. `/workflows-models` configures model tiers. Use `/effort high`, `/effort ultra`, or `/effort off` to change the current session's standing orchestration effort (higher effort can spend substantially more tokens).

## Mental model

A *defined workflow* is a JavaScript orchestration script with a `meta` name and description. Pi runs the script, and each `agent(prompt, options)` starts a subagent with its own context. The script retains intermediate outputs, controls dependencies, and returns one result; subagents do the actual reading, searching, and editing. Runs start in the background by default, with a run ID, progress view, and eventual result delivered to the conversation.

- `parallel([() => agent(...), ...])`: independent tasks run concurrently; results preserve input order. Pass **functions**, not already-started promises.
- `pipeline(items, stage1, stage2, ...)`: each item moves through stages **in order**, while different items move through the pipeline concurrently. A stage receives `(previousValue, originalItem, index)`. Results preserve input order.
- `phase("Name")`: groups work in the progress UI; phase names must match declared metadata. Phases describe the run; they do not replace per-item pipeline dependencies.
- `workflow(savedName, args)`: calls a *saved* workflow inline (one nesting level, shared limits). The five built-in patterns are invoked at the top level, not through this helper.

For example, with two areas, pipeline execution may interleave like this:

```text
Pi adapter:  inspect ──► verify ──┐
Launcher:    inspect ──► verify ──┼──► synthesize once both finish
```

Verification for an area receives **that area's** inspection result. It does not wait for the other area's inspection to finish. The final synthesis waits for the entire pipeline. If a stage returns `null` after a recoverable failure, the next stage still receives `null`: check it rather than interpreting it as “no issues.”

## Example: a defined, two-stage CLI review

Pass this script to Pi's `workflow` tool as `script`, or ask Pi to create an equivalent workflow. It is read-only by instruction; the extension does not itself enforce read-only tools here. Two fixed areas bound the fan-out to at most **five logical agent calls**: two inspections, two verifications, and one report.

```js
export const meta = {
  name: "cli_risk_review",
  description: "Inspect and independently verify launcher risks",
  phases: [{ title: "Inspect and verify" }, { title: "Synthesize" }],
};

const areas = [
  { id: "pi", path: "apps/cli/src/harnesses/pi" },
  { id: "launcher", path: "apps/cli/src/launcher" }
];

phase("Inspect and verify");
const results = await pipeline(
  areas,
  async (_unused, area) =>
    agent(
      `Read ${area.path} and identify concrete launcher risks. Do not edit files. ` +
        `Cite paths and line numbers; say explicitly if you found none.`,
      { label: `inspect:${area.id}` },
    ),
  async (inspection, area) => {
    if (inspection === null) return { inspection: null, verification: null };
    const verification = await agent(
      `Independently verify these ${area.id} findings against ${area.path}. ` +
        `Do not edit files. Identify unsupported claims and cite evidence.\n\n${inspection}`,
      { label: `verify:${area.id}` },
    );
    return { inspection, verification };
  },
);

// Pair results with their original identities *before* interpreting failures.
const ledger = areas.map((area, index) => {
  const result = results[index];
  return {
    area: area.id,
    status: result?.inspection != null && result?.verification != null
      ? "complete" : "incomplete",
    inspection: result?.inspection ?? null,
    verification: result?.verification ?? null,
  };
});

phase("Synthesize");
const report = await agent(
  `Report only verified risks. Flag every incomplete area; do not treat missing ` +
    `coverage as a clean bill of health.\n\n${JSON.stringify(ledger)}`,
  { label: "synthesize:cli-risks" },
);
return { ledger, report };
```

The pipeline's `results[index]` corresponds to `areas[index]`, even if another item's verification finishes first. The ledger retains both raw inspection and verification and marks missing work as incomplete. For machine-readable decisions instead of prose, give an agent a small JSON `schema`; otherwise `agent()` returns text (or recoverable `null`), **not** a parsed JSON object.

To turn this example into a reusable command, run a workflow with its script and save that run with `/workflows save cli-risk-review`. See [Getting started in Pi](#getting-started-in-pi) for invocation and run controls.

## Fictional end-to-end example: Moonbase release decision

**Illustrative only.** Moonbase, its files, models, and agent type do not exist in this repository. This is a map of the available knobs, not a workflow to launch unchanged. In particular, **not every option belongs on one agent**: `thread` cannot be combined with worktree isolation, `cwd` cannot be combined with worktree isolation, and `name` is an alternative to `script` at the top-level tool input.

The hypothetical request is: “Review up to three Moonbase components for release `R-42`. For each component, inspect evidence and independently check it. Then check the runbook and rollback plan in parallel, produce a decision, and check it for unsupported claims and missing coverage.”

```text
args.components ──► pipeline(each component: inspect → verify)
                 ──► parallel(runbook check, rollback check)
                 ──► decide → verify → completenessCheck
```

Items within the pipeline overlap; the two side checks overlap with each other **after** the pipeline finishes. The phases here are deliberate barriers, not simultaneous branches.

### 1. Inputs to the top-level `workflow` tool

This **JSONC illustration** shows every top-level input; comments and placeholders must be removed/replaced before an actual tool call. Usually omit the commented-out fields. The `args` object becomes the script's `args` global.

```jsonc
{
  "script": "<paste the JavaScript script below>", // Or use "name"; do not need both.
  // "name": "codebase-audit",              // Saved workflow wins over a built-in of the same name.
  "args": {
    "release": "R-42",
    "components": [
      { "id": "gateway", "path": "moonbase/gateway" },
      { "id": "habitat", "path": "moonbase/habitat" }
    ]
  },
  "background": true,                     // Default; false blocks for the result in this turn.
  "maxAgents": 12,                       // Max 3 components × 2 + 2 side checks + 1 decision + 2 reviewers + 1 critic.
  "concurrency": 3,                       // Simultaneous agents; clamped to 1–16.
  "agentRetries": 1,                      // Recoverable failures only; 0 by default, up to 3.
  // "agentTimeoutMs": 120000,            // Optional per-agent time limit; otherwise configured/unbounded.
  // "tokenBudget": 50000,                // Optional soft spend gate, ONLY if the user requests a cap.
  // "resumeFromRunId": "prior-run-id"    // Instead: edited script + prior incomplete run; always background.
}
```

`name` selects a saved workflow or one of `deep-research`, `adversarial-review`, `code-review`, `multi-perspective`, and `codebase-audit`; each built-in has its **own** `args` shape. `name` cannot be combined with `resumeFromRunId`. A completed run cannot be resumed; use a new run. For the fictional script below, `maxAgents: 12` covers the largest allowed input (three components); the two-component input normally needs at most ten calls. Runtime execution retries do **not** add logical agent slots; helper-created agents do.

### 2. The fictional orchestration script

This is the `script` value above, shown as JavaScript rather than an escaped JSON string. It demonstrates **pipeline dependencies**, independent parallel work, `args`, phases, model routing, named roles, structured results, quality helpers, and honest failure reporting. The fake paths and role must be replaced before running it.

```js
export const meta = {
  name: "moonbase_release_review", // Required literal name and description; this must be the first statement.
  description: "Inspect, verify, and decide whether a fictional release is ready",
  phases: [
    { title: "Component pipeline" },
    { title: "Independent checks" },
    { title: "Decision and quality" },
  ],
};

// args is JSON from the tool call. Validate cardinality before spawning anything.
const release = args?.release;
const components = args?.components;
if (typeof release !== "string" || !Array.isArray(components) ||
    components.length < 1 || components.length > 3 ||
    components.some((c) => !c || typeof c.id !== "string" || !c.id ||
      typeof c.path !== "string" || !c.path) ||
    new Set(components.map((c) => c.id)).size !== components.length) {
  throw new Error("Expected a release and 1–3 components with unique ids and paths");
}

const inspectionSchema = {
  type: "object",
  properties: { risks: { type: "array", items: { type: "string" } } },
  required: ["risks"], // Empty array means an inspected component had no reported risks.
};
const verificationSchema = {
  type: "object",
  properties: {
    supported: { type: "boolean" },
    explanation: { type: "string" },
  },
  required: ["supported", "explanation"],
};

phase("Component pipeline");
const perComponent = await pipeline(
  components,
  // Stage 1: components are independent and may be inspected simultaneously.
  async (_previous, component) => agent(
    `Inspect ${component.id} at ${component.path} for ${release}. ` +
      `Return risks with file/line evidence; do not edit files.`,
    { label: `inspect:${component.id}`, tier: "small", thinking: "low",
      schema: inspectionSchema },
  ),
  // Stage 2: this component's verification waits for ITS inspection, not all inspections.
  async (inspection, component) => {
    if (inspection === null) return { inspection: null, verification: null };
    const verification = await agent(
      `Independently check ${component.id} at ${component.path}. ` +
        `Confirm or reject these findings with evidence: ${JSON.stringify(inspection)}`,
      { label: `verify:${component.id}`, agentType: "fictional-auditor",
        schema: verificationSchema },
    );
    return { inspection, verification };
  },
);

// Preserve every intended ID, including ones whose agent returned null.
const ledger = components.map((component, index) => {
  const result = perComponent[index]; // pipeline returns results in INPUT order.
  return {
    id: component.id,
    status: result?.inspection != null && result?.verification != null
      ? "reviewed" : "missing",
    inspection: result?.inspection ?? null,
    verification: result?.verification ?? null, // supported:false is NOT a failed call.
  };
});

phase("Independent checks");
const sideResults = await parallel([
  () => agent(`Check the ${release} runbook at moonbase/ops/runbook.md. Do not edit.`,
    { label: "check:runbook", tier: "small" }),
  () => agent(`Check the ${release} rollback plan at moonbase/ops/rollback.md. Do not edit.`,
    { label: "check:rollback", tier: "small" }),
]);
const sideChecks = ["runbook", "rollback"].map((id, index) => ({
  id, status: sideResults[index] === null ? "missing" : "reviewed",
  result: sideResults[index],
}));

phase("Decision and quality");
const decision = await agent(
  `Decide whether ${release} can ship. Use ONLY these results; report missing ` +
    `coverage explicitly.\n${JSON.stringify({ ledger, sideChecks })}`,
  { label: "decide:release", tier: "big", schema: {
    type: "object",
    properties: {
      ship: { type: "boolean" },
      reasons: { type: "array", items: { type: "string" } },
    },
    required: ["ship", "reasons"],
  } },
);
// verify() creates two MORE agents; it isn't a free boolean check.
const vote = decision === null ? null : await verify(
  { release, ledger, sideChecks, decision },
  { reviewers: 2, threshold: 1, lens: ["evidence", "missing coverage"] },
);
// One more critic agent; advisory result or null, not a proof of completeness.
const coverage = await completenessCheck({ release, components },
  { ledger, sideChecks, decision });
log(`Reviewed ${components.length} components; recorded ${budget.spent()} tokens so far`);
return { release, ledger, sideChecks, decision, vote, coverage }; // Plain JSON data only.
```

> `agent()` without `schema` returns text (or `null`); a prompt saying “return JSON” does not parse it. Schema failures after bounded repair **throw**, rather than becoming a recoverable `null`. The verification agent above uses a fictional `agentType` and will fail unless that definition exists. Read-only prompts alone do not enforce read-only tools.

### 3. Configuration that the example assumes

A **hypothetical** tier mapping in `~/.pi/workflows/model-tiers.json` (or its external per-project overlay) could look like this. Replace *every* model spec with a real, available, authenticated model; these placeholders will not run:

```json
{
  "tiers": {
    "small": "provider/REPLACE_WITH_REAL_SMALL_MODEL:low",
    "medium": "provider/REPLACE_WITH_REAL_MEDIUM_MODEL:medium",
    "big": "provider/REPLACE_WITH_REAL_BIG_MODEL:high"
  }
}
```

A fictional `.pi/agents/fictional-auditor.md` would define the role used by the second pipeline stage (or put it in the **active** Pi agent directory's `agents/` folder):

```md
---
name: fictional-auditor
description: Checks release risk claims against source evidence
tools: read
model: provider/REPLACE_WITH_REAL_REVIEW_MODEL
thinking: high
---

Verify each supplied claim against the named component. Cite evidence; do not invent files.
```

The `tools: read` allowlist is meaningful; saying “do not edit” in a prompt is not an access-control mechanism. Other bound agent-definition fields include `disallowedTools` (a denylist) and `isolation: worktree`. In this version, `mcp`, `skills`, and `background` in agent-definition frontmatter are parsed but do **not** supply those capabilities to children. `model` in the agent definition takes precedence over a script's `tier` for that agent, but an explicit `agent("...", { model: "provider/id" })` overrides both. Phase-level and metadata-level `model` defaults also exist. The selection order is **explicit model → agent-type model → tier → phase model → metadata model → inherited main model (if enabled) → implicit medium → session default**. An unavailable explicitly selected model errors instead of silently switching.

The separate `~/.pi/workflows/settings.json` holds *extension defaults*, not script arguments. This optional JSON example uses no spending or time cap:

```json
{
  "keywordTriggerEnabled": true,
  "keywordTriggerWord": "workflow",
  "defaultEffort": "off",
  "defaultConcurrency": 3,
  "defaultAgentRetries": 1,
  "inheritMainModel": false,
  "persistAgentSessions": false,
  "progressPanelMode": "compact",
  "progressPanelMaxAgents": 8,
  "providerMiddlewareExtensions": []
}
```

Other supported settings: `defaultAgentTimeoutMs` (positive milliseconds or `null` for no hard timeout), `defaultTokenBudget` (positive tokens or `null` for no cap), `deliveredResultMaxChars` (background result fallback length), and `excludeSubagentTools` (additional child-tool denylist). Repo-local `.pi/workflows/settings.json` overrides global settings; an external user-specific project override under `~/.pi/workflows/projects/<project>/settings.json` takes precedence over both. Absent tier config, an explicitly requested tier may fall back to the session model with a warning: configure `/workflows-models` if small/big should actually mean different models. Child sessions do not load other Pi extensions by default; only trusted, explicitly allowlisted provider middleware is opted in, and that allowlist loads whole extensions, not only auth hooks.

### 4. Remaining knobs and when *not* to combine them

All `agent(prompt, options?)` inputs, including those deliberately **not** exercised by the main example:

| Option | Illustrative value | Meaning / caveat |
| --- | --- | --- |
| `label`, `phase` | `"inspect:gateway"`, `"Component pipeline"` | Unique display label; optionally override current phase. |
| `schema` | `{ type: "object", ... }` | Plain JSON Schema for validated structured output. Without it, output is text. |
| `model`, `thinking`, `tier` | `"provider/id:high"`, `"low"`, `"small"` | Exact model beats agent type and tier; model's thinking suffix beats separate `thinking`. Use real configured routes only. |
| `agentType` | `"fictional-auditor"` | Named `.pi/agents/*.md` role binding prompt, tool policy, model, thinking, possibly worktree isolation. |
| `isolation`, `keepWorktree` | `"worktree"`, `true` | Optional separate Git worktree per live call, kept for merge by default. `false` for `isolation` opts out of an agent-type worktree default; `keepWorktree: false` removes a temporary worktree. |
| `cwd` | `"/absolute/existing/path"` | Target existing directory for the child session; cannot combine with worktree isolation. |
| `thread` | `"writer"` | Reuse one child's conversation **sequentially** inside a single uninterrupted invocation; cannot combine with worktree isolation and is not journal-replayed. Never use the same thread in parallel calls. |
| `timeoutMs`, `retries` | `120000`, `1` | Per-call overrides for timeout and recoverable-failure retries; `timeoutMs: null` disables the timeout. Retries are capped at 3. |

Other script globals/helpers are composable, but each extra agent consumes capacity:

| Feature | Example or rule |
| --- | --- |
| `meta.model`, `meta.phases[].model`, `meta.phases[].detail` | Literal optional default model, phase-specific model, and phase description; `phase("Name", { budget: N })` sets an optional **soft token** gate. |
| `cwd`, `process.cwd()`, `log()`, `budget.spent()/remaining()` | Read the run directory, append a progress log, or inspect **raw** token accounting; `budget.total` is the configured total. |
| `judgePanel(attempts, { judges: 3, rubric: "..." })` | Compare candidates; uses one agent per populated attempt **times** judges. |
| `retry(thunk, { attempts: 3, until })` / `gate(thunk, validator, { attempts: 3 })` | Bounded semantic retries / validation feedback; each thunk that calls `agent()` is a *new* logical call, unlike execution retries. |
| `loopUntilDry({ round, key, consecutiveEmpty: 2, maxRounds: 50 })` | Deduplicate discoveries until two empty rounds or the bound; retain a ledger of failed rounds yourself. |
| `workflow("saved-name", childArgs)` | Call a **saved** script inline; one nested level, shared agent/concurrency/token limits. Not how built-in names are called. |
| `checkpoint("Approve?", { default: false, headless: "abort" })` | Human **confirm** only with a foreground UI (`background: false`); background runs are headless. `input`, `select`, and `timeoutMs` are declared but not implemented as interactive forms. |
| `checkpoint({ kind, checkpointId, payload })` | Different durable controller handoff: pauses the run until a host attaches a JSON response and resumes the *exact* checkpoint ID. No popup and no automatic default. |

For example, an **implementation** branch could use `agent("Make the change", { isolation: "worktree", keepWorktree: true })`, while a **follow-up conversation** could use sequential `thread: "writer"` calls instead. Do not combine those modes or assume a worktree will be merged automatically. `parallel()` requires functions (`() => agent(...)`); `pipeline()` passes the prior stage's value to the next stage for the **same item**. Neither helper magically turns a failed `null` into a negative result.

## Workflow-level fallbacks and retry configuration

Here **fallback means an alternate workflow step**, not a backup model. There is no declarative `fallback` field: write the branch in the script. For example, this is an **alternative** to the Moonbase component pipeline above; it does not run in addition to it:

```js
const perComponent = await pipeline(
  components,
  async (_previous, component) => {
    const primary = await agent(
      `Inspect ${component.id} at ${component.path} using the usual checklist.`,
      { label: `primary:${component.id}`, schema: inspectionSchema, retries: 1 },
    );
    // After 1 extra attempt, a recoverable failure becomes null. Only THEN try
    // a different method; an empty risks array is a valid inspected result.
    const backup = primary === null ? await agent(
      `Inspect ${component.id} at ${component.path} using the independent checklist.`,
      { label: `backup:${component.id}`, schema: inspectionSchema, retries: 0 },
    ) : null;
    return {
      source: primary !== null ? "primary" : backup !== null ? "backup" : "missing",
      inspection: primary ?? backup, // Null means neither path covered this item.
    };
  },
  async (candidate, component) => {
    if (candidate.inspection === null) return { ...candidate, verification: null };
    const verification = await agent(
      `Verify ${component.id}: ${JSON.stringify(candidate.inspection)}`,
      { label: `verify:${component.id}`, schema: verificationSchema },
    );
    return { ...candidate, verification };
  },
);
// Keep component IDs and source (primary/backup/missing) in the returned ledger.
```

The backup is a **new logical agent call** with a different prompt; it can itself fail. If you allow three components, this branch raises the Moonbase example's worst case from **12 to 15 calls** (up to 3 per component, plus the same 6 independent/quality calls). Raise `maxAgents` accordingly. You can similarly branch to `await workflow("saved-backup-name", args)` if that saved workflow exists; its agents consume the same shared limits and nesting is capped at one level. You may also fall back on an explicit *semantic* rejection (for example, a schema-validated `ready: false`), not only `null`. Do **not** silently treat a missing result as “no issues.”

| Retry layer | Where to set it | What it means |
| --- | --- | --- |
| Default | `defaultAgentRetries: 1` in `~/.pi/workflows/settings.json` (or a project overlay) | Default **extra** execution attempts for each agent; 0 if unset. |
| Run | `agentRetries: 1` on the top-level `workflow` call | Overrides the workflow default for this run. |
| Individual call | `agent(prompt, { retries: 2 })` | Overrides the run default for that call; 0–3 extra attempts on recoverable execution failures. |
| Semantic retry | `retry(thunk, { attempts: 3, until: isGood })` or `gate(thunk, validator, { attempts: 3 })` | Runs **new logical calls** when a result is unsatisfactory. `attempts` counts total thunk calls; bound the loop and include every possible call in `maxAgents`. |

Execution retries repeat the same call/route on recoverable failures such as timeout or empty output; after exhaustion the call returns `null`. Nonrecoverable errors (including schema failure after repair, agent-limit exhaustion, or token-budget exhaustion) throw: do not turn those into ordinary fallback successes. `retry()` does not automatically judge quality—its `until` predicate must be synchronous, and exhaustion returns only the last result. Keep an attempt ledger if earlier attempts matter.

## Configuration and limits

- Per-agent routing supports an exact `model`, a configured `tier`, or a named `agentType` definition with instructions/tool policy. Tier mappings live in `~/.pi/workflows/model-tiers.json`; `/workflows-models` edits them. Agent definitions live in `.pi/agents/*.md` or the active Pi agent directory's `agents/*.md`. Do not assume a tier uses a cheaper model until its mapping is configured.
- Extension settings live in `~/.pi/workflows/settings.json`. Repo-local `.pi/workflows/settings.json` and the extension's user-specific project override can layer over global settings. Options include `defaultConcurrency`, `defaultAgentRetries`, `inheritMainModel`, and `persistAgentSessions`.
- `maxAgents` defaults to 1,000; concurrent agents are capped at 16. A run/phase token budget is a **soft pre-call gate**: already-running agents may overshoot. Without a configured default or an explicit limit, there is no run token budget or hard per-agent timeout.
- Background runs can be paused and resumed from their journal. Successful unchanged agent calls in the matching prefix can replay without rerunning; changing or inserting an earlier call invalidates the later prefix. Completed runs cannot be resumed in place with an edited script.
- Scripts cannot use imports, `require`, direct filesystem/network access, `Date.now()`, or `Math.random()`; send such work to subagents. The VM makes replay predictable, **not** secure. Child sessions do not load other host extensions by default, so extension-provided tools (including MCP bridges) are not automatically present.

Use this for independently inspectable areas with an explicit verification or synthesis step. A small, direct task usually costs less and is easier to review without a multi-agent workflow.
