# `ux-orchestrator-os`: Pi feasibility and implementation proposal

**Status:** standalone, open-source Pi extension design/feasibility assessment; not an installed extension, implementation, or approved medical-device workflow. Inspected against locally installed Pi 0.87.1 and `@quintinshaw/pi-dynamic-workflows` 3.13.0; confirm APIs against every Pi version the new plugin will support. This proposal does **not** depend on the dynamic-workflows plugin; Figr and Claude Code describe intended UX breadth/fidelity, not required integrations.

## Verdict and evidence boundary

A **new Pi extension plus a deterministic controller** can implement read-only research, staged UX proposals, independent reviews, persistent context pods, and three mandatory human checkpoints. Pi supplies commands, custom tools, SDK agent sessions, session/UI events, and configurable models. Pi does **not** supply a built-in UX state machine, durable authenticated approvals, a protected Figma writer, or a first-class subagent-role manifest: we must build those parts.

| Requirement | Feasibility | What would actually provide it |
| --- | --- | --- |
| Role-specific research, flow, DS, execution and critic workers | **Yes, engineering work** | Pi SDK `createAgentSession()` (or Pi JSON/RPC child processes); explicit prompt, model, tools and context for each role. |
| Psychological journey and DS-conflict analysis | **Possible, not deterministic quality** | Structured outputs with evidence/provenance, independent critique, validation rubrics and human review. A model's opinion is not user research or compliance evidence. |
| Three non-skippable approval gates and revisions | **Yes for plugin-controlled actions; security depends on the boundary** | External durable FSM, validated reviewer decisions and a write executor that checks approval *at mutation time*. A Pi dialog or system prompt alone cannot enforce this. |
| Global/local context across Pi sessions | **Yes** | Versioned, bounded, explicitly selected pods stored outside Pi's compaction summaries; pinned snapshots per run. |
| Read Figma structure, text, layouts and components | **Verified for the supplied example node** | An already-authenticated native `get_figma_data` tool returned the `HiFi` canvas and selected child frames. It exposes a structured read result, **not** guaranteed complete variable-library access, screenshots, or design intent. |
| Retrieve referenced image/icon assets | **Tool exposed; not exercised** | The native `download_figma_images` tool can save selected SVG/PNG assets locally. It is not a full-frame screenshot exporter; validate output path and privacy before calling it. |
| Create/edit Figma Auto Layout and publish node IDs | **Not available with the observed tools; blocks automated Figma writing** | Neither exposed tool mutates design nodes. A future independently verified write tool/editor bridge would need bounded authority, read-back and recovery; authenticated read access does not grant edits. |
| Generate React/Tailwind code and test it | **Yes, conditional on repository access** | A staged code worker, appropriate tools, frontend-specific checks and human review; “production-ready” cannot be inferred from generation alone. |
| Health/medical safety compliance | **Not automatable as a guarantee** | Policy rules, clinical/legal ownership, human approval, and independent tests. A disclaimer is not a substitute for jurisdictional review. |

This is a **tool-observed capability assessment**, not a vendor certification. I successfully read the user-supplied Figma file's `HiFi` canvas (`128:8318`) and three child frames; the host supplies authentication, so the plugin need not implement a connection or login for this read path. The asset-download tool was inspected but not called, and **no Figma node-write tool is exposed**. No Figma edit, full-frame export, token-library version, or current vendor write capability was verified. The plugin can consume the host's native tool contract without implementing its transport.

## Recommended ownership and trust boundaries

```text
Pi TUI / trusted RPC client
  └─ /ux-start, /ux-status, /ux-review, /ux-abort (PROPOSED commands)
       │
       ▼
Opt-in Pi extension: presentation + role dispatch; never the authority for a write
       │                │
       │                ├─ bounded Pi SDK sessions: research, IA, DS, concepts, critic
       │                │   explicit tools/models/context; no production write credential
       │                └─ optional sandboxed code-draft worker after gate 3
       ▼
Durable controller: FSM + immutable artifacts/pod snapshot + approval/audit store
       │                ▲
       │                └─ authenticated reviewer, decision bound to proposal revision
       ├─ authenticated native Figma read tools → bounded evidence for the controller
       ▼
Single write executor: authorization recheck → staged code/Figma operation → read-back
       │
       └─ OPTIONAL future Figma writer/editor bridge (not exposed today)
```

**Orchestrator = deterministic program**, not `seniordesigner.md` acting as the authority. Role prompts/skills guide reasoning but cannot approve a transition, create a credential, or disable a gate. The controller and executor own the only code paths that can transition from planning to mutation. The critic cannot mark a missing review as passed.

There are two deployment grades:

