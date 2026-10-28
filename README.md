# DBX Agent Filesystem samples

Sample apps and services for [DBX Agent Filesystem](https://docs.dropboxapi.com/agentfs/docs/get-started/introduction), which gives users and agents persistent file storage in your product. The [API reference](https://docs.dropboxapi.com/agentfs/api-reference/overview) covers the endpoints the samples call.

## Samples

| Sample | What it shows |
|---|---|
| [FolderSync](foldersync/) | A desktop app that keeps a project folder in sync with a managed user's Dropbox. It runs on macOS today. It signs users in through a small token server that keeps the app secret, gives each project an agent limited to that project's folder, writes as that agent, and undoes the agent's writes. |

Each sample has its own README with setup steps.

## Support

These samples show how to build on DBX Agent Filesystem, and they change along with its API. Use them as starting points for your own code, not as production code. For bugs or questions about a sample, open a GitHub issue. Report security problems as described in [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, tests, pull requests, and the Dropbox Contributor License Agreement.

## License

Unless otherwise noted:

    Copyright (c) 2026 Dropbox, Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
