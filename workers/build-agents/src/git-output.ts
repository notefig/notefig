/**
 * What the agent's git output looks like, taken from the Linear issue: the branch is Linear's own `branchName` (so
 * Linear's GitHub integration links the PR and moves the issue), and the type prefix comes from the issue's label.
 */

export interface IssueSummary {
	id: string;
	identifier: string;
	title: string;
	url: string;
	branchName: string;
	labels: readonly string[];
}

/** `fix`, `feat`… from the first label with a type, or `chore` when none has one. */
export function changeType(labels: readonly string[], typeLabels: ReadonlyMap<string, string>): string {
	for (const label of labels) {
		const type = typeLabels.get(label.toLowerCase());
		if (type) return type;
	}
	return "chore";
}

/** `fix: <summary>`: the agent's own summary when it gives one, otherwise the issue title. */
export function pullRequestTitle(type: string, summary: string): string {
	const text = summary.trim().replace(/^(\w+)(\(.+?\))?:\s*/, "");
	return `${type}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** The PR body: the agent's description, the release notes CI requires, and the line that closes the issue. */
export function pullRequestBody(issue: IssueSummary, description: string, releaseNotes: readonly string[]): string {
	const notes = releaseNotes.length > 0 ? releaseNotes.map((note) => `- ${note}`).join("\n") : "_none_";
	return `${description.trim()}\n\n## Release notes\n\n${notes}\n\nCloses ${issue.identifier}\n`;
}
