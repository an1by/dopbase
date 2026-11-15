import { describe, expect, it } from "vitest";
import { tokenExpiresIn } from "./token-expiry";

describe("tokenExpiresIn", () => {
  it("accepts the maximum custom duration in either unit", () => {
    expect(tokenExpiresIn("custom", "26280", "h")).toBe("26280h");
    expect(tokenExpiresIn("custom", "1095", "d")).toBe("1095d");
    expect(tokenExpiresIn("never", "", "h")).toBe("never");
    expect(() => tokenExpiresIn("10y", "", "h")).toThrow();
  });

  it("caps runner tokens at a year", () => {
    expect(tokenExpiresIn("custom", "365", "d", 365)).toBe("365d");
    expect(tokenExpiresIn("custom", "8760", "h", 365)).toBe("8760h");
    expect(() => tokenExpiresIn("custom", "366", "d", 365)).toThrow(
      "Enter a value from 1 to 365 days.",
    );
    expect(() => tokenExpiresIn("custom", "8761", "h", 365)).toThrow();
  });

  it("rejects invalid custom durations", () => {
    for (const amount of [
      "",
      "0",
      "-1",
      "1.5",
      "1096",
      "999999999999999999999",
    ]) {
      expect(() => tokenExpiresIn("custom", amount, "d")).toThrow();
    }
  });
});
