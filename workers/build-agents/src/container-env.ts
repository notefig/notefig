import { Files, SandboxFileError } from "@cloudflare/sandbox";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileKind,
	type FileWatcher,
	type WatchChange,
	type WatchTarget,
	LineScanner,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";

/**
 * Pi's execution environment over a Durable Object's own container (`ctx.container`): files through the Sandbox SDK's
 * `Files` (`sandbox-shim` in the image), commands through the container's process API. Reads load the whole file,
 * which suits source files; streaming readers and watching come with the full adapter.
 */
export class ContainerEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly #container: Container;
	readonly #files: Files;
	readonly #running = new Set<ExecProcess>();

	constructor(container: Container, options: { id: string; cwd: string }) {
		this.#container = container;
		this.#files = new Files(container);
		this.id = options.id;
		this.cwd = options.cwd;
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(resolve(this.cwd, path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(normalize(parts.join("/")));
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const absolute = resolve(this.cwd, path);
		return this.#file(absolute, async () => {
			const response = await this.#files.readFile(absolute, { signal: context.abortSignal });
			return new Uint8Array(await response.arrayBuffer());
		});
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split("\n");
		const last = lines.length - 1;
		let index = 0;
		return ok({
			readLine: async () => {
				if (index > last || (index === last && lines[last] === "")) return ok(undefined);
				const line = { text: lines[index], terminated: index < last };
				index++;
				return ok(line);
			},
			close: async () => {},
		});
	}

	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split("\n");
		if (lines.at(-1) === "") lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const info = await this.#stat(path, options?.noFollow === true, context);
		if (!info.ok) return info;
		if (info.value.kind === "symlink") return err(new FileError("invalid", "Is a symbolic link", info.value.path));
		if (info.value.kind === "directory") return err(new FileError("is_directory", "Is a directory", info.value.path));
		const bytes = await this.readBinaryFile(path, context);
		if (!bytes.ok) return bytes;
		// The file as it was opened: later renames or writes don't change what this reader sees.
		const data = bytes.value;
		const where = info.value.path;
		let closed = false;
		const usable = (context: Context): { ok: false; error: FileError } | undefined => {
			if (context.abortSignal?.aborted) return { ok: false, error: new FileError("aborted", "Aborted", where) };
			if (closed) return { ok: false, error: new FileError("invalid", "Reader is closed", where) };
			return undefined;
		};
		return ok({
			info: async (context) => usable(context) ?? ok({ ...info.value, size: data.length }),
			read: async (offset, length, context) => {
				const refused = usable(context);
				if (refused) return refused;
				if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
					return err(new FileError("invalid", "Invalid byte range", where));
				}
				return ok(data.slice(offset, offset + length));
			},
			scanLines: async ({ startLine, endLine }, context) => {
				const refused = usable(context);
				if (refused) return refused;
				let scanner: LineScanner;
				try {
					scanner = new LineScanner(startLine, endLine);
				} catch {
					return err(new FileError("invalid", "Invalid line range", where));
				}
				scanner.push(data);
				return ok(scanner.finish());
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const absolute = resolve(this.cwd, path);
		const parent = absolute.slice(0, absolute.lastIndexOf("/")) || "/";
		return this.#file(absolute, async () => {
			await this.#files.mkdir(parent, { recursive: true, signal: context.abortSignal });
			await this.#files.writeFile(absolute, content, { signal: context.abortSignal });
		});
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const existing = await this.readBinaryFile(path, context);
		if (!existing.ok && existing.error.code !== "not_found") return existing;
		const added = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const before = existing.ok ? existing.value : new Uint8Array();
		const joined = new Uint8Array(before.length + added.length);
		joined.set(before);
		joined.set(added, before.length);
		return this.writeFile(path, joined, context);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#run(["truncate", "-s", String(size), resolve(this.cwd, path)], context);
	}

	async flushFile(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = resolve(this.cwd, sourcePath);
		return this.#file(source, () => this.#files.rename(source, resolve(this.cwd, destinationPath), { signal: context.abortSignal }));
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.#stat(path, false, context);
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const absolute = resolve(this.cwd, path);
		const entries = await this.#file(absolute, () => this.#files.readDirectory(absolute, { signal: context.abortSignal }));
		if (!entries.ok) return entries;
		const infos: FileInfo[] = [];
		for (const entry of entries.value) {
			const info = await this.#stat(`${absolute}/${entry.name}`, true, context);
			if (info.ok) infos.push(info.value);
		}
		return ok(infos);
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const absolute = resolve(this.cwd, path);
		const info = await this.#stat(absolute, false, context);
		if (!info.ok) return info;
		if (info.value.kind !== "directory") return err(new FileError("not_directory", "Not a directory", absolute));
		const names = await this.#file(absolute, () => this.#files.readDirectory(absolute, { signal: context.abortSignal }));
		if (!names.ok) return names;
		const remaining = names.value.map((entry) => entry.name);
		let closed = false;
		return ok({
			next: async (maxEntries, context) => {
				if (context.abortSignal?.aborted) return err(new FileError("aborted", "Aborted", absolute));
				if (closed) return err(new FileError("invalid", "Reader is closed", absolute));
				if (!Number.isInteger(maxEntries) || maxEntries < 1) return err(new FileError("invalid", "maxEntries must be at least 1", absolute));
				const entries: FileInfo[] = [];
				while (entries.length < maxEntries && remaining.length > 0) {
					const name = remaining.shift() as string;
					// Stat'ed now, not at open: an entry removed since then is skipped.
					const entry = await this.#stat(`${absolute}/${name}`, true, context);
					if (entry.ok) entries.push(entry.value);
					else if (entry.error.code !== "not_found") return entry;
				}
				return ok({ entries, done: remaining.length === 0 });
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		const script = targets.map((target) => findCommand({ ...target, path: resolve(this.cwd, target.path) })).join("; ");
		const snapshot = async (): Promise<Map<string, string> | undefined> => {
			let output = "";
			const result = await this.exec(["sh", "-c", script], { onOutput: (text, _context, { stream }) => stream === "stdout" && (output += text) }, context);
			if (!result.ok) return undefined;
			const entries = new Map<string, string>();
			for (const line of output.split("\n")) {
				const tab = line.indexOf("\t");
				if (tab > 0) entries.set(line.slice(0, tab), line.slice(tab + 1));
			}
			return entries;
		};
		let previous = await snapshot();
		if (!previous) return err(new FileError("unknown", "Could not list the watched paths"));
		let closed = false;
		const poll = async () => {
			while (!closed && !context.abortSignal?.aborted) {
				await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
				if (closed) return;
				const current = await snapshot();
				if (!current || closed) continue;
				const changed = new Set<string>();
				for (const [path, signature] of current) if (previous?.get(path) !== signature) changed.add(path);
				for (const path of previous?.keys() ?? []) if (!current.has(path)) changed.add(path);
				previous = current;
				if (changed.size > 0) onChange({ paths: [...changed].sort() });
			}
		};
		void poll();
		return ok({
			mode: "polling",
			close: async () => {
				closed = true;
			},
		});
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const absolute = resolve(this.cwd, path);
		const output = await this.#output(["realpath", "-m", absolute], context);
		return output.ok ? ok(output.value.trim()) : output;
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.#stat(path, false, context);
		if (info.ok) return ok(true);
		return info.error.code === "not_found" ? ok(false) : info;
	}

	async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const absolute = resolve(this.cwd, path);
		return this.#file(absolute, () =>
			this.#files.mkdir(absolute, { recursive: options?.recursive === true, signal: context.abortSignal }),
		);
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const absolute = resolve(this.cwd, path);
		return this.#file(absolute, () =>
			this.#files.remove(absolute, {
				recursive: options?.recursive === true,
				force: options?.force === true,
				signal: context.abortSignal,
			}),
		);
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const output = await this.#output(["mktemp", "-d", `/tmp/${prefix ?? "pi-"}XXXXXX`], context);
		return output.ok ? ok(output.value.trim()) : output;
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const suffix = options?.suffix ? [`--suffix=${options.suffix}`] : [];
		const output = await this.#output(["mktemp", ...suffix, `/tmp/${options?.prefix ?? "pi-"}XXXXXX`], context);
		return output.ok ? ok(output.value.trim()) : output;
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		if (typeof command !== "string" && command.length === 0) return err(new ExecutionError("spawn_error", "No program to run"));
		// An argv command runs through a check for the program, so a missing one is a spawn error, not exit 127.
		const argv =
			typeof command === "string"
				? ["bash", "-lc", command]
				: ["sh", "-c", `command -v "$1" >/dev/null 2>&1 || exit ${MISSING_PROGRAM}; exec "$@"`, "sh", ...command];
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		let timedOut = false;
		const timer =
			options?.timeout === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						abort.abort();
					}, options.timeout * 1000);
		let process: ExecProcess;
		try {
			process = await this.#container.exec(argv, {
				cwd: options?.cwd === undefined ? this.cwd : resolve(this.cwd, options.cwd),
				...(options?.env ? { env: options.env } : {}),
				signal: abort.signal,
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			clearTimeout(timer);
			context.abortSignal?.removeEventListener("abort", onAbort);
			return err(new ExecutionError("spawn_error", `Could not start ${argv[0]}`, toError(error)));
		}
		this.#running.add(process);
		abort.signal.addEventListener("abort", () => process.kill(9), { once: true });
		let callbackError: unknown;
		const pump = async (stream: ReadableStream | null, name: "stdout" | "stderr") => {
			if (!stream) return;
			const decoder = new TextDecoder();
			for await (const chunk of stream as ReadableStream<Uint8Array>) {
				const text = decoder.decode(chunk, { stream: true });
				if (!text || !options?.onOutput) continue;
				try {
					options.onOutput(text, context, { stream: name });
				} catch (error) {
					callbackError ??= error;
				}
			}
		};
		try {
			const [exitCode] = await Promise.all([process.exitCode, pump(process.stdout, "stdout"), pump(process.stderr, "stderr")]);
			if (callbackError !== undefined) return err(new ExecutionError("callback_error", "Output callback failed", toError(callbackError)));
			if (timedOut) return err(new ExecutionError("timeout", `Timed out after ${options?.timeout} seconds`));
			if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Aborted"));
			if (typeof command !== "string" && exitCode === MISSING_PROGRAM) {
				return err(new ExecutionError("spawn_error", `${command[0]} was not found`));
			}
			return ok({ exitCode });
		} catch (error) {
			if (timedOut) return err(new ExecutionError("timeout", `Timed out after ${options?.timeout} seconds`));
			if (abort.signal.aborted) return err(new ExecutionError("aborted", "Aborted"));
			return err(new ExecutionError("unknown", "Command failed", toError(error)));
		} finally {
			clearTimeout(timer);
			context.abortSignal?.removeEventListener("abort", onAbort);
			this.#running.delete(process);
		}
	}

	async cleanup(): Promise<void> {
		for (const process of this.#running) process.kill(9);
		this.#running.clear();
	}

	async #stat(path: string, noFollow: boolean, context: Context): Promise<Result<FileInfo, FileError>> {
		const absolute = resolve(this.cwd, path);
		const stat = await this.#file(absolute, () =>
			noFollow ? this.#files.lstat(absolute, { signal: context.abortSignal }) : this.#files.stat(absolute, { signal: context.abortSignal }),
		);
		if (!stat.ok) return stat;
		const kind: FileKind = stat.value.type === "directory" ? "directory" : stat.value.type === "symlink" ? "symlink" : "file";
		return ok({
			name: absolute.split("/").pop() || "/",
			path: absolute,
			kind,
			size: Number(stat.value.size),
			mtimeMs: stat.value.modifiedAt.getTime(),
		});
	}

	/** A command's stdout, as a file result: a nonzero exit is the stderr message. */
	async #output(argv: string[], context: Context): Promise<Result<string, FileError>> {
		let stdout = "";
		let stderr = "";
		const result = await this.exec(argv, { onOutput: (text, _context, { stream }) => (stream === "stdout" ? (stdout += text) : (stderr += text)) }, context);
		if (!result.ok) return err(new FileError(result.error.code === "aborted" ? "aborted" : "unknown", result.error.message));
		if (result.value.exitCode !== 0) return err(new FileError("unknown", stderr.trim() || `${argv[0]} exited ${result.value.exitCode}`));
		return ok(stdout);
	}

	async #run(argv: string[], context: Context): Promise<Result<void, FileError>> {
		const output = await this.#output(argv, context);
		return output.ok ? ok(undefined) : output;
	}

	async #file<T>(path: string, operation: () => Promise<T>): Promise<Result<T, FileError>> {
		try {
			return ok(await operation());
		} catch (error) {
			return err(toFileError(error, path));
		}
	}
}

