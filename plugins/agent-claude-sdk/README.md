# Claude Agent SDK

This agent connector runs Claude through the Agent SDK and its bundled Claude Code CLI. It resumes sessions per chat, exposes gateway tools, and starts the SDK with local settings and skill discovery disabled.

## Configuration

Add an entry under `agents` in `tsugimori.json`.

```json
{
  "id": "claude",
  "kind": "claude-sdk",
  "enabled": true,
  "model": "default",
  "thinking": "low",
  "serviceTier": "default",
  "compactAt": 250000,
  "options": {
    "claudeHome": "agents/claude/home",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "tokenEnv": "CLAUDE_CODE_OAUTH_TOKEN"
  }
}
```

| Key                     | Default and behavior                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `kind`, `enabled` | Choose a unique agent ID and use kind `claude-sdk`. `enabled` defaults to `true`.                                                                                        |
| `model`, `thinking`     | Optional model and effort overrides. The SDK supplies its defaults when these are omitted. Supported `/thinking` levels are `low`, `medium`, `high`, `xhigh`, and `max`. |
| `serviceTier`           | `fast` enables SDK fast mode, and `default` selects standard speed. The gateway ignores other tier names for Claude. Availability depends on the model and account.      |
| `compactAt`             | Target context size in tokens. It must be a positive safe integer and defaults to 250,000.                                                                               |
| `options.claudeHome`    | Login directory. The default is `agents/<id>/home`. Relative paths resolve from the workspace.                                                                           |
| `options.apiKeyEnv`     | Name of the API key variable. The implicit name is `ANTHROPIC_API_KEY` when neither credential option is set.                                                            |
| `options.tokenEnv`      | Name of a Claude Code OAuth token variable. Set it explicitly for manual token authentication.                                                                           |

Choose the credential option for your authentication method and omit the other from the example. Credentials can come from the process environment or workspace `.env`. For browser sign-in, the wizard configures both credential options as `null`, which uses the login in `claudeHome` and suppresses the implicit API key. The SDK supplies the CLI version, so a workspace `version` field does not pin Claude.

## Web capabilities

Set `agentWeb.search` and `agentWeb.fetch` globally or override either under this agent's `web` object. Both default to `true`. Anthropic runs native `WebSearch` even in gateway execution scopes when search is enabled. The gateway provides `web.fetch` with public-address checks and response limits. Native Claude `WebFetch` is available only outside gateway execution scopes and only when fetch is enabled. It makes requests from the host with the existing approval flow. [Agent web capabilities](../../README.md#agent-web-capabilities)

## Guided setup

Run `corepack pnpm exec tsugimori add agent claude-sdk --dir ./ws` or `/add agent claude-sdk [--id <id>]` as the owner. For an existing instance, use `/login <id>` or `corepack pnpm exec tsugimori setup login <id> --dir ./ws`.

1. Choose `login` or `token`. For `login`, follow the supplied browser link, provide the one-time authorization code if prompted, then type `yes` to confirm the reported account. The bundled CLI saves browser login in the agent home. For `token`, generate a token with `claude setup-token` and enter it at the secret prompt. Setup checks the token and saves it to `.env` under `CLAUDE_CODE_OAUTH_TOKEN_<ID_HEX>`, where `ID_HEX` is the uppercase UTF-8 hex encoding of the instance ID.
2. Setup runs a test turn. After the final checks, it saves the instance configuration.

For manual API-key authentication, configure the key before starting the gateway. The wizard offers browser sign-in and setup-token entry.

## Checks and status

`tsugimori doctor` checks that the platform-specific bundled CLI runs and that its home is writable or can be created. It checks for configured authentication and reports whether the CLI advertises a configurable native compaction window. With an explicit key or token, the authentication check confirms presence. Guided setup's test turn exercises provider access.

To route a chat to Claude, run `/model` and choose the Claude instance and model, or type `/model <agentId> <model>`. Use `/model <agentId> default` to select Claude's default model.

For a chat routed to Claude, `/status` shows the effective model, reasoning and speed when known, along with context usage and the reported model window when available. It shows compaction timing and session count from traces. When the SDK reports subscription rate-limit events, the card shows cached five-hour and seven-day quota windows and reset times as available. The card uses cached state. **System** shows whether the Claude instance is attached.

Usage events now include cache reads and writes in `inputTokens`. Earlier releases reported only uncached input. The task console shows the cache read and write counts from the SDK's aggregate turn result when reported.

## Execution records

Claude reports the active model and reasoning effort from the SDK initialization message through the `model` event. It emits `reasoning` events for visible thinking text supplied by the SDK.

## Compaction

After a completed turn reports a context above `compactAt`, the connector queues a background `/compact`. Further turns on that session wait for it. The owner can also use `/compact` to request compaction for the current session. The gateway records native, manual, and post-turn compaction and records before/after token counts when supplied.

Native auto-compaction is a safety net for long turns. Claude receives `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as the larger of `compactAt × 1.6` (rounded up) and `compactAt + 150,000`, capped at the known model context window and subject to Claude's own limits. [Rolling summaries](../../README.md#context-and-summaries)

## Inbound images

The connector defaults to a 1,568 px long edge and a standard-tier pixel budget
of 1,568 × 28² pixels. The Claude API accepts 10 MB per base64-encoded image,
so the connector limits the raw image to 7,500,000 bytes. Set
`agents[].options.imageMaxEdge` and `agents[].options.imageMaxBytes` to lower the
limits for your deployment. Visual inputs are sent as base64 image content in
the SDK streaming prompt.

[Claude vision limits](https://platform.claude.com/docs/en/build-with-claude/vision#request-limits)
and [Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

Set `agents[].options.imageMaxPixels` to change the pixel budget. Automatic
previews download up to 32 MiB per source attachment by default. Use
`agents[].options.imageSourceMaxBytes` to change the source limit.
