import { describe, expect, it } from "vitest";

// Infrastructure smoke test. It asserts the package foundation only; it does
// not test WakeIt behavior, because none exists yet.
describe("package foundation (source entries)", () => {
  it("imports the core entry without React, Axios or browser globals", async () => {
    // Node environment: `window` is undefined. Importing must not throw.
    expect(typeof (globalThis as Record<string, unknown>)["window"]).toBe("undefined");
    const core = await import("../../src/index");
    expect(Object.keys(core)).toEqual([]);
  });

  it("imports the react and axios entries", async () => {
    expect(Object.keys(await import("../../src/react/index"))).toEqual([]);
    expect(Object.keys(await import("../../src/axios/index"))).toEqual([]);
  });
});
