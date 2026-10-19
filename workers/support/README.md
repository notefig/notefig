# support.notefig.com

The Cloudflare Worker behind the app's **Send Feedback** dialog. Later routes
(roadmap, and others like it) sit next to feedback as `/v1/<name>`.

`POST /v1/feedback` takes `{ message, version, os, debugReport? }` and files
it as an issue in MET's Triage, in the **Metrists Roadmap** project,
labelled `Feedback`. The message is markdown, filed as written and titled
with its first line's plain text; `@mentions` are broken, so an issue synced
to GitHub can't ping anyone.

MET syncs to the public GitHub repo, and the sync copies the title,
description and the issue's synced comment thread. So the description holds
only what the user wrote, with each screenshot as a "[Screenshot N]" marker
and no link. The screenshots and, when the user ticks "Include debug info",
the debug panel's report (up to 50,000 characters) go in a top-level comment
instead, which starts its own thread; Linear's sync doesn't copy comments
outside the synced thread, so they stay in Linear.

Screenshots come as `multipart/form-data`: the same JSON in a `feedback`
part, and each image as a file part named by its id, which the message
refers to as `![](attachment:<id>)`. Up to 3 images, each PNG, JPEG or
WebP (checked by its leading bytes, not just its type) and at most 2 MB.
Each one the message shows is uploaded to Linear's own file storage with
`fileUpload`. Multipart keeps the images as bytes: the runtime parses them
natively, well inside the Free plan's CPU time, where decoding base64 out
of JSON wouldn't be.

| Guard | How |
|---|---|
| 1 request a minute per IP | Workers Rate Limiting binding |
| Body over 8 MB | 413, read without buffering more |
| Calls from anywhere but the app | 403 unless `Origin` is one of `ALLOWED_ORIGINS` |

A Linear failure answers `502`, and the app keeps the draft so the user can
retry.

The Worker isn't an npm workspace. It has its own lockfile so wrangler stays
out of the root one, and its tests run on Node's built-in runner.

```bash
cd workers/support
npm ci
npm test
npm run typecheck
```

## One-time setup

1. **Linear**
   - Turn on Triage for the MET team. Put its status id in
     `LINEAR_TRIAGE_STATE_ID` in `wrangler.toml`. One way to find it is
     `query { team(id: "<LINEAR_TEAM_ID>") { states { nodes { id name type } } } }`.
   - Create an API key that can create issues. A dedicated member is best,
     because issues are created as whoever owns the key. Save the key as the
     GitHub secret `LINEAR_SUPPORT_API_KEY`.
2. **Cloudflare**
   - The deploy uses the existing `CLOUDFLARE_API_TOKEN`. It needs
     *Workers Scripts: Edit* and, on the
     notefig.com zone, *Workers Routes: Edit* and *DNS: Edit*, so the
     `support.notefig.com` custom domain can be created.
   - Optional: add a WAF rule on `support.notefig.com` that blocks anything
     other than `POST` and `OPTIONS`, so junk is stopped before the Worker
     runs.
3. **GitHub**
   - After the first deploy, set the repository variable
     `SUPPORT_URL=https://support.notefig.com`. Desktop releases built after
     that show **Send Feedback**.

`deploy-support.yml` deploys on every push to `main` that touches this
folder. It refuses to deploy while `wrangler.toml` still has a `REPLACE_`
placeholder.

## Agent

`POST /v1/linear` hands accepted feedback to a coding agent: a Claude Managed
Agents session, billed to the Anthropic API account. When an approver
(`APPROVER_IDS`) assigns an issue that's out of Triage to the agent account
(`AGENT_USER_ID`, Notefig Support), the Worker:

1. reads every comment on the issue from Linear, the private debug report
   included, and downloads the screenshots they show;
2. starts a session of the **feedback builder** (`agents/feedback-builder/`)
   with `notefig/notefig` attached on `main` and a hard spend cap of
   `AGENT_BUDGET_CENTS` (default $20). Its first message is the issue, its
   comments and the screenshots as images;
3. records the session for the issue in KV (`AGENT_SESSIONS`, 30 days) and
   comments on the issue with a link to the session in the Claude Console.

After that, the approver's comments on the issue, and edits to its title or
description, go to the same session as new messages, screenshots included.
A session that finished goes idle, and the message wakes it to continue on
its branch and PR. Only approvers' updates are forwarded: comments on the
public GitHub issue sync into Linear, so anyone else's would be a way to
instruct the agent. The Worker's own comments are never forwarded.

