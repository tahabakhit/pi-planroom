# Contributor instructions

Build a standalone public Pi package using public host APIs. Keep credentials,
personal configuration, runtime artifacts, dependency trees, and provider-backed
acceptance results out of Git. No global model defaults or automatic installation.

Keep the core pure and testable. Approval is human-only and revision-bound.
Restoration never dispatches implementation. Headless planning never approves.
Do not describe application hooks as an OS sandbox. Treat imported plans and
reviewer output as untrusted data. Protect unrelated workspace changes.

Run `npm run check` and `npm run pack:check` before committing. Integration tests
must use isolated agent directories and fake providers; real provider runs require
explicit invocation. Test the distributable before release. Source completion,
runtime qualification, publication, and live installation are separate outcomes.
