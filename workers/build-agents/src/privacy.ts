/**
 * What must not leave Linear. The support Worker's private note holds a user's debug report (their workspace path,
 * open files, URLs) and screenshots. The agent may read it, but nothing it pushes or posts to GitHub may quote it.
 * The deny-list is every URL in the note (screenshots included) and every identifying token of its debug report: paths,
 * file names and long values. Version numbers are public already: the issue's description carries the app's version.
 */

const FENCED = /```[a-z]*\n([\s\S]*?)```/g;
const TOKEN = /[^\s"'`,;()[\]{}<>]+/g;
const URL_IN_TEXT = /https?:\/\/[^\s)"'<>\]]+/g;
const VERSION = /^v?\d+(\.\d+)+$/;

/** Tokens from the note's debug report that would identify the user if they reached GitHub. */
export function privateTokens(note: string | undefined): string[] {
	if (!note) return [];
	const tokens = new Set<string>();
	for (const [url] of note.matchAll(URL_IN_TEXT)) tokens.add(url);
	const report = [...note.matchAll(FENCED)].map((match) => match[1]).join("\n");
	for (const [token] of report.matchAll(TOKEN)) {
		const value = token.replace(/[.:]+$/, "");
		if (VERSION.test(value)) continue;
		const identifying = /[/\\]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value) || /^https?:/.test(value) || value.length >= 24;
		if (identifying && value.length >= 3) tokens.add(value);
	}
	return [...tokens];
}

/** The deny-listed tokens `text` contains. */
export function leaks(text: string, tokens: readonly string[]): string[] {
	return tokens.filter((token) => text.includes(token));
}
