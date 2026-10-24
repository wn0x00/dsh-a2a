# DeepSeek Harness A2A Bridge

Canonical source: [xbot/deepseek-harness-a2a](https://gitea.guanzhu.me/xbot/deepseek-harness-a2a)
(private repository). Develop and review plugin changes here. The platform keeps a
pinned vendor snapshot for its builds and source download; sync a reviewed source
commit instead of editing that copy.

Maintainer documentation: [architecture](https://gitea.guanzhu.me/xbot/deepseek-harness-a2a/src/branch/main/docs/ARCHITECTURE.md)
and [release / platform synchronization](https://gitea.guanzhu.me/xbot/deepseek-harness-a2a/src/branch/main/docs/RELEASE.md).

This Cordis bundle loads **inside DeepSeek Harness** through its `dsh.bundle`
manifest and `cordis.patch.yml`. It receives the real `ctx.agents` service,
receives standard A2A Messages and returns Task status and result artifacts.
It requires Node 22.19+ and DSH 0.2.1-rc.2 or newer in the 0.2 series. The separate executable is a transport
diagnostic; installing that executable alone does not enable a Harness plugin.

## Install or update

In the platform, open an Agent's **子 Agent → 添加子 Agent**, then select the
**info** icon for connection instructions and a direct download of version
**0.1.9**. There is no separate device list or download page.

In the Windows graphical client:

1. Open **Plugins**. If the bridge is already installed, uninstall the old
   version first; DSH does not upgrade an installed bundle in place.
2. Select **Add plugin**. In **包名或地址**, enter the downloaded file's full
   path, such as `C:\Users\your-name\Downloads\xbot-deepseek-harness-a2a-0.1.9.tgz`.
3. In **安装源**, select the npm official registry (`https://registry.npmjs.org/`)
   or a working default registry. A plugin `.tgz` URL belongs in **包名或地址**,
   never in **安装源** / `--registry`.
4. Install, then click **立即启用 / Enable now**. Successful pnpm output only
   confirms installation; the graphical client installs bundles disabled.
5. Fully exit and restart Harness. Check the installed version is **0.1.9**.

Perform these steps in the same graphical client/profile. An installation in a
separate CLI profile does not activate it in the graphical client. Uninstalling
the bundle does not remove the bridge's separately stored platform credentials.

For a CLI profile:

```powershell
dsh plugin --profile demo add .\xbot-deepseek-harness-a2a-0.1.9.tgz
dsh --profile demo
```

The package downloaded from `agent.guanzhu.me` connects to
`https://agent.guanzhu.me` by default. Local source builds keep
`http://127.0.0.1:8000`; no Keycloak configuration is required. A release build
can set `XBOT_DEFAULT_GATEWAY_URL` to its HTTPS platform origin. For another
platform, set its backend/public gateway URL before
launching Harness, or set the plugin's `gatewayUrl` configuration:

```powershell
$env:A2A_GATEWAY_URL = 'https://platform.example.com'
dsh --profile demo
```

The native adapter inherits the Harness profile's default Agent preset and
provider/model. Select another configured preset or model in **设置 → Xbot 平台任务**.
For a profile without a default, set `A2A_LLM_PROVIDER` and `A2A_LLM_MODEL`. The native
plugin runs one Agent entry point; it does not require `allowedSkills`,
`A2A_ALLOWED_SKILLS`, or tool registration. Harness chooses and manages its own
internal tools.

## Platform account authorization

Open **设置 → Xbot 平台任务**, optionally set **设备名称** and **设备描述**,
then select **保存任务配置** and **连接平台**. The plugin reads the platform's
authorization metadata, creates a device authorization request with an S256
PKCE challenge, and opens the platform's **连接本地智能体** authorization page. Sign in with your platform
account and approve the displayed Harness instance. Return to **子 Agent** and
select the local agent; the list refreshes and configuration saves automatically.
No client secret or platform admin session is
stored in Harness. The loopback callback is
`http://127.0.0.1:43127/oauth/callback`; it listens only while authorization is
pending and closes after completion or ten minutes. If a browser does not open,
the connection card reports the failure; retry from the settings page. After a
timeout or denied request, select **连接平台** again to create a fresh authorization
request. The settings page does not expose authorization URLs, PKCE state or
credentials.
Startup only restores saved credentials; it never opens a consent page by itself.
The local callback displays success only after token exchange and device
registration finish. It then attempts the desktop's fixed `dsh://open` command
and offers **打开 DeepSeek Harness** if the browser requires a click. This
foreground action carries no authorization code or token. The top-level loopback
redirect remains the credential channel; no cloud-to-loopback fetch is used.

The connection card shows the live state: **已连接**, **需要授权**,
**等待浏览器授权**, **正在连接**, **连接中断**, or **连接失败**. It also displays the
platform, device identity, active task count and recent connection/contact times.
**刷新状态** reads the current host state; a settings save does not imply a
successful connection. **无法读取状态** means the settings client cannot currently
read the host service.

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

Version 0.1.3 creates a new random device identity, persisted separately for
each platform and Harness profile. **An old Keycloak device is not automatically
claimed.** Authorize the new device with the intended platform account, then
select the local agent again in the calling Agent's **子 Agent** configuration.
Existing `A2A_OIDC_ISSUER_URL` and `A2A_DEVICE_ID` environment variables do not
change platform-mode authorization or import an old device identity.

Access and refresh credentials survive restarts. Windows protects them with
DPAPI for the current signed-in Windows account under `%LOCALAPPDATA%\Xbot\a2a`.
Linux/macOS use a user-only directory and mode-0600 credential file under
`$XDG_STATE_HOME/xbot/a2a` (default `~/.local/state/xbot/a2a`). Profiles and
platforms use distinct directories. Do not copy credential storage between
users. A profile lock prevents two processes from rotating the same credential.
The lock is released when the plugin stops; a stale lock from an exited process
is recovered on the next start.

The plugin rotates refresh tokens before access-token expiry. If the platform
revokes the grant or it expires, polling pauses without opening a browser.
Select **连接平台** in Harness settings when you want to authorize again. Removing a target
with the trash icon in **子 Agent** changes only that calling Agent's configuration;
it does not revoke the shared device grant. A revoked grant requires fresh approval.
The device name defaults to `DeepSeek Harness (<computer name>)`. **设备名称**
overrides that default (and the existing `A2A_DEVICE_NAME` fallback). The optional
**设备描述** is limited to 1,000 characters. Saving these fields on an already
connected device updates its platform directory entry and per-device A2A Card;
it does not change the global platform gateway Card or any hosted Agent's name/persona. Neither field grants tools or permissions.

`A2A_PROFILE` or the plugin `profile` property can
explicitly select credential isolation for a custom host; native Harness uses
its profile's Cordis `baseUrl` automatically.

An external OIDC provider remains an explicit compatibility option:
`authMode: external` (or `A2A_AUTH_MODE=external`) together with `issuerUrl` /
`A2A_OIDC_ISSUER_URL`. It is not the default and does not create platform-owned
device grants. The backend must separately support the external issuer.

## Workspace and conversations

Open **设置 → Xbot 平台任务**, also available in
**Plugins → @xbot/deepseek-harness-a2a → 配置**. **工作区（项目目录）** is one
directory setting: choose an existing Harness workspace, pick a local folder,
or enter a full path. These are three ways to choose the same directory. The
first task registers that directory as a native workspace and attaches its
session, so it appears under that directory in the left sidebar. **使用 Harness
默认目录** uses the host's default directory; it does not follow whichever
workspace is temporarily selected in the browser. Choose an **Agent 预设（工具集）** and
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
Agent preset to supply tools and preserves Harness sandbox enforcement. Start a
new platform conversation when upgrading a context created by 0.1.5 without a
recorded Agent preset.

## Build and diagnostic runner

`npm test` builds and checks PKCE, persistent profile isolation, refresh rotation,
revocation without browser popups, explicit reconnection, callback completion,
identity settings, native execution and package metadata.
`npm run pack:release` stages the `.tgz`, README and SHA-256 release manifest in
this repository's `release/` directory. Set `XBOT_RELEASE_DIR` to another directory
(relative to the package root, or absolute) when exporting a release to the
platform. Build and test with Node 22.19+ and `npm ci`; the package is private and
is distributed as a versioned tarball, not published to the public npm registry.

For transport diagnosis without Harness:

```powershell
npm install .\xbot-deepseek-harness-a2a-0.1.9.tgz
npx xbot-deepseek-harness-a2a
# Revoke this diagnostic profile's authorization:
npx xbot-deepseek-harness-a2a --logout
```

The diagnostic runner has its own profile/device and a literal echo handler. Use
native DSH to validate real model execution. Both use the same platform login
flow; the diagnostic runner does not replace the Harness plugin loader.
