# DSH A2A Bridge

让平台上的 Agent 通过 A2A 调用本机 **DeepSeek Harness**，在指定工作区执行任务，并将结果返回平台。任务会话保留在 Harness 中，方便继续查看和使用。

- **环境**：DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`，Node.js `>=22.19.0`
- **包名**：`@guanzhu.me/dsh-a2a`
- **源码**：[wn0x00/dsh-a2a](https://github.com/wn0x00/dsh-a2a)

## 安装

在 Harness 图形客户端中：

1. 打开 **Plugins → Add plugin**。
2. 在 **包名或地址** 中填写 `@guanzhu.me/dsh-a2a`，安装源选择 npm 官方源 `https://registry.npmjs.org/`。
3. 安装后点击 **立即启用**，然后完全退出并重新打开 Harness。

也可以在 **包名或地址** 中填写本地 `.tgz` 文件的完整路径；不要把包地址填到“安装源”中。

## 连接平台

1. 打开 **设置 → A2A 平台任务**。
2. 填写 **平台地址**，例如 `https://platform.example.com`。插件不预设平台地址。
3. 按需设置 **设备名称**、**工作区（项目目录）**、**Agent 预设**和**模型**，点击 **保存任务配置**。预设与模型留空时使用 Harness 默认配置。
4. 点击 **连接平台**，在浏览器中登录平台账号并授权。
5. 确认连接状态为 **已连接**，再到平台中调用方 Agent 的 **子 Agent** 配置里选择这台本地 Agent。

之后即可从平台发起任务。Harness 需要保持运行；任务使用所选预设的工具，并遵循 Harness 的权限与审批设置。

## 更新

打开 **A2A 平台任务 → 插件更新 → 检查更新**，确认目标版本后安装。看到 **更新已安装，等待重启** 后，完全退出并重新打开 Harness。更新功能需要 npm 上已有发布版本。

## 常见问题

| 情况 | 处理方式 |
| --- | --- |
| 安装后无法使用 | 确认在当前图形客户端中安装并启用，再完全重启 Harness；另一个 CLI profile 的安装不会自动生效。 |
| 保存配置后仍未连接 | 保存只更新配置，还需点击 **连接平台** 并完成浏览器授权。 |
| 无法读取连接状态 | 先检查插件是否启用并重启 Harness，再刷新状态。 |
| 显示需要授权 | 点击 **连接平台**；要更换授权账号时使用 **重新授权**，并先等待运行中的任务结束。 |
| 平台中找不到本机 Agent | 确认使用同一平台账号完成授权，并在调用方的 **子 Agent** 配置中重新选择。 |

## 开发与维护

```sh
npm ci
npm test
npm run pack:release
```

打包产物位于 `release/`。首次发布需要本机交互验证，后续发布使用 GitHub Actions OIDC。

- [详细使用说明](https://github.com/wn0x00/dsh-a2a/blob/main/docs/USAGE.md)：CLI profile、授权与凭据、会话行为、协议和诊断工具。
- [架构说明](https://github.com/wn0x00/dsh-a2a/blob/main/docs/ARCHITECTURE.md)
- [发布说明](https://github.com/wn0x00/dsh-a2a/blob/main/docs/RELEASE.md)
