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

## Local development

Create `.dev.vars`. It's gitignored, and its values override `[vars]`:

```ini
LINEAR_API_KEY=lin_api_...
ALLOWED_ORIGINS=http://localhost:1420
```

Then run `npm run dev` here, and `VITE_SUPPORT_URL=http://localhost:8787
npm run dev:desktop` at the repository root. A real key files real issues,
so use a test team's ids in `.dev.vars` if you don't want them in MET.
