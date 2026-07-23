import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../clipboard";

describe("copyTextToClipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes through navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyTextToClipboard("my draft prompt");
    expect(writeText).toHaveBeenCalledWith("my draft prompt");
    vi.unstubAllGlobals();
  });

  it("falls back to execCommand when the clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    await copyTextToClipboard("fallback text");
    expect(execCommand).toHaveBeenCalledWith("copy");
    // The staging textarea must not be left in the document.
    expect(document.querySelector("textarea")).toBeNull();
    vi.unstubAllGlobals();
  });
});