- **Read-only/local prototype:** an opt-in Pi extension may own local artifacts and request TUI signoff, with no Figma write credentials and no production code write capability. Useful for verifying UX and flow, **not** a strong security claim.
- **Production-controlled execution:** move durable approval and write execution to a separately controlled service/principal. Authenticate reviewer and worker identities, limit credentials and network paths, and allow only the executor to reach the mutation API. An extension/sidecar running as the **same OS user** as Pi is a deterministic software gate for cooperative components, **not an isolation boundary** against other extensions, shell commands, or direct use of accessible credentials. For a hard restriction, use a separate account/container/service with OS/network controls.

Pi's `tool_call` interception and host tool permissions are useful defense in depth, but do not cover arbitrary process/network access or an unrelated SDK child. A child with `bash` can write even if `edit` and `write` are absent. Explicit read-only tool allowlists, controlled resource discovery, restricted credentials and (when required) OS isolation must precede prompting. If a native Figma **write** tool appears later, do not expose it directly to planning/model workers; route it through the gate-bound executor.

### Standalone OSS Pi package (proposed)

Build an independent Pi package, not an integration with a particular host application. During development load a local package for one Pi invocation (`pi -e ./ux-orchestrator-os`); a published version could be installed through `pi install npm:<published-package-name>`. Ordinary installed Pi packages load in later sessions, so installation alone does **not** make the plugin opt-in per session. Choose either explicit one-invocation loading or an installed extension that is **default-off and inert** until `/ux-start` or a user setting enables it. Package dependencies must be declared; do not assume another Pi plugin or a particular project supplies them.

```text
ux-orchestrator-os/                  # proposed separate OSS package, not created here
├── package.json                    # pi.extensions: ["./src/extension.ts"]
├── src/
│   ├── extension.ts                # Pi commands and presentation
│   ├── sessions.ts                 # explicitly configured role sessions
│   ├── controller.ts               # durable FSM client / local prototype
│   ├── pods.ts                     # versioned context selection
│   └── figma-read.ts               # URL parsing and bounded native-tool evidence
├── prompts/                        # versioned role instructions, not authority
└── tests/                          # fixtures, fake executors, gate/replay tests
```

Use Pi's actual Node.js-or-Bun host compatibility for the extension and its dependencies. A separately controlled service is an **optional architecture choice for production-grade approvals/writes**, not a requirement to couple the plugin to an existing app. A local-only extension and service running under the same OS identity do not form a hard security boundary.

## Pi integration plan (proposed interfaces, not existing commands)

1. Register `/ux-start [figma-url]`, `/ux-status <runId>`, `/ux-review <runId> <gate>`, `/ux-abort <runId>` (and optionally `/ux-resume`) with `pi.registerCommand()`. The URL, if supplied, selects a **read-only** starting canvas/node after validation; it is not a write authorization. Optionally register one narrowly scoped model-callable `ux_prepare` tool; no general `ux_approve` or `ux_figma_write` tool offered to a model. Commands should display a *reviewed artifact*, not ask the model whether it may proceed.
2. Start an **in-process SDK worker session** using `createAgentSession({ model, thinkingLevel, tools, resourceLoader, settingsManager, sessionManager })` per role/task. Use `SessionManager.inMemory()` for transient workers; persist the **validated outputs**, not an unbounded transcript. Resolve each configured `provider/modelId` with `ModelRuntime` and check authentication/capabilities before starting. Subscribe for progress, inspect completed message/stop reason and `agent_settled`, propagate abort, cap output, and `dispose()` in `finally`. Process children (`pi --mode json`/RPC) are an alternative when lifecycle or process isolation is required, not an OS sandbox by themselves.
3. Use **explicit** `tools` (e.g. `read`, `grep`, `find`, `ls` for project reading), not Pi's ordinary `read,bash,edit,write` default. For the native Figma read path, a controller or narrowly authorized read-only worker passes validated `fileKey`, `nodeId` and bounded `depth` to the host tool; never grant arbitrary tool selection or `bash` to pre-approval workers. Inject the read capability explicitly into each SDK session that needs it—do not assume a tool available in the parent Pi session automatically exists in an in-process worker. `DefaultResourceLoader` may still discover project resources; for high-assurance roles, control the loader or use a bounded loader/isolated environment, and test its actual loaded extensions/instructions. Project content and Figma tool results remain untrusted prompt input.
4. `ctx.ui.custom()` can present rich TUI review; `ctx.ui.confirm/select/editor` can collect local feedback. RPC can relay supported dialogs via `extension_ui_request/response`, but the protocol **does not authenticate the answering human**; `ctx.hasUI` includes RPC. JSON/print have no UI. An absent/disconnected UI must leave the gate pending or deny, never proceed. Bound RPC dialog waits with a timeout or controller-owned disconnect/cancellation; map timeout/cancel to pending or denial, never approval. Persist an authenticated approval in the controller *before* any resume or write; Pi `appendEntry()` is suitable for display/session metadata, **not** the authoritative cross-session permission store.
5. Separate worker memory from **durable knowledge**. Per-role Pi `SettingsManager.inMemory({ compaction: { reserveTokens, keepRecentTokens } })` can tune worker-session compaction; Pi `compaction.modelOverrides` can tune thresholds by model. For screenshots, verify the effective `images.blockImages`/resize settings, model image input, provider limits and a sample end-to-end image delivery; merely choosing a vision model is insufficient. Neither compaction scheme preserves a required context pod or an approval: pin pod/artifact revisions in the controller and rehydrate them into fresh workers. Never derive permission from transcript text, branch summaries, or compaction output.

