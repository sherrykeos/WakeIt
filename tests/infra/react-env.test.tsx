import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// Verifies the jsdom + JSX + React Testing Library toolchain for later React
// phases, using an inline element. No WakeIt component exists yet.
describe("react test environment", () => {
  it("renders JSX in jsdom with React Testing Library", () => {
    render(<p>toolchain ok</p>);
    expect(screen.getByText("toolchain ok")).toBeTruthy();
    expect(typeof document).toBe("object");
  });
});
