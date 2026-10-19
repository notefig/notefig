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

Registering the apps and syncing the secrets is scripted; see the setup section (stage 2).

## Development

```bash
npm ci
npm run typecheck
npm test          # workerd, against test/wrangler.jsonc (no container)
npm run dev       # needs Docker: builds the image and runs containers locally
```

Pi Durable 1.3 has no `onWake` yet, so the object keeps a heartbeat alarm while the harness has live tasks. When Pi
releases `onWake`, the alarm can follow the harness's own schedule instead.