The installed dynamic-workflows extension demonstrates concurrency, retries, and a **durable object-checkpoint** handoff. It is optional reference code, not a dependency. In particular its simple/string checkpoint in background/headless mode can take a default answer; it is **not** a hard approval gate. Its journal/replay does not make external Figma writes idempotent.

## Required state machine and permissions

Maintain a durable, versioned transition table in the controller. A gate record is created **only after** the relevant artifacts are stored and hashed. Semantic agents may propose a transition; only controller code may commit it. Proposed state names (not Pi APIs):

| State → next | Condition/action | Capabilities granted |
| --- | --- | --- |
| `INGESTING` → `NEEDS_CLARIFICATION` or `AWAIT_G1` | Missing critical motivations/rules → explicit questions; otherwise save `01_problem_framing.md` with evidence and hypotheses. | Read only. |
| `NEEDS_CLARIFICATION` → `INGESTING` or `ABORTED` | Human supplies context/aborts. New input changes the pod/proposal revision. | Read only. |
| `AWAIT_G1` → `FLOW_MAPPING` or `INGESTING` or `ABORTED` | **Human** approves the problem statement, requests revision, or aborts. | Read only. |
| `FLOW_MAPPING` → `AWAIT_G2` | Save `02_journey_flow.md` and `flow_diagram.mermaid`: motivations, emotional friction, all entries, decisions, escape/back paths and edge cases. **No layouts yet.** | Read only. |
| `AWAIT_G2` → `CONCEPTS_AND_DS` or `FLOW_MAPPING` or `ABORTED` | **Human** approves emotional journey/flow or requests a new version. | Read only. |
| `CONCEPTS_AND_DS` → `DS_CONFLICT` or `AWAIT_G3` | Produce three **low-fidelity** concepts (`03_concept_options.md`), token map from a **verified** DS source, and `04_ds_conflict_report.md`. Figma style aliases are leads, not authoritative tokens; a harmful reuse conflict requires an explicit remedy/owner decision. | Read only; no high-fidelity code/Figma mutation. |
| `DS_CONFLICT` → `CONCEPTS_AND_DS` or `ABORTED` | Human resolves reuse/adapt/create, or aborts; preserve the original concern in audit. Never quietly weaken hierarchy to satisfy DS reuse. | Read only. |
| `AWAIT_G3` → `PREPARE_EXECUTION` or `CONCEPTS_AND_DS` or `ABORTED` | **Human** selects a concept and signs the DS strategy, token map, copy constraints, staging target(s) and allowed operation classes. Clinical owner must sign sensitive copy policy when required. | Scope only staging preparation; never broad production access. |
| `PREPARE_EXECUTION` → `AWAIT_STAGE_WRITE` or `CRITIQUE` | Generate `05_component.tsx` in an isolated staging workspace (a Git worktree if applicable). **Only if a writer is independently verified**, prepare a reviewable exact Figma operation manifest (node/target IDs, structure, copy, token references and tool arguments) without touching Figma. Otherwise send code/spec to critique. | Staging code draft only; no Figma mutation. |
| `AWAIT_STAGE_WRITE` → `APPLY_STAGING` or `PREPARE_EXECUTION` or `ABORTED` | Extra **human** signoff on the exact manifest hash, target and copy (and clinical reviewer if required). A changed payload requires another signoff; gate 3 alone is insufficient. | No mutation until decision is durably recorded. |
| `APPLY_STAGING` → `CRITIQUE` or `NEEDS_RECONCILIATION` | With verified bridge and matching gate-3 **and** stage-write approvals, apply only the signed operations to a duplicate/staging Figma file; read back actual nodes and visual output. | Narrow gate-bound executor only. |
| `CRITIQUE` → `AWAIT_RELEASE` (production) or `FINAL_PACKAGE_READY` (handoff-only) or earliest invalidated upstream phase | Independent safety/accessibility/DS/code review. Material changes invalidate dependent approvals **before** any revised write. A handoff-only run packages `06_final_design_pr_package.md` and audit without publishing. | Review only. |
| `AWAIT_RELEASE` → `PUBLISHING` or `ABORTED` | **Mandatory for production**: authorized human checks actual Figma preview **if edits occurred** (otherwise the spec/code), tests, medical/legal signoffs and diff before publish/merge. | Production executor may receive narrow, time-limited authority. |
| `PUBLISHING` → `FINAL_PACKAGE_READY` or `NEEDS_RECONCILIATION` | Apply approved operations, read back node/code state, write `06_final_design_pr_package.md` and audit; mark complete only after verification. | Rechecked narrow authority. |
| Any nonterminal → `ABORTED` or `NEEDS_RECONCILIATION` | Revoke pending approvals, cancel workers and fence old executors. If a remote write may have been dispatched, record uncertainty and reconcile before claiming a terminal abort. | No new operations. |

