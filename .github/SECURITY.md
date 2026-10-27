# Security Policy

## Supported Versions

| Version | Supported |
| - | - |
| Latest npm release | Yes |
| Older releases | No |

The released artifact is the npm package `@konghaoyao/peri-code-review` with
the `peri-code-review` bin, run on Node.js 24 LTS or newer. Only the latest
release receives security updates.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public issues.**

Use GitHub's private vulnerability reporting for this repository: open the
**Security** tab and choose **Report a vulnerability**. If private reporting is
unavailable, contact the maintainers privately through a channel listed on
their GitHub profiles.

### What to Include

- A description of the vulnerability and its potential impact.
- Step-by-step instructions to reproduce the issue.
- Affected version(s) and platform.
- Any suggested fix or mitigation, if available.

## Scope

The `peri-code-review` MCP server is in scope. Examples:

- Path traversal or symlink escapes that read outside the bound repository or `workflow-root`.
- Writing outside `output-dir`, overwriting an existing report, or following a symlink out of the output directory.
- Reviewing mutable input, or reconstructing an exportable result from journal fragments when the workflow has no complete return value.
- Command injection through Git arguments or repository paths.
- Reading or exporting secret paths (`.env`, private keys and similar) despite the hard exclusion.
- A workflow run identifier or long-text reference that escapes its run directory.
- Exporting a finding whose location does not resolve in the reviewed Git revision, or writing a report before that evidence validation runs.

Out of scope:

- Vulnerabilities in Peri itself, in the host model, or in third-party
  dependencies that are not exploitable through this server.
- Denial of service that requires local access to the process.
- Social engineering attacks.

## AI Policy

You may use AI or LLM tools while investigating a vulnerability, but the
responsibility for anything you submit rests entirely with you. Treat
model-generated text as an unverified draft and disclose how AI was used.
Keep reports focused on what a maintainer needs to reproduce and fix the issue.

## Response Timeline

- Acknowledgment: within 3 business days.
- Initial assessment: within 7 business days.
- Fix and coordinated disclosure: as soon as practical for confirmed issues.
