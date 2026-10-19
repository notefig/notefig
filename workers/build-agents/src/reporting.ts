import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import type { Activity } from "./linear.ts";

/**
 * What the agent shows on its Linear session, from Pi's hooks: each tool call as an action, its reasoning text as a
 * thought, and its final answer as the response. Hooks run inside Pi's durable tasks, so a run resumed after an
 * eviction keeps reporting; a step interrupted mid-post may post twice, which is harmless.
 */
export function reporting(post: (activity: Activity) => Promise<void>) {
	const safely = (activity: Activity) =>
		post(activity).catch((error: unknown) => {
			console.error("reporting: activity not posted", error);
		});

	return defineExtension({
		name: "notefig.reporting",
		hooks: [
			hook(GenerationTask, {
				afterResponse: async (message) => {
					if (message.stopReason !== "toolUse") return;
					const thought = textOf(message.content);
					if (thought) await safely({ type: "thought", body: thought });
				},
				onYield: async (answer) => {
					await safely({ type: "response", body: textOf(answer.content) || "Done." });
					return undefined;
				},
			}),
			hook(ToolTask, {
				afterTool: async (call, result) => {
					// The question is the session's last word: an action after it would take the session out of
					// "awaiting input", since Linear derives the state from the latest activity.
					if (call.name === "ask_maintainer") return undefined;
					await safely({
						type: "action",
						action: call.name,
						parameter: describe(call.arguments),
						...(result.isError ? { result: "failed" } : {}),
					});
					return undefined;
				},
			}),
		],
	});
}

type Content = readonly { type: string; text?: string }[];

function textOf(content: Content): string {
	return content
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** A tool call's arguments in one line: the command, the path, or the first string argument. */
function describe(args: Record<string, unknown>): string {
	const value = args.command ?? args.path ?? args.file_path ?? Object.values(args).find((arg) => typeof arg === "string");
	const line = typeof value === "string" ? value.split("\n")[0] : "";
	return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
