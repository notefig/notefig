# Workers

Notefig's server side is two Cloudflare Workers. Each is its own package (not an npm workspace, and outside Fallow),
installed, tested and deployed on its own.

| Worker | Domain | What it does | Docs |
|---|---|---|---|
| `notefig-support` (`workers/support`) | support.notefig.com | Turns the desktop app's **Send feedback** dialog into Linear Triage issues | [support/README.md](support/README.md) |
| `notefig-build-agents` (`workers/build-agents`) | agents.notefig.com | Gives each accepted Linear issue an agent that implements it and opens a pull request | [build-agents/README.md](build-agents/README.md) |

## How they fit together

```text
 Notefig desktop app
   │  Send feedback (⌘⇧M): markdown, screenshots, optional debug report
   ▼
 support.notefig.com ──▶ Linear: a Triage issue in MET (Feedback label, Metrists Roadmap project)
                          + a private top-level comment with screenshots and the debug report
                            (Linear's GitHub sync doesn't copy top-level comments)
   │
   │  A maintainer reviews it, moves it out of Triage, labels it, and delegates it to Notefig Build Agent
   ▼
 agents.notefig.com ──▶ IssueAgent (Durable Object for that issue) ──▶ its container: clone, change, test, push
   ▲                         │
   │                         ├─▶ GitHub: the issue's branch and a pull request (as notefig-build-agent[bot])
   │                         └─▶ Linear: the agent session (thoughts, actions, questions, the result)
   │
   └── Linear (messages, stop) and GitHub (reviews, failed CI, merge/close) come back to the same agent
```

The support Worker also has a `/v1/linear` route from the first version of the agent stage (assigning an issue to
the Notefig Support user fired a claude.ai routine). Build agents replace it; the route, its KV namespace and
secrets, and the routine are removed once build agents run in production (see build-agents/README.md, "Cutover").

## Accounts

| Account | What lives there |
|---|---|
| **Cloudflare** (Workers **Paid** plan; containers and the Kimi model need it) | Both Workers, their custom domains, KV namespaces, the rate limiter, the build agents' Durable Objects and container image, the AI Gateway `notefig-build-agents`, Workers AI |
| **GitHub** `notefig/notefig` | The code, the deploy workflows, the `build-agents` environment (secrets and a variable), repo secrets, the `notefig-build-agent` GitHub App |
| **Linear** (workspace with team **MET**) | Triage and issues; the **Notefig Build Agent** app; the Notefig Support user (the old routine's assignee) |

## Every secret and where it lives

Values are never in the repository. GitHub is the source of truth; deploys copy secrets to the Workers.

### GitHub: repository secrets (Settings → Secrets and variables → Actions)

| Name | Used by | What it is |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy-support.yml`, `deploy-marketing.yml`, `release-desktop.yml` | Cloudflare token for those deploys (set March 2026). Not used by build agents: their environment has its own |
| `CLOUDFLARE_ACCOUNT_ID` | the deploys above, and `release-build-agents.yml` | The Cloudflare account id (not secret, kept with the token) |
| `LINEAR_SUPPORT_API_KEY` | `deploy-support.yml` → Worker secret `LINEAR_API_KEY` | Linear personal API key the support Worker files issues and private comments with. It's currently Parsa's, so feedback issues show Parsa as the creator; a key from the Notefig Support user would change that |

The desktop, CLI and marketing workflows have their own secrets (Apple, Tauri signing, PostHog, Vercel); they're not
part of the Workers.

### GitHub: environment `build-agents` (Settings → Environments → build-agents)

| Name | Kind | What it is | Created by |
|---|---|---|---|
| `GH_APP_ID` | secret | The GitHub App's id | `npm run create-github-app` |
| `GH_APP_PRIVATE_KEY` | secret | The app's private key (PEM, PKCS#1) | `npm run create-github-app` |
| `GH_APP_WEBHOOK_SECRET` | secret | Signs the app's webhooks | `npm run create-github-app` |
| `LINEAR_CLIENT_ID` | secret | The Linear app's OAuth client id | Linear app form |
| `LINEAR_CLIENT_SECRET` | secret | Its client secret (client credentials grant) | Linear app form |
| `LINEAR_WEBHOOK_SECRET` | secret | Signs the Linear app's webhooks | Linear app form |
| `AI_GATEWAY_TOKEN` | secret | Cloudflare **account** token: AI Gateway Run + Workers AI Read | Cloudflare dashboard |
| `CLOUDFLARE_API_TOKEN` | secret | Build agents' own deploy token (overrides the repo secret for this environment only) | Cloudflare dashboard |
| `BUILD_AGENTS_APPROVERS` | variable | Comma-separated emails whose delegations start an agent | `gh variable set` |

### Cloudflare: Worker secrets (set by deploys, never by hand)

| Worker | Secrets |
|---|---|
| `notefig-support` | `LINEAR_API_KEY` (from CI); `LINEAR_WEBHOOK_SECRET`, `CLAUDE_ROUTINE_TOKEN` (set by hand for the old agent route, removed at cutover) |
| `notefig-build-agents` | the seven secrets of the `build-agents` environment above, copied on every release |

### Cloudflare: API tokens

| Token | Kind | Permissions | Stored as |
|---|---|---|---|
| Original deploy token (March 2026) | account-owned (Manage Account → Account API Tokens) | Workers deploys for support, marketing | repo `CLOUDFLARE_API_TOKEN` |
| Build agents deploy token | user token, from the **Edit Cloudflare Workers** template | that template (Workers Scripts, KV, Routes, Containers…) + Account → **AI Gateway: Edit**; zone notefig.com | `build-agents` env `CLOUDFLARE_API_TOKEN` |
| AI Gateway token | account-owned | Account → **AI Gateway: Run**, **Workers AI: Read** (Edit was added too; Read is enough) | `build-agents` env `AI_GATEWAY_TOKEN` |

### Local only

`workers/build-agents/.dev.vars` (gitignored, mode 600) holds the same values for `wrangler dev`; see
build-agents/README.md, "Local development". `workers/support/.dev.vars` likewise for the support Worker.

## Deploying

| Worker | How | When |
|---|---|---|
| support | `.github/workflows/deploy-support.yml` | every push to `main` touching `workers/support/**`, or by hand |
| build agents | `.github/workflows/release-build-agents.yml` | only by hand, with a version; tags `build-agents-v{version}` |

Build agents never deploy on push: the agent can write to the repository, so a new version of it ships only when
someone releases it.

## CI

`ci-tests.yml` runs "Test Support Worker" (Node's test runner) and "Test Build Agents" (vitest in workerd) on every
PR and push to main/develop.
