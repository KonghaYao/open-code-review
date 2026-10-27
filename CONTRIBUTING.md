# Contributing to peri-code-review

Thank you for contributing to the `peri-code-review` MCP server. This project
is MCP-only: it exposes code review state to Peri and never calls a model or
runs an agent itself.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and
inclusive environment. Please be kind and constructive in all interactions. See
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Ways to Contribute

- Report bugs with reproduction steps.
- Suggest improvements to the MCP tools, resources or contract.
- Improve the documentation under [`docs/peri-mcp/`](docs/peri-mcp/).
- Review pull requests.
- Write code, tests or fixtures.

Do not propose model providers, agent orchestration, IDE extensions or a review
CLI: those surfaces are out of scope for this repository.

## Getting Started

### Prerequisites

- [Go 1.26.9+](https://go.dev/dl/)
- [Git](https://git-scm.com/)
- [Make](https://www.gnu.org/software/make/)

### Setup

```bash
# 1. Fork the repository on GitHub

# 2. Clone your fork
git clone https://github.com/<your-username>/open-code-review.git
cd open-code-review

# 3. Add upstream remote (for syncing updates)
git remote add upstream https://github.com/KonghaYao/open-code-review.git

# 4. Build the MCP server
make build

# 5. Run the tests
make test
```

`make build` writes `bin/peri-code-review`. Run
`./bin/peri-code-review version` to confirm the build.

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
feat(tools): add a bounds field to review_context
fix(store): keep request keys stable across retries
docs(contract): clarify review_finish outcomes
```

Commit messages must be in English. Do not add AI attribution trailers.

### AI Assistance

If you use AI/LLM tools, disclose that in your pull request and name the
tools/models used. You must understand and review every generated line, and you
must answer maintainer questions yourself. See
[`AGENTS.md`](AGENTS.md) for the full rules.

### License Headers

Every source file must include an SPDX license header. After creating new
files, run:

```bash
make license-add
```

`make license-check` verifies tracked source files.

### Formatting and Checks

Run before opening a pull request:

```bash
make check
make test
```

`make check` runs the license and English checks, formats and tidies the code,
and runs `go vet`. `make test` sets `LC_ALL=C` so git emits English messages.

Source files are English-only. Do not put translated prose in code; Markdown
documentation is not scanned and is the right place for translations.

## Pull Requests

- Keep the change focused and explain the motivation in the PR description.
- Include tests for behavior changes.
- Update [`docs/peri-mcp/contract.md`](docs/peri-mcp/contract.md) when a tool
  schema, error code, resource URI, idempotency rule or state layout changes.
- Make sure CI passes: `go test ./...`, `go vet ./...`, the license check and
  the English check.
- Do not commit generated binaries, local state or `go.local.*` files.

## Reporting Security Issues

Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting as described in [`.github/SECURITY.md`](.github/SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, as described in [`LICENSE`](LICENSE).
