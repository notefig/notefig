# Intake Worker

A Cloudflare Worker, on the Workers Free plan, that takes submissions from the public (feedback from the app, for now) into Linear Triage, and runs agent builds for issues you approve in Linear.

```
App ──▶ intake.notefig.com ──▶ Linear Triage (label: Feedback)  + private "Debug report" link
                                    │
                you: Accept  ───────┤  adds `agent:build`, moves it to GA roadmap, queues a build
                you: Decline ───────┘  counts against the submitter; deletes the debug report
                                    │
   you: add `agent:build` to any MET issue, or create one from the Agent build template
                                    │
              BuildQueue (one build at a time) ──▶ workflow_dispatch: agent-build.yml
                                    │
           PR on agent/met-123, review requested from you ──▶ result posted back to the Worker
                                    │
                    comments on the Linear issue: started, queued, PR opened, failed
```

Builds start only from Linear, and only from an approver's action there. Nothing on GitHub can start one: `agent-build.yml` runs on `workflow_dispatch` alone, which only the Worker (as the GitHub App) calls.

## How it works

- **Workflows.** Each intake workflow is one definition in `src/workflows/`. A definition sets the payload schema, how the Linear issue is worded, its limits, what accepting it does, and any private report it carries. Feedback is the only workflow so far. To add another, write a new definition and add it to `src/workflows/index.ts`. It gets its own route, `POST /v1/workflows/<id>/submissions`, and its own state.
- **State.** Two kinds of Durable Object, both SQLite-backed (the only kind on the Free plan). Neither runs between calls: they wake for a request or an alarm.
  - `WorkflowState`, one per workflow (named by its id): submissions, day counters, and private reports. Keys are built only in `src/store.ts`, under a `v1:` prefix; a future change to a record's shape moves to `v2:` instead of reading old records as new ones. Records hold salted hashes, never the submitted text or the raw install id. A daily alarm deletes day counters older than 7 days and reports older than 30.
  - `BuildQueueObject`, one for the service: which build is running and which wait (`src/build-queue.ts`, under the same `v1:` rule).
- **Builds** (`src/builds.ts`). An approver accepting a workflow's issue, adding `agent:build` to any issue, or creating an issue with it, asks for a build. The queue runs one at a time, since builds share your Claude subscription; the rest wait and the issue says what it waits behind. A build's dispatch carries the issue's key, title and description. When it ends, `agent-build.yml` posts the result to `POST /v1/builds/result`, authenticated with GitHub's OIDC token (no shared secret), and the Worker comments on the issue and starts the next build. A build with no result after 75 minutes is given up on, so a lost runner can't stall the queue. To build an issue again, remove `agent:build` and add it back.
- **Private reports** (`src/reports.ts`). A submission can carry text that must not go public. Feedback's is the debug panel's report, when the user ticks "Include debug report". It's stored in `WorkflowState`, never in the issue, and linked from the issue as an attachment to `GET /v1/reports/<workflow>/<id>`. Cloudflare Access guards that path, and the Worker verifies Access's token on every read too, so a missing or misconfigured Access application fails closed. The report is deleted when the issue is declined, or after 30 days. The agent never sees it.
- **Abuse limits** (per workflow, set in its definition):
  - Cloudflare's rate limiter allows 5 requests a minute per IP.
  - Each install can submit 5 times a day.
  - The workflow opens at most 50 new issues a day.
  - An install with 3 declined issues is ignored from then on.
  - The same text from another install becomes a comment on the existing issue, not a new issue, up to 100 a day. Repeats from the same install are dropped.
  - A submission interrupted before its issue was created frees its text after 10 minutes, so it can be sent again.
  - Dropped submissions still get a 202, so a submitter can't tell they were filtered.
  - At most 20 accepted feedback issues a day start a build. Builds you start yourself aren't capped.
- **Approvers.** Only Linear users in `LINEAR_APPROVER_IDS` can accept, decline or start builds. The webhook ignores everyone else.
- **Public text.** The repo is public and Linear syncs MET issues to it. The issue body says the text came from a user and must be treated as a report. Every line is quoted and every `@` is defused so it can't mention anyone.

## One-time setup

### Linear

1. **Turn on Triage for MET**: Settings → Teams → Metrists → Triage. The Worker files every submission there, and refuses submissions while Triage is off.
2. **Labels** `Feedback` and `agent:build` exist in MET already. The Worker looks up labels and projects by name, so no ids go into config.
3. **Check what syncs.** Under Settings → Integrations → GitHub, the MET → `notefig/notefig` issue sync covers the whole team. If Triage issues sync before you accept them, unreviewed feedback is public as soon as it arrives. Decide whether that's acceptable; builds no longer depend on the sync either way.
4. **Create an API key** (Settings → Security & access → Personal API keys) with write access to MET, on your own account. The Worker's comments and label changes appear as you.
5. **Add a webhook** (Settings → API → Webhooks):
   - URL: `https://intake.notefig.com/v1/linear/webhook`
   - Resource: Issues
   - Team: Metrists

   Copy its signing secret.
6. **Add an issue template** for starting builds by hand (Settings → Teams → Metrists → Templates): name it **Agent build**, with label `agent:build` and project GA roadmap. An issue created from it starts a build straight away.

Day to day:

