import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../core/config";
import type { FetchLike, NormalizedBackend } from "../core/types";
import { res } from "../../tests/helpers/readiness";
import { probe } from "./probe";

function backend(
  isReady?: (r: Response) => boolean | Promise<boolean>,
  extra = {},
): NormalizedBackend {
  const config = normalizeConfig({
    backend: {
      health: { url: "https://api.test/health", method: "post", headers: { "X-Key": "k" } },
      ...(isReady === undefined ? {} : { isReady }),
      ...extra,
    },
  });
  return config.backends["default"] as NormalizedBackend;
}

const signal = new AbortController().signal;
const answer =
  (response: Response): FetchLike =>
  () =>
    Promise.resolve(response);

describe("probe", () => {
  it("sends the configured request: method, headers, no-store cache, and the signal", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(res(200));
    await probe(backend(), fetchImpl, signal);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://api.test/health", {
      method: "POST",
      headers: { "X-Key": "k" },
      cache: "no-store",
      signal,
    });
  });

  it("default validator: any 2xx is ready, including 204 without a body", async () => {
    for (const status of [200, 201, 204]) {
      expect(await probe(backend(), answer(res(status)), signal)).toEqual({ ok: true });
    }
  });

  it("default validator: non-2xx is `rejected` (HTTP success is required, not sufficient)", async () => {
    for (const status of [301, 404, 500, 503]) {
      expect(await probe(backend(), answer(res(status)), signal)).toEqual({
        ok: false,
        reason: "rejected",
      });
    }
  });

  it("a custom validator decides alone: HTTP 200 can be rejected", async () => {
    const result = await probe(
      backend(() => false),
      answer(res(200)),
      signal,
    );
    expect(result).toEqual({ ok: false, reason: "rejected" });
  });

  it("a custom validator can accept a non-2xx response", async () => {
    const result = await probe(
      backend((r) => r.status === 503),
      answer(res(503)),
      signal,
    );
    expect(result).toEqual({ ok: true });
  });

  it("supports async validators over JSON bodies and 204", async () => {
    const json = backend(async (r) => ((await r.json()) as { status: string }).status === "ready");
    expect(await probe(json, answer(res(200, '{"status":"ready"}')), signal)).toEqual({ ok: true });
    expect(await probe(json, answer(res(200, '{"status":"warming"}')), signal)).toEqual({
      ok: false,
      reason: "rejected",
    });
    const noBody = backend((r) => r.status === 204);
    expect(await probe(noBody, answer(res(204)), signal)).toEqual({ ok: true });
  });

  it("a throwing or rejecting validator is `invalid-response`", async () => {
    const throws = backend(() => {
      throw new Error("secret body: token=abc");
    });
    const rejects = backend(() => Promise.reject(new Error("nope")));
    const badJson = backend(async (r) => (await r.json()) === 1);
    for (const b of [throws, rejects]) {
      expect(await probe(b, answer(res(200)), signal)).toEqual({
        ok: false,
        reason: "invalid-response",
      });
    }
    expect(await probe(badJson, answer(res(200, "<html>")), signal)).toEqual({
      ok: false,
      reason: "invalid-response",
    });
  });

  it("a validator must return exactly true or false: anything else is `invalid-response`", async () => {
    for (const value of [undefined, null, "yes", 1, {}]) {
      const b = backend((() => value) as unknown as () => boolean);
      expect(await probe(b, answer(res(200)), signal)).toEqual({
        ok: false,
        reason: "invalid-response",
      });
    }
  });

  it("a failed request is `network-error`", async () => {
    const failing: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    expect(await probe(backend(), failing, signal)).toEqual({ ok: false, reason: "network-error" });
  });

  it("does not invoke the validator when the request fails", async () => {
    const isReady = vi.fn(() => true);
    await probe(backend(isReady), () => Promise.reject(new Error("x")), signal);
    expect(isReady).not.toHaveBeenCalled();
  });

  it("releases the response body after validation, best effort", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const response = { ok: true, body: { cancel } } as unknown as Response;
    await probe(backend(), answer(response), signal);
    expect(cancel).toHaveBeenCalledTimes(1);

    const failingCancel = {
      ok: true,
      body: { cancel: () => Promise.reject(new Error("locked")) },
    } as unknown as Response;
    expect(await probe(backend(), answer(failingCancel), signal)).toEqual({ ok: true });

    const throwingCancel = {
      ok: true,
      body: {
        cancel: () => {
          throw new Error("locked");
        },
      },
    } as unknown as Response;
    expect(await probe(backend(), answer(throwingCancel), signal)).toEqual({ ok: true });
  });
});