`REVISE` is not `APPROVE`: produce a **new** proposal revision, then request a new decision. Invalidation runs **downstream**: a changed user motivation, missing prescription rule, or new/expired global medical policy returns to G1; a changed journey/edge-case assumption returns to G2; a changed concept, DS token, approved copy or operation constraint returns to G3. Recompute the pod snapshot and revoke dependent approvals and write manifests on any such change. A paused run never self-approves on timeout, model confidence, `mode: autonomous`, missing UI, stale controller response, or a retry. Phase 1 can read the supplied Figma nodes through the observed native read tool; it cannot create nodes. The release gate is **required for any production publish/merge** beyond the three UX checkpoints; it is not needed if the run ends at reviewed handoff.

### Durable approval/write contract

Store one immutable proposal and one append-only decision per revision. An example **conceptual** approval record:

```json
{
  "schemaVersion": 1,
  "runId": "run-123",
  "gate": "STAGE_WRITE",
  "revision": 2,
  "proposalSha256": "<digest-of-reviewed-proposal>",
  "operationManifestSha256": "<digest-of-exact-args-copy-hierarchy-and-target-nodes>",
  "contextSnapshotSha256": "<digest-of-global-and-local-pod-revisions>",
  "target": { "kind": "figma-staging-file", "fileId": "<placeholder-id>" },
  "allowedOperations": ["create_auto_layout_frame"],
  "status": "pending",
  "reviewerId": null,
  "expiresAt": null
}
```

`approve/revise/abort` must be a transactional compare-and-swap on `(runId, gate, revision, proposalSha256, expectedState)` from an **authenticated** reviewer, with an audit record, reason and trusted timestamp. Refuse changed context, target or operation sets; reject stale/late decisions, unauthorized reviewers and conflicting duplicate decisions. An identical repeated response is harmless. Require an active G3 approval **plus** the exact stage-write manifest hash before staging Figma calls; the executor verifies actual payload and target against the signed manifest, not merely its operation class. For code/Figma writes, persist intent and a stable operation key before dispatch (`planned → dispatched → applied` or `uncertain`); recheck approval, policy/copy revision and expiry, required clinical/legal reviewer roles, generation/fencing token, file/node preconditions and payload at **each** mutation, then read back. If the bridge cannot identify an already-applied operation after a crash, transition to `NEEDS_RECONCILIATION` and require a human; do not blind-retry it. A remote request already in flight **can still commit after abort** unless the remote service supports fencing/cancellation; local checks prevent new dispatch but cannot guarantee remote rollback. Pause/restart restores pending gates, **not** an automatic transition to execution.

Approval does not imply a UI tool can be invoked safely from a worker: no write credentials or accessible alternate endpoint belong in planning workers. A Pi session can be forked/compacted independently of the controller; the controller's run, snapshot and gate revision remain authoritative.

## Context pod contract

The proposed `context_store/global_pod/` and `local_pods/[project_id]/` structure is a good **logical** layout; it must not silently turn sensitive screens/briefs into source-controlled files. Default to private local storage under Pi's resolved agent directory, e.g. `<pi-agent-dir>/ux-orchestrator-os/` (`~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it). Explicitly opt into project-local non-sensitive fixtures only. Restrict file permissions, retention and export; avoid raw medical data in telemetry/audit.

| Pod | Required data/behavior |
| --- | --- |
| Global | Versioned brand, approved medical/legal copy with owner and expiry, DS tokens/component metadata, domain heuristics. Independent immutable revision; organization policy cannot be overridden by an untrusted project pod. |
| Local | Stable `projectId`, brief, analytics/keyword sampling **with source/date**, current image/file references, consent/sensitivity, checkpoint history and outputs. No invented metrics or reinterpretation of missing data as zero. |
| Snapshot | Per-run list of `{ podId, revision, sha256, provenance, sensitivity }`; normalize and hash validated bytes before use. Require explicit selection and size limits; stale/missing source → clarification, not silent substitution. |
| Output | Append-only artifact versions for each phase, structured links to underlying evidence and who confirmed assumptions, separate from disposable child conversation history. |

