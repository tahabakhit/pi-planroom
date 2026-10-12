# Contributing

Use an isolated development agent directory and temporary fixture workspaces. Do not commit authentication, runtime plans, reviewer artifacts, provider-backed transcripts, or personal configuration.

```sh
npm ci --ignore-scripts
npm run check
npm run pack:check
npm run qualify:package
```

Changes to tool policy, approval identity, branch restoration, persistence, or handoff need adversarial tests as well as the happy path. Prefer pure core tests plus public Pi SDK/CLI tests. A mocked API alone is insufficient for release qualification. Preserve existing host/repository authority; never add a model approval shortcut or automatic implementation on resume.

Public APIs only. Keep Pi libraries host-provided peers and avoid introducing an external coding/workflow engine. A provider-backed check must be explicit, bounded, and separately identified from offline results. Documentation must describe limitations honestly.

For a bug report include package/Pi/Node versions, platform, interface (TUI/RPC/print), steps, and sanitized errors. State whether there were in-flight effects. Do not upload an entire private plan or session as a default reproduction.

Release work is separate from local tests and installation. See [Testing and release](docs/testing.md).
