# Architecture

The canonical implementation is the private
[`xbot/deepseek-harness-a2a`](https://gitea.guanzhu.me/xbot/deepseek-harness-a2a)
repository. The platform vendors a reviewed source snapshot and produces its
download artifacts from that snapshot. The plugin has its own version and test
suite; platform API, authorization policy and deployment remain in the platform
repository. See [release and synchronization](RELEASE.md).

## Host and client

The npm package is a Cordis bundle. `package.json` declares `dsh.bundle` and
`dsh.client`; `cordis.patch.yml` loads the native host adapter from `dist/index.js`.
The adapter in `src/harness.ts` receives Harness services, restores its credential
profile, creates the bridge, and disposes its resources with the plugin lifecycle.
`src/plugin.ts` manages registration, connection and the outbound task loop.

The settings client in `client/index.js` is loaded through Harness's ModuleLoader.
`scripts/build-client.mjs` bundles the client and shared contract into one browser
IIFE. React and Harness UI/catalog services come from the host's module factory;
the plugin does not ship a second React runtime. `src/workspace-settings.ts`
validates the host-side workspace and execution configuration.

`src/connection-control.ts` exposes `xbotA2a.status`, `connect`, `reauthorize` and
`cancelAuthorization`
through the host's public Typert service API. Each operation requires the local
host owner's principal. The host registers the strict descriptors from
`src/connection-contract.ts`; the browser mounts the same contract using the
host's Zod module. Mounting the contribution does not grant Cordis namespace
access: the settings page is registered in a child scope that explicitly injects
`remote.xbotA2a` after `$mount` completes. Loading it in the outer injection list
would wait for the namespace before the plugin can mount it. The child scope is
disposed before the contract is unmounted. Status reads use Typert transport
cancellation; signals do not become wire arguments. Strict snapshot codecs
validate both host output and client input. `src/connection-state.ts` defines the public status projection:
connection phase, device identity, task count and timestamps, without tokens,
PKCE state or stored credentials. The settings page reads live bridge state;
saved configuration alone is not proof of a working connection. Configuration editing
and the associated controls use the public `ConfigForm` snapshot
(`status === "ready"` and `writable === true`). That snapshot has no `mode` field.
Tests load the real settings service and snapshot store before mounting the
plugin page, covering the Host contract instead of adding fictitious fields. If local status
is unavailable, management actions are hidden and retained snapshots are marked
stale. Recovery instructions distinguish local service availability from
platform authorization. Read timeouts abort the carrier; polling and manual
refresh share a single request.

Reauthorization pauses an idle relay without clearing its saved credentials.
Cancellation, denial, timeout or browser failure clears only pending consent and
restores the prior connection when its grant is valid. Successful exchange
replaces the credentials; a later registration error retains the new credentials
for a connection retry. The host rejects reauthorization while tasks are active.

The supported host range is DSH `>=0.2.1-rc.2 <0.3.0`, with Node `>=22.19.0`.
Host protocol and Cordis packages are declared as peers and are also available as
development dependencies for contract checks. `src/cli.ts` is an independent
transport diagnostic with an echo handler; it does not activate a Harness plugin
or perform native Agent execution.

## Plugin updates

`src/plugin-update.ts` reads the fixed private Gitea Generic package source. It
uses a separately protected read-only package credential and issues only GET
requests to the configured Gitea origin; redirects and arbitrary download URLs
are rejected. Registry names, versions and manifest fields are validated before
selecting the highest published version. Installation binds the confirmation to
that exact version and verifies size, SHA-256 and the archive's package identity.

The owner-only `xbotA2a` update methods return a strict public snapshot, never
credentials or raw upstream errors. The write-only credential methods clear or
replace only the updater's credential. Updates remain usable when the platform's
authorization metadata endpoint is unavailable. The UI has separate controls for
checking a release and explicitly installing it.

The adapter acquires an idle-task lock, pauses incoming work and fences connection
actions while installation proceeds. The public Harness `pluginManager.installBundle`
owns the actual package operation. Plugin cleanup must not cancel or await that
operation: hot replacement may be waiting for this same cleanup. A private,
atomic receipt and native package inventory reconcile an interrupted result.
Unknown outcomes never trigger another install automatically. Verified local
archives remain available for the host package manager's file dependencies.

## Authorization and transport

`src/platform.ts` builds platform-mode configuration and separates profiles by
platform and local Harness profile. `src/pkce.ts` handles S256 PKCE, exchange and
refresh; `src/oauth-callback.ts` owns the temporary loopback listener and browser
completion response. `src/token-store.ts` persists credentials using Windows
DPAPI or a user-only file and serializes access with the profile lock. Neither
client settings nor platform task payloads receive stored access/refresh tokens.

The platform owns account login, human consent, device grants and authorization
of callers. The bridge restores saved authorization at startup and opens a new
consent flow only after an explicit local action. External OIDC mode is an
explicit compatibility setting; it is not the default platform identity path.

`src/gateway.ts` implements the private outbound register/pull/report relay. The
platform presents standard A2A messages and tasks to callers; that public A2A
surface and the private device relay are different protocol boundaries. Device
credentials allow receiving and reporting that device's tasks, not dispatching
tasks as a platform caller.

## Native execution and persistence

`src/task-runner.ts` dispatches received work to the native adapter. The adapter
uses the selected Harness Agent preset, model and workspace and retains native
Agent handles until disposal. Remote payloads cannot override local execution
settings or acquire additional tool permissions. Harness still enforces tool
approval and sandbox policy.

`src/session-index.ts` records the A2A context-to-Harness session mapping. Contexts
are serialized and isolated by platform, profile and authorization scope. Native
session storage is flushed after a completed turn; a restart resumes the
plugin's own mapped session. Changing workspace or Agent preset requires a new
platform conversation. Existing sessions retain their native model selection.

## Build boundary

TypeScript emits host code and declarations into `dist/`; esbuild emits the
ModuleLoader client; `scripts/build-defaults.mjs` writes only the selected gateway
origin. The local default is loopback. A platform release sets
`XBOT_DEFAULT_GATEWAY_URL` to its HTTPS origin. No credential is a build input.

`scripts/stage-release.mjs` runs the package build through `npm pack`, calculates
the actual archive size/SHA-256 and stages the archive, README and manifest.
Generated files stay in `dist/` and `release/` unless an explicit release directory
is supplied. See [README](../README.md) for user installation and operation.

## Settings evidence

Captures: [connected](assets/settings-connected.png),
[awaiting authorization](assets/settings-authorizing.png),
[reauthorization confirmation](assets/settings-reauthorize.png), and
[mobile layout](assets/settings-mobile.png),
[status recovery](assets/settings-status-unavailable.png),
[ready to connect](assets/settings-connect-ready.png),
[plugin updates](assets/settings-update.png),
[restart required](assets/settings-update-restart.png), and
[update mobile layout](assets/settings-update-mobile.png). These use the real settings
components with controlled RPC and UI-primitives fixtures. They do not represent
a foreground interaction test inside the Windows desktop host.