Pod text is **data**, not executable instructions. Detect prompt-injection attempts, validate JSON schema and canonical paths, reject traversal/symlink escapes where file scope matters, redact sensitive input before model calls, and enforce provider/data-residency policy. Never blindly upload screens/health history, replay a model-created context summary as approval, or depend on Pi's automatic compaction to remember a pod. Each worker gets the minimal immutable snapshot relevant to its role; record the digest of what it actually received. Qualitative claims about anxiety should cite supplied research or be labeled hypotheses requiring user validation.

## Configuration proposal

These are **proposed `ux-orchestrator-os` fields**, not current Pi or dynamic-workflows settings. Prefer a validated, versioned `config.json` stored under the resolved Pi agent directory; keep secrets in a separate credential store or executor. JSONC below is *illustrative* (remove comments/placeholders for real JSON). Reject unknown major versions, invalid paths/models/tools, and any request to disable the mandatory gates; project-local settings may narrow limits but cannot relax policy. Parse before starting workers; record the effective sanitized configuration revision in each run.

```jsonc
{
  "schemaVersion": 1,
  "enabled": false,                        // Opt in explicitly; never silently start on Pi launch.
  "mode": "strict_supervised",           // "autonomous" may automate READ-ONLY preparation, not gates.
  "limits": {
    "maxConcurrentWorkers": 3,
    "maxRoleCallsPerRun": 24,
    "maxOutputCharsPerWorker": 16000
  },
  "retry": {
    "transientWorkerRetries": 1,        // Reattempt the same read-only worker on transport failure.
    "semanticRevisionAttempts": 2,     // New calls/versions, always bounded and audited.
    "figmaWriteRetries": 0             // Never replay an uncertain external write blindly.
  },
  "roles": {
    "research": { "model": "configured-provider/research-model", "thinking": "high",
      "tools": ["read", "grep", "find", "ls"],
      "compaction": { "reserveTokens": 16384, "keepRecentTokens": 12000 } },
    "iaFlow":   { "model": "configured-provider/flow-model", "thinking": "high", "tools": [] },
    "dsAudit":  { "model": "configured-provider/ds-model", "thinking": "medium", "tools": [] },
    "executor": { "model": "configured-provider/code-model", "thinking": "medium", "tools": [] },
    "critic":   { "model": "configured-provider/critic-model", "thinking": "high", "tools": [] }
  },
  "pods": {
    "selection": "explicit", "allowSensitiveWithoutConsent": false,
    "maxContextChars": 24000, "rejectUnverifiableSources": true,
    "globalPodRef": "core-health-diagnostics@reviewed-revision",
    "localPodRoot": "<private-project-pod-root>"
  },
  "gates": {
    "required": ["G1", "G2", "G3"],    // Mandatory, not a user-disableable preference.
    "autoProceed": false,                 // Must remain false; zero confidence threshold is NOT approval.
    "onNoReviewer": "remain_pending",    // Also for disconnected RPC / JSON / print.
    "reviewerTransport": "trusted_controller",
    "requireStageWriteApproval": true,   // Required for any staging Figma mutation.
    "requirePublishApproval": true      // Required for any production merge/publish.
  },
  "designSystem": {
    "tokenSource": "<reviewed-design-system-source>", // Figma style aliases alone are not authoritative tokens.
    "onHierarchyConflict": "block_for_resolution",
    "strictReuse": false                 // Do not force a harmful legacy component.
  },
  "domainSafety": {
    "requireClinicalReviewer": true,
    "disallowedClaims": ["diagnostic_presumption", "alarmist_urgency_phrasing"],
    "approvedCopyRef": "<versioned-global-pod-reference>"
  },
  "rubrics": {
    "problemFraming": ["pain_vs_symptom", "unverified_assumptions"],
    "empathy": ["anxiety_points", "sunk_cost", "escape_paths"],
    "dsIntegrity": ["token_mapping", "hierarchy_conflicts"],
    "handoff": ["source_links", "missing_coverage", "verification_evidence"]
  },
  "figma": {
    "readBinding": "native:figma_get_data",        // Host-mapped, authenticated read capability.
    "assetBinding": "native:figma_download_images", // Local asset download, not a frame screenshot.
    "defaultDepth": 2,
    "maxReadDepth": 4,
    "assetPolicy": "on_demand_private_cache",
    "writeEnabled": false,                  // Must stay false until a separate writer is verified.
    "writeExecutorRef": null,               // NOT an arbitrary tool name the model can choose.
    "approvedTargetKind": "duplicate_only",
    "requireReadback": true
  },
  "outputs": { "codeTarget": "staging_workspace", "publishAutomatically": false }
}
```

