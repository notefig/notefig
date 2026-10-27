import { describe, expect, it } from "vitest";
import { fitDictation } from "./target";

describe("fitDictation", () => {
  it("starts a sentence as spoken at the start of a block", () => {
    expect(fitDictation("", "", "Hello there.")).toBe("Hello there.");
  });

  it("adds a space after a previous sentence", () => {
    expect(fitDictation("Done.", "", "Next one.")).toBe(" Next one.");
  });

  it("lowercases the first word mid-sentence but keeps I", () => {
    expect(fitDictation("We should ", "", "Ship it.")).toBe("ship it.");
    expect(fitDictation("and then ", "", "I left.")).toBe("I left.");
  });

  it("drops the closing period and adds a space before a following word", () => {
    expect(fitDictation("We ", "will see", "Really")).toBe("really ");
    expect(fitDictation("We ", "will see", "Really.")).toBe("really ");
  });

  it("inserts nothing for silence", () => {
    expect(fitDictation("x", "y", "  ")).toBe("");
  });
});
