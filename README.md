# DSH A2A Bridge

Canonical source: [wn0x00/dsh-a2a](https://github.com/wn0x00/dsh-a2a).
The package is published to npm as
[`@guanzhu.me/dsh-a2a`](https://www.npmjs.com/package/@guanzhu.me/dsh-a2a) with
OIDC trusted publishing; every release is built and published by GitHub Actions
with provenance.

Maintainer documentation: [architecture](docs/ARCHITECTURE.md) and
[release](docs/RELEASE.md).

This Cordis bundle loads **inside DeepSeek Harness** through its `dsh.bundle`
manifest and `cordis.patch.yml`. It receives the real `ctx.agents` service,
receives standard A2A Messages and returns Task status and result artifacts.
It requires Node 22.19+ and DSH 0.2.1-rc.2 or newer in the 0.2 series. The
separate executable is a transport diagnostic; installing that executable alone
does not enable a Harness plugin.

## Platform address

The plugin ships **without a built-in platform (OAuth authorization) address**.
Before the first connection, open **设置 → A2A 平台任务**, fill in **平台地址**
(the platform's HTTPS origin, for example `https://platform.example.com`;
loopback `http://127.0.0.1` is accepted for local development) and select
**保存任务配置**. The address is validated, normalized to its origin and
persisted in the local Harness configuration; changing it later switches to a
separate local credential profile and requires fresh authorization.

The standalone diagnostic takes the address from `--gateway` (saved for later
runs) or `A2A_GATEWAY_URL`:

```powershell
npx @guanzhu.me/dsh-a2a --gateway https://platform.example.com
```

## Install or update

Install the current version from the public npm registry. In the Windows
graphical client:

1. Open **Plugins**, select **Add plugin**. In **包名或地址**, enter
   `@guanzhu.me/dsh-a2a` (or the full path of a downloaded `.tgz`).
2. In **安装源**, select the npm official registry
   (`https://registry.npmjs.org/`) or a working default registry. A plugin
   `.tgz` URL belongs in **包名或地址**, never in **安装源** / `--registry`.
3. Install, then click **立即启用 / Enable now**. Successful pnpm output only
   confirms installation; the graphical client installs bundles disabled.
4. Fully exit and restart Harness, then configure **平台地址** as above.

Perform these steps in the same graphical client/profile. An installation in a
separate CLI profile does not activate it in the graphical client. Uninstalling
the bundle does not remove the bridge's separately stored platform credentials.

For a CLI profile:

```powershell
dsh plugin --profile demo add @guanzhu.me/dsh-a2a
dsh --profile demo
```

The native adapter inherits the Harness profile's default Agent preset and
provider/model. Select another configured preset or model in **设置 → A2A 平台任务**.
For a profile without a default, set `A2A_LLM_PROVIDER` and `A2A_LLM_MODEL`. The native
plugin runs one Agent entry point; it does not require `allowedSkills`,
`A2A_ALLOWED_SKILLS`, or tool registration. Harness chooses and manages its own
internal tools.

## Updates inside Harness

Open **A2A 平台任务 → 插件更新** and select **检查更新**. The update source is
the public npm registry: the plugin reads the `@guanzhu.me/dsh-a2a` registry
document, selects the highest published strict SemVer version and freezes that
exact release for confirmation. No credential or token is required or stored.
Only GET requests to `registry.npmjs.org` are issued; redirects and tarballs on
any other origin are rejected.

**更新到 <版本>** asks you to confirm that exact version, then downloads the
registry tarball and verifies its npm `dist.integrity` (SHA-512) and the
archive's package identity before handing it to Harness's native Plugin
Manager. Tasks or pending authorization block installation. An idle connection
pauses new work during installation and resumes afterwards. The native
installer preserves the bundle's configuration; the plugin does not uninstall
itself or execute custom package-manager shell commands.

When **更新已安装，等待重启** appears, fully exit and reopen Harness. If the client
loses the installation reply, use **核对更新结果**. A missing reply is not a
successful install and does not cause an automatic second installation. The local
receipt records the target version; after restart, the running version confirms
whether that update took effect. The exact verified archive remains in the
profile's private update cache because the native installer can reference it as
a local file dependency.

## Platform account authorization

Open **设置 → A2A 平台任务**, set **平台地址**, optionally set **设备名称** and
**设备描述**, then select **保存任务配置** and **连接平台**. The plugin reads the
platform's authorization metadata, creates a device authorization request with
an S256 PKCE challenge, and opens the platform's **连接本地智能体** authorization
page. Sign in with your platform account and approve the displayed Harness
instance. Return to **子 Agent** and select the local agent; the list refreshes
and configuration saves automatically. No client secret or platform admin
session is stored in Harness. The loopback callback is
`http://127.0.0.1:43127/oauth/callback`; it listens only while authorization is
pending and closes after completion or ten minutes. If a browser does not open,
the connection card reports the failure; retry from the settings page. After a
timeout or denied request, select **连接平台** again to create a fresh
authorization request. The settings page does not expose authorization URLs,
PKCE state or credentials.
Startup only restores saved credentials; it never opens a consent page by itself.
The local callback displays success only after token exchange and device
registration finish. It then attempts the desktop's fixed `dsh://open` command
and offers **打开 DeepSeek Harness** if the browser requires a click. This
foreground action carries no authorization code or token. The top-level loopback
redirect remains the credential channel; no cloud-to-loopback fetch is used.

The connection card shows the live state: **需要配置平台地址**, **已连接**,
**需要授权**, **等待浏览器授权**, **正在连接**, **连接中断**, or **连接失败**.
It also displays the platform, device identity, active task count and recent
connection/contact times. **刷新状态** reads the current host state; a settings
save does not imply a successful connection. A status-read failure means the
settings page cannot read its local Harness service; it is not evidence that
platform authorization expired. Enable the plugin and, if it was just installed
or updated, fully exit and reopen Harness before refreshing. The page hides
authorization actions until it can read the service again. Cached information
is explicitly marked stale. Status requests have a cancellation deadline, and
retries do not overlap. Diagnostic details show only known error codes, never
upstream errors or credentials.

Connection and update controls use the real Harness configuration readiness and
`writable` flag. A disabled connection action explains whether the configuration
is loading, read-only, unsaved or busy. Saving or discarding configuration changes
restores the action when the Host permits it; a read-only configuration remains
read-only. Local owner checks still apply to every management RPC.

Use **重新授权**, then confirm with **打开浏览器授权**, to start fresh consent for
an idle device. Active tasks prevent reauthorization. While consent is pending,
**取消本次授权** cancels that attempt. Reauthorization temporarily pauses task
polling and retains the previous credentials until token exchange succeeds.
Cancellation, refusal, timeout or failure to open the browser restores polling
when the previous authorization is still valid. A first-time connection without
previous credentials returns to **需要授权**. If new tokens were exchanged but
device registration fails, the plugin keeps the new tokens and shows the failure;
**连接平台** retries registration. Cancellation does not revoke a previously
connected device's grant.

Each platform address and Harness profile gets its own random device identity,
persisted locally. Authorize the device with the intended platform account, then
select the local agent again in the calling Agent's **子 Agent** configuration.
Existing `A2A_OIDC_ISSUER_URL` and `A2A_DEVICE_ID` environment variables do not
change platform-mode authorization or import an old device identity.

Access and refresh credentials survive restarts. Windows protects them with
DPAPI for the current signed-in Windows account under `%LOCALAPPDATA%\dsh-a2a`.
Linux/macOS use a user-only directory and mode-0600 credential file under
`$XDG_STATE_HOME/dsh-a2a` (default `~/.local/state/dsh-a2a`). Profiles and
platforms use distinct directories. Do not copy credential storage between
users. A profile lock prevents two processes from rotating the same credential.
The lock is released when the plugin stops; a stale lock from an exited process
is recovered on the next start.

The plugin rotates refresh tokens before access-token expiry. If the platform
revokes the grant or it expires, polling pauses without opening a browser.
Select **连接平台** in Harness settings when you want to authorize again. Removing
a target with the trash icon in **子 Agent** changes only that calling Agent's
configuration; it does not revoke the shared device grant. A revoked grant
requires fresh approval. The device name defaults to
`DeepSeek Harness (<computer name>)`. **设备名称** overrides that default (and the
existing `A2A_DEVICE_NAME` fallback). The optional **设备描述** is limited to
1,000 characters. Saving these fields on an already connected device updates its
platform directory entry and per-device A2A Card; it does not change the global
platform gateway Card or any hosted Agent's name/persona. Neither field grants
tools or permissions.

`A2A_PROFILE` or the plugin `profile` property can
explicitly select credential isolation for a custom host; native Harness uses
its profile's Cordis `baseUrl` automatically.

An external OIDC provider remains an explicit compatibility option:
`authMode: external` (or `A2A_AUTH_MODE=external`) together with `issuerUrl` /
`A2A_OIDC_ISSUER_URL`. It is not the default and does not create platform-owned
device grants. The backend must separately support the external issuer.

## Workspace and conversations

Open **设置 → A2A 平台任务**, also available in
**Plugins → @guanzhu.me/dsh-a2a → 配置**. **工作区（项目目录）** is one directory
setting: choose an existing Harness workspace, pick a local folder, or enter a
full path. These are three ways to choose the same directory. The first task
registers that directory as a native workspace and attaches its session, so it
appears under that directory in the left sidebar. **使用 Harness 默认目录** uses
the host's default directory; it does not follow whichever workspace is
temporarily selected in the browser. Choose an **Agent 预设（工具集）** and
**模型** from the host's actual catalogs, then select **保存任务配置**. Empty values
inherit Harness defaults; clearing an override restores inheritance. The host
checks that the directory exists and is accessible before saving and execution.
These settings belong to the local profile; platform messages cannot override them.

The selected Agent preset supplies the tools, including Shell when the preset
includes it. Selecting a folder grants no additional permissions. The page shows
the host's current new-session permission default and description. Change it in
**Harness 设置 → 常规 → 权限**; configure model credentials in **设置 → 模型**.
Tool approvals and sandbox enforcement continue through Harness, and existing
sessions retain their original permissions.

A new A2A `contextId` creates a persistent DSH session. Subsequent messages with
the same context reuse the live session, or resume it after restarting Harness.
Each completed turn is flushed to native session storage. The session stays
attached to its workspace and visible after the task finishes.
Requests for the same context execute sequentially. The plugin only resumes
sessions it created, and isolates mappings by platform/profile and local
authorization epoch. Reauthorizing starts a new scope; refreshing tokens does
not. Changing the working directory or Agent preset requires a new platform
conversation; continuing an old context is rejected. The plugin's model setting
is the default for new sessions. Existing sessions retain their native model
selection, including changes made in DSH. The plugin does not automatically
switch the desktop's selected conversation. It rejects a task if that session
is already running in the DSH UI, without canceling the user's work.

Hosted Agents submit local sub-Agent calls asynchronously and receive a task
receipt immediately. Completion, failure, cancellation, or a request for input
returns to the original platform conversation. Use `call_agent` with
`action=get` and the receipt's task ID to inspect it; do not submit the same task
again while waiting. The platform chat refreshes completed background results
while idle and when the page becomes visible again.

## Protocol and execution boundary

The platform presents an A2A v1 JSON-RPC endpoint and Agent Card for each
connected native Agent. `SendMessage` accepts a standard user `Message` and
returns `{task: ...}`; `contextId` groups related tasks, and `taskId` continues
an interrupted task. `AgentCard.skills` describes the Agent's capabilities;
it does not register Harness tools or select an execution handler. This adapter
currently accepts text parts and produces text artifacts.

The outbound registration/pull/report APIs are a **private internal relay**,
not a standard A2A transport binding. They allow a Windows client behind NAT to
execute the Agent exposed by the platform. The relay negotiates native message
execution explicitly and keeps legacy skill handlers separate. Upgrading does
not reinterpret old queued skill jobs as native Agent messages.

Native execution uses `ctx.agents.create()` or `resume()`, `agent.followup()`,
`agent.whenIdle()`, and `ctx.sessions.flush()`. Remote tasks use the host's actual
agent runtime. Approval-required tasks are denied unless `approveRemoteTasks`
is explicitly enabled. The platform checks ownership, grant validity, and the
calling Agent's selected sub-agents. A device token cannot dispatch tasks.
The pull loop observes cancellation through standard `GetTask` and passes it
to Harness; cancellation latency depends on polling and the active tool.

The plugin retains its native Agent handles until the plugin stops, then calls
`handle.dispose()`. A task finishing does not remove the session from the DSH
sidebar or close its handle. Plugin shutdown still cancels Agent-owned
background jobs; the Windows ACL runner also uses `KILL_ON_JOB_CLOSE`. Shell
submission or a completed Task alone does not prove that a visible window opened
or remains open. The adapter mounts the selected native
Agent preset to supply tools and preserves Harness sandbox enforcement.

## Build and diagnostic runner

`npm test` builds and checks PKCE, persistent profile isolation, refresh rotation,
revocation without browser popups, explicit reconnection, callback completion,
identity settings, native execution and package metadata.
`npm run pack:release` stages the `.tgz`, README and SHA-256 release manifest in
this repository's `release/` directory. Set `DSH_A2A_RELEASE_DIR` to another directory
(relative to the package root, or absolute) when exporting a release. Build and
test with Node 22.19+ and `npm ci`; the package is public on npm and published
exclusively by GitHub Actions through OIDC trusted publishing.

For transport diagnosis without Harness:

```powershell
npm install @guanzhu.me/dsh-a2a
npx dsh-a2a --gateway https://platform.example.com
# Revoke this diagnostic profile's authorization:
npx dsh-a2a --logout
```

The diagnostic runner has its own profile/device and a literal echo handler. Use
native DSH to validate real model execution. Both use the same platform login
flow; the diagnostic runner does not replace the Harness plugin loader.
