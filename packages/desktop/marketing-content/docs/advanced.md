---
title: Advanced
description: Self-hosted infrastructure — run your own git server and CI runners.
order: 10
---
# Advanced

This section covers self-hosted infrastructure. Most users can skip this and use GitHub or the hosted options.

## Self-Hosted Git

Run your own git server instead of using GitHub or GitLab. This gives you complete control over your repositories and data. See [Self-Hosted Git](/docs/git-server).

## Custom Runners

Use your own CI/CD infrastructure instead of GitHub Actions or GitLab CI. See [Custom Runners](/docs/runners).

## Architecture

```
Git Repository → CLI Build → Static Files → Web Server
```

The git server stores your markdown. The CLI processes it. Your web server serves the result. Each component can be self-hosted or provided by a third party.