/** The exit status the argv wrapper uses for a program that isn't there. */
const MISSING_PROGRAM = 211;
const WATCH_INTERVAL_MS = 250;

/**
 * A `find` listing of one watch target, one `path<TAB>type size mtime inode` line per entry: the target itself (its
 * symlink followed), and below it either everything (recursive) or its children, without excluded names.
 */
function findCommand(target: WatchTarget): string {
	const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
	const prune = [
		...(target.exclude?.hidden ? ["-name '.*'"] : []),
		...(target.exclude?.names ?? []).map((name) => `-name ${quote(name)}`),
	];
	const depth = target.recursive ? "" : "-maxdepth 1";
	// Excluded names are pruned below the target, never the target itself.
	const skip = prune.length > 0 ? `\\( ! -path ${quote(target.path)} \\( ${prune.join(" -o ")} \\) \\) -prune -o` : "";
	return `find -H ${quote(target.path)} ${depth} ${skip} -printf '%p\\t%y %s %T@ %i\\n' 2>/dev/null`;
}

const ERRNO: Record<string, FileErrorCode> = {
	ENOENT: "not_found",
	EACCES: "permission_denied",
	EPERM: "permission_denied",
	EISDIR: "is_directory",
	ENOTDIR: "not_directory",
	EINVAL: "invalid",
	ENOTEMPTY: "invalid",
	EEXIST: "invalid",
};

function toFileError(error: unknown, path: string): FileError {
	if (error instanceof DOMException && error.name === "AbortError") return new FileError("aborted", "Aborted", path);
	if (SandboxFileError.is(error)) return new FileError(ERRNO[error.code] ?? "unknown", error.detail || error.message, path, error);
	return new FileError("unknown", toError(error).message, path, toError(error));
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** POSIX `path.resolve` against `cwd`, without Node. */
export function resolve(cwd: string, path: string): string {
	return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
}

function normalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}
