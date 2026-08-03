import fs from "node:fs";
import path from "node:path";

const CONTRACT_VERSION = "jarvis-paperclip/v1";
const MAX_SUMMARY_CHARS = 4_000;
const MAX_PACKET_BYTES = 16_000;
const GOVERNANCE_DISPOSITIONS = new Set(["approved", "not_required"]);
const REQUIRED_PACKET_ARRAYS = ["constraints", "success_criteria", "tools", "paths"];
const LEARN_OUTCOMES = new Set(["success", "failure", "cancelled", "timed_out"]);
const TASK_BRIDGE_OPERATIONS = new Set(["issues:intake"]);
const PAPERCLIP_AUTHORITY_FIELDS = new Set([
  "approval",
  "approval_state",
  "approvalState",
  "approvals",
  "assignment",
  "assignment_id",
  "assignmentId",
  "assigned_agent_id",
  "assignedAgentId",
  "assignee",
  "assignee_agent_id",
  "assigneeAgentId",
  "budget",
  "budget_disposition",
  "budgetDisposition",
  "budget_remaining_cents",
  "budgetRemainingCents",
  "company_id",
  "companyId",
  "cost",
  "disposition",
  "evidence",
  "goal_id",
  "goalId",
  "issue",
  "issue_id",
  "issueId",
  "project",
  "project_id",
  "projectId",
  "run",
  "run_id",
  "runId",
  "status",
  "workspace",
  "workspace_cwd",
  "workspace_id",
  "workspaceCwd",
  "workspaceId",
]);

export class ContractViolation extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractViolation";
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractViolation(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireAuthority(authority) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new ContractViolation("Paperclip authority envelope is required");
  }
  for (const field of [
    "companyId",
    "goalId",
    "projectId",
    "productKey",
    "issueId",
    "assignmentId",
    "assignedAgentId",
    "runId",
    "workspaceId",
    "workspaceCwd",
  ]) {
    requireNonEmptyString(authority[field], `paperclip.${field}`);
  }
  const approvalState = requireNonEmptyString(authority.approvalState, "paperclip.approvalState");
  const budgetDisposition = requireNonEmptyString(
    authority.budgetDisposition,
    "paperclip.budgetDisposition",
  );
  if (!GOVERNANCE_DISPOSITIONS.has(approvalState)) {
    throw new ContractViolation(`paperclip.approvalState is not cleared: ${approvalState}`);
  }
  if (!GOVERNANCE_DISPOSITIONS.has(budgetDisposition)) {
    throw new ContractViolation(`paperclip.budgetDisposition is not cleared: ${budgetDisposition}`);
  }
  if (!Number.isSafeInteger(authority.budgetRemainingCents) || authority.budgetRemainingCents < 0) {
    throw new ContractViolation("paperclip.budgetRemainingCents must be a non-negative integer");
  }
  return authority;
}

function canonicalizeWithExistingAncestor(candidate) {
  let ancestor = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink()) {
        throw new ContractViolation(`Jarvis path traverses broken symlink: ${ancestor}`);
      }
    } catch (error) {
      if (error instanceof ContractViolation) throw error;
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const canonicalAncestor = fs.realpathSync.native(ancestor);
  return path.join(canonicalAncestor, ...suffix);
}

function isWithinWorkspace(candidate, workspace) {
  const root = fs.realpathSync.native(path.resolve(workspace));
  const resolved = canonicalizeWithExistingAncestor(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export function buildExpandEnvelope({ authority, harness, prompt }) {
  const paperclip = requireAuthority(authority);
  const harnessName = requireNonEmptyString(harness, "harness");
  return {
    contract_version: CONTRACT_VERSION,
    trace_id: paperclip.runId,
    prompt: requireNonEmptyString(prompt, "prompt"),
    harness_id: `paperclip:${harnessName}:${paperclip.assignedAgentId}`,
    product_id: paperclip.productKey,
    packet_id: paperclip.issueId,
    paperclip: { ...paperclip },
  };
}

function rejectAuthorityClaims(value, location = "packet") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectAuthorityClaims(item, `${location}[${index}]`));
    return;
  }
  for (const [field, nested] of Object.entries(value)) {
    if (PAPERCLIP_AUTHORITY_FIELDS.has(field)) {
      throw new ContractViolation(
        `Jarvis packet contains Paperclip authority field at ${location}: ${field}`,
      );
    }
    rejectAuthorityClaims(nested, `${location}.${field}`);
  }
}

