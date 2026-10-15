# Synplex DSH workspace bridge

This adapter implements six MCP tools over stdio and the shared local HTTP connector. It prepares work for the current host only. It never starts an Agent, calls a model, uploads sources, or grants review/acceptance authority.

Run from the complete Synplex workspace (existing root dependencies required):

```sh
node adapters/dsh/mcp.mjs /absolute/path/to/dedicated-connection.json
```

The connection JSON has exactly `endpoint`, `tokenFile`, and `scope`. `endpoint` is a loopback HTTP origin with an explicit port. `tokenFile` is an absolute path to an existing owner-only regular credential file. `scope` explicitly contains `projectId`, `versionId`, and `branchId`; null is an exact default, never a wildcard. Credential text is read only by the shared connector and sent in the authenticated HTTP header. It is not accepted through JSON, environment, URL, stdio, or logs. The bridge reads no connection environment variables. Protect the connection file too if its paths are sensitive.

Tool schemas come directly from `services/workspace/service.mjs` `toolDefinitions()` and advertise the configured scope as a constant. The same scope is enforced on every call. Only `host_assist` / `current_host` preparation is accepted. The tool list is get_project_state, find_evidence, prepare_task, record_result, propose_lesson, get_operation. Tool failures preserve the shared error/retry contract; callers retain the original requestId and query operation receipts after uncertainty.

## Independent package and verified integration

2026-10-14: the previous network/source evidence limitation was resolved. The official deepseek-ai/deepseek-harness revision d743267388641bc76f17c45ce8b4c231aed1d32c MCP-client README, Config and lifecycle were read. Published Cordis 4.0.4, dsh-tools 0.2.0-rc.2 and dsh-mcp-client 0.2.0-rc.2 were installed into an isolated prefix with lifecycle scripts disabled. Actual Cordis loaded this extension, discovered six MCP tools, read real HTTP/SQLite state, prepared a full host_assist packet, and removed the tools on unload. No mock MCP client or model calls were used. This is an official-runtime check, not a desktop or model-driven task acceptance.

`extension.mjs` composes the official MCP-client with `ctx.plugin`, `inject=['tools']`, and explicit connectionFile. Cordis owns disposal. It never starts an Agent. The standalone package contains copied connector code and frozen tool schemas, no repository/service/Ajv dependency, no credential bytes, and no root source-tree path imports. Its peer version is pinned to the runtime actually verified. Do not use an arbitrary npm dist-tag as a compatibility claim.

Build a package (omit the connection argument for an unconfigured public candidate):

```sh
node plugins/build-dsh.mjs /absolute/path/to/package /absolute/path/to/private-connection.json
```

The package exposes `dsh.bundle.patch` and contains `cordis.patch.yml`. It can be packed from its output directory with `npm pack --ignore-scripts`. Configure `connectionFile` to an absolute private connection JSON, or supply the private packaged connection.json. Copies contain only endpoint, scope and a credential file path. They work only on the configured computer; never publish personal connection paths. Web downloads are authenticated project-specific private candidates.

Reproduce the isolated official-runtime check from the integration tree:

```sh
npm install --prefix .runtime/dsh-host-check --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/cordis@4.0.4 @deepseek-ai/dsh-mcp-client@0.2.0-rc.2 @deepseek-ai/dsh-tools@0.2.0-rc.2
node scripts/integration/dsh-host-check.mjs
```

The script creates a temporary synthetic project, invokes the real tool runtime, unloads the plugin and closes its own service. It never reads or changes the active DSH profile/app. Current desktop installation, autonomous model tool choice and cross-host business delivery remain separate acceptance steps. The former README's blocked-network statement described the earlier stage and is no longer a current blocker.
