# Try the useful part first

Problem: before opening a repository in a coding agent, determine which commands
its configuration would start and whether it redirects a model API endpoint.

From an AgentCrash checkout with Node 20 or later, run a four-case local trial:

```sh
node agents/trial.mjs
```

It invokes the actual inspection CLI on synthetic configurations: an MCP server,
a session hook, an endpoint redirect and an ordinary build script that should
not be reported as agent startup. It does not install or execute any configured
commands. There are no accounts, keys, network requests or telemetry.

For a report you choose to keep:

```sh
node agents/trial.mjs --output agentcrash-trial.json
```

The command refuses to overwrite an existing report. It records source hashes,
expected findings, observed findings and outcomes. These are synthetic test
results, not an attestation of real-world safety or independent adoption.

Then try the actual task on a local repository you are permitted to inspect:

```sh
node bin/agentcrash.js inspect /absolute/path/to/repository --json
```

Exit 1 means blocking findings, with valid JSON output; exit 2 means an invalid
request or inspection failure. The catalog describes the interface:
[agents/catalog.json](catalog.json). For MCP setup, see the main README.

## Tell us where it failed to help

If you choose, [open an Agent trial report](https://github.com/croviatrust/agentcrash/issues/new?template=agent-trial.yml).
Describe the actual task, the obstacle and whether you would use it again.
The synthetic trial JSON is optional. Do not include your repository's private
configuration or model credentials. No report is uploaded automatically.

Reports are treated as self-reported feedback. Stars, trial counts and generated
reports are not counted as retained users. Real adoption must be supported by
actual task use and subsequent reuse, with the limitations of those reports
kept explicit.