The `native:*` names are **proposed plugin aliases** that the host must map to the available, authenticated read tools; they are not Pi built-ins or proof that SDK worker sessions inherit them. The `executor` role's empty tool list means its model can **draft** code but cannot write it; a guarded application layer stages validated output after G3 (or a separately sandboxed code worker may be authorized for that exact workspace). Configure real model IDs as `provider/modelId` from the active Pi registry; check availability and image input for vision roles. Missing explicit routes **pause/fail**, never silently substitute a less capable model for a safety role. Optional ordered model fallbacks for *read-only* tasks require explicit policy and audit; execution retries (transient API failures), semantic revisions (new agent calls) and fallback strategies are separate, bounded mechanisms. Do **not** automatically retry non-idempotent Figma operations. Pi's retry/compaction settings affect child sessions if inherited; per-role overrides require independently configured SDK sessions. No model configuration can turn a checkpoint into a human approval.

Example **pod metadata**, also a proposed schema, not Pi-native:

```json
{
  "schemaVersion": 1,
  "podId": "diagnostic-srp-pdp-overview",
  "revision": 3,
  "scope": "project",
  "sensitivity": "internal-no-patient-data",
  "provenance": [
    { "kind": "user-brief", "ref": "brief.md", "sha256": "<digest>" },
    { "kind": "screenshot", "ref": "screens_current/srp.png", "sha256": "<digest>" },
    { "kind": "figma-node", "ref": "<file-key>/128:8318", "depth": 2,
      "retrievedAt": "<ISO-8601>", "sha256": "<digest-of-read-result>" },
    { "kind": "analytics", "ref": "analytics_and_keywords.json", "sha256": "<digest>" }
  ],
  "selectedGlobalPod": "core-health-diagnostics@reviewed-revision",
  "expiresAt": null
}
```

The input example's `traffic_distribution` (0.46/0.41/0.13) and keyword volume (17,600) are **supplied scenario data**, not verified analytics; record their date and source. The `medical_disclaimer_required` rule is a draft domain policy, not proof that every proposed claim is compliant. A Figma read digest records the returned subtree at a time; the observed tool exposes **no remote file-version marker or authoritative variable-library revision**. Treat a separate token source as unverified until connected, and re-read relevant nodes before approving a design based on old evidence.

## Native Figma tools: working read path, no node-write path

Assume the host exposes Figma calls as **already-authenticated native tools**. The plugin does not need to install an adapter, handle tokens, or manage connection/auth transport for this path. These are the **actual tool signatures observed** for the supplied example (names are host-specific, not Pi APIs):

| Native tool | Inputs | Observed/advertised output and boundary |
| --- | --- | --- |
| `figma-developer-mcp_get_figma_data` | `{ fileKey: string, nodeId?: string, depth?: number }` | Read succeeded. Returns `metadata`, `nodes`, and `globalVars.styles` as text; selected subtrees include names, types, text, component IDs, layout modes, dimensions and style references. Depth controls traversal. It does **not** expose a file revision, complete variable library, frame screenshot or design-node mutation. |
| `figma-developer-mcp_download_figma_images` | `{ fileKey, nodes: [{ nodeId, fileName, imageRef?, ... }], localPath, pngScale? }` | Advertised to **save selected SVG/PNG images or icons to disk**. Not called during this assessment; this is a local file-write side effect, not a full-screen visual render or Figma edit. Validate output directory, filenames, permissions and result paths before use. |

### Read-only worked example: Radiology — Assured Services

