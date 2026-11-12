import { describe, expect, it } from "vitest";
import { userIdOf } from "./store.pg.js";

describe("userIdOf (the created_by of a grader version)", () => {
  it("returns the lower-case uuid of a dfl:<uuid> principal", () => {
    expect(userIdOf("dfl:0A1B2C3D-0000-4000-8000-123456789ABC")).toBe("0a1b2c3d-0000-4000-8000-123456789abc");
  });
  it("returns null for any other principal shape", () => {
    for (const p of ["", "dfl:", "dfl:not-a-uuid", "0xabc", "runner", "dfl:0a1b2c3d-0000-4000-8000-123456789abc-x", " dfl:0a1b2c3d-0000-4000-8000-123456789abc"]) {
      expect(userIdOf(p)).toBeNull();
    }
  });
});
