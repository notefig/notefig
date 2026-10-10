import { renderToStaticMarkup } from "react-dom/server";
import { HarnessLogo } from "../harness-logo";

const markup = (harnessId: string) =>
  renderToStaticMarkup(<HarnessLogo harnessId={harnessId} />);

describe("HarnessLogo", () => {
  it("draws each built-in harness its own mark", () => {
    const marks = ["claude-code", "opencode", "gemini-cli", "devin"].map(markup);
    expect(new Set(marks).size).toBe(marks.length);
    for (const mark of marks) expect(mark).not.toContain("lucide-bot");
  });

  it("falls back to a generic bot for any other harness", () => {
    expect(markup("custom:lab")).toContain("lucide-bot");
  });
});
