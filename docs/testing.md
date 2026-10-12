# Testing and release

Different checks establish different facts. Do not label offline fixture results as provider-backed acceptance or claim an npm publication from a package dry-run.

## Local, offline checks

```sh
npm ci --ignore-scripts
npm run check
npm run pack:check
npm run qualify:package
```

`check` includes strict TypeScript and Node tests for lifecycle, hashing, private/exclusive storage, writer recovery, shell/path policy, drift, question/approval boundaries, Markdown rendering, and review validation. Integration/acceptance tests use **Pi's real public SDK** with a deterministic native provider and scripted RPC UI responses. They exercise nested gates, current-session completion, declined approval, linked destination setup, restoration, branching, compaction, and separate reviewer usage.

`qualify:package` creates/extracts an actual npm tarball and loads its extension through the installed Pi CLI. Isolated temporary directories and an offline deterministic provider exercise text, JSONL, and the actual RPC UI protocol. The RPC fixture declines approval, then approves a harmless local fixture and completes it with native Bash evidence. It also installs/removes the package in a disposable profile while preserving artifacts, and drives a real Pi terminal through a Python standard-library PTY. The terminal exercise covers question dismissal/explicit answering, scroll/resize, edit/parent diff, fresh destination setup, declined approval, and completion. No real provider, user project, or live configuration is used. Runtime test resources are not shipped in the tarball. Development qualification requires Python 3 and `tar`; installed users do not need these test dependencies.

TUI component tests additionally cover real Markdown rendering, width bounds, controls, and viewport behavior. Automated terminal testing is not a claim of human usability testing or compatibility with every terminal.

## Provider-backed qualification

Provider calls are opt-in and must identify the model and credentials deliberately:

```sh
PLANROOM_LIVE_MODEL=provider/model-id \
PLANROOM_LIVE_AUTH=/path/to/your/pi/auth.json \
  npm run qualify:live
```

The script uses an in-memory copy of only the selected provider's credential, an isolated agent directory/workspace, disabled catalog refresh/background warming/retries, bounded provider requests/output, and an explicit deadline. It does not install Planroom into a live profile or rewrite credential/configuration files. Providers may still bill cancelled/failed requests. Review the script before supplying credentials, and do not run it against live systems.

The budget is eight model dispatches, 2,048 output tokens per request, 30-second supported client timeouts, and a 120-second overall abort deadline. Limits are best effort for provider implementations. `PLANROOM_LIVE_REPORT` can explicitly save a private failure diagnostic outside the checkout; do not publish it. Results distinguish investigation/submission, declined approval, and an approved fixture implementation with acceptance evidence. A failure blocks a provider-backed qualification claim; no fallback model or invisible retry is selected. Provider responses/transcripts are runtime data and must not be committed to the public repository. Print only a sanitized pass/fail and usage summary.

## Supported matrix

- Minimum runtime: Node 22.19, Pi 1.1.0.
- Primary target: Linux with local POSIX storage.
- macOS: covered by the CI matrix when those jobs pass; not inferred from a Linux run.
- Newer Node/Pi: compatibility must be verified, not assumed from a peer range.
- Windows/network filesystems: unqualified.

CI runs deterministic checks and packaged CLI qualification on Linux/Node 22 and 24 and macOS/Node 24. Live-provider calls and human usability checks are not hidden in credential-free CI; automated real-terminal acceptance is included.

## Release gate

Before tagging/publishing:

1. Ensure the working tree contains only intended package changes and no secrets or runtime artifacts.
2. Run `check`, `pack:check`, and `qualify:package` against the exact release tree.
3. Run bounded provider-backed acceptance against a deliberately chosen available model.
4. Require automated real-terminal acceptance, plus the SDK restoration/abort/failure checks. Perform additional human usability checks when available, and identify them honestly rather than relabeling scripted fixture decisions.
5. Confirm documentation, package contents, version/Pi compatibility, license, and recovery behavior.
6. Require CI success; review dependency/platform limitations and security reports.
7. Create the public tag/release separately. npm publication requires authenticated npm authority (or configured trusted publishing), not just a GitHub login.
8. Test installation/removal in a disposable profile. Live activation is a separate user decision.

The release workflow is manual and environment-gated. It verifies that the release tag matches `package.json`, runs deterministic checks/qualification, creates a tarball, and can publish only when authorized by the release environment and npm credentials. Provider-backed qualification must be attested explicitly after a separate deliberate run; its private transcript is never an uploaded artifact. Never weaken these gates to make a release appear complete.
