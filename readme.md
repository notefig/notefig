# <img src="https://notefig.com/images/metrists-abstract.svg" height="25" />&nbsp;&nbsp;Notefig [![Downloads Per Month](https://img.shields.io/npm/dm/notefig)](https://www.npmjs.com/package/notefig) [![Top Language](https://img.shields.io/github/languages/top/notefig/notefig)](https://github.com/notefig/notefig/) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT) [![CI Tests](https://github.com/notefig/notefig/actions/workflows/ci-tests.yml/badge.svg)](https://github.com/notefig/notefig/actions/workflows/ci-tests.yml) [![Desktop Release](https://github.com/notefig/notefig/actions/workflows/release-desktop.yml/badge.svg)](https://github.com/notefig/notefig/actions/workflows/release-desktop.yml)

---

Notefig publishes text artifacts — written and refined with the help of AI agents — from markdown source. The primary way to work with Notefig is the **[desktop app](https://notefig.com)** — a local editor that facilitates you and your agents collaborating on the same files in real time.

This repo also contains the **Notefig CLI**, which powers the desktop app under the hood (builds, publishing, agent pairing) and remains fully usable on its own if you'd rather drive things from the terminal.

## Getting Started

The fastest way in is the desktop app: [download it from notefig.com](https://notefig.com), open a folder, and start writing — agents can read and edit the same files you do.

Prefer the terminal? Create a new directory and run:

```bash
npx notefig watch --noob
```

Modify the markdown files. You can then publish:

```bash
npx notefig publish
```

That's it. You can push your files to a repository and connect your CI/CD pipeline. From now, every time you push to your repository, Notefig will automatically publish your artifact.

## Using AI agents from the web app (`notefig agent`)

The Notefig web app can drive AI coding agents (Claude Code, OpenCode, …)
that run on **your** machine. The browser can't spawn processes, so a small
local worker does it for you:

```bash
npx notefig agent
```

This starts a local worker in the current folder, prints a QR code + pairing
link, and opens your browser to pair. The agent runs on your machine and edits
files directly; the web app talks to it over an end-to-end-encrypted
connection (the pairing code never reaches any server — it rides the link
fragment). Leave it running while you work; `Ctrl-C` stops it.

This is the same pairing flow the desktop app uses under the hood — the CLI
command is there for anyone who wants it without installing the app.

Options:

| Flag                 | Purpose                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dir <path>`       | Folder the agent operates on (default: current dir).                                                                                                         |
| `--port <n>`         | Pin the local WebSocket port (default: ephemeral).                                                                                                           |
| `--app-url <url>`    | Web app to open/pair with (default: `https://app.notefig.com`; or set `NOTEFIG_APP_URL`).                                                                  |
| `--no-open`          | Don't auto-open the browser.                                                                                                                                 |
| `--tunnel-url <url>` | Pair over a `wss://` tunnel you provide (ngrok, Tailscale Funnel, your own proxy) instead of `ws://127.0.0.1` — for reaching the worker from another device. |

The worker only ever spawns the harnesses it already knows about
(Claude Code / OpenCode / …) and never runs anything received over the
connection. See the app's "Connect a machine" dialog for pairing.

### Documentation

Follow [the full documentation](https://notefig.com/docs) to get started building your own project.

## Features

- Live reload while in watch mode
- Fast and incremental builds
- Static web export
- `.epub` export

## Roadmap

See [our docs](https://notefig.com/docs) for more information about where we are taking Notefig.

## Contributing

This package is a beginner-friendly package. If you don't know where to start, visit [Make a Pull Request](https://makeapullrequest.com/) to learn how to make pull requests.

Please visit [Contributing](CONTRIBUTING.md) for more info.

## Code of Conduct

Please visit [Code of Conduct](CODE_OF_CONDUCT.md).

---

# License

MIT
