/**
 * Registers the agent's GitHub App from `github-app.json` (GitHub's manifest flow), stores its credentials as secrets
 * of the `build-agents` GitHub environment, points `wrangler.jsonc`'s git author at the app's bot user, and opens the
 * page to install it on the repository.
 *
 *   node --experimental-strip-types scripts/create-github-app.ts <org> [--webhook-url <url>] [--name <name>]
 *
 * Needs `gh` logged in as an org owner. A second app for local testing: `--name notefig-build-agent-dev
 * --webhook-url https://<tunnel>/v1/github`, then set its secrets on a different environment with `--env`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const org = args[0];
const option = (name: string) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
};
if (!org || org.startsWith("--")) {
	console.error("Usage: create-github-app.ts <org> [--webhook-url <url>] [--name <name>] [--env <environment>]");
	process.exit(1);
}
const environment = option("env") ?? "build-agents";
const repo = JSON.parse(execFileSync("gh", ["repo", "view", "--json", "nameWithOwner"], { encoding: "utf8" })).nameWithOwner;

const manifest = JSON.parse(readFileSync(`${root}/github-app.json`, "utf8"));
if (option("name")) manifest.name = option("name");
if (option("webhook-url")) manifest.hook_attributes.url = option("webhook-url");

const PORT = 53_682;
manifest.redirect_url = `http://127.0.0.1:${PORT}/callback`;
const state = crypto.randomUUID();

const code = await new Promise<string>((resolve, reject) => {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
		if (url.pathname === "/") {
			// GitHub takes the manifest as a form POST; this page submits it.
			response.setHeader("Content-Type", "text/html");
			response.end(`<form id="f" method="post" action="https://github.com/organizations/${org}/settings/apps/new?state=${state}">
				<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
			</form><script>document.getElementById("f").submit()</script>`);
			return;
		}
		if (url.pathname === "/callback") {
			response.end("The app is registered. You can close this tab.");
			server.close();
			if (url.searchParams.get("state") !== state) reject(new Error("State mismatch"));
			else resolve(url.searchParams.get("code") ?? "");
		}
	});
	server.listen(PORT, "127.0.0.1", () => {
		const page = `http://127.0.0.1:${PORT}/`;
		console.log(`Opening ${page} to register "${manifest.name}" on ${org}…`);
		execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [page]);
	});
});

const conversion = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
	method: "POST",
	headers: { Accept: "application/vnd.github+json" },
});
if (!conversion.ok) throw new Error(`Manifest conversion failed (${conversion.status}): ${await conversion.text()}`);
const app = (await conversion.json()) as { id: number; slug: string; pem: string; webhook_secret: string; html_url: string };

const setSecret = (name: string, value: string) =>
	execFileSync("gh", ["secret", "set", name, "--env", environment, "--repo", repo], { input: value });
setSecret("GH_APP_ID", String(app.id));
setSecret("GH_APP_PRIVATE_KEY", app.pem);
setSecret("GH_APP_WEBHOOK_SECRET", app.webhook_secret);
console.log(`Stored GH_APP_ID, GH_APP_PRIVATE_KEY and GH_APP_WEBHOOK_SECRET on the "${environment}" environment.`);

// Commits by the bot user show the app's avatar; its email needs the bot user's id.
const bot = (await (await fetch(`https://api.github.com/users/${app.slug}%5Bbot%5D`)).json()) as { id: number };
const wrangler = `${root}/wrangler.jsonc`;
writeFileSync(
	wrangler,
	readFileSync(wrangler, "utf8")
		.replace(/("GIT_AUTHOR_NAME": )"[^"]*"/, `$1"${app.slug}[bot]"`)
		.replace(/("GIT_AUTHOR_EMAIL": )"[^"]*"/, `$1"${bot.id}+${app.slug}[bot]@users.noreply.github.com"`),
);
console.log(`Set the git author in wrangler.jsonc to ${app.slug}[bot]; commit that change.`);

const install = `${app.html_url}/installations/new`;
console.log(`Install the app on ${repo} only: ${install}`);
execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [install]);
