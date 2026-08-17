---
title: Quick Start
description: Install the Notefig editor or CLI and publish your first book in minutes.
order: 1
---
# Quick Start

## Editor (Recommended)

**macOS**

Download from [GitHub releases](https://github.com/notefig/notefig/releases).

**Web (Chrome only)**

Open [app.notefig.com](https://app.notefig.com) in Chrome.

**Other platforms**

Linux and Windows support is in development.

## CLI

Install the CLI:

```bash
npm install -g notefig
```

Or use npx without installing:

```bash
npx notefig <command>
```

Start the development server in a folder of markdown files:

```bash
npx notefig watch
```

Build and publish when you're ready:

```bash
npx notefig build
npx notefig publish vercel
```
