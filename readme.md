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
