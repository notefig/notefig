# Build agents (agents.notefig.com)

Delegate an accepted Linear issue to the **Notefig Build Agent** app, and an agent implements it and opens a pull
request. You steer it from the Linear session; reviews and CI on its pull request reach it too.

Not an npm workspace: installed, tested and deployed on its own, like `workers/support`.

## How it works

```text
Linear ──(agent session events)──▶ Worker ──▶ IssueAgent (one Durable Object per issue)
GitHub ──(reviews, CI, merges)───▶   │          ├─ Pi Durable harness on the object's SQLite
                                     │          │    transcript, running turn, queued feedback
                                     │          ├─ alarm heartbeat: resumes after eviction or a deploy
                                     │          └─ its own container (Dockerfile): the repo clone
                                     │               internet off; reaches only intercepted hosts
                                     ├─ GitGateway: github.com for this repo, adds the token,
                                     │    pushes only to the issue's branch, only from the push tool
                                     └─ RegistryGateway: npm and crates.io, passed through
```

- **Linear is the control surface.** Delegating an issue starts its agent; a message in the session steers it at the
  next tool round; the session's stop button stops it. The agent reports each tool call as an action, its reasoning
  as thoughts, questions as elicitations, and its result as the response.
- **Who can start it.** Only delegations by `APPROVER_EMAILS`, only for issues out of Triage, and while
  `LINEAR_TEST_LABEL` is set, only issues with that label (their pull requests open as drafts).
- **Git output follows Linear.** The branch is the issue's own `branchName`, so Linear's GitHub integration links the
  pull request and moves the issue. The title's type comes from the issue's label (`TYPE_LABELS`). The body gets
  `## Release notes` and `Closes MET-n`.
- **Feedback from GitHub.** Reviews and review comments from collaborators or `TRUSTED_REVIEWERS`, failed CI runs on
  the branch, and the pull request closing all go to the issue's agent.
- **Privacy.** The support Worker's private note (debug report, screenshots) is in the agent's prompt, never on
  GitHub: `push` and `open_pull_request` refuse commits or text that quote its paths, file names or URLs.
- **Any model.** pi-ai through Cloudflare AI Gateway: `MODEL_PROVIDER` and `MODEL_ID` in `wrangler.jsonc`.

## Configuration

Account-specific values are the `vars` in `wrangler.jsonc`; nothing is an id you have to look up. Two are set at deploy
time so they stay out of the repository: `APPROVER_EMAILS` (from the GitHub variable `BUILD_AGENTS_APPROVERS`) and
`CLOUDFLARE_ACCOUNT_ID`. Secrets live in GitHub and are synced to the Worker on release:

| Secret | From |
|---|---|
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | the Linear app (client credentials on, agent session events) |
| `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_WEBHOOK_SECRET` | the GitHub App |
| `AI_GATEWAY_TOKEN` | a Cloudflare API token with AI Gateway Run |

## Setup, or moving to other accounts

Everything below is a script, except two forms no API offers: creating the Linear app, and giving the AI Gateway a
provider key. Secrets go to the GitHub environment `build-agents`, and the release workflow copies them to the Worker.

1. **Edit `wrangler.jsonc`'s vars** for the new accounts: the repo, the Linear team key, the labels, the model and the
   custom domain in `routes`. In GitHub, set the variable `BUILD_AGENTS_APPROVERS` (comma-separated emails).
2. **GitHub App.** As an org owner:
   ```bash
   npm run create-github-app -- <org>
   ```
   It creates the `build-agents` environment, registers the app from `github-app.json`, stores `GH_APP_ID`, `GH_APP_PRIVATE_KEY` and `GH_APP_WEBHOOK_SECRET`,
   writes the bot's git author into `wrangler.jsonc` (commit it), and opens the page to install the app. Install it on
   this repository only.
3. **Linear app** (Linear has no API for creating apps). Settings → API → Applications → New:
   - name **Notefig Build Agent**, callback URL `https://agents.notefig.com/v1/linear/installed` (the install link
     bootstrap prints returns there);
   - turn on **Client credentials**;
   - webhooks on, URL `https://agents.notefig.com/v1/linear`, events **Agent session events** and
     **Permission changes**.

   Then store its values:
   ```bash
   gh secret set LINEAR_CLIENT_ID --env build-agents
   gh secret set LINEAR_CLIENT_SECRET --env build-agents
   gh secret set LINEAR_WEBHOOK_SECRET --env build-agents
   ```
4. **Cloudflare.** Make an API token with AI Gateway Run and store it as `AI_GATEWAY_TOKEN`. The deploy token
   (`CLOUDFLARE_API_TOKEN`) also needs Workers, Containers, KV and AI Gateway edit rights.
5. **Bootstrap** (idempotent; the release workflow runs the Linear and gateway parts again):
   ```bash
   LINEAR_CLIENT_ID=… LINEAR_CLIENT_SECRET=… CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
     APPROVER_EMAILS=… npm run bootstrap
   ```
   It protects `main` (pull requests and checks required; admins and the release workflows bypass), creates the Linear labels, checks the
   team and approvers, creates the AI Gateway, and prints the link that installs the Linear app as an agent.
   In the gateway's dashboard, add a provider key or turn on unified billing.
6. **Release.** Run the "Release Build Agents" workflow.

## Development

```bash
npm ci
npm run typecheck
npm test                 # workerd, no container: units, webhooks, and the agent's lifecycle
npm run test:container   # needs Docker: Pi's environment conformance suite in a real container
npm run dev              # needs Docker: the whole Worker with containers, locally
```

- **`npm test`** runs `IssueAgent` itself (as `test/issue-agent.ts`, with a scripted pi-ai model and Linear and
  GitHub that record what they're sent) on Cloudflare's own Durable Object storage, alarms and eviction: answering
  on the session, refusing Triage and unlabelled issues, finishing a turn an eviction cut off, admitting a retried
  message once, ending a run on a question, and stopping.
- **`npm run test:container`** runs Pi's `createEnvConformance` cases against `ContainerEnv` in a slim container
  (`test/container`): file and directory readers, writes, renames, watching (by polling), exec with windows,
  timeouts, aborts and spawn errors, symlinks; and a container snapshot round trip. `listFiles` is optional in Pi
  and left out, so Pi walks directories itself.

## Containers

Each agent's container starts on its first tool call, with internet off, and stops after 10 idle minutes; the next
tool call starts it again. After every push the object snapshots it, so a restart resumes with the clone,
`node_modules` and build caches instead of cloning and installing again. A release changes the image, and then the
next start is a fresh clone. The container is destroyed when the pull request merges or closes, or on stop.

Pi Durable 1.3 has no `onWake` yet, so the object keeps a heartbeat alarm while the harness has live tasks, and frees
idle conversations at once (`contextRetentionMs: 0`), since 1.3's retention timers would keep the object awake. When
Pi releases `onWake`, the alarm can follow the harness's own schedule instead.
