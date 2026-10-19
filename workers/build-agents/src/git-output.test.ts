import { describe, expect, it } from "vitest";
import { changeType, pullRequestBody, pullRequestTitle } from "./git-output.ts";

const typeLabels = new Map([
	["bug", "fix"],
	["feature", "feat"],
]);

describe("changeType", () => {
	it("takes the type from the first label that has one, case-insensitively", () => {
		expect(changeType(["Feedback", "Bug"], typeLabels)).toBe("fix");
		expect(changeType(["feature"], typeLabels)).toBe("feat");
		expect(changeType(["Feedback"], typeLabels)).toBe("chore");
	});
});

describe("pullRequestTitle", () => {
	it("prefixes the type, replacing one the agent already wrote", () => {
		expect(pullRequestTitle("fix", "The sidebar keeps its scroll position")).toBe("fix: the sidebar keeps its scroll position");
		expect(pullRequestTitle("fix", "feat(sidebar): Keep scroll")).toBe("fix: keep scroll");
	});
});

describe("pullRequestBody", () => {
	const issue = { id: "1", identifier: "MET-42", title: "t", url: "u", branchName: "b", labels: [] };

	it("adds release notes and closes the issue", () => {
		expect(pullRequestBody(issue, "What changed.", ["Renaming keeps your place"])).toBe(
			"What changed.\n\n## Release notes\n\n- Renaming keeps your place\n\nCloses MET-42\n",
		);
	});

	it("says _none_ when users won't notice", () => {
		expect(pullRequestBody(issue, "Refactor.", [])).toContain("## Release notes\n\n_none_\n");
	});
});
