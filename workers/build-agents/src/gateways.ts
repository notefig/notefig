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

		let body: BodyInit | null = request.body;
		if (advertisesPush || pushes) {
			if (!this.ctx.props.push) return refuse("Push with the push tool; it checks the commits first.");
			if (pushes) {
				const bytes = new Uint8Array(await request.arrayBuffer());
				const updates = readRefUpdates(bytes.subarray(0, MAX_PUSH_HEADER));
				if (!updates || !onlyUpdates(updates, this.ctx.props.branch)) {
					return refuse(`Only refs/heads/${this.ctx.props.branch} can be pushed, and not deleted.`);
				}
				body = bytes;
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

function refuse(message: string): Response {
	// git shows the body of a 403 to the user, here the agent.
	return new Response(`${message}\n`, { status: 403, headers: { "Content-Type": "text/plain" } });
}
