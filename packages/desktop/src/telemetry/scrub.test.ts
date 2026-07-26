import { describe, expect, it } from "vitest";
import { scrubEvent, scrubExceptionMessage, scrubString } from "./scrub";

describe("scrubString — paths and usernames", () => {
  it("replaces macOS home directories with ~", () => {
    const out = scrubString(
      "Error: ENOENT at /Users/parsa/Documents/notes/todo.md",
    );
    expect(out).not.toContain("parsa");
    expect(out).not.toContain("todo.md");
  });

  it("replaces linux home directories", () => {
    expect(scrubString("failed on /home/alice/projects/x")).not.toContain(
      "alice",
    );
  });

  it("replaces windows home directories", () => {
    const out = scrubString("at C:\\Users\\bob\\AppData\\Roaming\\app");
    expect(out).not.toContain("bob");
  });

  it("handles usernames with dots, dashes, and unicode", () => {
    for (const name of ["john.doe", "mary-jane", "übel", "田中"]) {
      expect(scrubString(`/Users/${name}/ws/doc`)).not.toContain(name);
    }
  });

  it("replaces URL-encoded workspace paths from route URLs", () => {
    const out = scrubString(
      "http://localhost/%2FUsers%2Fparsa%2FDocuments%2Fmetrists/edit",
    );
    expect(out).not.toContain("parsa");
  });

  it("replaces file:// URLs", () => {
    expect(scrubString("file:///Users/parsa/ws/notes.md")).not.toContain(
      "parsa",
    );
  });

  it("replaces non-home absolute paths with <path>", () => {
    const out = scrubString("watch failed for /Volumes/External/work/notes");
    expect(out).not.toContain("External");
    expect(out).toContain("<path>");
  });

  it("replaces tilde-relative paths", () => {
    const out = scrubString("could not open ~/Documents/journal/2026");
    expect(out).not.toContain("journal");
  });

  it("replaces windows UNC share paths", () => {
    const out = scrubString("open failed: \\\\fileserver\\parsa\\notes");
    expect(out).not.toContain("fileserver");
    expect(out).not.toContain("parsa");
  });

  it("replaces bare home-dir with no trailing segments", () => {
    expect(scrubString("chdir /home/alice failed")).not.toContain("alice");
  });
});

describe("scrubString — file names, emails, size", () => {
  it("replaces standalone user file names by extension", () => {
    const out = scrubString("Failed to parse Meeting Notes.md near line 4");
    expect(out).not.toContain("Meeting Notes");
    expect(out).toContain("<file>");
  });

  it("covers document, image, and archive extensions", () => {
    for (const file of [
      "diary.txt",
      "finances 2026.xlsx",
      "scan_0042.png",
      "backup.tar",
      "résumé.pdf",
    ]) {
      expect(scrubString(`error with ${file}`)).not.toContain(file);
    }
  });

  it("keeps app bundle/code frames debuggable", () => {
    const out = scrubString("at renderRow (index-tfVUcEtu.js:1:5100)");
    expect(out).toContain("index-tfVUcEtu.js");
  });

  it("replaces email addresses", () => {
    const out = scrubString("git author dimenturs@gmail.com rejected");
    expect(out).not.toContain("dimenturs");
    expect(out).toContain("<email>");
  });

  it("truncates oversized strings", () => {
    const out = scrubString("x".repeat(10_000));
    expect(out.length).toBeLessThan(2_100);
    expect(out).toContain("<truncated>");
  });

  it("leaves ordinary error text untouched", () => {
    expect(scrubString("Cannot read properties of undefined")).toBe(
      "Cannot read properties of undefined",
    );
  });
});

describe("scrubExceptionMessage — quoted content", () => {
  it("redacts single-, double-, back-, and smart-quoted substrings", () => {
    const out = scrubExceptionMessage(
      "Failed to save 'My Secret Plan' and \"draft two\" and `raw text` and “memoir”",
    );
    expect(out).not.toContain("Secret");
    expect(out).not.toContain("draft");
    expect(out).not.toContain("raw text");
    expect(out).not.toContain("memoir");
    expect(out).toContain("<redacted>");
  });

  it("still scrubs paths inside the message", () => {
    const out = scrubExceptionMessage("ENOENT /Users/parsa/ws/a/b");
    expect(out).not.toContain("parsa");
  });
});

describe("scrubEvent", () => {
  it("strips URL, referrer, and user-agent properties outright", () => {
    const event = {
      properties: {
        $current_url: "http://localhost/%2FUsers%2Fparsa%2Fws",
        $pathname: "/%2FUsers%2Fparsa%2Fws",
        $referrer: "http://x",
        $raw_user_agent: "Mozilla/5.0 ...",
        harness: "claude-code",
      } as Record<string, unknown>,
    };
    const out = scrubEvent(event);
    expect(out.properties).not.toHaveProperty("$current_url");
    expect(out.properties).not.toHaveProperty("$pathname");
    expect(out.properties).not.toHaveProperty("$referrer");
    expect(out.properties).not.toHaveProperty("$raw_user_agent");
    expect(out.properties?.harness).toBe("claude-code");
  });

  it("scrubs nested exception stack frames", () => {
    const event = {
      properties: {
        $exception_list: [
          {
            stacktrace: {
              frames: [
                { filename: "/Users/parsa/app/dist/index.js", lineno: 1 },
              ],
            },
          },
        ],
      } as Record<string, unknown>,
    };
    expect(JSON.stringify(scrubEvent(event))).not.toContain("parsa");
  });

  it("redacts quoted user content in exception messages", () => {
    const event = {
      properties: {
        $exception_list: [
          { type: "Error", value: "Could not render 'Chapter 1 — draft'" },
        ],
        $exception_message: 'Could not render "Chapter 1 — draft"',
      } as Record<string, unknown>,
    };
    const json = JSON.stringify(scrubEvent(event));
    expect(json).not.toContain("Chapter 1");
    expect(json).toContain("<redacted>");
  });

  it("scrubs deeply nested arrays and objects in properties", () => {
    const event = {
      properties: {
        breadcrumbs: [
          { note: "opened /Users/parsa/ws" },
          { emails: ["a@b.com"] },
        ],
      } as Record<string, unknown>,
    };
    const json = JSON.stringify(scrubEvent(event));
    expect(json).not.toContain("parsa");
    expect(json).not.toContain("a@b.com");
  });

  it("passes null through (posthog before_send can drop events)", () => {
    expect(scrubEvent(null)).toBeNull();
  });
});
