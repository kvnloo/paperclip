import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ContractViolation,
  buildExpandEnvelope,
  authorizeTaskBridge,
  buildLearnEnvelope,
  createIdempotentIntakeLedger,
  createRunLifecycle,
  validateJarvisPacket,
} from "./jarvis-paperclip-contract.mjs";

const authority = Object.freeze({
  companyId: "company-1",
  goalId: "goal-1",
  projectId: "project-1",
  productKey: "paperclip",
  issueId: "issue-1",
  issueIdentifier: "ZER-2",
  assignmentId: "agent-1",
  runId: "run-1",
  workspaceId: "workspace-1",
  workspaceCwd: "/workspace/zer0/oss/paperclip",
  approvalState: "not_required",
  budgetRemainingCents: 2500,
});

test("expand binds Jarvis context to canonical Paperclip execution references", () => {
  const request = buildExpandEnvelope({
    authority,
    harness: "hermes",
    prompt: "Continue the assigned integration work",
  });

  assert.equal(request.contract_version, "jarvis-paperclip/v1");
  assert.equal(request.trace_id, authority.runId);
  assert.equal(request.packet_id, authority.issueId);
  assert.equal(request.product_id, "paperclip");
  assert.equal(request.harness_id, "paperclip:hermes:agent-1");
  assert.deepEqual(request.paperclip, authority);
  assert.equal(request.prompt, "Continue the assigned integration work");
});

test("Jarvis packets cannot claim Paperclip authority or escape the selected workspace", () => {
  const valid = validateJarvisPacket({
    goal: "Add executable contract coverage",
    constraints: ["Preserve Paperclip authority"],
    success_criteria: ["Contract tests pass"],
    tools: ["paperclip"],
    paths: ["/workspace/zer0/oss/paperclip/scripts"],
    product_id: "paperclip",
    context_pack: { session_cards: [] },
  }, authority);
  assert.equal(valid.goal, "Add executable contract coverage");

  assert.throws(
    () => validateJarvisPacket({
      goal: "Unauthorized lifecycle change",
      constraints: [],
      success_criteria: [],
      tools: [],
      paths: [authority.workspaceCwd],
      product_id: "paperclip",
      status: "done",
    }, authority),
    (error) => error instanceof ContractViolation && /authority field.*status/.test(error.message),
  );

  assert.throws(
    () => validateJarvisPacket({
      goal: "Claim a different product",
      constraints: [],
      success_criteria: [],
      tools: [],
      paths: [authority.workspaceCwd],
      product_id: "wrong-product",
    }, authority),
    (error) => error instanceof ContractViolation && /product_id/.test(error.message),
  );

  assert.throws(
    () => validateJarvisPacket({
      goal: "Hide authority inside context",
      constraints: [],
      success_criteria: [],
      tools: [],
      paths: [authority.workspaceCwd],
      product_id: "paperclip",
      context_pack: { proposed: { status: "done" } },
    }, authority),
    (error) => error instanceof ContractViolation && /authority field.*status/.test(error.message),
  );

  assert.throws(
    () => validateJarvisPacket({
      goal: "Hide snake-case authority inside context",
      constraints: [],
      success_criteria: [],
      tools: [],
      paths: [authority.workspaceCwd],
      product_id: "paperclip",
      context_pack: { issue_id: "shadow-issue" },
    }, authority),
    (error) => error instanceof ContractViolation && /authority field.*issue_id/.test(error.message),
  );

  assert.throws(
    () => validateJarvisPacket({
      goal: "Hide workspace authority inside context",
      constraints: [],
      success_criteria: [],
      tools: [],
      paths: [authority.workspaceCwd],
      product_id: "paperclip",
      context_pack: { workspace_id: "shadow-workspace" },
    }, authority),
    (error) => error instanceof ContractViolation && /authority field.*workspace_id/.test(error.message),
  );

  assert.throws(
    () => validateJarvisPacket({
      goal: "Use a relative path",
      constraints: [],
      success_criteria: [],
      tools: [],
      paths: ["scripts"],
      product_id: "paperclip",
    }, authority),
    (error) => error instanceof ContractViolation && /absolute/.test(error.message),
  );

  assert.throws(
    () => validateJarvisPacket({
      goal: "Write elsewhere",
      constraints: [],
      success_criteria: [],
      tools: [],
      paths: ["/workspace/zer0/products/sft-svlm"],
      product_id: "paperclip",
    }, authority),
    (error) => error instanceof ContractViolation && /outside Paperclip workspace/.test(error.message),
  );
});