export function validateJarvisPacket(packet, authority) {
  const paperclip = requireAuthority(authority);
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new ContractViolation("Jarvis packet must be an object");
  }

  let packetBytes;
  try {
    packetBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  } catch {
    throw new ContractViolation("Jarvis packet must be JSON-serializable");
  }
  if (packetBytes > MAX_PACKET_BYTES) {
    throw new ContractViolation(
      `Jarvis packet size exceeds ${MAX_PACKET_BYTES} bytes: ${packetBytes}`,
    );
  }

  rejectAuthorityClaims(packet);

  const validated = {
    ...packet,
    goal: requireNonEmptyString(packet.goal, "goal"),
    product_id: requireNonEmptyString(packet.product_id, "product_id"),
  };
  if (validated.product_id !== paperclip.productKey) {
    throw new ContractViolation(
      `Jarvis product_id does not match Paperclip product key: ${validated.product_id}`,
    );
  }
  for (const field of REQUIRED_PACKET_ARRAYS) {
    const value = packet[field];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new ContractViolation(`${field} must be an array of strings`);
    }
    validated[field] = [...value];
  }
  for (const candidate of validated.paths) {
    if (!path.isAbsolute(candidate)) {
      throw new ContractViolation(`Jarvis path must be absolute: ${candidate}`);
    }
    if (!isWithinWorkspace(candidate, paperclip.workspaceCwd)) {
      throw new ContractViolation(`Jarvis path is outside Paperclip workspace: ${candidate}`);
    }
  }
  if (
    packet.context_pack !== undefined &&
    (!packet.context_pack || typeof packet.context_pack !== "object" || Array.isArray(packet.context_pack))
  ) {
    throw new ContractViolation("context_pack must be an object");
  }
  return validated;
}

function requireRedactedSummary(summary) {
  const normalized = requireNonEmptyString(summary, "summary");
  const secretPatterns = [
    /\bBearer\s+\S+/i,
    /\b(?:authorization|api[_ -]?key|password|secret|token)\b\s*[:=]\s*\S+/i,
    /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/,
  ];
  if (secretPatterns.some((pattern) => pattern.test(normalized))) {
    throw new ContractViolation("learn summary contains secret-like material after redaction");
  }
  return normalized.slice(0, MAX_SUMMARY_CHARS);
}

export function buildLearnEnvelope({
  authority,
  harness,
  outcome,
  summary,
  redacted,
  evidenceRefs = [],
}) {
  const paperclip = requireAuthority(authority);
  const normalizedOutcome = requireNonEmptyString(outcome, "outcome");
  if (!LEARN_OUTCOMES.has(normalizedOutcome)) {
    throw new ContractViolation(`unsupported learn outcome: ${normalizedOutcome}`);
  }
  if (redacted !== true) {
    throw new ContractViolation("learn summary must be explicitly redacted");
  }
  if (!Array.isArray(evidenceRefs) || !evidenceRefs.every((item) => typeof item === "string")) {
    throw new ContractViolation("evidenceRefs must be an array of strings");
  }
  return {
    contract_version: CONTRACT_VERSION,
    trace_id: paperclip.runId,
    idempotency_key: `learn:${paperclip.runId}:final`,
    harness_id: `paperclip:${requireNonEmptyString(harness, "harness")}:${paperclip.assignedAgentId}`,
    product_id: paperclip.productKey,
    outcome: normalizedOutcome,
    summary: requireRedactedSummary(summary),
    redaction_confirmed: true,
    paperclip: {
      company_id: paperclip.companyId,
      project_id: paperclip.projectId,
      issue_id: paperclip.issueId,
      issue_identifier: paperclip.issueIdentifier,
      run_id: paperclip.runId,
    },
    evidence_refs: [...evidenceRefs],
  };
}

export function createRunLifecycle(runId) {
  requireNonEmptyString(runId, "runId");
  let state = "created";
  const transition = (expected, next, message) => {
    if (state !== expected) {
      throw new ContractViolation(message ?? `run must be ${expected} before ${next}`);
    }
    state = next;
    return state;
  };
  return {
    get state() {
      return state;
    },
    clearGovernance() {
      return transition("created", "governance_cleared");
    },
    checkout() {
      return transition(
        "governance_cleared",
        "checked_out",
        "Paperclip governance must be cleared before checkout",
      );
    },
    expand() {
      return transition("checked_out", "expanded");
    },
    spawn() {
      return transition("expanded", "spawned");
    },
    persistEvidence() {
      return transition("spawned", "evidence_persisted");
    },
    finalizePaperclip() {
      return transition("evidence_persisted", "paperclip_finalized");
    },
    learn() {
      return transition(
        "paperclip_finalized",
        "learned",
        "Paperclip evidence and final disposition must be durable before Jarvis learn",
      );
    },
  };
}

