import { WorkerEntrypoint } from "cloudflare:workers";
import { type Env, readConfig } from "./config.ts";
import { gitHubClient } from "./github.ts";
import { onlyUpdates, readRefUpdates } from "./receive-pack.ts";

/**
 * The container's way out. It starts without internet access, so it reaches only the hosts its Durable Object
 * intercepts, and each intercepted request passes through one of these entrypoints first.
 */

export interface GitGatewayProps {
	/** The only branch a push may update. */
	branch: string;
	/** Set only while the agent's `push` tool runs; a push at any other time is refused. */
	push: boolean;
}

/** The pkt-line header of a push fits in this many bytes; a longer one is refused rather than buffered. */
const MAX_PUSH_HEADER = 64 * 1024;

/**
 * `github.com` for git over HTTPS, for the one repository: fetches always, pushes to the issue's branch while a push is
 * permitted. The installation token is added here, so the container never holds one.
 */
export class GitGateway extends WorkerEntrypoint<Env, GitGatewayProps> {
	override async fetch(request: Request): Promise<Response> {
		const { repo } = readConfig(this.env);
		const url = new URL(request.url);
		const base = `/${repo.owner}/${repo.name}`;
		const path = url.pathname.replace(/\.git(?=\/)/, "");
		const service = url.searchParams.get("service");
		const fetches =
			(request.method === "GET" && path === `${base}/info/refs` && service === "git-upload-pack") ||
			(request.method === "POST" && path === `${base}/git-upload-pack`);
		const advertisesPush = request.method === "GET" && path === `${base}/info/refs` && service === "git-receive-pack";
		const pushes = request.method === "POST" && path === `${base}/git-receive-pack`;
		if (url.hostname !== "github.com" || !(fetches || advertisesPush || pushes)) {
			return refuse(`Only ${repo.owner}/${repo.name} over git is reachable from here.`);
		}

		let body: ReadableStream<Uint8Array> | null = request.body;
		if (advertisesPush || pushes) {
			if (!this.ctx.props.push) return refuse("Push with the push tool; it checks the commits first.");
			if (pushes && request.body) {
				// Only the ref-update header is buffered; the pack streams on to GitHub behind it.
				const { header, rest } = await readHeader(request.body);
				const updates = readRefUpdates(header);
				if (!updates || !onlyUpdates(updates, this.ctx.props.branch)) {
					await rest.cancel();
					return refuse(`Only refs/heads/${this.ctx.props.branch} can be pushed, and not deleted.`);
				}
				body = prepend(header, rest);
			}
		}

		const token = await gitHubClient({ appId: this.env.GH_APP_ID, privateKey: this.env.GH_APP_PRIVATE_KEY }, repo).token();
		const headers = new Headers(request.headers);
		headers.set("Authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
		return fetch(url, { method: request.method, headers, body });
	}
}

/** Package registries the setup and tests need, passed through unchanged. */
export class RegistryGateway extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		return fetch(request);
	}
}

/** Hosts `RegistryGateway` serves. */
export const REGISTRY_HOSTS = ["registry.npmjs.org", "index.crates.io", "static.crates.io"];

/**
 * Reads a push body up to the end of its pkt-line header (the flush packet) or `MAX_PUSH_HEADER` bytes, whichever
 * comes first, and hands back what was read and the reader positioned after it.
 */
async function readHeader(stream: ReadableStream<Uint8Array>): Promise<{ header: Uint8Array; rest: ReadableStream<Uint8Array> }> {
	const reader = stream.getReader();
	let header = new Uint8Array();
	while (header.length < MAX_PUSH_HEADER && readRefUpdates(header) === null) {
		const { done, value } = await reader.read();
		if (done) break;
		const joined = new Uint8Array(header.length + value.length);
		joined.set(header);
		joined.set(value, header.length);
		header = joined;
	}
	const rest = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel: (reason) => reader.cancel(reason),
	});
	return { header, rest };
}

/** `head`, then everything `rest` yields. */
function prepend(head: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = rest.getReader();
	let sent = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sent) {
				sent = true;
				controller.enqueue(head);
				return;
			}
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel: (reason) => reader.cancel(reason),
	});
}

function refuse(message: string): Response {
	// git shows the body of a 403 to the user, here the agent.
	return new Response(`${message}\n`, { status: 403, headers: { "Content-Type": "text/plain" } });
}
