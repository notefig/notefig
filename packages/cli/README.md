# <img src="https://metrists.com/images/metrists-abstract.svg" height="25" />&nbsp;&nbsp;Metrists [![Downloads Per Month](https://img.shields.io/npm/dm/metrists)](https://www.npmjs.com/package/metrists) [![Top Language](https://img.shields.io/github/languages/top/metrists/metrists)](https://github.com/metrists/metrists/) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT) [![<metrists>](https://github.com/metrists/metrists/actions/workflows/tests.yml/badge.svg)](https://github.com/metrists/metrists/actions/workflows/tests.yml)

---

Metrists acts as a Continuous Deployment pipeline for your books. It makes publishing books an incremental, quick and automated process.

## Getting Started

Create a new directory and execute the following command:

```bash
npx metrists watch --noob
```

Modify the markdown files. You can then publish your book:

```
npx metrists publish
```

That's it. You can push your files to a repository and connect your CI/CD pipeline. From now, every time you push to your repository, Metrists will automatically publish your book.

## Using AI agents from the web app (`metrists agent`)

The Metrists web app can drive AI coding agents (Claude Code, OpenCode, …)
that run on **your** machine. The browser can't spawn processes, so a small
local worker does it for you:

```bash
npx metrists agent
```

This starts a local worker in the current folder, prints a QR code + pairing
link, and opens your browser to pair. The agent runs on your machine and edits
files directly; the web app talks to it over an end-to-end-encrypted
connection (the pairing code never reaches any server — it rides the link
fragment). Leave it running while you work; `Ctrl-C` stops it.

Options:

| Flag | Purpose |
|------|---------|
| `--dir <path>` | Folder the agent operates on (default: current dir). |
| `--port <n>` | Pin the local WebSocket port (default: ephemeral). |
| `--app-url <url>` | Web app to open/pair with (default: `https://app.metrists.com`; or set `METRISTS_APP_URL`). |
| `--no-open` | Don't auto-open the browser. |
| `--tunnel-url <url>` | Pair over a `wss://` tunnel you provide (ngrok, Tailscale Funnel, your own proxy) instead of `ws://127.0.0.1` — for reaching the worker from another device. |

The worker only ever spawns the harnesses it already knows about
(Claude Code / OpenCode / …) and never runs anything received over the
connection. See the app's "Connect a machine" dialog for pairing.

### Documentation

Follow [the full documentation](https://metrists.com/docs) to get started building your own project.

## Features

- Live reload while in watch mode
- Fast and incremental builds
- Static web export
- `.epub` export (coming soon)

## Roadmap

See [our docs](https://metrists.com/docs) for more information about where we are taking metrists.

## Contributing

This package is a beginner-friendly package. If you don't know where to start, visit [Make a Pull Request](https://makeapullrequest.com/) to learn how to make pull requests.

Please visit [Contributing](CONTRIBUTING.md) for more info.

## Code of Conduct

Please visit [Code of Conduct](CODE_OF_CONDUCT.md).

---

# License

MIT