export function authorizeTaskBridge(credential, request) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new ContractViolation("task-bridge credential is required");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ContractViolation("task-bridge request is required");
  }
  const credentialCompanyId = requireNonEmptyString(credential.companyId, "credential.companyId");
  const credentialProjectId = requireNonEmptyString(credential.projectId, "credential.projectId");
  const credentialHarnessId = requireNonEmptyString(credential.harnessId, "credential.harnessId");
  const requestCompanyId = requireNonEmptyString(request?.companyId, "request.companyId");
  const requestProjectId = requireNonEmptyString(request?.projectId, "request.projectId");
  const requestHarnessId = requireNonEmptyString(request?.harnessId, "request.harnessId");
  const operation = requireNonEmptyString(request?.operation, "request.operation");
  if (credentialCompanyId !== requestCompanyId) {
    throw new ContractViolation("task-bridge request crosses company boundary");
  }
  if (credentialProjectId !== requestProjectId) {
    throw new ContractViolation("task-bridge request crosses project boundary");
  }
  if (credentialHarnessId !== requestHarnessId) {
    throw new ContractViolation("task-bridge request crosses harness boundary");
  }
  if (!TASK_BRIDGE_OPERATIONS.has(operation)) {
    throw new ContractViolation(`task-bridge unsupported operation: ${operation}`);
  }
  if (!Array.isArray(credential.scopes) || !credential.scopes.includes(operation)) {
    throw new ContractViolation(`task-bridge credential lacks scope: ${operation}`);
  }
  return true;
}

function canonicalJson(value, seen = new Set()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new ContractViolation("learn event must be JSON-serializable");
  }
  seen.add(value);
  const canonical = Array.isArray(value)
    ? value.map((item) => canonicalJson(item, seen))
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonicalJson(value[key], seen)]),
      );
  seen.delete(value);
  return canonical;
}

export function createIdempotentLearnLedger() {
  const byKey = new Map();
  let sequence = 0;
  return {
    get size() {
      return byKey.size;
    },
    accept(event, options = {}) {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new ContractViolation("learn event must be an object");
      }
      const contractVersion = requireNonEmptyString(
        event.contract_version,
        "contract_version",
      );
      if (contractVersion !== CONTRACT_VERSION) {
        throw new ContractViolation(`unsupported learn contract version: ${contractVersion}`);
      }
      const traceId = requireNonEmptyString(event.trace_id, "trace_id");
      const idempotencyKey = requireNonEmptyString(event.idempotency_key, "idempotency_key");
      if (idempotencyKey !== `learn:${traceId}:final`) {
        throw new ContractViolation("learn idempotency key does not match trace_id");
      }
      if (!LEARN_OUTCOMES.has(event.outcome)) {
        throw new ContractViolation(`unsupported learn outcome: ${event.outcome}`);
      }
      if (event.redaction_confirmed !== true) {
        throw new ContractViolation("learn event must confirm redaction");
      }
      if (typeof event.summary !== "string" || event.summary.length > MAX_SUMMARY_CHARS) {
        throw new ContractViolation(`learn summary size exceeds ${MAX_SUMMARY_CHARS} characters`);
      }
      requireRedactedSummary(event.summary);
      if (
        !Array.isArray(event.evidence_refs) ||
        !event.evidence_refs.every((item) => typeof item === "string")
      ) {
        throw new ContractViolation("learn evidence_refs must be an array of strings");
      }
      if (!event.paperclip || typeof event.paperclip !== "object" || Array.isArray(event.paperclip)) {
        throw new ContractViolation("learn Paperclip provenance is required");
      }
      if (requireNonEmptyString(event.paperclip.run_id, "paperclip.run_id") !== traceId) {
        throw new ContractViolation("learn Paperclip run_id does not match trace_id");
      }
      const serialized = JSON.stringify(canonicalJson(event));
      const existing = byKey.get(idempotencyKey);
      if (existing) {
        if (existing.serialized !== serialized) {
          throw new ContractViolation(`learn idempotency collision: ${idempotencyKey}`);
        }
        return { learnId: existing.learnId, created: false };
      }
      sequence += 1;
      const record = {
        learnId: `jarvis-learn-${sequence}`,
        serialized,
      };
      byKey.set(idempotencyKey, record);
      if (options.crashAfterPersist === true) {
        throw new Error("simulated crash after learn persistence");
      }
      return { learnId: record.learnId, created: true };
    },
  };
}

export function createIdempotentIntakeLedger() {
  const byFingerprint = new Map();
  let sequence = 0;
  return {
    get size() {
      return byFingerprint.size;
    },
    intake(proposal, options = {}) {
      if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        throw new ContractViolation("intake proposal must be an object");
      }
      const companyId = requireNonEmptyString(proposal.companyId, "companyId");
      const originKind = requireNonEmptyString(proposal.originKind, "originKind");
      const originId = requireNonEmptyString(proposal.originId, "originId");
      const originFingerprint = requireNonEmptyString(
        proposal.originFingerprint,
        "originFingerprint",
      );
      requireNonEmptyString(proposal.originRunId, "originRunId");
      requireNonEmptyString(proposal.title, "title");
      const key = `${companyId}\u0000${originKind}\u0000${originId}\u0000${originFingerprint}`;
      const existing = byFingerprint.get(key);
      if (existing) return { issueId: existing.issueId, created: false };
      sequence += 1;
      const record = {
        issueId: `paperclip-issue-${sequence}`,
        proposal: { ...proposal },
      };
      byFingerprint.set(key, record);
      if (options.crashAfterPersist === true) {
        throw new Error("simulated crash after persistence");
      }
      return { issueId: record.issueId, created: true };
    },
  };
}