The agent works in Anthropic's sandbox and follows the rules in its system
prompt. It pushes an `agent/<issue>` branch and opens a PR through the
GitHub MCP server. The PR says `Closes <issue>`, so Linear links it to the
issue. The debug report stays inside the session: the system prompt
forbids copying it into commits or the PR.

| Check | How |
|---|---|
| The call is Linear's | HMAC-SHA256 of the raw body against `LINEAR_WEBHOOK_SECRET` (`Linear-Signature`), and a `webhookTimestamp` within 60 s |
| A person chose this | The assignment's actor must be in `APPROVER_IDS`. Feedback filed by anyone else never starts the agent on its own |
| It was accepted | The issue's state isn't Triage |
| It can't overspend | The session's `budget`: Anthropic pauses it at the cap |
| A retry can't act twice | Each Linear delivery (`Linear-Delivery`) the Worker acts on is claimed in KV first, so a retried one neither starts a second run nor repeats an update |
| Screenshots come from Linear only | The Worker downloads `uploads.linear.app` files only (at most 5 per message), and its key goes nowhere else |

Neither secret enters the sandbox. The repository token is used by
Anthropic's git proxy, and the GitHub MCP credential sits in a vault. The
sandbox reaches package managers and the agent's MCP server only. The
route answers `503` until every secret below is set. If a session won't
start, or an update can't reach it, the Worker says so on the issue:
assigning the agent again starts a new run.

### Setup

1. **The agent, environment and vault.** With the
   [`ant` CLI](https://github.com/anthropics/anthropic-cli)
   (`brew install anthropics/tap/ant`, then `ant auth login`), from
   `workers/support`:
   ```bash
   ant apply --dry-run agents/feedback-builder   # review the plan
   ant apply agents/feedback-builder             # create; writes claude-lock.json (commit it)
   ```
   To change the agent later, edit `agent.md` and run `ant apply` again.
2. **GitHub tokens.** Create two fine-grained tokens for `notefig/notefig`:
   - one for the repository (Contents: read and write), used for clone and
     push;
   - one for the GitHub MCP server (Pull requests: read and write).

   Store the second in the vault:
   ```bash
   VAULT_ID=$(jq -r '.resources["./agents/feedback-builder/vault.yaml"].id' claude-lock.json)
   read -rs GITHUB_MCP_TOKEN && export GITHUB_MCP_TOKEN
   jq -n '{display_name: "GitHub MCP", auth: {type: "static_bearer",
     mcp_server_url: "https://api.githubcopilot.com/mcp/", token: env.GITHUB_MCP_TOKEN}}' \
     | ant beta:vaults:credentials create --vault-id "$VAULT_ID"
   ```
   Protect `main` (require pull requests) so the agent's push can only go
   to its own branch.
3. **Linear webhook.** Settings → API → Webhooks: URL
   `https://support.notefig.com/v1/linear`, team MET, resources **Issues**
   and **Comments**. Copy the signing secret.
   The Worker's own Linear key (`LINEAR_API_KEY`, from the
   `LINEAR_SUPPORT_API_KEY` GitHub secret) should belong to Notefig Support,
   not an approver. Its issues and comments then come from the support
   account.
4. **Worker secrets**, once. Deploys keep them. The ids come from
   `claude-lock.json`:
   ```bash
   npx wrangler@4.151.1 secret put LINEAR_WEBHOOK_SECRET
   npx wrangler@4.151.1 secret put ANTHROPIC_API_KEY
   npx wrangler@4.151.1 secret put MANAGED_AGENT_ID        # agent.md's id
   npx wrangler@4.151.1 secret put MANAGED_ENVIRONMENT_ID  # environment.yaml's id
   npx wrangler@4.151.1 secret put AGENT_VAULT_ID          # vault.yaml's id
   npx wrangler@4.151.1 secret put AGENT_GITHUB_TOKEN      # the repository token
   ```

## Local development

Create `.dev.vars`. It's gitignored, and its values override `[vars]`:

```ini
LINEAR_API_KEY=lin_api_...
ALLOWED_ORIGINS=http://localhost:1420
```

Then run `npm run dev` here, and `VITE_SUPPORT_URL=http://localhost:8787
npm run dev:desktop` at the repository root. A real key files real issues,
so use a test team's ids in `.dev.vars` if you don't want them in MET.
