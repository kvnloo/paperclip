# Jarvis ↔ Paperclip integration contract

**Status:** reviewed v1 guidance for the `sft-svlm` / Jarvis ultracode workflow  
**Contract version:** `jarvis-paperclip/v1`

## Authority boundary

| Plane | Owns |
| --- | --- |
| **Paperclip** | goals, projects, issues, assignment/checkout, runs, workspaces, approvals, budgets/cost disposition, artifacts/evidence, routines, evaluation, final status |
| **Jarvis** | identity, cross-harness focus, private memory, retrieval, intent expansion, context packets, product discovery, model routing, outcome learning |
| **Harness** | scoped execution in the Paperclip-selected workspace and evidence production |

Jarvis may recommend work, tools, paths, or success criteria. It may not assign an agent, select a different execution workspace, approve an action, change a budget, mark an issue done, or create a second task lifecycle. A harness must treat the Paperclip issue brief as authoritative when it conflicts with Jarvis context.

The active design is the Postgres/concurrent design in `sft-svlm/prompt.md` and `sft-svlm/docs/JARVIS.md`. The older SQLite-first section in `BLEEDING_EDGE_DESIGN.md` is historical and must not override the current 5–20-harness Postgres decision.

## Pre-run contract

Paperclip performs assignment, atomic checkout, budget/approval checks, and workspace selection **before** asking Jarvis for context.

```json
{
  "contract_version": "jarvis-paperclip/v1",
  "trace_id": "<paperclip-run-id>",
  "prompt": "<authoritative issue brief or bounded intent>",
  "harness_id": "paperclip:hermes:<assigned-agent-id>",
  "product_id": "paperclip",
  "packet_id": "<paperclip-issue-id>",
  "paperclip": {
    "companyId": "...",
    "goalId": "...",
    "projectId": "...",
    "productKey": "paperclip",
    "issueId": "...",
    "issueIdentifier": "ZER-2",
    "assignmentId": "...",
    "assignedAgentId": "...",
    "runId": "...",
    "workspaceId": "...",
    "workspaceCwd": "/workspace/zer0/oss/paperclip",
    "approvalState": "approved|not_required",
    "budgetDisposition": "approved|not_required",
    "budgetRemainingCents": 0
  }
}
```

The Paperclip run ID is the canonical execution trace. Jarvis stores it as an external reference. `product_id` is Paperclip's stable project URL key (or an explicit project→Jarvis mapping), while the opaque Paperclip project UUID remains in the `paperclip` envelope. If Jarvis also creates an internal expand-event ID, return it separately; never replace the Paperclip run ID.

### Accepted Jarvis response

```json
{
  "goal": "...",
  "constraints": ["..."],
  "success_criteria": ["..."],
  "tools": ["..."],
  "paths": ["/workspace/zer0/oss/paperclip/..."],
  "product_id": "paperclip",
  "model_server_id": "...",
  "focus_version": 17,
  "context_pack": {}
}
```

Required enforcement:

1. Validate the response schema before spawning the harness.
2. Reject Jarvis fields that claim Paperclip authority (`status`, assignment, approvals, budgets, run, issue, project, workspace, evidence disposition).
3. Every returned write path must be absolute and, after realpath/symlink resolution, equal to or beneath Paperclip's selected workspace. Retrieval-only external paths must be labeled separately and mounted/read-authorized by Paperclip policy.
4. Cap the serialized packet at 16,000 UTF-8 bytes and omit or summarize low-value context rather than truncating authoritative Paperclip instructions.
5. `required=true` fails closed **before spawn** on timeout, malformed context, or policy violation. Optional mode emits an explicit degradation marker.

## Post-run contract

The harness first writes durable comments/documents/work products/evidence and final disposition to Paperclip. Jarvis then receives a redacted, replay-safe learning event.

```json
{
  "contract_version": "jarvis-paperclip/v1",
  "trace_id": "<paperclip-run-id>",
  "idempotency_key": "learn:<paperclip-run-id>:final",
  "harness_id": "paperclip:hermes:<assigned-agent-id>",
  "product_id": "paperclip",
  "outcome": "success|failure|cancelled|timed_out",
  "summary": "<bounded redacted outcome summary>",
  "redaction_confirmed": true,
  "paperclip": {
    "company_id": "...",
    "project_id": "...",
    "issue_id": "...",
    "issue_identifier": "ZER-2",
    "run_id": "..."
  },
  "evidence_refs": ["paperclip://issues/<id>/runs/<run-id>"]
}
```

Do not send raw transcripts, credentials, environment dumps, or complete private artifacts to `/learn`. Paperclip remains the evidence store; Jarvis learns from bounded summaries and stable references. `/learn` must deduplicate by idempotency key so a crash after persistence and a replay produce one learning event.

