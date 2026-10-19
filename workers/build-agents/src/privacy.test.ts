import { describe, expect, it } from "vitest";
import { PRIVATE_NOTE_MARKER } from "./linear.ts";
import { leaks, privateTokens } from "./privacy.ts";

// The support Worker's format: screenshots as unfenced image links, then the fenced debug report.
const note = [
	PRIVATE_NOTE_MARKER,
	"",
	"### Screenshots",
	"",
	"**Screenshot 1**",
	"",
	"![Screenshot 1](https://uploads.linear.app/abc/def/screenshot-1.png)",
	"",
	"### Debug report",
	"",
	"```text",
	"workspace: /Users/someone/Documents/taxes-2026",
	"open: budget.md, notes/plan.md, a.md",
	"version: 0.0.147",
	"url: https://app.notefig.com/w/abc?tabs=budget.md",
	"layout: split",
	"```",
].join("\n");

describe("privateTokens", () => {
	it("takes paths, file names and URLs from the debug report", () => {
		const tokens = privateTokens(note);
		expect(tokens).toContain("/Users/someone/Documents/taxes-2026");
		expect(tokens).toContain("budget.md");
		expect(tokens).toContain("notes/plan.md");
		expect(tokens).toContain("https://app.notefig.com/w/abc?tabs=budget.md");
		expect(tokens).toContain("a.md");
		expect(tokens).not.toContain("split");
		expect(tokens).not.toContain("0.0.147");
	});

	it("takes the screenshot URLs, which are outside the fence", () => {
		expect(privateTokens(note)).toContain("https://uploads.linear.app/abc/def/screenshot-1.png");
	});

	it("finds nothing without a note", () => {
		expect(privateTokens(undefined)).toEqual([]);
	});
});

describe("leaks", () => {
	it("names the private tokens a text quotes", () => {
		const tokens = privateTokens(note);
		expect(leaks("Fixed opening budget.md from a split layout", tokens)).toEqual(["budget.md"]);
		expect(leaks("Fixed opening a file from a split layout", tokens)).toEqual([]);
	});
});
