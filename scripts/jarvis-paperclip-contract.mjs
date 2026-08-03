import fs from "node:fs";
import path from "node:path";

const CONTRACT_VERSION = "jarvis-paperclip/v1";
const MAX_SUMMARY_CHARS = 4_000;
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
  "assignee",
  "assignee_agent_id",
  "assigneeAgentId",
  "budget",
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
    "projectId",
    "productKey",
    "issueId",
    "assignmentId",
    "runId",
    "workspaceId",
    "workspaceCwd",
  ]) {
    requireNonEmptyString(authority[field], `paperclip.${field}`);
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
    harness_id: `paperclip:${harnessName}:${paperclip.assignmentId}`,
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
    harness_id: `paperclip:${requireNonEmptyString(harness, "harness")}:${paperclip.assignmentId}`,
    product_id: paperclip.productKey,
    outcome: normalizedOutcome,
    summary: requireNonEmptyString(summary, "summary").slice(0, MAX_SUMMARY_CHARS),
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
    checkout() {
      return transition("created", "checked_out");
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
  const requestCompanyId = requireNonEmptyString(request?.companyId, "request.companyId");
  const requestProjectId = requireNonEmptyString(request?.projectId, "request.projectId");
  const operation = requireNonEmptyString(request?.operation, "request.operation");
  if (credentialCompanyId !== requestCompanyId) {
    throw new ContractViolation("task-bridge request crosses company boundary");
  }
  if (credentialProjectId !== requestProjectId) {
    throw new ContractViolation("task-bridge request crosses project boundary");
  }
  if (!TASK_BRIDGE_OPERATIONS.has(operation)) {
    throw new ContractViolation(`task-bridge unsupported operation: ${operation}`);
  }
  if (!Array.isArray(credential.scopes) || !credential.scopes.includes(operation)) {
    throw new ContractViolation(`task-bridge credential lacks scope: ${operation}`);
  }
  return true;
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