For the [user-supplied Figma example](https://www.figma.com/design/3nRh0U3kOrUERyTbx2cQij/Radiology---Assured-Services?node-id=128-8318&p=f), parse `fileKey = 3nRh0U3kOrUERyTbx2cQij` and URL `node-id=128-8318` as tool `nodeId = "128:8318"`. Querying `get_figma_data({ fileKey, nodeId: "128:8318", depth: 2 })` returned the **`HiFi` CANVAS**. It contains `Section 1` with frames labelled `Radiology test`, `cart`, `Booking summary`, `Payment`, and `Booking success page`, and `Section 2` with `OLD`/`NEW` frames. Follow-up reads of `749:823` (`Radiology test`), `749:1786` (`cart`) and `1141:6349` (`NEW`) at depth 2 showed structured descendants. The cart contains text `Tests added` and `Selected lab`; the `NEW` frame includes a `Bottomsheet` whose layout mode is `column` and whose descendants include `Header Image` and `Content`. This demonstrates **retrieval**, not that either version is better, that a flow is complete, that all nodes use Auto Layout, or that clinical requirements are met.

The plugin should (1) validate the supplied URL/file scope, (2) fetch a shallow canvas index, (3) drill into **selected** nodes at bounded depth, (4) parse the observed YAML-like text defensively into a schema-checked read-only evidence record with node IDs, source, depth, fetch time and digest, and (5) pass only relevant excerpts to flow/DS workers. Enforce query count, response-size and time limits; a truncated/unknown result is *incomplete evidence*, not an empty canvas. The observed `globalVars.styles` contains style/layout mappings; do **not** equate it to a verified organization token library or infer unshown frames. Do not infer interactions or prescription rules from frame labels alone. If the host later exposes a visual frame-render tool, separately verify its output; the image-download tool by itself cannot supply a full-screen screenshot. Only download selected assets when needed, into an approved private scratch directory, and do not silently write them into a project tree. Capture the returned node IDs in the local pod and compare a **fresh** read before a gate decision; a digest and timestamp are not a remote file version.

### Write-path preflight remains conditional

The two available tools **cannot** create frames, change Auto Layout, set variables or publish. If a native write tool or editor bridge is provided later, inspect its *real* operation schemas, scope and read-back behavior; keep it inaccessible to planning workers. Authenticate/authorize the **operation** at the controller even if the host has authenticated the tool caller. Use a duplicate/staging file, capture a baseline and rollback plan, and verify target/node preconditions. Bind concept, target file, permitted operation classes, token/copy constraints to G3; then review and sign the **exact** Figma operation manifest at `STAGE_WRITE` before the executor sends any mutation. Read back the actual nodes and a separately verified visual preview. If the write outcome is uncertain, reconcile rather than replay blindly; do not report a published node ID without an actual write result and read-back. Vendor/API write support must be checked when choosing that future tool—read access is not evidence of arbitrary node-edit support.

Meanwhile, Phase 5 can produce a reviewed *Figma implementation specification plus code draft*, not a claim that a Figma frame was created. Keep code in an isolated staging workspace (Git worktree when supported); for a target React/Tailwind project, use **that project's** package manager, framework version, lint/test commands and design tokens. Test accessibility, keyboard/empty/loading/long-text states, responsive breakpoints and token mapping. WCAG 2.2 AA generally requires **4.5:1 for normal text**, **3:1 for large text**, and **3:1 for applicable non-text UI indicators**; automation alone does not establish compliance. Require human UX/clinical/legal review before production merge or Figma publish.

## Acceptance tests driven by the three supplied scenarios

| Scenario | Required observable behaviors | Must *not* happen |
| --- | --- | --- |
| Late prescription barrier (sunk cost) | Discovery ties the late barrier to upstream Search/Cart; gate 1 asks who decides prescription requirements; flow models verification calls, fallbacks and relief copy; artifacts cite provided evidence. | Jumping to a checkout banner or generating UI/code before gates 1–3. |
| Family-member overdue tests vs generic `Info Card` | Concepts preserve **who**, **which test**, **why it matters**; DS audit emits `DS_CONFLICT` if component hides identity/hierarchy; human records reuse/adapt/create decision before gate 3. | Silent reuse, generic urgency claims, or auto-proceed on unresolved conflict. |
| Chronic-medicine insight on order history | Discovery flags anxiety and placement risk; gate 1 asks whether order tracking is an appropriate surface; critic flags diagnosis/advice/panic/medicine-cessation copy; approved reviewer checks monitoring language and anxiety-support-ticket measures alongside conversion. | Publishing scary side-effect claims, adding treatment advice, or claiming medical validity solely from a disclaimer. |

Give each scenario a versioned fixture (brief, screen reference, token/component inventory, expected reviewer responses) and deterministic oracles:

- **Prescription:** expected sequence `INGESTING → AWAIT_G1 → INGESTING (REVISE) → AWAIT_G1 → FLOW_MAPPING`; require the revised problem framing to cite the actual prescription rule and a flow branch for Search/Cart warnings. No code/Figma events before G3.
- **Family hierarchy:** fixture includes a deliberately truncating `Info Card`; require `DS_CONFLICT` with *who/what/why* preserved and reject a reviewer choice of “reuse unchanged” until a compliant new/adapted concept is versioned and signed at G3.
- **Chronic medicine:** fixture injects unsafe advice and expired approved copy; even if the model critic misses it, expiration and missing authorized clinical signoff block staging write and release. Record copy revision and support-ticket/anxiety measurement plan in the handoff; don't assert that model review establishes safety.
- **Native Figma read fixture:** parse the supplied URL's `node-id=128-8318` to `128:8318`; a bounded depth-2 read should expose `HiFi`, `Section 1`, `Section 2` and the `OLD`/`NEW` labels. Drill into `749:1786` to recover `Tests added`/`Selected lab`. Assert that the default workflow calls **no asset download or Figma write**, gracefully handles inaccessible/deleted nodes and changed response shapes, and never upgrades style aliases into verified DS tokens or claims a remote revision. Use a redacted fixture rather than checking private design content into public tests.

Across all scenarios, run failure-injection tests for `APPROVE/REVISE/ABORT`, repeated/stale decisions, simultaneous reviewers, changed pod snapshots/global policies, restart while awaiting a gate, cancellation during a write, offline/headless operation, denied credentials, agent timeout/invalid output, false-negative critique, and remote success followed by local crash. Assert **zero** plugin-controlled mutation calls before G3, **zero** Figma staging writes without an exact `STAGE_WRITE` signature, and **zero** production publish without release approval. Include a *same operation class, changed medical copy or target* test. If a write was already dispatched when abort occurred, require reconciliation rather than claiming zero subsequent remote commits. Use fake native Figma readers, a fake gated write executor and event logs for deterministic assertions. A qualitative empathy score is supporting evidence, never a substitute for a reviewer or a real user study.

## Risk-ordered build plan (future work, not undertaken here)

1. **Product and threat-model decisions:** identify reviewer identities, TUI vs trusted RPC/console, patient-data policy, tenant boundaries, retention/delete rules, required Figma edit operations and target environment. Define approved clinical/legal copy ownership. Choose local prototype vs separate-principal enforcement before claiming “hard” gates.
2. **Contracts first:** specify schemas for global/local pods, provenance, artifacts, revision hashes, decision records and FSM transitions; define operational policy that cannot be disabled by project config. Fixture-test all three scenarios and missing/unsafe input.
3. **Read-only Pi prototype:** opt-in command, bounded native Figma reads from a user-supplied URL, explicit role session factory, images/pods and evidence-aware proposals. Verify the observed schema and controlled injection of the host read tool into Pi workers on the plugin's declared compatibility range (starting with inspected 0.87.1), plus models, vision, costs, cancellation and TUI/RPC/JSON handling. Do not provision write credentials.
4. **Durable gates:** implement authenticated controller, transactional compare-and-swap, audit, leases/fencing, restart recovery, separate approval prompts and a no-UI fail-closed policy. Test mutation denial independently of model messages, compaction and Pi session branches.
5. **Conditional staging pilot:** only if a future native writer/editor bridge is offered, verify its specific node-edit API and permissions, duplicate file, run one gate-approved mutation, read back and test uncertain-commit reconciliation. Current native tools support **read-only design inspection** plus asset downloads, so the first working deliverable is a Figma-spec-only handoff path.
6. **Code, critique and release:** isolated staging workspace, target-project checks, accessibility/medical/DS review, release signoff and handoff package. Only then consider a standalone reviewer service/console for multiple reviewers or shared governance; maintain the Pi extension as a thin client rather than duplicating authority.

### Decisions that remain open

- Who is permitted to approve each gate and clinical copy, and how is that identity authenticated in a terminal or remote client?
- Is a local same-user gate adequate for an internal prototype, or is a separate service/principal required from day one?
- The native read tool works for the sample file; what future **write** API (if any) can create/edit Auto Layout nodes in a scoped staging file, and is publication a distinct operation?
- May sensitive screenshots/analytics leave the machine; which providers, regions, and retention policies apply?
- Are organization global pods mandatory and centrally curated, or is everything private/local? How do policy changes invalidate pending signoffs?
- What counts as a material revision after critique, and what evidence and reviewers are mandatory before release?

## Sources inspected and limitations

- Installed Pi: `@earendil-works/pi-coding-agent/docs/{extensions,sdk,configuration,settings,models,packages,skills,sessions,session-format,compaction,rpc-extension-ui,tui,security,cli-integration}.md`; `examples/sdk/{02-custom-model,03-custom-prompt,05-tools,06-extensions,07-context-files,10-settings,12-full-control}.ts`; `examples/extensions/{permission-gate,custom-compaction,question}.ts`; `examples/extensions/subagent/README.md`. Exact SDK declarations should be checked again against the shipping version.
- Installed dynamic-workflows reference: its `workflow-authoring/references/{runtime,lifecycle}.md` and checkpoint/persistence implementation. Not an authorization dependency.
- Live Figma tool inspection: `figma-developer-mcp_get_figma_data` signature and successful read of file `3nRh0U3kOrUERyTbx2cQij`, canvas `128:8318` and child nodes `749:823`, `749:1786`, `1141:6349` at depth 2; `figma-developer-mcp_download_figma_images` signature only (not called). Treat them as authenticated **native host tools** for the proposed plugin; their implementation transport is out of scope. No credential-bearing configuration was opened, no Figma write tool was exposed, and no remote writes were attempted. Current Figma vendor node-write capabilities were **not independently verified** here.