test("workspace confinement rejects symlink escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-contract-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, "escape"));
  fs.symlinkSync(path.join(root, "missing-target"), path.join(workspace, "broken"));

  try {
    assert.throws(
      () => validateJarvisPacket({
        goal: "Follow a workspace symlink",
        constraints: [],
        success_criteria: [],
        tools: [],
        paths: [path.join(workspace, "escape", "write.txt")],
        product_id: "paperclip",
      }, { ...authority, workspaceCwd: workspace }),
      (error) => error instanceof ContractViolation && /outside Paperclip workspace/.test(error.message),
    );
    assert.throws(
      () => validateJarvisPacket({
        goal: "Follow a broken workspace symlink",
        constraints: [],
        success_criteria: [],
        tools: [],
        paths: [path.join(workspace, "broken", "write.txt")],
        product_id: "paperclip",
      }, { ...authority, workspaceCwd: workspace }),
      (error) => error instanceof ContractViolation && /broken symlink/.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Jarvis learning occurs only after Paperclip evidence and disposition are durable", () => {
  const run = createRunLifecycle(authority.runId);
  run.checkout();
  run.expand();
  run.spawn();

  assert.throws(
    () => run.learn(),
    (error) => error instanceof ContractViolation && /final disposition/.test(error.message),
  );

  run.persistEvidence();
  run.finalizePaperclip();
  assert.equal(run.learn(), "learned");
  assert.equal(run.state, "learned");
});

test("learn events preserve run provenance while sending bounded evidence summaries", () => {
  const event = buildLearnEnvelope({
    authority,
    harness: "hermes",
    outcome: "failure",
    summary: "Focused test failed because the gateway was unavailable",
    redacted: true,
    evidenceRefs: ["paperclip://issues/issue-1/runs/run-1"],
  });

  assert.equal(event.trace_id, authority.runId);
  assert.equal(event.idempotency_key, "learn:run-1:final");
  assert.deepEqual(event.paperclip, {
    company_id: authority.companyId,
    project_id: authority.projectId,
    issue_id: authority.issueId,
    issue_identifier: authority.issueIdentifier,
    run_id: authority.runId,
  });
  assert.deepEqual(event.evidence_refs, ["paperclip://issues/issue-1/runs/run-1"]);
  assert.equal("raw_transcript" in event, false);

  assert.throws(
    () => buildLearnEnvelope({
      authority,
      harness: "hermes",
      outcome: "invented",
      summary: "Invalid lifecycle result",
      redacted: true,
    }),
    (error) => error instanceof ContractViolation && /outcome/.test(error.message),
  );

  assert.throws(
    () => buildLearnEnvelope({
      authority,
      harness: "hermes",
      outcome: "success",
      summary: "Unreviewed raw output",
      redacted: false,
    }),
    (error) => error instanceof ContractViolation && /redacted/.test(error.message),
  );
});

test("task-bridge credentials are project-scoped and cannot perform governed actions", () => {
  const credential = {
    companyId: authority.companyId,
    projectId: authority.projectId,
    scopes: ["issues:intake"],
  };

  assert.equal(authorizeTaskBridge(credential, {
    companyId: authority.companyId,
    projectId: authority.projectId,
    operation: "issues:intake",
  }), true);
  assert.throws(
    () => authorizeTaskBridge({ scopes: ["issues:intake"] }, {
      operation: "issues:intake",
    }),
    (error) => error instanceof ContractViolation && /companyId/.test(error.message),
  );

  assert.throws(
    () => authorizeTaskBridge(credential, {
      companyId: authority.companyId,
      projectId: "project-elsewhere",
      operation: "issues:intake",
    }),
    (error) => error instanceof ContractViolation && /project boundary/.test(error.message),
  );
  assert.throws(
    () => authorizeTaskBridge({
      ...credential,
      scopes: ["issues:intake", "agents:assign"],
    }, {
      companyId: authority.companyId,
      projectId: authority.projectId,
      operation: "agents:assign",
    }),
    (error) => error instanceof ContractViolation && /unsupported operation/.test(error.message),
  );
});

test("intake requires Paperclip run provenance", () => {
  const ledger = createIdempotentIntakeLedger();
  assert.throws(
    () => ledger.intake({
      companyId: authority.companyId,
      originKind: "task_bridge",
      originId: "jarvis-proposal-without-run",
      originFingerprint: "sha256:missing-run",
      title: "Untraceable proposal",
    }),
    (error) => error instanceof ContractViolation && /originRunId/.test(error.message),
  );
});

test("intake survives a crash after persistence without creating duplicate authority", () => {
  const ledger = createIdempotentIntakeLedger();
  const proposal = {
    companyId: authority.companyId,
    originKind: "task_bridge",
    originId: "jarvis:system-finding",
    originRunId: "jarvis-observation-8",
    originFingerprint: "sha256:finding-8",
    title: "Recover replayed intake",
  };

  assert.throws(
    () => ledger.intake(proposal, { crashAfterPersist: true }),
    /simulated crash after persistence/,
  );
  const replay = ledger.intake(proposal);

  assert.equal(replay.created, false);
  assert.equal(ledger.size, 1);
});

test("intake fingerprints are isolated by Paperclip company", () => {
  const ledger = createIdempotentIntakeLedger();
  const proposal = {
    companyId: "company-1",
    originKind: "task_bridge",
    originId: "jarvis:system-finding",
    originFingerprint: "sha256:shared-finding",
    originRunId: authority.runId,
    title: "Same finding in separate companies",
  };

  const firstCompany = ledger.intake(proposal);
  const secondCompany = ledger.intake({ ...proposal, companyId: "company-2" });

  assert.notEqual(firstCompany.issueId, secondCompany.issueId);
  assert.equal(ledger.size, 2);
});

test("actionable Jarvis intake is replay-safe and Paperclip remains the issue authority", () => {
  const ledger = createIdempotentIntakeLedger();
  const proposal = {
    companyId: authority.companyId,
    originKind: "task_bridge",
    originId: "jarvis:system-finding",
    originRunId: "jarvis-observation-7",
    originFingerprint: "sha256:finding-7",
    title: "Investigate repeated context misses",
  };

  const first = ledger.intake(proposal);
  const replay = ledger.intake(proposal);

  assert.equal(first.issueId, replay.issueId);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(ledger.size, 1);
  assert.match(first.issueId, /^paperclip-issue-/);
});
