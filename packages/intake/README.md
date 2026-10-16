# Intake Worker

A Cloudflare Worker that takes submissions from the public (feedback from the app, for now) into Linear Triage. When you accept one there, it hands the issue to the agent build.

```
App ──▶ intake.notefig.com ──▶ Linear Triage (label: Feedback)
                                    │
                you: Accept  ───────┤  webhook: adds `agent:build`, moves it to GA roadmap
                you: Decline ───────┘  webhook: counts against the submitter
                                    │
                  Linear syncs the issue to GitHub (team-wide sync)
                                    │
     .github/workflows/agent-build.yml ──▶ PR from the GitHub App, review requested from you
```

You can also start a build without the app: create an issue in Linear with the **Agent build** template (below), or add `agent:build` to any MET issue. Once it syncs, the workflow picks it up.

## How it works

- **Workflows.** Each intake workflow is one definition in `src/workflows/`. A definition sets the payload schema, how the Linear issue is worded, its limits, and what accepting it does. Feedback is the only workflow so far. To add another, write a new definition and add it to `src/workflows/index.ts`. It gets its own route, `POST /v1/workflows/<id>/submissions`, and its own state.
- **State.** Each workflow's state lives in its own Durable Object instance, `WorkflowState`, named by the workflow id. A Durable Object instance handles one call at a time, so the day counters can't be raced. Keys are built only in `src/store.ts`, under a `v1:` prefix. A future change to a record's shape moves to `v2:` instead of reading old records as new ones. Records hold salted hashes, never the submitted text or the raw install id. A daily alarm deletes day counters older than 7 days.
- **Abuse limits** (per workflow, set in its definition):
  - Cloudflare's rate limiter allows 5 requests a minute per IP.
  - Each install can submit 5 times a day.
  - The workflow opens at most 50 new issues a day.
  - An install with 3 declined issues is ignored from then on.
  - The same text from another install becomes a comment on the existing issue, not a new issue. Repeats from the same install are dropped.
  - Dropped submissions still get a 202, so a submitter can't tell they were filtered.
- **Accepting.** The webhook acts only when all of these hold:
  - an approver (`LINEAR_APPROVER_IDS`) moved the issue
  - the issue was in Triage
  - the issue has the workflow's source label

  It then adds `agent:build` and the GA roadmap project. Past 5 agent builds a day, it adds only the project and leaves a comment.
- **Public text.** The repo is public and Linear syncs the issue to it. The issue body says the text came from a user and must be treated as a report. Every line is quoted and every `@` is defused so it can't mention anyone.

## One-time setup

### Linear

1. **Turn on Triage for MET**: Settings → Teams → Metrists → Triage. The Worker files every submission there, and refuses submissions while Triage is off.
2. **Create two team labels in MET**: `Feedback` and `agent:build`. The Worker looks up labels and projects by name, so no ids go into config.
3. **Check what syncs.** Under Settings → Integrations → GitHub, confirm the MET → `notefig/notefig` issue sync is on and that labels sync. If Triage issues sync before you accept them, unreviewed feedback is public as soon as it arrives. Decide whether that's acceptable.
4. **Create an API key** (Settings → Security & access → Personal API keys) with write access to MET. Create it on your own account: synced issues are authored by the GitHub account linked to the Linear user who created them, and the workflow only runs on issues authored by accounts in `AGENT_ISSUE_AUTHORS`.
5. **Add a webhook** (Settings → API → Webhooks):
   - URL: `https://intake.notefig.com/v1/linear/webhook`
   - Resource: Issues
   - Team: Metrists

   Copy its signing secret.
6. **Add an issue template** for starting builds by hand (Settings → Teams → Metrists → Templates): name it **Agent build**, with label `agent:build` and project GA roadmap. Issues you create from it skip Triage and go straight to the agent once they sync. The Worker's daily cap doesn't apply to them.

Day to day:

| In Triage | What happens |
|---|---|
| **Accept** (any open status) | `agent:build` and GA roadmap are added, the issue syncs, and the agent opens a PR |
| **Decline** | Nothing visible. The submitter is ignored after 3 declines |
| **Mark as duplicate** | Recorded, no penalty |
| Accept without a build | Remove `Feedback` before accepting |

### Cloudflare

```sh
cd packages/intake
npx wrangler secret put LINEAR_API_KEY          # from step 4
npx wrangler secret put LINEAR_WEBHOOK_SECRET   # from step 5
npx wrangler secret put SUBMITTER_SALT          # any long random string; never change it
npx wrangler deploy
```

After that, `deploy-intake.yml` deploys on every push to `main` that touches this package. Its `CLOUDFLARE_API_TOKEN` needs **Workers Scripts: Edit** and **Workers Routes: Edit** on the notefig.com zone, on top of the Pages permissions the marketing deploy already uses.

Add these WAF rules on the notefig.com zone (Security → WAF). They drop junk before it reaches the Worker:

- **Rate limiting rule:** path starts with `/v1/workflows/`, more than 20 requests in 10 minutes per IP, then block for an hour.
- **Custom rule:** host is `intake.notefig.com` and `ip.src.asnum` is a hosting provider (for example `16509 14618 15169 396982 14061 24940 16276 8075`), then Managed Challenge. Real users send feedback from home and office networks, not cloud servers.
- **Custom rule:** host is `intake.notefig.com` and the method isn't `POST` or `OPTIONS`, or the path is outside `/v1/` and `/health`, then Block.

### GitHub

1. **Create a GitHub App** (for example `notefig-agent`) installed on `notefig/notefig`. Give it Contents: write and Pull requests: write, and **not** Workflows. Without Workflows, a push that touches `.github/` is refused.
2. **Create an environment `agent`** (Settings → Environments). Restrict it to the `main` branch and add:
   - secret `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`
   - secret `AGENT_APP_PRIVATE_KEY`
   - variable `AGENT_APP_ID`
3. **Add repository variables:**
   - `INTAKE_URL` = `https://intake.notefig.com`. Release and site builds read it, and leaving it unset hides "Send feedback".
   - `AGENT_ISSUE_AUTHORS` (optional) = `["parsasi"]`
   - `AGENT_REVIEWER` (optional) = `parsasi`
   - `AGENT_EGRESS_POLICY` (optional): set it to `audit` for the first run, then check the harden-runner report for hosts the run needed that the allowlist is missing.
4. **Protect `main`** so it requires your approving review. The bot then can't merge.

## Before turning it on

Send one piece of feedback from a dev build (`VITE_INTAKE_URL=https://intake.notefig.com npm run dev:desktop`), then check:

- [ ] It lands in MET Triage with `Feedback` and a kind label.
- [ ] The GitHub issue's author is in `AGENT_ISSUE_AUTHORS`. If it shows a Linear bot account instead, add that login.
- [ ] Accepting it adds `agent:build` and GA roadmap in Linear, and the label reaches the GitHub issue.
- [ ] `agent-build.yml` starts and opens a PR that requests your review.

## Local development

```sh
npm run test -w packages/intake
npm run build -w packages/intake      # typecheck
cd packages/intake && npx wrangler dev
```

## Known gaps

- The agent step's network allowlist includes `github.com` and the npm registry, which the job needs. A prompt-injected run could still push data to an attacker's repository or package with credentials the attacker supplies. Your review of the issue before accepting it, and of the PR, is the backstop.
- Manually started builds (the template, or adding the label yourself) aren't counted against the daily agent cap.