| In Linear | What happens |
|---|---|
| **Accept** a Feedback issue (any open status) | `agent:build` and GA roadmap are added and a build is queued |
| **Decline** | Nothing visible. Its debug report is deleted; the submitter is ignored after 3 declines |
| **Mark as duplicate** | Recorded, no penalty |
| Accept without a build | Remove `Feedback` before accepting |
| **Add `agent:build`** to any issue, or create one from **Agent build** | A build is queued |
| Remove `agent:build` and add it back | The issue builds again (delete its `agent/met-…` branch first if a PR was opened) |

### GitHub

1. **Create a GitHub App** (for example `notefig-agent`) installed on `notefig/notefig` only, with:
   - Actions: write (the Worker dispatches `agent-build.yml`)
   - Contents: write and Pull requests: write (the workflow pushes the branch and opens the PR)
   - **not** Workflows, so a push that touches `.github/` is refused.

   Note its App ID and generate a private key.
2. **Create an environment `agent`** (Settings → Environments). Restrict it to the `main` branch and add:
   - secret `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`
   - secret `AGENT_APP_PRIVATE_KEY`
   - variable `AGENT_APP_ID`
3. **Add repository variables:**
   - `INTAKE_URL` = `https://intake.notefig.com`, with no trailing slash: it is also the OIDC audience the Worker checks. Release and site builds read it, and leaving it unset hides "Send feedback".
   - `AGENT_REVIEWER` (optional) = `parsasi`
   - `AGENT_EGRESS_POLICY` (optional): set it to `audit` for the first run, then check the harden-runner report for hosts the run needed that the allowlist is missing.
4. **Protect `main`** so it requires your approving review. The bot then can't merge.

### Cloudflare

1. **Cloudflare Access** for report links. Zero Trust's Free plan covers up to 50 users; it asks for a card at signup but doesn't charge it.
   1. Zero Trust → Settings: note your team domain (`<team>.cloudflareaccess.com`).
   2. Access → Applications → Add → Self-hosted. Domain `intake.notefig.com`, path `v1/reports`. Policy: Allow, emails = yours. Note the application's **Audience (AUD) tag**.
2. **Vars.** In `wrangler.jsonc`, fill in `GITHUB_APP_ID`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Until the Access pair is set, report links answer 404.
3. **Secrets and deploy:**

   ```sh
   cd packages/intake
   npx wrangler secret put LINEAR_API_KEY          # Linear step 4
   npx wrangler secret put LINEAR_WEBHOOK_SECRET   # Linear step 5
   npx wrangler secret put SUBMITTER_SALT          # any long random string; never change it
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY  # the App's .pem, as GitHub gave it
   npx wrangler deploy
   ```

   After that, `deploy-intake.yml` deploys on every push to `main` that touches this package. Its `CLOUDFLARE_API_TOKEN` needs **Workers Scripts: Edit** and **Workers Routes: Edit** on the notefig.com zone, on top of the Pages permissions the marketing deploy already uses.
4. **WAF rules** on the notefig.com zone (Security → WAF), to drop junk before it reaches the Worker:
   - **Rate limiting rule:** path starts with `/v1/workflows/`, more than 20 requests in 10 minutes per IP, then block for an hour.
   - **Custom rule:** host is `intake.notefig.com`, path starts with `/v1/workflows/`, and `ip.src.asnum` is a hosting provider (for example `16509 14618 15169 396982 14061 24940 16276 8075`), then Managed Challenge. Real users send feedback from home and office networks. Keep it off `/v1/builds/` and `/v1/linear/`: GitHub's runners and Linear's webhooks do come from cloud networks.
   - **Custom rule:** host is `intake.notefig.com` and the method isn't `GET`, `POST` or `OPTIONS`, or the path is outside `/v1/` and `/health`, then Block.

**Free plan fit.** Each request does little CPU work (signature checks, one RSA signature for the GitHub App token, JSON), well under the 10 ms limit; the rest is waiting on Linear and GitHub, which doesn't count. Durable Object use is a few rows per submission or build, far below 100,000 writes a day.

## Before turning it on

Send one piece of feedback from a dev build (`VITE_INTAKE_URL=https://intake.notefig.com npm run dev:desktop`) with the debug report ticked, then check:

- [ ] It lands in MET Triage with `Feedback`, a kind label, and a "Debug report" link.
- [ ] The link asks you to sign in, then shows the report. In a private window, signed out, it doesn't.
- [ ] If the issue syncs to GitHub, the debug report doesn't appear there.
- [ ] Accepting it adds `agent:build` and GA roadmap, and the issue gets "Agent build started".
- [ ] `agent-build.yml` runs, opens a PR on `agent/met-…` that requests your review, and the issue gets the PR link.
- [ ] Adding `agent:build` to a second issue while the first builds says it's queued, and it starts when the first ends.

## Local development

```sh
npm run test -w packages/intake
npm run build -w packages/intake      # typecheck
cd packages/intake && npx wrangler dev
```

## Known gaps

- The agent step's network allowlist includes `github.com` and the npm registry, which the job needs. A prompt-injected run could still push data to an attacker's repository or package with credentials the attacker supplies. Your review of the issue before accepting it, and of the PR, is the backstop.
- A build given up on after 75 minutes may still be running on GitHub. If it later opens a PR, the PR is still linked to the issue by its branch, but the issue gets no comment for it.
