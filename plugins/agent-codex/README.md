# Codex

The Codex plugin connects the gateway to Codex App Server. It resumes each chat's Codex thread and applies chat-level model, reasoning effort, and speed settings on the next turn.

## Configuration

Add an entry under `agents` in `tsugimori.json`.

```json
{
  "id": "codex",
  "kind": "codex",
  "enabled": true,
  "version": "1.2.3",
  "model": "default",
  "thinking": "medium",
  "serviceTier": "default",
  "compactAt": 250000,
  "options": {
    "command": "codex",
    "codexHome": "agents/codex/home",
    "asyncCompaction": false
  }
}
```

| Key                                    | Default and behavior                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `kind`, `enabled`                | Choose a unique agent ID and use kind `codex`. `enabled` defaults to `true`.                                                                                                                                                                                                                                   |
| `version`                              | Optional managed release pin. Replace the example with an installed release or omit it. The gateway uses the entrypoint recorded in `runtime/codex/<version>/codex-package.json`, falling back to `bin/codex` or `bin/codex.exe` within that release directory. A pin takes precedence over `options.command`. |
| `options.command`                      | Unpinned executable, default `codex` on PATH. Paths containing a slash or backslash resolve from the workspace.                                                                                                                                                                                                |
| `options.codexHome`                    | Login and configuration directory, default `agents/<id>/home`. Relative paths resolve from the workspace. The plugin sets `CODEX_HOME` to this directory.                                                                                                                                                      |
| `model`, `thinking`, `serviceTier`     | Optional overrides of Codex defaults. Reasoning levels for `/thinking` are `minimal`, `low`, `medium`, `high`, and `xhigh`. Codex accepts provider tiers, including `fast` and `default` (standard speed).                                                                                                     |
| `compactAt`, `options.asyncCompaction` | Target token count (default 250,000) and opt-in to CLI async compaction (default `false`). See below.                                                                                                                                                                                                          |

Codex's native defaults come from the top-level `model`, `model_reasoning_effort`, and `service_tier` keys in its home directory's `config.toml`. The gateway refreshes those values on workspace reload. The child process also inherits `OPENAI_API_KEY`, `CODEX_API_KEY`, and `OPENAI_BASE_URL` when set in the process environment. Guided setup uses ChatGPT device sign-in and stores login credentials in the instance home.

## Guided setup

Run `corepack pnpm exec tsugimori add agent codex --dir ./ws` or `/add agent codex [--id <id>]` as the owner.

1. Setup installs the full managed release archive for the host and verifies the published SHA-256 digest. Managed installation supports Linux, macOS, and Windows on x64 and arm64 when a matching package exists.
2. Setup runs `codex login --device-auth` in the instance home. Open the displayed sign-in URL, enter the device code, then type `yes` to confirm the reported ChatGPT account.
3. Setup runs a test turn and saves the enabled agent entry with its installed version.

For an existing agent, use `/login <id>` or `corepack pnpm exec tsugimori setup login <id> --dir ./ws`. The Codex re-login flow runs the sign-in step and final checks. Use `corepack pnpm exec tsugimori setup ./ws --upgrade` to refresh managed release pins and their accompanying helper executables.

## Checks and status

`tsugimori doctor` checks the executable, the version and `codex-code-mode-host` helper for managed installs, login status, and the CLI's supported compaction timing. Use setup with `--upgrade` to repair a managed install missing that helper. Unsupported compaction timing is a warning.

For a chat routed to Codex, `/status` shows the implementation, effective model, effort and speed, context usage, session age, and cached provider quota and compaction details when available. The gateway uses reported session information and the configured or native defaults it knows about. **System** lists the agent's attachment state.

## Execution records

Codex reports the active model and reasoning effort through the SDK `model` event when the app server supplies them. It emits `reasoning` events for visible reasoning summaries supplied by the server.

## Compaction

The gateway configures Codex's post-turn compaction on supported CLIs. Set `options.asyncCompaction` to `true` to use async compaction when the CLI supports it. These modes derive a percentage threshold from `compactAt` and the model context window. With an unknown model window or unsupported timing, native auto-compaction is the fallback.

The native safety net uses `model_auto_compact_token_limit`. Its value is the larger of `compactAt × 1.6` (rounded up) and `compactAt + 150,000`, capped at the known model context window and subject to Codex's own limits. `compactAt` must be a positive safe integer. Owners can use `/compact` for the existing session. Traces record compaction timing and before/after context counts when reported. [Rolling summaries](../../README.md#context-and-summaries)

## Inbound images

The connector defaults to a 2,048 px long edge and a high-detail pixel budget
of 2,500 × 32² pixels. The OpenAI vision guide documents a 512 MB total image
payload and up to 1,500 images per request. The connector uses a 10,000,000 byte
per-image default to keep App Server messages small. Set
`agents[].options.imageMaxEdge` and `agents[].options.imageMaxBytes` to change
these limits. Images are sent as inline data URLs in App Server `turn/start`.

[OpenAI image input requirements and model sizing](https://developers.openai.com/api/docs/guides/images-vision)
and [Codex App Server turn input](https://developers.openai.com/codex/app-server#turns)

Set `agents[].options.imageMaxPixels` to change the pixel budget. Automatic
previews download up to 32 MiB per source attachment by default. Use
`agents[].options.imageSourceMaxBytes` to change the source limit.
