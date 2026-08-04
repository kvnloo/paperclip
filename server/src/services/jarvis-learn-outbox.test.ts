import { describe, expect, it, vi } from "vitest";

import {
  deliverPendingJarvisLearn,
  readPendingJarvisLearnOutbox,
  resolveJarvisDeliveryConfig,
} from "./jarvis-learn-outbox.js";

const envelope = {
  contract_version: "jarvis-paperclip/v1",
  trace_id: "run-1",
  idempotency_key: "learn:run-1:final",
  harness_id: "paperclip:hermes:agent-1",
  product_id: "paperclip",
  outcome: "success" as const,
  summary: "Closed remaining contract gaps",
  redaction_confirmed: true as const,
  paperclip: {
    company_id: "co-1",
    project_id: "proj-1",
    issue_id: "issue-1",
    run_id: "run-1",
  },
  evidence_refs: ["paperclip://issues/issue-1/runs/run-1"],
};

describe("jarvis learn outbox", () => {
  it("reads only pending redacted envelopes", () => {
    expect(readPendingJarvisLearnOutbox({
      jarvis_learn_outbox: { status: "pending", envelope },
    })?.envelope?.trace_id).toBe("run-1");
    expect(readPendingJarvisLearnOutbox({
      jarvis_learn_outbox: { status: "delivered", envelope },
    })).toBeNull();
    expect(readPendingJarvisLearnOutbox({
      jarvis_learn_outbox: { status: "pending", envelope: { ...envelope, redaction_confirmed: false } },
    })).toBeNull();
  });

  it("requires trusted env gateway for token auth", () => {
    expect(() => resolveJarvisDeliveryConfig(
      { jarvisGatewayUrl: "https://other.example" },
      { JARVIS_GATEWAY_URL: "https://trusted.example", JARVIS_GATEWAY_TOKEN: "secret" },
    )).toThrow("must match JARVIS_GATEWAY_URL");
  });

  it("delivers after finalization and marks outbox delivered", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, created: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await deliverPendingJarvisLearn({
      resultJson: {
        jarvis_learn_outbox: { status: "pending", envelope },
        jarvis_outcome_recorded: false,
      },
      adapterConfig: {},
      env: { JARVIS_GATEWAY_URL: "http://127.0.0.1:4200" },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.delivered).toBe(true);
    expect(result.resultJson.jarvis_outcome_recorded).toBe(true);
    expect((result.resultJson.jarvis_learn_outbox as { status: string }).status).toBe("delivered");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls.at(0);
    expect(call).toBeTruthy();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4200/v1/learn");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toBe(
      "learn:run-1:final",
    );
  });

  it("records failure without undoing Paperclip disposition metadata", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 503 }));
    const result = await deliverPendingJarvisLearn({
      resultJson: {
        summary: "paperclip already finalized",
        jarvis_learn_outbox: { status: "pending", envelope },
      },
      env: { JARVIS_GATEWAY_URL: "http://127.0.0.1:4200" },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.delivered).toBe(false);
    expect(result.resultJson.summary).toBe("paperclip already finalized");
    expect(result.resultJson.jarvis_outcome_recorded).toBe(false);
    expect((result.resultJson.jarvis_learn_outbox as { status: string }).status).toBe("failed");
  });
});
