/**
 * Paperclip-owned Jarvis learn outbox.
 *
 * Adapters enqueue a redacted contract envelope into run resultJson.
 * Heartbeat drains it only after durable Paperclip finalization.
 */

const LOCAL_GATEWAY_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export type JarvisLearnEnvelope = {
  contract_version: string;
  trace_id: string;
  idempotency_key: string;
  harness_id: string;
  product_id?: string;
  outcome: "success" | "failure" | "cancelled" | "timed_out" | string;
  summary: string;
  redaction_confirmed: boolean;
  paperclip: Record<string, unknown>;
  evidence_refs: string[];
};

export type JarvisLearnOutboxItem = {
  status?: string;
  envelope?: JarvisLearnEnvelope;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeGatewayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Jarvis gateway URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Jarvis gateway URL must not contain credentials, query, or fragment");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOCAL_GATEWAY_HOSTNAMES.has(url.hostname.toLowerCase()))
  ) {
    throw new Error("Jarvis gateway URL must use HTTPS unless it points at localhost");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/v1")) pathname = pathname.slice(0, -3);
  return `${url.origin}${pathname}`;
}

export function resolveJarvisDeliveryConfig(
  adapterConfig: Record<string, unknown> | null | undefined,
  env: Record<string, string | undefined> = process.env,
): { gatewayUrl?: string; token?: string; timeoutMs: number } {
  const configured = asString(adapterConfig?.jarvisGatewayUrl);
  const envUrl = asString(env.JARVIS_GATEWAY_URL);
  const trustedEnv = envUrl ? normalizeGatewayUrl(envUrl) : undefined;
  const gatewayUrl = configured ? normalizeGatewayUrl(configured) : trustedEnv;
  const token = asString(env.JARVIS_GATEWAY_TOKEN);
  if (token && gatewayUrl) {
    if (!trustedEnv) throw new Error("JARVIS_GATEWAY_TOKEN requires a trusted JARVIS_GATEWAY_URL");
    if (gatewayUrl !== trustedEnv) {
      throw new Error("Token-authenticated Jarvis gateway must match JARVIS_GATEWAY_URL");
    }
  }
  const configuredTimeout = adapterConfig?.jarvisTimeoutMs;
  const timeoutMs = Math.min(
    30_000,
    Math.max(
      100,
      typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout)
        ? configuredTimeout
        : Number.parseInt(env.JARVIS_TIMEOUT_MS ?? "1500", 10) || 1500,
    ),
  );
  return { gatewayUrl, token: gatewayUrl ? token : undefined, timeoutMs };
}

export function readPendingJarvisLearnOutbox(
  resultJson: Record<string, unknown> | null | undefined,
): JarvisLearnOutboxItem | null {
  const raw = resultJson?.jarvis_learn_outbox;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as JarvisLearnOutboxItem;
  if (item.status && item.status !== "pending") return null;
  const envelope = item.envelope;
  if (!envelope || typeof envelope !== "object") return null;
  if (envelope.redaction_confirmed !== true) return null;
  if (typeof envelope.summary !== "string" || typeof envelope.idempotency_key !== "string") return null;
  return item;
}

export async function deliverPendingJarvisLearn(opts: {
  resultJson: Record<string, unknown>;
  adapterConfig?: Record<string, unknown> | null;
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<{
  resultJson: Record<string, unknown>;
  delivered: boolean;
  error?: string;
}> {
  const pending = readPendingJarvisLearnOutbox(opts.resultJson);
  if (!pending?.envelope) {
    return { resultJson: opts.resultJson, delivered: false };
  }

  let config: { gatewayUrl?: string; token?: string; timeoutMs: number };
  try {
    config = resolveJarvisDeliveryConfig(opts.adapterConfig, opts.env ?? process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      resultJson: {
        ...opts.resultJson,
        jarvis_outcome_recorded: false,
        jarvis_outcome_error: message,
        jarvis_learn_outbox: { ...pending, status: "failed", error: message },
      },
      delivered: false,
      error: message,
    };
  }

  if (!config.gatewayUrl) {
    return {
      resultJson: {
        ...opts.resultJson,
        jarvis_outcome_recorded: false,
        jarvis_outcome_error: "Jarvis gateway not configured",
        jarvis_learn_outbox: { ...pending, status: "skipped", reason: "no_gateway" },
      },
      delivered: false,
      error: "Jarvis gateway not configured",
    };
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Jarvis learn timed out after ${config.timeoutMs}ms`)),
    config.timeoutMs,
  );
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": pending.envelope.idempotency_key,
    };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const response = await fetchFn(`${config.gatewayUrl}/v1/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contract_version: pending.envelope.contract_version,
        summary: pending.envelope.summary,
        harness_id: pending.envelope.harness_id,
        product_id: pending.envelope.product_id,
        outcome: pending.envelope.outcome,
        idempotency_key: pending.envelope.idempotency_key,
        redaction_confirmed: true,
        paperclip: pending.envelope.paperclip,
        evidence_refs: pending.envelope.evidence_refs,
        payload: {
          jarvis_trace_id: pending.envelope.trace_id,
          paperclip: pending.envelope.paperclip,
          evidence_refs: pending.envelope.evidence_refs,
          redaction_confirmed: true,
          contract_version: pending.envelope.contract_version,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Jarvis learn failed with HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as { ok?: unknown }).ok !== true) {
      throw new Error("Jarvis learning endpoint did not acknowledge the outcome");
    }
    return {
      resultJson: {
        ...opts.resultJson,
        jarvis_outcome_recorded: true,
        jarvis_outcome_error: null,
        jarvis_learn_outbox: {
          ...pending,
          status: "delivered",
          created: (body as { created?: boolean }).created ?? null,
        },
      },
      delivered: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      resultJson: {
        ...opts.resultJson,
        jarvis_outcome_recorded: false,
        jarvis_outcome_error: message,
        jarvis_learn_outbox: { ...pending, status: "failed", error: message },
      },
      delivered: false,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}
