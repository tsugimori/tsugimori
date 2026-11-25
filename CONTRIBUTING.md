# Contributing

Use Node.js 24 or later and run pnpm through Corepack.

```sh
corepack pnpm install
corepack pnpm check
```

The check runs TypeScript, ESLint, Prettier, Node's test runner, and the package build. Run `corepack pnpm format` to apply formatting.

Core libraries and the CLI live in `packages/`. Official plugins belong in `plugins/` and import framework contracts from `@tsugimori/plugin-sdk`. Keep platform and agent implementations out of the core packages. Use `definePlugin` for plugin definitions and register their factories by kind. For external approval requests, await `AgentIO.requestApproval` before performing the operation.

Change the SQLite schema in `packages/storage-sqlite/src/schema.ts` and run `corepack pnpm --filter @tsugimori/storage-sqlite db:generate` to generate migrations. Keep SQL and SQLite details in the storage implementation. Keep deployment data and credentials in a separate workspace. Record timing through `Tracer` and keep secrets out of logs and trace attributes.

Use fake connectors for background summary tests and keep summary generation off the task queue.

Verify schedules with a fake clock and adapter. Claims and the next due time are written together before delivery.

Execution plugins must isolate each chat and expose only services started in its own execution session. Use fake processes or disposable workspaces for execution tests.

The admin UI uses the gateway’s read-only data interface. Test Access verification with locally generated signing keys and a fake JWKS response.

Use fake DNS requests and fake cloudflared processes for preview tests. Keep the Cloudflare API token and Quick Tunnel redemption tokens out of subprocess environments and trace data.

Plugins can declare read-only `checks(ctx)` and ordered `setupSteps` in `definePlugin`. Return safe details and affected capabilities so the gateway can degrade features independently. Use the injected command runner and fetch in tests for package managers, archives, and sign-in. Setup checkpoints contain configuration and step progress. Pass credentials through `writeEnv` and keep them out of configuration, progress text, message storage, and trace data.
