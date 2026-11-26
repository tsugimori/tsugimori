# Local sandbox

This execution backend uses bubblewrap on Linux to isolate commands, files, and background services by conversation. Each chat has a persistent workdir.

## Configuration

Add the top-level `exec` section in `tsugimori.json`.

```json
{
  "exec": {
    "kind": "local-sandbox",
    "denyRead": ["~/private", "private-data"]
  }
}
```

`"exec": {}` enables the backend with kind `local-sandbox` and an empty list of additional read restrictions. `denyRead` accepts up to 64 distinct paths. Relative paths resolve from the workspace, and `~/` resolves from the service user's home. Built-in restrictions cover workspace credentials, agent login directories, and private host and chat paths. The backend needs no credentials.

## Setup, checks, and status

Install `bwrap` and enable unprivileged user namespaces on the Linux host. `corepack pnpm exec tsugimori setup [dir]` prints the package-manager command when bubblewrap is missing and a supported manager is present. Add `--yes` to run it. This plugin is configured in JSON.

`tsugimori doctor` checks the host platform, bubblewrap availability, and whether bubblewrap can create isolated namespaces. Host namespace policy or AppArmor can block that check. If these checks fail, the gateway disables its shell and file tools while chat remains available. The **System** section of `/status` shows sandbox availability.

## Tools and limits

| Agent tool                | Behavior                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec.run`                | Takes an argument vector `cmd`, optional `timeoutMs`, and optional `backgroundPort`. The default timeout is 30 seconds for a foreground command and 10 seconds to start a background service. An explicit timeout can be 1–300,000 ms. |
| `exec.read`, `exec.write` | Read and write UTF-8 files inside the current chat's workdir, subject to path restrictions.                                                                                                                                            |
| `exec.stop`               | Stops this chat's execution session and its background services.                                                                                                                                                                       |

Commands run with a minimal environment and isolated network. Persistent writes go to the chat workdir, mounted as `/workspace` inside the sandbox. A service started with `exec.run` and `backgroundPort` can be published from that chat through the [preview plugin](../tunnel-cloudflare/README.md). Rule and skill edits can be recorded by the gateway when Git is available. Agent connectors have their own built-in tool policies in addition to these gateway tools.
