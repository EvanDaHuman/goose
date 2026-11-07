// Naive Managed Agents: client and readiness. SDK @usenaive-sdk/vetta 0.10.0 (docs/research/naive-api-notes.md).
// The SDK never retries; retries live in the injected fetch, which is safe because an SDK call computes its headers
// (including Idempotency-Key) once, so a resend carries the same key.
import { randomUUID } from "node:crypto";
import { ApiError, createClient, type VettaClient } from "@usenaive-sdk/vetta";
import { config } from "../config";

export type NaiveState =
  | "missing_key" | "unauthorized" | "missing_scope" | "no_plan" | "no_credits" | "model_unavailable" | "ready" | "unreachable" | "error";

export type NaiveStatus = {
  state: NaiveState;
  message: string;
  checkedAt: string;
  organization?: string;
  plan?: string | null;
  balanceMicroUsd?: number;
  mode?: string;
  model?: string;
  scopes?: string[];
  requestId?: string;
  warning?: string;
};

export const NEEDED_SCOPES = ["agents:write", "agents:read", "sessions:write", "sessions:read", "files:write", "files:read", "billing:read"];

/** fetch with backoff on 429 (honouring Retry-After) and transient 5xx; at most `tries` attempts. */
export function retryingFetch(base: typeof fetch = globalThis.fetch, tries = 4): typeof fetch {
  return (async (input: any, init?: any) => {
    let last: Response | undefined;
    for (let i = 0; i < tries; i++) {
      try {
        last = await base(input, init);
      } catch (e) {
        if (i === tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      if (last.status !== 429 && ![500, 502, 503, 504].includes(last.status)) return last;
      const after = Number(last.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** i));
    }
    return last!;
  }) as typeof fetch;
}

export function naiveClient(fetchImpl: typeof fetch = globalThis.fetch, apiKey: string = config.naive.apiKey): VettaClient {
  return createClient({ baseUrl: config.naive.baseUrl, apiKey, fetch: retryingFetch(fetchImpl), idempotencyKey: () => randomUUID() });
}

export function describeError(e: unknown) {
  if (e instanceof ApiError) {
    return { status: e.status, code: e.code, type: e.type, message: e.message, requestId: e.requestId, param: e.param };
  }
  if (e instanceof Error && e.name === "ZodError") {
    return { message: "Naive answered in a shape this SDK version does not expect", issues: (e as any).issues?.slice?.(0, 5) };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}

export async function naiveStatus(client?: VettaClient, apiKey: string = config.naive.apiKey): Promise<NaiveStatus> {
  const checkedAt = new Date().toISOString();
  if (!apiKey) {
    return { state: "missing_key", checkedAt,
      message: "VETTA_API_KEY is not set. The agents cannot run on Naive until an API key with an active plan is added to .env." };
  }
  const c = client ?? naiveClient();
  try {
    const me = await c.auth.me();
    const scopes = me.scopes as string[];
    const missing = scopes.includes("admin") ? [] : NEEDED_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) {
      return { state: "missing_scope", checkedAt, organization: me.organization?.id, scopes,
        message: `The API key is missing scopes: ${missing.join(", ")}. Create a key with ${NEEDED_SCOPES.join(",")}.` };
    }
    const sub = await c.credits.subscription();
    const inGrace = sub.status === "past_due" && sub.grace_until && new Date(sub.grace_until) > new Date();
    if (sub.status !== "active" && !inGrace) {
      return { state: "no_plan", checkedAt, organization: me.organization?.id, plan: sub.plan,
        message: `The Naive organization has no active plan (status: ${sub.status}). Every agent call answers 402 until one is active.` };
    }
    const bal = await c.credits.show();
    if (bal.balance_micro_usd <= 0) {
      return { state: "no_credits", checkedAt, organization: me.organization?.id, plan: sub.plan, balanceMicroUsd: bal.balance_micro_usd,
        mode: bal.mode, message: "The Naive balance is zero; top up before running agents." };
    }
    try {
      await c.models.retrieve(config.naive.model);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return { state: "model_unavailable", checkedAt, organization: me.organization?.id, model: config.naive.model,
          message: `Naive does not serve the model ${config.naive.model}; set NAIVE_MODEL to one that models.list returns.` };
      }
      throw e;
    }
    return { state: "ready", checkedAt, organization: me.organization?.id, plan: sub.plan, balanceMicroUsd: bal.balance_micro_usd,
      mode: bal.mode, model: config.naive.model, scopes,
      warning: inGrace ? `Payment is past due; agents keep working until ${sub.grace_until}.` : undefined,
      message: `Connected to Naive (${bal.mode} mode), model ${config.naive.model}.` };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) return { state: "unauthorized", checkedAt, requestId: e.requestId,
        message: `Naive rejected the API key: ${e.message} (401 ${e.code}).` };
      if (e.code === "subscription_required") return { state: "no_plan", checkedAt, requestId: e.requestId,
        message: "The Naive organization has no active plan (402 subscription_required)." };
      if (e.status === 403) return { state: "missing_scope", checkedAt, requestId: e.requestId,
        message: `Naive refused a readiness call (403 ${e.code}): the key lacks a scope. Needed: ${NEEDED_SCOPES.join(",")}.` };
      return { state: "error", checkedAt, requestId: e.requestId, message: `${e.status} ${e.code}: ${e.message}` };
    }
    if (e instanceof Error && e.name === "ZodError") {
      return { state: "error", checkedAt, message: "Naive answered in a shape SDK 0.10.0 does not expect (ZodError); check for a newer SDK." };
    }
    return { state: "unreachable", checkedAt, message: `Could not reach ${config.naive.baseUrl}: ${(e as Error).message}` };
  }
}
