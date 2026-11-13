import type { FetchLike, NormalizedBackend } from "../core/types";

/** Why a probe attempt did not establish readiness (timeouts are decided by the controller). */
export type ProbeFailure = "rejected" | "invalid-response" | "network-error";

export type ProbeResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: ProbeFailure };

/** Releases the response body without reading it. Best effort: failures are irrelevant. */
function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The body may already be consumed or locked by the validator.
  }
}

/**
 * One probe attempt: send the health request, then let the validator decide (AD-20).
 *
 * Transport success is not readiness. The default validator accepts HTTP 2xx; a custom
 * `isReady` decides alone and must return exactly `true` or `false`; throwing, rejecting or
 * returning anything else is `invalid-response`. A failed request is `network-error`.
 * Resolves always (never rejects). The caller owns the timeout and aborts through `signal`.
 */
export async function probe(
  backend: NormalizedBackend,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const { url, method, headers } = backend.health;

  let response: Response;
  try {
    response = await fetchImpl(url, { method, headers: { ...headers }, cache: "no-store", signal });
  } catch {
    return { ok: false, reason: "network-error" };
  }

  let verdict: unknown;
  try {
    verdict = backend.isReady === undefined ? response.ok : await backend.isReady(response);
  } catch {
    discard(response);
    return { ok: false, reason: "invalid-response" };
  }
  discard(response);

  if (verdict === true) return { ok: true };
  if (verdict === false) return { ok: false, reason: "rejected" };
  return { ok: false, reason: "invalid-response" };
}
