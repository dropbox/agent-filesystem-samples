# AGENTS.md

Public repo of DBX Agent Filesystem samples. Each top-level folder is one self-contained sample. Read its `README.md` before changing it.

## Wayfinding

- `foldersync/`: desktop Electron app in TypeScript, macOS today (`src/engine/` sync and Dropbox client, `src/main/` main process, `src/renderer/` window, `test/` Vitest tests).
- `foldersync/tokenserver/`: Go token server that holds the app secret and mints managed-user tokens.

## Build and test

From `foldersync/`, for what you changed:

- `npm ci` once, then `npm run typecheck` and `npm test`. Tests use fakes and need no Dropbox account.
- `cd tokenserver && go vet ./... && go test ./...`
- `npm run build:tokenserver && npm run package`: builds `out/FolderSync-mac-arm64.zip` (macOS only).
- Don't run anything that calls the real Dropbox API unless the user gives you a test app and credentials.
- Format TypeScript with `npx prettier --write --print-width 100 --single-quote --no-bracket-spacing --trailing-comma es5 <files>`.

## Rules

- Sync must never delete or overwrite a file that changed in Dropbox since the last sync: delete with `delete_v2` and `parent_rev`, upload edits in `update` mode with the known rev, and upload new files in `add` mode.
- No fallback logic or made-up defaults. Fail with a clear error.
- Tests must not assume a case-insensitive file system, a non-root user, or that `chmod` blocks access. Skip with a reason where the platform can't support a test.
- Public repo: no secrets, tokens, user IDs, internal hostnames or links, or people's names in code, commits, or pull requests. Use placeholders like `<your_app_key>`.
- Don't describe security problems in public issues, pull requests, or commits. See `SECURITY.md`.
- Keep comments short and about what the code does. Match the surrounding code.
