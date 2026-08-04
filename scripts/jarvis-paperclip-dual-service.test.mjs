/**
 * Dual-service contract gate (mocked Paperclip + Jarvis handlers).
 *
 * Proves:
 *   governance → checkout → expand → harness → Paperclip evidence/disposition → learn
 * including timeout outcome fidelity and crash/replay learn dedupe.
 *
 * Run: pnpm exec node --test scripts/jarvis-paperclip-dual-service.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeTaskBridge,
  buildExpandEnvelope,
  buildLearnEnvelope,
  createIdempotentLearnLedger,
  createRunLifecycle,
  validateJarvisPacket,
} from "./jarvis-paperclip-contract.mjs";

const authority = {
  companyId: "co-1",
  goalId: "goal-1",
  projectId: "proj-1",
  productKey: "paperclip",
  issueId: "issue-1",
  issueIdentifier: "ZER-2",
  assignmentId: "asg-1",
  assignedAgentId: "agent-1",
  runId: "run-1",
  workspaceId: "ws-1",
  workspaceCwd: process.cwd(),
  approvalState: "approved",
  budgetDisposition: "not_required",
  budgetRemainingCents: 500,
};

function createMockJarvis() {
  const learnLedger = createIdempotentLearnLedger();
  const expands = [];
  return {
    expands,
    async expand(body) {
      expands.push(body);
      assert.equal(body.trace_id, authority.runId);
      assert.ok(body.paperclip?.runId);
      return {
        goal: "Close remaining Jarvis contract gaps",
        constraints: ["Paperclip remains authority"],
        success_criteria: ["Dual-service gate green"],
        tools: ["terminal"],
        paths: [authority.workspaceCwd],
        product_id: "paperclip",
        model_server_id: "t0-stub",
        focus_version: 1,
      };
    },
    async learn(event, options = {}) {
      return learnLedger.accept(event, options);
    },
    learnSize() {
      return learnLedger.size;
    },
  };
}

function createMockPaperclip(jarvis) {
  const issues = new Map();
  const runs = new Map();
  return {
    issues,
    runs,
    async intake(proposal, credential) {
      authorizeTaskBridge(credential, {
        companyId: proposal.companyId,
        projectId: proposal.projectId,
        harnessId: proposal.harnessId,
        operation: "issues:intake",
      });
      const key = `${proposal.companyId}:${proposal.originFingerprint}`;
      if (issues.has(key)) return { issueId: issues.get(key), created: false };
      const issueId = `issue-${issues.size + 1}`;
      issues.set(key, issueId);
      return { issueId, created: true };
    },
    async executeRun({ timedOut = false, crashAfterLearnPersist = false } = {}) {
      const life = createRunLifecycle(authority.runId);
      life.clearGovernance();
      life.checkout();

      const expandReq = buildExpandEnvelope({
        authority,
        harness: "hermes",
        prompt: "Implement remaining contract gaps",
      });
      const packet = await jarvis.expand(expandReq);
      const validated = validateJarvisPacket(packet, authority);
      life.expand();

      // Harness spawn after expand.
      life.spawn();
      const harnessEvidence = {
        exitCode: timedOut ? null : 0,
        timedOut,
        summary: timedOut
          ? "Harness timed out after budget"
          : "Adapter enqueued redacted learn outbox only",
      };

      // Paperclip evidence + disposition BEFORE learn.
      runs.set(authority.runId, {
        status: timedOut ? "timed_out" : "succeeded",
        evidence: harnessEvidence,
        resultJson: {
          jarvis_learn_outbox: {
            status: "pending",
            envelope: null,
          },
        },
      });
      life.persistEvidence();
      life.finalizePaperclip();

      const outcome = timedOut ? "timed_out" : "success";
      const learnEvent = buildLearnEnvelope({
        authority,
        harness: "hermes",
        outcome,
        summary: harnessEvidence.summary,
        redacted: true,
        evidenceRefs: [`paperclip://issues/${authority.issueId}/runs/${authority.runId}`],
      });

      // Outbox drain after finalization.
      let first;
      try {
        first = await jarvis.learn(learnEvent, { crashAfterPersist: crashAfterLearnPersist });
      } catch (error) {
        assert.match(String(error.message), /simulated crash/);
        // Client retries after crash — must dedupe.
        first = await jarvis.learn(learnEvent);
        assert.equal(first.created, false);
      }
      if (!crashAfterLearnPersist) {
        assert.equal(first.created, true);
      }
      life.learn();

      // Replay is a no-op create.
      const replay = await jarvis.learn(learnEvent);
      assert.equal(replay.created, false);
      assert.equal(replay.learnId, first.learnId);

      runs.get(authority.runId).resultJson.jarvis_learn_outbox = {
        status: "delivered",
        envelope: learnEvent,
      };
      runs.get(authority.runId).resultJson.jarvis_outcome_recorded = true;

      return {
        run: runs.get(authority.runId),
        packet: validated,
        learnId: first.learnId,
        outcome,
      };
    },
  };
}

test("dual-service success path enforces finalization-before-learn", async () => {
  const jarvis = createMockJarvis();
  const paperclip = createMockPaperclip(jarvis);
  const result = await paperclip.executeRun();
  assert.equal(result.outcome, "success");
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.resultJson.jarvis_outcome_recorded, true);
  assert.equal(result.run.resultJson.jarvis_learn_outbox.status, "delivered");
  assert.equal(jarvis.learnSize(), 1);
  assert.equal(jarvis.expands.length, 1);
  assert.equal(jarvis.expands[0].product_id, "paperclip");
});

test("dual-service timeout preserves timed_out and survives learn crash/replay", async () => {
  const jarvis = createMockJarvis();
  const paperclip = createMockPaperclip(jarvis);
  const result = await paperclip.executeRun({ timedOut: true, crashAfterLearnPersist: true });
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.run.status, "timed_out");
  assert.equal(jarvis.learnSize(), 1);
});

test("task-bridge intake remains company/project/harness scoped and intake-only", async () => {
  const jarvis = createMockJarvis();
  const paperclip = createMockPaperclip(jarvis);
  const credential = {
    companyId: authority.companyId,
    projectId: authority.projectId,
    harnessId: "paperclip:hermes:agent-1",
    scopes: ["issues:intake"],
  };
  const first = await paperclip.intake({
    companyId: authority.companyId,
    projectId: authority.projectId,
    harnessId: "paperclip:hermes:agent-1",
    originFingerprint: "fp-1",
  }, credential);
  const second = await paperclip.intake({
    companyId: authority.companyId,
    projectId: authority.projectId,
    harnessId: "paperclip:hermes:agent-1",
    originFingerprint: "fp-1",
  }, credential);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.issueId, second.issueId);

  await assert.rejects(
    () => paperclip.intake({
      companyId: authority.companyId,
      projectId: "other-project",
      harnessId: "paperclip:hermes:agent-1",
      originFingerprint: "fp-2",
    }, credential),
    /project boundary/,
  );
});
