# AGENTS.md

Public repo of DBX Agent Filesystem samples. Each top-level folder is one self-contained sample. Read its `README.md` before changing it.

## Wayfinding

- `foldersync/`: desktop Electron app in TypeScript, macOS today (`src/engine/` sync and Dropbox client, `src/main/` main process, `src/renderer/` window, `test/` Vitest tests).
- `foldersync/tokenserver/`: Go token server that holds the app secret and mints managed-user tokens.

## Build and test

From `foldersync/`, for what you changed:

- `npm ci` once, then `npm run lint`, `npm run typecheck`, and `npm test`. Tests use fakes and need no Dropbox account.
- `npm run format` formats the TypeScript and scripts with Prettier. CI checks it with `npm run format:check`.
- `cd tokenserver && go vet ./... && go test ./... && golangci-lint run` (golangci-lint 2.15 or later, built with Go 1.27 or later).
- `npm run build:tokenserver && npm run package`: builds `out/FolderSync-mac-arm64.zip` (macOS only).
- CI (`.github/workflows/ci.yml`) calls `foldersync.yml`, which runs these checks plus ShellCheck and `govulncheck` when a pull request changes `foldersync/` or FolderSync's workflows; its jobs skip otherwise. A new sample needs its own workflow with the same first job, called from `ci.yml` and added to `all-passed`.
- Releases: `.github/workflows/foldersync-release.yml`, run by hand on `main`. See "Releasing FolderSync" in CONTRIBUTING.md.

## Local live e2e tests

- `npm run test:e2e` runs the local live e2e tests in `test/e2e/` against real Dropbox through a token server. It creates and deletes managed users. Running them before a PR that changes sync, tokens, agents, or the token server is highly recommended. A maintainer runs them before every release.
- Never ask for, read, or pass on an app secret. Ask the user to run `npm run build:tokenserver && npm start` for their test app in their own terminal. It asks for the secret without showing it and never saves it.
- Then run `FOLDERSYNC_E2E_TOKEN_SERVER=http://127.0.0.1:8787 npm run test:e2e` (about 10 minutes) and put the result in the PR's test plan.
- Only use an app the user named as a test app.
- A run stops at once if the token server isn't running. A failed run keeps its log in `out/e2e/`, with tokens and the secret redacted. Don't paste tokens or connection keys anywhere.

## Rules

- Sync must never delete or overwrite a file that changed in Dropbox since the last sync: delete with `delete_v2` and `parent_rev`, upload edits in `update` mode with the known rev, and upload new files in `add` mode.
- No fallback logic or made-up defaults. Fail with a clear error.
- Tests must not assume a case-insensitive file system, a non-root user, or that `chmod` blocks access. Skip with a reason where the platform can't support a test.
- Public repo: no secrets, tokens, user IDs, internal hostnames or links, or people's names in code, commits, or pull requests. Use placeholders like `<your_app_key>`.
- Don't describe security problems in public issues, pull requests, or commits. See `SECURITY.md`.
- Keep comments short and about what the code does. Match the surrounding code.
