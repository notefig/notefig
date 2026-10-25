# Build agents (agents.notefig.com)

Delegate an accepted Linear issue to the **Notefig Build Agent** app, and an agent implements it and opens a pull
request. You steer it from the Linear session; reviews, failed CI and merges on its pull request reach it too.

This is the complete reference: what runs where, every configuration value and secret, how to set it all up on new
accounts, how to run and test it locally, how it's released, and what went wrong while building it. For both
Workers together and the full secrets inventory, see [../README.md](../README.md).

Not an npm workspace: installed, tested and deployed on its own, like `workers/support`.

**Contents:**
[Overview](#overview) ·
[A run, step by step](#a-run-step-by-step) ·
[Security model](#security-model) ·
[Configuration](#configuration) ·
[Secrets](#secrets) ·
[Accounts and their settings](#accounts-and-their-settings) ·
[Setup, or moving to other accounts](#setup-or-moving-to-other-accounts) ·
[Local development](#local-development) ·
[Testing](#testing) ·
[Releasing](#releasing) ·
[Operating it](#operating-it) ·
[Lifecycle and cost](#lifecycle-and-cost) ·
[Costs](#costs) ·
[Troubleshooting](#troubleshooting) ·
[Last end-to-end run](#last-end-to-end-run-2026-10-19-local) ·
[Cutover from the routine](#cutover-from-the-routine) ·
[Files](#files)

## Overview

```text
Linear ──(agent session events)──▶ Worker ──▶ IssueAgent: one Durable Object per Linear issue
GitHub ──(reviews, CI, merges)────▶   │          ├─ Pi Durable harness on the object's own SQLite
                                      │          │    transcript, running turn, queued feedback, checkpoints
                                      │          ├─ heartbeat alarm: resumes after an eviction or a deploy
                                      │          ├─ model calls ──▶ AI Gateway ──▶ Workers AI (Kimi K2.7 Code)
                                      │          └─ its own container (Dockerfile): the repository clone
                                      │               internet off; reaches only the hosts intercepted below
                                      ├─ GitGateway: github.com for this repo; adds the token; pushes only to
                                      │    the issue's branch, only while the push tool holds the permit
                                      └─ RegistryGateway: npm and crates.io, passed through
```

| Piece | Built on | Why |
|---|---|---|
| The agent loop | [Pi Durable](https://github.com/earendil-works/pi) 1.3 (`@earendil-works/pi-durable`) | Every model call and tool call is a task that checkpoints before moving on, so a run survives the process dying |
| Where the loop runs | A Cloudflare **Durable Object** per issue (`IssueAgent`) | Single-writer storage (SQLite) that sleeps for free and wakes on an alarm or a webhook; it outlives any one process |
| Where tools run | That object's own **container** (Cloudflare Containers via the Sandbox SDK's `Files`) | A throwaway Linux machine with the repo; it holds no secrets and can be destroyed at any time |
| The control surface | Linear's **Agent API** (an OAuth app acting as itself) | Delegation starts work, session messages steer it, the stop button stops it, and the agent reports back as activities |
| Feedback from code review | A **GitHub App** | Reviews, review comments, failed workflow runs and PR closes arrive as webhooks |
| Models | **AI Gateway** → **Workers AI** | Any model in pi-ai's catalog by changing two vars; logs and spend per call in the gateway |

The brain (the Durable Object) and the hands (the container) are separate on purpose: either can die and the other
carries on. The object rebuilds a lost container from its last snapshot or a fresh clone; the container never needs
the object's state, and never sees a token.

## A run, step by step

1. **A maintainer delegates an issue** to Notefig Build Agent in Linear (assign it, or @-mention the app). Linear
   creates an agent session and sends `AgentSessionEvent` / `created` to `POST /v1/linear`.
2. **The Worker** (`src/index.ts`) checks the signature (`Linear-Signature`, HMAC-SHA256 with
   `LINEAR_WEBHOOK_SECRET`) and that the webhook is under 60 seconds old (`src/linear-webhook.ts`). Only sessions
   started by an approver (`APPROVER_EMAILS`) count. It answers 200 at once (Linear wants an answer in 5 seconds) and
   hands the event to `ISSUE_AGENT.getByName(issueId)` in `ctx.waitUntil`.
3. **The issue's `IssueAgent`** (`src/issue-agent.ts`):
   - posts the thought "Reading the issue." (Linear marks a session unresponsive without an activity in 10 seconds);
   - fetches the issue (`src/linear.ts`: title, description, Linear's `branchName`, labels, state, and the support
     Worker's private note with the debug report and screenshots);
   - refuses issues still in Triage, and, while `LINEAR_TEST_LABEL` is set, issues without that label;
   - records the branch → issue mapping in KV (`BRANCHES`), so GitHub events find the agent;
   - moves the issue to the team's first started state (In Progress) if it's still in Backlog or Todo;
   - arms a heartbeat alarm, then submits "Start working on the issue." to the harness with the request id
     `linear:session:<session id>`, so a retried webhook is admitted once.
4. **Pi Durable** runs the conversation: the system prompt (`src/prompt.ts`: where issues come from, what's private,
   how to work) plus the issue section, then model turns and tool calls, each checkpointed in the object's SQLite
   (tables prefixed `pi_`).
5. **The first tool call starts the container** (`#prepare` in `issue-agent.ts`):
   - from the snapshot of its last push if there is one taken on the current image, otherwise from the image;
   - internet off; `github.com` intercepted by `GitGateway`, npm and crates.io by `RegistryGateway`;
   - clones the repo to `/workspace/repo` and checks out the issue's branch (creating it from `main` if it's new),
     with the bot as git author;
   - stops on its own after 10 idle minutes; the next tool call starts it again.
6. **The agent works** with Pi's coding tools (`bash`, `read`, `edit`, `write`, through `ContainerEnv`,
   `src/container-env.ts`) and three of its own (`src/tools.ts`):
   - `push`: reads every outgoing commit's message, author and own patch (`git log --patch --cc origin/main..HEAD`,
     which includes merge commits), refuses if any quotes the private note, then opens the gateway's push permit,
     runs `git push --no-verify`, closes the permit, and snapshots the container. `--no-verify` skips only the
     repository's pre-push hook, which runs the whole desktop e2e suite in a browser: CI runs it on the pull request,
     and its failures come back to the agent. The commit hook (Fallow) still runs in the container;
   - `open_pull_request`: the title type from the issue's label (`TYPE_LABELS`), the body with `## Release notes`
     and `Closes MET-n`, a draft while the issue has the test label; the PR link is added to the Linear session;
   - `ask_maintainer`: posts a Linear elicitation and ends the run until someone answers.
7. **Reporting** (`src/reporting.ts`, Pi hooks): each tool call becomes an `action` activity, reasoning text before
   tool calls a `thought`, and the final answer the `response`. Linear derives the session's state from them.
8. **Linear's GitHub integration** sees the PR on the issue's own branch and moves the issue (In Progress → In Review
   → Done on merge).
9. **Feedback comes back to the same object:**
   - a message in the Linear session (`prompted`) joins the running work at the next tool round, or starts the next
     run, with request id `linear:<activity id>`;
   - the session's **stop** button (`prompted` with the `stop` signal) pauses it: the run is aborted and the
     container destroyed, but the transcript stays, so a message picks it up again;
   - **unassigning** the agent (an `Issue` update whose previous delegate was the app) ends it: see "Lifecycle and
     cost";
   - an approver's comment on the issue in Linear (a `Comment` event) steers it, with request id
     `linear:comment:<comment id>`, while the issue is delegated to the app. Comments in an agent session's thread
     arrive as `prompted` and one that mentions the app opens its own session, so neither is passed on twice; nor is a
     comment by an integration, such as one synced from GitHub;
   - a review, a review comment or a comment in the PR's conversation (`issue_comment`, whose branch the Worker
     looks up from the PR), from someone who can push to the repository or a `TRUSTED_REVIEWERS` bot, steers it. Every human reviewer is checked with the permission endpoint (write, maintain or admin):
     `author_association` can't tell, since MEMBER and COLLABORATOR don't mean write access and a private org
     membership shows as CONTRIBUTOR;
   - a failed workflow run on the branch arrives with the commit it ran on, a hint to pull first (others may have
     pushed), and the end of each failed job's log, fetched by the object: the container can't reach CI. Each run
     attempt is its own message, so a re-run's failure isn't taken for a repeat;
   - the PR merging or closing ends it the same way, and so does the issue being marked done, cancelled or deleted
     in Linear (an `Issue` update to a completed or canceled state, moved to the trash, or a `remove`). The Worker
     passes that on only for an issue an agent took (its `issue:<id>` key in `BRANCHES`, or, for one taken before
     that key existed, the app as its delegate), so closing other issues wakes no object.

   GitHub events count only for the repository's own branches: a fork's PR from a same-named branch is ignored.
10. **Between events the object sleeps.** While the harness has live tasks a heartbeat alarm comes back every 60
    seconds; if the object was evicted (a deploy, a host move), the alarm restarts it and Pi resumes from the last
    checkpoint. Once idle, the alarm clears itself.

## Security model

The agent reads text strangers write (feedback, public PR comments), so every capability is held outside its reach.

| Risk | What stops it |
|---|---|
| Forged webhooks | HMAC signatures (Linear, GitHub), Linear's timestamp within 60 s |
| A stranger starts or steers an agent | Only approvers' delegations and messages (by email); GitHub feedback only from people who can push to the repo or listed bots, only on this repo's branches |
| The agent reads or leaks a token | The container holds none. The GitHub token is added by `GitGateway` on the way out; Linear and model calls are made by the Durable Object |
| The agent pushes somewhere else | `GitGateway` parses the push's ref updates and allows only `refs/heads/<issue branch>`, no deletion, only while the `push` tool holds the permit. This is the guard: the `main` ruleset only stops force pushes and deletion (see below) |
| The agent reaches other hosts | The container starts with internet off; only intercepted hosts resolve |
| Private feedback reaches GitHub | The debug report and screenshots stay in Linear's top-level private comment; `push` and `open_pull_request` refuse anything that quotes its URLs, paths or file names, in any commit of the push |
| A merged change was never reviewed | The agent opens pull requests and can't push to `main`; a human merges |
| Someone uses the AI Gateway | Authentication is on: calls without `AI_GATEWAY_TOKEN` get 401 |
| A runaway agent's cost | One container per issue, stopped after 10 idle minutes; the gateway logs every model call; stop from Linear at any time |

## Configuration

All in `wrangler.jsonc`. Names, not ids: the Linear team, labels and approvers are looked up by name or email.

| Var | Value | Meaning |
|---|---|---|
| `GITHUB_REPO` | `notefig/notefig` | The one repository the agent clones and pushes to |
| `LINEAR_TEAM_KEY` | `MET` | The Linear team (bootstrap checks it) |
| `LINEAR_TEST_LABEL` | (empty: live) | Testing mode. While set (it was `agent-test` until go-live), only issues with this label start an agent, and their PRs are drafts |
| `APPROVER_EMAILS` | (empty in the file) | Set at deploy from the `BUILD_AGENTS_APPROVERS` GitHub variable, so no address is in the repo |
| `TRUSTED_REVIEWERS` | `greptile-apps[bot]` | GitHub logins besides collaborators whose reviews reach the agent |
| `TYPE_LABELS` | `Bug=fix,Feature=feat,Improvement=improve` | Issue label → commit/PR type. No match: `chore` |
| `MODEL_PROVIDER` | `cloudflare-ai-gateway` | pi-ai provider |
| `MODEL_ID` | `workers-ai/@cf/moonshotai/kimi-k2.7-code` | The default model, in that provider's catalog. Claude would be `claude-sonnet-5-5` (needs an Anthropic key in the gateway) |
| `MODEL_LABELS` | `Kimi K2.7 Code=…kimi-k2.7-code,GLM 5.3=…glm-5.3,GLM 5.3 Flash=…glm-5.3-flash,DeepSeek V4 Pro=…deepseek-v4-pro-0813` | The whitelist an issue's **Model** label picks from (`Label=modelId`). See "Choosing the model" |
| `AI_GATEWAY_ID` | `notefig-build-agents` | The gateway bootstrap creates |
| `CLOUDFLARE_ACCOUNT_ID` | (empty in the file) | Set at deploy from the secret of the same name |
| `GIT_AUTHOR_NAME` | `notefig-build-agent[bot]` | Written by `create-github-app` |
| `GIT_AUTHOR_EMAIL` | `344640214+notefig-build-agent[bot]@users.noreply.github.com` | The bot user's id + login, so GitHub shows the app as the author |

Bindings: `ISSUE_AGENT` (Durable Object `IssueAgent`, SQLite, migration `v1`), the container on `IssueAgent`
(image `workspace` from `./Dockerfile`, `scheduling_policy: durable_object`), `BRANCHES` (KV, no id: wrangler creates
it on the first deploy), route `agents.notefig.com` as a custom domain, observability on.

Constants in code: heartbeat 60 s, container idle timeout 10 min, container instance `standard-2`, repo at
`/workspace/repo`, push header limit 64 KiB, request body limit 1 MiB.

## Secrets

All in the GitHub environment **`build-agents`**; the release workflow copies them to the Worker. Never set them on
the Worker by hand: the next release overwrites them.

| Secret | What it's for | Where it comes from | Rotate |
|---|---|---|---|
| `LINEAR_CLIENT_ID` | The Linear app; with the secret it mints an app-actor token (client credentials grant, 30 days, minted again on a 401) | Linear app page | New app only |
| `LINEAR_CLIENT_SECRET` | ↑ | Linear app page | Regenerate on the app page, `gh secret set`, release |
| `LINEAR_WEBHOOK_SECRET` | Verifies `Linear-Signature` | Linear app page, Webhooks | Regenerate, `gh secret set`, release |
| `GH_APP_ID` | The GitHub App, for its JWT | `create-github-app` | New app only |
| `GH_APP_PRIVATE_KEY` | Signs the app's JWT (RS256, WebCrypto; PKCS#1 keys are wrapped to PKCS#8). The JWT buys one-hour installation tokens for this repo only | `create-github-app` | Generate a key on the app page, `gh secret set`, release, delete the old key |
| `GH_APP_WEBHOOK_SECRET` | Verifies `X-Hub-Signature-256` | `create-github-app` | Change on the app page, `gh secret set`, release |
| `AI_GATEWAY_TOKEN` | `cf-aig-authorization` on every model call; with Workers AI: Read it also pays for Workers AI | Cloudflare account token | Roll it, `gh secret set`, release |
| `CLOUDFLARE_API_TOKEN` | The release workflow's deploy and bootstrap (not given to the Worker) | Cloudflare user token, "Edit Cloudflare Workers" template + AI Gateway Edit | Roll it, `gh secret set` |

Also used by the workflow: the repo secret `CLOUDFLARE_ACCOUNT_ID` and the environment variable
`BUILD_AGENTS_APPROVERS`.

## Accounts and their settings

### Cloudflare
- **Plan: Workers Paid.** On the free plan, Workers AI refuses Kimi ("not available on the Workers Free plan") and
  Containers don't run. After upgrading it took about two minutes to apply.
- **AI Gateway `notefig-build-agents`:** authentication **on** (required: an open gateway with stored provider keys is
  usable by anyone with its URL), logs on, no cache, no rate limit. Workers AI needs no provider key: the gateway uses
  the caller's token, which is why `AI_GATEWAY_TOKEN` has Workers AI: Read. For Claude, add an Anthropic key under
  Provider keys (or turn on unified billing) and change `MODEL_ID`.
- **Created by the first release:** the Worker, its custom domain `agents.notefig.com`, the `BRANCHES` KV namespace,
  the Durable Object namespace, and the container application with its image.

### GitHub
- **App `notefig-build-agent`** (org notefig, private), from `github-app.json`:
  - permissions: metadata read, contents write, pull requests write, actions read, checks read;
  - events: `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `workflow_run`;
  - webhook `https://agents.notefig.com/v1/github`;
  - installed on **notefig/notefig only**;
  - its bot user `notefig-build-agent[bot]` (id 344640214) is the commit author.
- **Environment `build-agents`:** the secrets above and the variable `BUILD_AGENTS_APPROVERS`.
- **Ruleset on `main`** (from `npm run bootstrap -- --github`, named "Protect main"): no force pushes, no deletion;
  repository admins bypass. That's all a ruleset can enforce here: the CLI and desktop release workflows push their
  version bumps straight to `main` with the Actions token, and a repository ruleset can't name GitHub Actions as a
  bypass actor (GitHub answers 422, "must be part of the ruleset source or owner organization"), so requiring pull
  requests or checks would block every release. A bump is a fast-forward, so these two rules leave it alone. What
  keeps the agent off `main` is `GitGateway`. To also require PRs, move the release workflows' bump pushes to a
  dedicated GitHub App (its integration *can* bypass) and add that app to the ruleset. The older "Push to Master"
  ruleset is in evaluate mode and enforces nothing; it can be deleted.

### Linear
- **App "Notefig Build Agent"** (Settings → API → Applications):
  - **Client credentials** on (the Worker mints its own app-actor token);
  - callback URL `https://agents.notefig.com/v1/linear/installed` (the Worker answers it with a short page);
  - webhooks on: `https://agents.notefig.com/v1/linear`, events **Agent session events**, **Issues** (so unassigning,
    closing or deleting the issue stops the agent), **Comments** (so an approver's comment on the issue reaches it) and **Permission changes**;
  - installed as an agent once by an admin, through the link `bootstrap` prints (`actor=app`, scopes
    `read,write,app:assignable,app:mentionable`). Installed agents take no seat.
- **The "Model" label group** (workspace level), with one label per `MODEL_LABELS` entry.
- **Team MET**, with the labels `agent-test`, `Bug`, `Feature`, `Improvement`. The app can't create labels in this
  workspace (label management is admin-only), so bootstrap lists missing ones to create by hand.
- **Approvers:** members whose **Linear account email** is in `BUILD_AGENTS_APPROVERS` (currently `mail@parsa.pro`;
  check it with Linear's API or Settings → Account, it may differ from your GitHub or Cloudflare email).
- The support Worker's private note is the top-level comment starting
  `_Private: comments outside the synced thread stay out of GitHub._` (`PRIVATE_NOTE_MARKER` in `src/linear.ts`).

## Setup, or moving to other accounts

Everything is a script, except the forms no API offers: creating the Linear app, Cloudflare tokens, and (for Claude)
a gateway provider key. Do it from `workers/build-agents`, on a machine with `gh` logged in as an org owner.

1. **Edit `wrangler.jsonc`'s vars** for the new accounts (repo, team key, labels, model, `routes` domain), and set
   the approvers:
   ```bash
   gh variable set BUILD_AGENTS_APPROVERS --env build-agents --body "you@example.com"
   ```
2. **GitHub App:**
   ```bash
   npm run create-github-app -- <org>
   ```
   Creates the `build-agents` environment, registers the app from `github-app.json` (a local page submits the
   manifest; click Create), stores `GH_APP_*`, writes them to `.dev.vars`, sets the git author in `wrangler.jsonc`
   (commit that), and opens the install page: install on the one repository. For a separate test app:
   `-- <org> --name notefig-build-agent-dev --webhook-url https://<tunnel>/v1/github --env build-agents-dev`.
3. **Linear app**, by hand, with the settings under "Accounts and their settings", then:
   ```bash
   gh secret set LINEAR_CLIENT_ID --env build-agents
   gh secret set LINEAR_CLIENT_SECRET --env build-agents
   gh secret set LINEAR_WEBHOOK_SECRET --env build-agents
   ```
4. **Cloudflare:** upgrade to Workers Paid. Create the AI Gateway token (account token: AI Gateway Run, Workers AI
   Read) and the deploy token ("Edit Cloudflare Workers" template + AI Gateway Edit, zone of the domain):
   ```bash
   gh secret set AI_GATEWAY_TOKEN --env build-agents
   gh secret set CLOUDFLARE_API_TOKEN --env build-agents
   ```
   The repo also needs `CLOUDFLARE_ACCOUNT_ID` (it already has it).
5. **Bootstrap** (idempotent; prints what it did and anything left to do by hand):
   ```bash
   LINEAR_CLIENT_ID=… LINEAR_CLIENT_SECRET=… APPROVER_EMAILS=… \
   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=<deploy token> \
   npm run bootstrap -- --linear --gateway
   ```
   - Linear: checks the team and approvers, creates the labels (or lists them to create by hand), prints the install
     link. Open it once as an admin.
   - Gateway: creates `notefig-build-agents` with authentication on, or turns authentication on.
   - `--github` (repo admin): the "Protect main" ruleset (no force pushes or deletion).
6. **Model:** for Workers AI nothing more. For Claude, add the provider key in the gateway and set `MODEL_ID`.
7. **Release:** run "Release Build Agents" (below).

## Local development

```bash
npm ci
npm run typecheck
npm test                 # workerd, no container (see Testing)
npm run test:container   # needs Docker
npm run dev              # needs Docker: the whole Worker with containers
```

**`.dev.vars`** (gitignored, mode 600) holds what the deployed Worker gets from secrets and deploy-time vars:

```text
GH_APP_ID=…               # written by create-github-app
GH_APP_PRIVATE_KEY="…"    # ↑ (quoted, with \n)
GH_APP_WEBHOOK_SECRET="…" # ↑
LINEAR_CLIENT_ID=…
LINEAR_CLIENT_SECRET=…
LINEAR_WEBHOOK_SECRET=…
AI_GATEWAY_TOKEN=…
CLOUDFLARE_ACCOUNT_ID=…
APPROVER_EMAILS=you@example.com
CLOUDFLARE_API_TOKEN=…    # not read by the Worker; handy for running bootstrap
```

**A full local run** against real Linear and GitHub:
1. Start Docker Desktop. The first `wrangler dev` builds the workspace image (about 3.3 GB; roughly 10 minutes on
   Apple Silicon, since containers are linux/amd64 and build under emulation); later runs reuse it.
2. `npx wrangler dev --port 8788` (8787 is often taken by another local Worker).
3. `npx -y cloudflared@0.7.1 tunnel --url http://localhost:8788 --no-autoupdate` prints a `trycloudflare.com` URL.
4. Point the Linear app's webhook at `<tunnel>/v1/linear` and the GitHub App's at `<tunnel>/v1/github`. **Point them
   back at agents.notefig.com afterwards.** (Or use a separate dev app for each.)
5. Delegate an accepted MET issue to Notefig Build Agent. Watch the `wrangler dev` output. To keep a local run to
   labelled issues and draft PRs, set `LINEAR_TEST_LABEL=agent-test` in `.dev.vars`.

Checklist for a run:
1. A thought appears within 10 s, then actions as it works.
2. The branch is the issue's `branchName`; a PR (a draft in testing mode) opens with the type prefix, release notes
   and `Closes`.
3. A message in the session during work lands at the next tool round.
4. Stopping `wrangler dev` mid-turn and starting it again resumes the run without duplicate activities.
5. A forced CI failure gets a fix pushed; a collaborator's review comment is addressed, a stranger's ignored.
6. `git push origin main` from the agent's bash gets 403 from `GitGateway`.
7. Nothing from the private note appears in the PR, commits or synced comments.
8. Stop ends the run and destroys the container.

## Testing

| Command | Where | What |
|---|---|---|
| `npm test` | workerd via `@cloudflare/vitest-plugin`, config `test/wrangler.jsonc` (no container) | Units: receive-pack parsing and the branch guard, git output, the privacy deny-list, Linear and GitHub webhook gating (forks included), the app JWT and PKCS#1 wrapping, Worker routing. **Lifecycle:** `test/issue-agent.ts` is the real `IssueAgent` with its four seams (`models`, `linear`, `github`, `workspace`) replaced by a scripted pi-ai faux model and recorders, on Cloudflare's own Durable Object storage, alarms and eviction: answering on the session, refusing Triage and unlabelled issues, finishing a turn an eviction cut off, admitting a retried message once, `ask_maintainer` ending the run, the stop button |
| `npm run test:container` | `wrangler dev` on `test/container` (a slim image with `sandbox-shim`), port 8799, Docker | Pi's own environment conformance suite (`createEnvConformance`) against `ContainerEnv`: readers, writes, renames, watching (by polling), exec windows, timeouts, aborts, spawn errors, symlinks (24 cases); `ContainerEnv`'s own cases (a program exiting 211 keeps its status, `cleanup()` stops watchers); and a container snapshot round trip. `listFiles` is optional in Pi and left out |
| CI "Test Build Agents" | `ci-tests.yml` | `npm ci`, typecheck, `npm test`, on every PR |

## Releasing

**"Release Build Agents"** (`.github/workflows/release-build-agents.yml`), by hand, with a version:
1. checks the version is semver and its tag doesn't exist;
2. `npm ci`, typecheck, tests;
3. `npm run bootstrap -- --linear --gateway`;
4. `wrangler deploy` through `wrangler-action` (wrangler 4.151.1): builds and pushes the container image (the runner
   has Docker), passes `APPROVER_EMAILS` and `CLOUDFLARE_ACCOUNT_ID` as `--var`, copies the seven secrets, tags the
   deployment `build-agents-v{version}`;
5. tags the deployed commit `build-agents-v{version}` (no version-bump commit, so a moving `main` can't leave a
   deploy without its tag) and creates a GitHub release listing this directory's commits since the previous tag,
   with `--latest=false` so the desktop release stays "latest" (installed apps read its `latest.json`).

Running agents survive a release: their objects restart and resume from their checkpoints. A container snapshot from
the old image isn't reused; the next start clones afresh.

## Operating it

- **Logs:** `npx wrangler tail notefig-build-agents`, or Workers → notefig-build-agents → Logs (observability on).
- **Model calls and spend:** AI → AI Gateway → notefig-build-agents → Logs.
- **Stop an agent:** the stop button in its Linear session, or unassign it (remove it as the delegate, or delegate
  the issue to someone else). Unassigning needs the Linear app's **Issues** webhook events.
- **Turn it off entirely:** turn off the Linear app's webhook (or empty `BUILD_AGENTS_APPROVERS` and release).
- **Live mode** (since MET-241): `LINEAR_TEST_LABEL` is empty, so any accepted issue an approver delegates starts an
  agent, and its PRs are ready for review. **Back to testing mode:** set it to `agent-test` and release.
- **Switch the default model:** `MODEL_PROVIDER`/`MODEL_ID` (any entry in pi-ai's catalog for that provider), release.

### Choosing the model

An issue's model is its **Model** label (Linear's workspace label group "Model", one child per model, so an issue has
at most one), set by hand or suggested when feedback is filed. Only labels in `MODEL_LABELS` count: their model ids
are the only ones a label can reach, so a label can't point an agent at an arbitrary or expensive model. No Model
label, or one not on the whitelist: `MODEL_ID`.

| Label | Model | For |
|---|---|---|
| Kimi K2.7 Code | `workers-ai/@cf/moonshotai/kimi-k2.7-code` | The default; everyday fixes and features |
| GLM 5.3 | `workers-ai/@cf/zai-org/glm-5.3` | 1M-token context; large changes across packages |
| GLM 5.3 Flash | `workers-ai/@cf/zai-org/glm-5.3-flash` | Cheap and fast; small, well-specified changes |
| DeepSeek V4 Pro | `workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813` | Strongest reasoning; hard bugs |

All four are Workers AI models, so the gateway needs no provider key; each answered through `notefig-build-agents` on
2026-10-20. The model is read when the agent accepts the issue and again when it's delegated again, and the agent
says on the session which one a label picked. A conversation already running switches at its next model request.
To add one: a child label under "Model" in Linear, its pair in `MODEL_LABELS`, release.

## Lifecycle and cost

What exists for an issue, and when it goes away:

| Thing | Created | Runs (and bills) | Stopped | Deleted |
|---|---|---|---|---|
| **Container** | the run's first tool call | while tools run (each command is capped at 20 minutes unless the model sets its own timeout), and up to 10 idle minutes after (`setInactivityTimeout`) | after 10 idle minutes, on the stop button, on the end | on the stop button and on the end (`container.destroy()`); an idle stop restarts on the next tool call |
| **Container snapshot** | after every successful push | (stored, not running) | | the record is dropped when a snapshot fails or the agent ends. The container API has no call to delete a snapshot, so the snapshot itself expires: Cloudflare keeps it 30 days from its creation or last restore, and an ended agent never restores it |
| **Durable Object** | the first webhook for the issue | only while handling an event or running the harness; it hibernates in between, and an evicted object costs nothing | | its storage (transcript, checkpoints, the issue, the session, the snapshot record) is erased on the end (`deleteAll`), and its alarm cleared. The harness's tables are created only once the issue is accepted, so an ended object holds no data and Cloudflare drops it |
| **Heartbeat alarm** | when work is admitted | wakes the object every 60 s while the harness has live tasks | once idle, it clears itself | on the end |
| **Branch mapping** (`BRANCHES` KV) | when the agent starts: branch → issue, and `issue:<id>` → branch | | | on the end, so GitHub and Linear events stop reaching it |
| **PR preview** (Pages, `pr-<number>` branch) | by `pr-preview.yml` on the agent's PR | (static files) | | every deployment on the branch, when the PR merges or closes (`pr-preview.yml`'s `remove` job, on `pull_request_target` so a conflicting PR is cleaned up too), or by its daily sweep |

**The end** comes when the PR merges or closes, the agent is unassigned, or the issue is marked done, cancelled or
deleted. The agent aborts any run, destroys the
container, removes the branch mapping, says so on the session and erases its storage, keeping nothing; a
review or CI failure arriving afterwards finds no issue and is ignored. Delegating the issue again starts afresh.

**The stop button is a pause, not the end:** the container goes, the transcript stays (a few KB in SQLite), and a
message resumes it. An agent that's merely finished a turn keeps its container for 10 minutes, so feedback that comes
quickly finds its workspace warm, then costs nothing but storage until something happens.

## Costs

- Workers Paid: $5/month, with Workers, Durable Objects and container allowances; usage beyond is billed.
- Containers: per active vCPU, memory and disk time. A container runs only while an agent works and for 10 minutes
  after; an agent waiting for review costs nothing but a sleeping Durable Object and its snapshot.
- Models: Workers AI per token (Kimi K2.7 Code), visible per call in the gateway.
- Linear agents and GitHub Apps: free. Linear app users take no seat.

## Troubleshooting

Everything below happened while building this.

| Symptom | Cause | Fix |
|---|---|---|
| `bootstrap`: `Linear: Query too complex` | One query for the team and all its labels exceeded Linear's complexity limit | Fetched in small pages (fixed) |
| `bootstrap`: `Linear: not allowed to take action` on labels | Label management is admin-only in this workspace; the app isn't an admin | Bootstrap lists missing labels; create them by hand |
| Gateway: `x-api-key header is required` (Claude) | No Anthropic key in the gateway; pi-ai sends only the gateway token | Add the provider key, or use Workers AI |
| Gateway: `Authentication error` (Workers AI) | The gateway token lacked Workers AI permission | Add Workers AI: Read to `AI_GATEWAY_TOKEN` |
| Gateway accepted calls without a token | Authentication was off | Turned on; bootstrap now enforces it |
| `Model … is not available on the Workers Free plan` | Free plan | Upgrade to Workers Paid; it applied after about two minutes |
| Workers AI provider not listed under Provider keys | Workers AI isn't an outside provider | Nothing to add; the gateway uses the caller's token |
| `wrangler dev`: `Address already in use` | Another local Worker on 8787 | `--port 8788` |
| `wrangler deploy --dry-run`: Docker CLI needed | Container images build even in dry runs | Start Docker, or check the bundle with a config without `containers` |
| Docker Desktop quit during the first build | It restarted itself on first launch | Start it again and rebuild |
| Durable Object never evicted in tests | Pi 1.3's memory-retention timers kept the object awake (and billed) | `contextRetentionMs: 0`, `documentRetentionMs: 0` |
| `ask_maintainer` failed when the container couldn't start | Pi builds the environment before every tool | The workspace is optional; coding tools fail with the reason, others run |
| First Worker test timed out in CI | Loading the bundle (Pi included) takes seconds on a cold runner | `testTimeout: 30_000` |
| `bootstrap --github`: 422 "Actor GitHub Actions integration must be part of the ruleset source or owner organization" | A repository ruleset can't exempt the built-in Actions integration | The ruleset only blocks force pushes and deletion, which releases never do (fixed); see "Accounts and their settings" |
| Pressing stop left the session "stopping" for minutes; the log said `waitUntil() tasks did not complete … cancelled` | `stop()` aborted the run first, and the abort waited on a test command running for over ten minutes, past the Worker's short `waitUntil` window. The object finished stopping on its own once the command ended | Stop destroys the container first, which ends any command at once; commands get a 20-minute default timeout (fixed) |
| The clone failed in production with "server certificate verification failed. CAfile: none" | The intercept re-signs TLS with the container CA, and `container.start`'s env doesn't reach `exec`'d commands | The CA goes into the system store, git's config and `/etc/profile.d` on every start (fixed) |
| The agent couldn't read `packages/desktop/AGENTS.md` | That file isn't committed (only the root AGENTS.md is) | Commit it if agents should follow it |
| Hard to find which Cloudflare token CI uses | The repo's token is account-owned, listed under Manage Account → Account API Tokens | Build agents have their own token on their environment |
| Every delegation ignored as "not started by an approver" | `APPROVER_EMAILS` had a different email than the Linear account | Use the Linear account's email |
| Reviews from maintainers never reached the agent | The collaborators API answers apps 404, and `author_association` shows a private org membership as CONTRIBUTOR | Check the permission endpoint instead (fixed) |
| `push` failed after minutes | The pre-push hook ran the desktop e2e suite in the container; it's slow (and under emulation, flaky) | The tool pushes with `--no-verify`; CI runs e2e (fixed) |
| The agent tried `git push --no-verify` from bash, then looked for tokens | The prompt didn't rule it out | The gateway refused (no permit) and there are no tokens; the prompt now forbids both (fixed) |
| The agent couldn't reproduce a CI failure | Someone else's commit on its branch; it couldn't read the CI log | The failure message has the commit, a pull hint and the log tail (fixed) |
| A re-run's failure was ignored | Same run id, deduplicated | Request ids include the run attempt (fixed) |
| A running agent kept old instructions after a change | A conversation stores its instructions at creation | Re-applied on every open when they differ (fixed) |
| The branch is `notefigbuildagent-met-…`, not `parsa-met-…` | Linear's `branchName` is personalised to whoever asks; the agent asks as itself | Expected; Linear links the PR by `met-<n>` |
| Issues stay Todo while their draft PRs are open | Linear's GitHub automation doesn't move issues on draft PRs by default | The agent moves its issue to In Progress itself when it starts (fixed) |
| Delegating MET-234 got no answer and Linear cancelled the session | The Linear app's webhook points at agents.notefig.com, not deployed yet; with no activity in 10 s, Linear marks the session unresponsive | Expected until the release (or point the webhook at a tunnel) |
| Linear deliveries never reach a local run | The Linear app's webhook points at agents.notefig.com | Point it at the tunnel, or play Linear's part: create a session with `agentSessionCreateOnIssue` and post signed `AgentSessionEvent`s (see "Last end-to-end run") |

## Last end-to-end run (2026-10-19, local)

Locally (`wrangler dev` with the real container, a cloudflared tunnel), against the real Linear workspace, GitHub
repo, CI, AI Gateway and Kimi K2.7 Code. The Linear app's webhook still pointed at agents.notefig.com, so its
deliveries were played by a script: a **real** agent session from `agentSessionCreateOnIssue` with the app's token,
and `AgentSessionEvent` webhooks signed with the real secret. Everything after the webhook was real. The GitHub App's
webhook was pointed at the tunnel through `PATCH /app/hook/config`, so GitHub's deliveries were real.

| # | Scenario | Result |
|---|---|---|
| 1 | Feedback through support.notefig.com → Triage issue (MET-237) with the private note, created by Notefig Support | ✓ |
| 2 | Delegated while in Triage | ✓ refused on the session |
| 3 | Accepted, no `agent-test` label | ✓ refused |
| 4 | Delegated by a non-approver | ✓ ignored |
| 5 | Real run: thought in seconds, container started, `npm ci` through the registry gateway, edit, Fallow commit hook, push, draft PR #441 `improve: …` with release notes and `Closes MET-237`, response on the session | ✓ after the push fixes above |
| 6 | Steering mid-run (the issue's file wasn't on `main`; told it where to write instead) | ✓ picked up at the next tool round |
| 7 | bash `git push` and `git push --no-verify` | ✓ refused by the gateway ("Push with the push tool") |
| 8 | Restart mid-run (`wrangler dev` reloaded several times) | ✓ resumed from the checkpoint |
| 9 | Review from a maintainer on the PR (GitHub's real webhook, then a redelivery) | ✓ after the review-trust fix: edited, pushed, reported |
| 10 | Someone else pushes a breaking commit; CI fails | ✓ after the CI-message fix: pulled, found the commit, fixed it, CI green |
| 11 | Stop button mid-run | ✓ aborted, response posted, container destroyed |
| 12 | Team-written issue needing a decision (MET-238) | ✓ asked with `ask_maintainer`, waited, answer resumed it, PR #443 `feat: …` |
| 13 | Worker killed mid-turn and started fresh (workspace lost, nothing pushed yet) | ✓ resumed on the heartbeat, noticed the edit was gone, redid it |
| 14 | PR closed | ✓ final response, container destroyed |
| 15 | Privacy | ✓ nothing from the debug report in either PR, its commits or descriptions |

After this run: the agent moves its issue to In Progress itself, and unassigning stops it (unit and lifecycle
tests; live once the Linear app sends Issues events).

Not exercised live: Linear's own webhook delivery and its UI (stop button, replies); a review from someone without push
access (no such account; covered by unit tests); asking the agent to leak private data or push to `main` on purpose
(the session's safety check declined to send those instructions; both guards are unit-tested, and the agent's own
bash pushes were refused live). The model's edits were correct but not always tidy (MET-238's split a sentence).

## Cutover from the routine

The first version of this stage was a claude.ai routine fired by the support Worker's `/v1/linear` route (#432), with
config PR #435. Once build agents run in production:
- remove `agent-trigger.ts`, `AGENT_DELIVERIES`, `CLAUDE_ROUTINE_*`, `AGENT_USER_ID` and `APPROVER_IDS` from
  `workers/support`, its README's Agent section, and the Worker secrets `LINEAR_WEBHOOK_SECRET` and
  `CLAUDE_ROUTINE_TOKEN`;
- delete the Linear webhook pointing at support.notefig.com/v1/linear, and the routine in claude.ai;
- close #435;

## Files

| Path | What |
|---|---|
| `src/index.ts` | Routes `/v1/linear`, `/v1/github`, `/v1/linear/installed`; exports the Worker, `IssueAgent`, `GitGateway`, `RegistryGateway` |
| `src/issue-agent.ts` | The Durable Object: harness, heartbeat, container lifecycle, snapshots, the seams tests replace |
| `src/container-env.ts` | Pi's `ExecutionEnv` over the container (`Files` + process API), polling watcher |
| `src/gateways.ts` | `GitGateway` (token, push permit, branch guard, streaming), `RegistryGateway` |
| `src/receive-pack.ts` | Reads a push's ref updates from its pkt-line header |
| `src/tools.ts` | `push`, `open_pull_request`, `ask_maintainer` |
| `src/reporting.ts` | Pi hooks → Linear activities |
| `src/prompt.ts` | The system prompt and the issue section |
| `src/privacy.ts` | The private note's deny-list |
| `src/linear.ts`, `src/linear-webhook.ts` | Linear client (client credentials, activities, issue) and webhook gating |
| `src/github.ts`, `src/github-webhook.ts` | GitHub App client (JWT, installation token, PRs, collaborators, failed jobs) and webhook gating |
| `src/git-output.ts` | Branch type, PR title and body |
| `src/config.ts`, `src/signature.ts`, `src/exports.d.ts` | Env and config, HMAC checks, `ctx.exports` types |
| `Dockerfile` | The workspace image: Node 22, Rust, Tauri's Linux libraries, Playwright Chromium 1.59.0, `sandbox-shim` |
| `wrangler.jsonc` | Worker, Durable Object, container, KV, route, vars |
| `github-app.json` | The GitHub App manifest |
| `scripts/create-github-app.ts`, `scripts/bootstrap.ts`, `scripts/test-container.ts` | Setup and the container test runner |
| `test/` | Test Worker entry and config, `TestIssueAgent`, lifecycle and routing tests, the container harness |