A post-run Jarvis outage must not erase or reverse completed Paperclip work. Record `jarvis_outcome_recorded=false` plus the error in Paperclip run metadata and retry through an explicit governed delivery path.

## Actionable cognition intake

Jarvis findings become Paperclip issues only through a scoped task-bridge key or authenticated `Harness idea intake` routine.

Required fields:

- `originKind: "task_bridge"` (or the routine's canonical kind)
- `originId`: task-bridge key/routine identity
- `originRunId`: Jarvis observation or routine run
- `originFingerprint`: deterministic content/idempotency fingerprint

The unique replay key is `(company, originKind, originId, originFingerprint)`. A retry after an ambiguous timeout returns the existing Paperclip issue. Jarvis stores the returned Paperclip issue ID and never creates its own authoritative issue record.

Credentials are one per company/project/harness boundary. An intake credential may create/deduplicate proposals in its project; it may not decide approvals, alter budgets, publish/deploy, merge/push, assign unrelated agents, or use board credentials.

## Candidate adapter review: fix-first findings

The active `hermes/jarvis-identity-bridge` candidate establishes useful basics: optional/required pre-run behavior, environment-only Jarvis token handling, schema checks, run-linked expand/learn calls, and focused mocked tests. It is **not ready to merge** until these contract gaps are closed:

1. **Post-run ordering:** the adapter calls `/learn` before returning its execution result, so Paperclip cannot yet have persisted evidence and final disposition. Emit learning from a Paperclip-owned post-finalization outbox/event hook instead.
2. **Workspace confinement:** current Jarvis packet validation accepts arbitrary absolute `paths`; a packet can redirect work outside Paperclip's selected workspace or through a symlink escape.
3. **Replay safety:** current `/v1/learn` always appends an activity row and has no idempotency key/deduplication path.
4. **Provenance persistence:** `/v1/expand` accepts `meta`, but its recorded expand activity currently retains only prompt/focus/cache/latency fields; Paperclip issue/run references need durable projection.
5. **Redaction:** the candidate forwards up to 4,000 characters of parsed harness response to `/learn` without a contract-level redaction/evidence-reference gate.
6. **Authority-field rejection:** shape validation checks required context fields but does not reject root or nested Jarvis-supplied lifecycle/workspace/budget/approval fields, nor a mismatched `product_id`.
7. **Outcome fidelity:** preserve Paperclip's `success|failure|cancelled|timed_out` disposition instead of collapsing every timeout or nonzero exit into `failure`.
8. **Scoped integration auth:** a gateway bearer token is useful transport auth, but it does not replace the separate company/project/harness-scoped Paperclip task-bridge credential for actionable intake. The task-bridge operation set must be an intake-only allowlist; claimed credential scopes cannot grant governance powers.
9. **Real contract gate:** mocked adapter tests pass, but a dual-service test must prove Paperclip governance/checkout → Jarvis expand → harness spawn → Paperclip evidence/disposition → idempotent Jarvis learn, including timeout and crash/replay.

## Executable reference tests

Run the dependency-free contract suite from the Paperclip repository root:

```bash
pnpm exec node --test scripts/jarvis-paperclip-contract.test.mjs
```

The suite covers:

- canonical Paperclip goals, assignment/agent identity, cleared approval/budget disposition, and product mapping on expand;
- rejection of root/nested authority claims, product mismatch, oversized packets, lexical workspace escapes, and symlink escapes;
- enforced Paperclip-governance-before-checkout and finalization-before-learn ordering;
- bounded, explicitly redacted, secret-scanned, provenance-linked learn events with a closed outcome enum;
- crash-after-persist learn replay deduplication and idempotency-collision rejection;
- company/project/harness-scoped task-bridge authorization with an intake-only operation allowlist;
- company-isolated idempotent intake;
- crash-after-persist replay without duplicate issue authority.

These tests are an executable protocol oracle. Adapter and Jarvis gateway integration tests should reuse the same cases against real HTTP handlers rather than weakening the oracle to match an implementation.

## Merge gate

Do not re-enable autonomous delivery until all are green:

- [ ] Paperclip checkout and budget/approval gate precede expand.
- [ ] Required/optional Jarvis failure modes are explicit.
- [ ] Workspace confinement and authority-field rejection are enforced.
- [ ] Task intake deduplicates on origin fingerprint with scoped auth.
- [ ] Learn deduplicates on idempotency key and stores Paperclip provenance.
- [ ] Outcome payload is redacted and evidence is referenced, not copied.
- [ ] Crash between remote persistence and client acknowledgement is replay-safe.
- [ ] No duplicate Paperclip/Jarvis issue authority exists.
- [ ] Real two-service contract test passes; mocked unit tests remain green.
