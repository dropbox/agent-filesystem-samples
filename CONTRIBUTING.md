# Contributing

Thanks for helping improve these samples.

## Before you start

- For non-trivial contributions, sign the [Dropbox Contributor License Agreement](https://opensource.dropbox.com/cla/).
- For a larger change, open an issue first so we can agree on the approach.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md), not in issues or pull requests.

## Repository layout

Each top-level folder is one sample, with its own README, dependencies, and tests:

- `foldersync/`: a desktop Electron app in TypeScript, and a token server in Go

## Working on FolderSync

You need Node.js 24 or later and Go 1.27.3 or later. The app runs on macOS on Apple silicon today.

```sh
cd foldersync
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
(cd tokenserver && go vet ./... && go test ./... && golangci-lint run)
```

CI runs the same checks on every pull request.

The local live e2e tests in `test/e2e/` run against real Dropbox with your own app's credentials; see "Local live e2e tests" in FolderSync's [README](foldersync/README.md#local-live-e2e-tests). We highly recommend running them before a pull request that changes sync, tokens, or agents. If you run them, include the result in your pull request. CI doesn't run them, so the repo never holds an app secret. Before a release, a maintainer runs them and includes the result in the pull request that changes the version.

The tests don't need a Dropbox account. They run against an in-memory Dropbox (`test/fakeDropbox.ts`) and a fake API (`test/fakeRpc.ts`). To build the app's zip file, run `npm run build:tokenserver && npm run package`. FolderSync's [README](foldersync/README.md#develop) lists the environment variables for development.

## Guidelines for sample code

- People copy sample code, so keep it small and easy to read. Comments say what the code does.
- Never commit real app keys, secrets, tokens, user IDs, or personal paths. Use placeholders such as `<your_app_key>`.
- Tests mustn't depend on the computer they run on. Don't assume a case-insensitive file system, a non-root user, or that `chmod` blocks access.
- FolderSync must never delete or overwrite a file that changed in Dropbox since the last sync. Add a test for any change to the sync rules.

## Pull requests

Keep each pull request to one change. In the description, say what changed, why, and how you tested it. A maintainer reviews and merges it.

## Reporting bugs

Include the sample and commit, your operating system, the steps, what you expected, and what happened. Remove access tokens, app secrets, and connection keys from logs.
