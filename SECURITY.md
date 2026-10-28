# Security policy

## Reporting a vulnerability

Please don't report security problems in public issues, discussions, or pull requests.

- In a sample in this repo, such as FolderSync's token server or how it handles tokens: use [private vulnerability reporting](https://github.com/dropbox/agent-filesystem-samples/security/advisories/new) for this repository.
- In Dropbox or the Agent Filesystem API: use the [Dropbox bug bounty program](https://app.intigriti.com/programs/dropbox/dropbox), as listed in [security.txt](https://www.dropbox.com/.well-known/security.txt).

Include:

- the sample and commit
- what an attacker could do
- steps to reproduce
- logs or a proof of concept, with app secrets, access tokens, and connection keys removed

Maintainers review reports as soon as they can and coordinate the fix and any public disclosure.

## Before you deploy sample code

The samples are starting points, not hardened services. FolderSync's token server, for example, signs users in by name only and accepts requests only from the same computer. Keep your app secret on your own backend, behind your own sign-in, as FolderSync's README explains.
