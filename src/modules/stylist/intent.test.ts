import { describe, expect, it } from "vitest";
import { occasionFromText } from "./intent";

describe("occasionFromText", () => {
  it("reads the occasion from plain words", () => {
    expect(occasionFromText("casual")).toBe("casual");
    expect(occasionFromText("Client meeting tomorrow, want to look sharp")).toBe("office");
    expect(occasionFromText("my cousin's sangeet")).toBe("wedding");
    expect(occasionFromText("Diwali puja at home")).toBe("festive");
    expect(occasionFromText("job interview at 10")).toBe("interview");
    expect(occasionFromText("dinner date")).toBe("date");
    expect(occasionFromText("flight to Goa")).toBe("travel");
  });
  it("returns null when no occasion is named", () => {
    expect(occasionFromText("something nice please")).toBeNull();
    expect(occasionFromText("")).toBeNull();
  });
  it("doesn't match inside other words", () => {
    expect(occasionFromText("update my look")).toBeNull(); // "date" inside "update"
  });
});
