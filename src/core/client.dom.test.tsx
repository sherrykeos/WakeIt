import { afterEach, describe, expect, it, vi } from "vitest";
import { createWakeIt } from "./client";

// Runs in jsdom, where browser globals exist: proves the core does not touch them
// (no listeners, timers or requests) during create / subscribe / dispose.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("core in a browser-like environment", () => {
  it("creates, subscribes and disposes without side effects", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const windowListener = vi.spyOn(window, "addEventListener");
    const documentListener = vi.spyOn(document, "addEventListener");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");

    const client = createWakeIt({ backend: { health: "https://api.example.com/health" } });
    const unsubscribe = client.subscribe(() => undefined);
    unsubscribe();
    client.dispose();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(windowListener).not.toHaveBeenCalled();
    expect(documentListener).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });
});
