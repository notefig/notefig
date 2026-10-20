import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** The environment's operations; `id` and `cwd` are plain values, `cleanup` never starts anything. */
type Operation = Exclude<{ [K in keyof ExecutionEnv]-?: ExecutionEnv[K] extends (...args: never[]) => unknown ? K : never }[keyof ExecutionEnv], "cleanup" | "listFiles">;

/**
 * The workspace as Pi is handed it: nothing starts until a file or shell call needs it. Pi builds the environment
 * before every model request and every tool call, so handing it the real one would start the container for an answer
 * that never touches the code, or for a tool that doesn't use it (asking the maintainer, the pull request). Each
 * operation opens the workspace once and forwards to it; a workspace that won't start fails the operation that needed
 * it, with the reason.
 */
export class LazyEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly #open: () => Promise<ExecutionEnv>;
	#env: Promise<ExecutionEnv> | undefined;

	constructor(open: () => Promise<ExecutionEnv>, options: { id: string; cwd: string }) {
		this.#open = open;
		this.id = options.id;
		this.cwd = options.cwd;
	}

	#real(): Promise<ExecutionEnv> {
		this.#env ??= this.#open().catch((error: unknown) => {
			this.#env = undefined;
			throw new Error(`The workspace couldn't start: ${error instanceof Error ? error.message : String(error)}`);
		});
		return this.#env;
	}

	#forward<K extends Operation>(name: K): ExecutionEnv[K] {
		const call = async (...args: unknown[]) => {
			const env = await this.#real();
			return (env[name] as (...args: unknown[]) => unknown).apply(env, args);
		};
		return call as unknown as ExecutionEnv[K];
	}

	absolutePath = this.#forward("absolutePath");
	joinPath = this.#forward("joinPath");
	canonicalPath = this.#forward("canonicalPath");
	exists = this.#forward("exists");
	readTextFile = this.#forward("readTextFile");
	openTextLineReader = this.#forward("openTextLineReader");
	readTextLines = this.#forward("readTextLines");
	readBinaryFile = this.#forward("readBinaryFile");
	openBinaryReader = this.#forward("openBinaryReader");
	writeFile = this.#forward("writeFile");
	appendFile = this.#forward("appendFile");
	truncateFile = this.#forward("truncateFile");
	flushFile = this.#forward("flushFile");
	renameFile = this.#forward("renameFile");
	fileInfo = this.#forward("fileInfo");
	listDir = this.#forward("listDir");
	openDirReader = this.#forward("openDirReader");
	watch = this.#forward("watch");
	createDir = this.#forward("createDir");
	remove = this.#forward("remove");
	createTempDir = this.#forward("createTempDir");
	createTempFile = this.#forward("createTempFile");
	exec = this.#forward("exec");

	/** Cleans up only a workspace an operation started: cleaning up never starts one. */
	async cleanup(context: Context): Promise<void> {
		const env = await this.#env?.catch(() => undefined);
		await env?.cleanup(context);
	}
}
