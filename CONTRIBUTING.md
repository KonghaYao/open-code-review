# Contributing to peri-code-review

Thank you for contributing to `@konghaoyao/peri-code-review`. This project is a
TypeScript MCP server published to npm: it prepares Git review input, matches
the internal rule catalog, and validates and exports Ultracode review results
over local stdio. It never calls a model and never schedules agents itself.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and
inclusive environment. Please be kind and constructive in all interactions. See
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Ways to Contribute

- Report bugs with reproduction steps.
- Suggest improvements to the three tools, the skills, or the protocol in
  [`docs/contract.md`](docs/contract.md).
- Improve the documentation in [`README.md`](README.md) and [`docs/`](docs).
- Review pull requests.
- Write code, tests, skills or fixtures.

Do not propose model providers, agent orchestration, an HTTP server, IDE
extensions or a standalone review CLI: those surfaces are out of scope for this
repository.

## Getting Started

### Prerequisites

- [Node.js 24 LTS](https://nodejs.org/en/download) or newer (`engines.node >= 24`)
- [Git](https://git-scm.com/)
- npm (bundled with Node.js)

### Setup

```bash
# 1. Fork the repository on GitHub

# 2. Clone your fork
git clone https://github.com/<your-username>/open-code-review.git
cd open-code-review

# 3. Add upstream remote (for syncing updates)
git remote add upstream https://github.com/KonghaYao/open-code-review.git

# 4. Install dependencies
npm ci

# 5. Run the checks
npm run check
```

To try the server from source, run `npm run dev -- serve --repo <path>`. To test
the packaged CLI, run `npm run build` and then `npm run smoke:cli`; it links
`dist/cli.js` as an npm-style `.bin` symlink in a temporary directory and fails
on empty output.

### Line Endings

This project enforces LF line endings via `.gitattributes`. Configure Git to
normalize line endings automatically:

```bash
git config core.autocrlf input
```

## Development Workflow

### Branching

Create a feature branch from `main`:

```bash
git checkout main
git pull upstream main
git checkout -b feat/your-feature-name
```

Use prefixes to indicate the type of change:

| Prefix      | Purpose                               |
| ----------- | ------------------------------------- |
| `feat/`     | New feature                           |
| `fix/`      | Bug fix                               |
| `docs/`     | Documentation only                    |
| `refactor/` | Code refactoring (no behavior change) |
| `test/`     | Adding or updating tests              |
| `chore/`    | Build, CI, or tooling changes         |

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short summary>

[optional body]
```

Examples:

```
feat(tools): accept a commit range in prepare_code_review
fix(evidence): reject a finding location the fixed source does not hold
docs(contract): clarify export_code_review partial results
```

Commit messages must be in English. Do not add AI attribution trailers.

### AI Assistance

If you use AI/LLM tools, disclose that in your pull request and name the
tools/models used. You must understand and review every generated line, and you
must answer maintainer questions yourself. See [`AGENTS.md`](AGENTS.md) for the
full rules.

### License Headers

Every source file must start with the SPDX header:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
```

Add it when you create a file. There is no generator script; the header is
checked in review. Do not edit existing copyright notices.

### Checks

Run before opening a pull request:

```bash
npm run check
```

`npm run check` runs `npm run typecheck` (`tsc --noEmit`) and `npm test`
(Vitest). Use `npm test -- <pattern>` to run a subset while iterating. For a
release-style pass, also run `npm run build` and `npm pack --dry-run`.

Source files are English-only: comments, identifiers and strings alike.
Translated prose belongs in Markdown documentation, not in code.

## Pull Requests

- Keep the change focused and explain the motivation in the PR description.
- Include tests for behavior changes. Tests that need Git create their own
  temporary repositories and clean them up.
- Update [`docs/contract.md`](docs/contract.md) when a tool schema, error code,
  resource URI or run-record format changes, and
  [`docs/migration.md`](docs/migration.md) when behavior or configuration
  changes.
- Disclose AI/LLM assistance and review all generated content yourself.

## Reporting Security Issues

Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting as described in [`.github/SECURITY.md`](.github/SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, as described in [`LICENSE`](LICENSE).
