/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });

  it("does not expose the host-only Jarvis gateway token to Hermes", async () => {
    const previousToken = process.env.JARVIS_GATEWAY_TOKEN;
    process.env.JARVIS_GATEWAY_TOKEN = "host-only-jarvis-token";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.JARVIS_GATEWAY_TOKEN).toBeUndefined();
    } finally {
      if (previousToken === undefined) delete process.env.JARVIS_GATEWAY_TOKEN;
      else process.env.JARVIS_GATEWAY_TOKEN = previousToken;
    }
  });

  it("injects Jarvis identity context and enqueues learn outbox without calling /learn", async () => {
    const workspacePath = process.cwd();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        goal: "Fix the assigned Paperclip issue",
        constraints: ["Keep Paperclip authoritative"],
        success_criteria: ["Focused test passes"],
        tools: ["paperclip"],
        paths: [workspacePath],
        product_id: "paperclip",
        model_server_id: "svlm-local-v1",
        focus_version: 9,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ctx } = makeCtx({
        jarvisGatewayUrl: "http://127.0.0.1:4200",
        jarvisRequired: true,
        cwd: workspacePath,
        productId: "paperclip",
      });
      (ctx as any).config.productId = "paperclip";
      const result = await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const childArgs = mocked.mock.calls[mocked.mock.calls.length - 1]![2] as string[];
      const queryIndex = childArgs.indexOf("-q");
      expect(queryIndex).toBeGreaterThanOrEqual(0);
      expect(childArgs[queryIndex + 1]).toContain("## Untrusted Jarvis advisory data");
      expect(childArgs[queryIndex + 1]).toContain("Fix the assigned Paperclip issue");

      // Expand only — learn is Paperclip post-finalization outbox.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:4200/v1/expand");
      const resultJson = result.resultJson as Record<string, unknown>;
      expect(resultJson.jarvis_trace_id).toBe("test-run-1");
      expect(resultJson.jarvis_model_id).toBe("svlm-local-v1");
      expect(resultJson.jarvis_outcome_recorded).toBe(false);
      expect(resultJson.jarvis_learn_outbox).toMatchObject({
        status: "pending",
        envelope: {
          outcome: "success",
          idempotency_key: "learn:test-run-1:final",
          redaction_confirmed: true,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records parsed terminal errors as failure in the pending learn outbox", async () => {
    const workspacePath = process.cwd();
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ response: "apparently done" }),
      stderr: "ERROR: verification failed",
      timedOut: false,
      pid: 123,
      startedAt: new Date().toISOString(),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        goal: "Fix the assigned Paperclip issue",
        constraints: ["Keep Paperclip authoritative"],
        success_criteria: ["Focused test passes"],
        tools: ["paperclip"],
        paths: [workspacePath],
        product_id: "paperclip",
        model_server_id: "svlm-local-v1",
        focus_version: 17,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ctx } = makeCtx({
        jarvisGatewayUrl: "http://127.0.0.1:4200",
        jarvisRequired: true,
        cwd: workspacePath,
      });
      (ctx as any).config.productId = "paperclip";
      const result = await execute(ctx as any);

      expect(result.errorMessage).toContain("ERROR: verification failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.resultJson).toMatchObject({
        jarvis_outcome_recorded: false,
        jarvis_learn_outbox: {
          status: "pending",
          envelope: {
            product_id: "paperclip",
            outcome: "failure",
          },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not spawn Hermes when required Jarvis context is malformed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ goal: "Incomplete packet" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ctx } = makeCtx({
        jarvisGatewayUrl: "http://127.0.0.1:4200",
        jarvisRequired: true,
      });
      await expect(execute(ctx as any)).rejects.toThrow(
        "Jarvis expansion missing required field",
      );
      expect(serverUtils.runChildProcess).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not contact Jarvis or spawn when the control plane already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by control plane"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ctx } = makeCtx({
        jarvisGatewayUrl: "http://127.0.0.1:4200",
        jarvisRequired: true,
      });
      (ctx as Record<string, unknown>).abortSignal = controller.signal;

      await expect(execute(ctx as any)).rejects.toThrow("cancelled before Jarvis expansion");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(serverUtils.runChildProcess).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rechecks cancellation after expansion before spawning Hermes", async () => {
    const workspacePath = process.cwd();
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      goal: "Fix the assigned Paperclip issue",
      constraints: ["Keep Paperclip authoritative"],
      success_criteria: ["Focused test passes"],
      tools: ["paperclip"],
      paths: [workspacePath],
      product_id: "paperclip",
      model_server_id: "svlm-local-v1",
      focus_version: 17,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ctx } = makeCtx({
        jarvisGatewayUrl: "http://127.0.0.1:4200",
        jarvisRequired: true,
        cwd: workspacePath,
      });
      (ctx as any).config.productId = "paperclip";
      (ctx as Record<string, unknown>).abortSignal = controller.signal;
      (ctx as any).onLog = vi.fn(async (_stream: string, chunk: string) => {
        if (chunk.includes("Jarvis identity context bound")) {
          controller.abort(new Error("cancelled by control plane"));
        }
      });

      await expect(execute(ctx as any)).rejects.toThrow("cancelled after Jarvis expansion");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(serverUtils.runChildProcess).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enqueues an explicit failed outbox when spawning throws after expansion", async () => {
    const workspacePath = process.cwd();
    vi.mocked(serverUtils.runChildProcess).mockRejectedValueOnce(new Error("spawn failed"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        goal: "Fix the assigned Paperclip issue",
        constraints: ["Keep Paperclip authoritative"],
        success_criteria: ["Focused test passes"],
        tools: ["paperclip"],
        paths: [workspacePath],
        product_id: "paperclip",
        model_server_id: "svlm-local-v1",
        focus_version: 17,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ctx } = makeCtx({
        jarvisGatewayUrl: "http://127.0.0.1:4200",
        jarvisRequired: true,
        cwd: workspacePath,
      });
      (ctx as any).config.productId = "paperclip";
      const result = await execute(ctx as any);

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("spawn failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.resultJson).toMatchObject({
        jarvis_trace_id: "test-run-1",
        jarvis_outcome_recorded: false,
        jarvis_learn_outbox: {
          status: "pending",
          envelope: { outcome: "failure" },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enqueues a failed outbox when terminal logging fails after Hermes exits", async () => {
    const workspacePath = process.cwd();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        goal: "Fix the assigned Paperclip issue",
        constraints: ["Keep Paperclip authoritative"],
        success_criteria: ["Focused test passes"],
        tools: ["paperclip"],
        paths: [workspacePath],
        product_id: "paperclip",
        model_server_id: "svlm-local-v1",
        focus_version: 17,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ctx } = makeCtx({
        jarvisGatewayUrl: "http://127.0.0.1:4200",
        jarvisRequired: true,
        cwd: workspacePath,
      });
      (ctx as any).config.productId = "paperclip";
      (ctx as any).onLog = vi.fn(async (_stream: string, chunk: string) => {
        if (chunk.includes("Exit code:")) throw new Error("terminal log write failed");
      });
      const result = await execute(ctx as any);

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("terminal log write failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.resultJson).toMatchObject({
        jarvis_outcome_recorded: false,
        jarvis_learn_outbox: {
          status: "pending",
          envelope: { outcome: "failure" },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
