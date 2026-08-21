# deepseek-balance-monitor

[简体中文](README.md) | [English](README.en.md)

一个 dsh web 插件，用于监控你的 DeepSeek 账户余额：

<img width="184" height="83" alt="屏幕截图 2026-08-21 140545" src="https://github.com/user-attachments/assets/4af06e4e-0cec-45fe-968b-6766b34eabbf" />
<img width="183" height="83" alt="屏幕截图 2026-08-21 140509" src="https://github.com/user-attachments/assets/cf2e3f50-597f-4897-85a2-20d3d72896fb" />
<img width="191" height="77" alt="屏幕截图 2026-08-21 140459" src="https://github.com/user-attachments/assets/e0dc51e7-5493-44fa-b7e8-a6d9ef827324" />

- **右下角余额角标**（`shell.overlay` 槽位）：显示最新余额、状态点、最近更新时间，以及角标最右侧的**圆形箭头手动刷新按钮**——点击后图标带旋转动画（至少转 650ms，保证肉眼可见）。
- **自动刷新服务**：Host 端随 DSH 启动（`DeepseekBalanceGateway`，Typert Remote 服务 `deepseekBalance/fetch`），启动时即预热拉取一次。角标通过通用 RPC 通道调用该端点（`ctx.connection.rpc.call('/api', 'deepseekBalance/fetch', …)`——与类型化 Remote 外观同一条通道），并按设置里配置的间隔自动刷新；每次返回都会更新显示。
- **设置 → 插件 → “余额监控”页签**：从预设（10 秒 / 30 秒 / 1 分钟 / 3 分钟 / 5 分钟）或自定义秒数（10–3600）中选择自动刷新间隔。选择持久化在 `deepseek-balance-monitor.refreshSeconds` 设置命名空间，立即生效。
- **状态点颜色**：读取中灰色、读到余额绿色、读取失败或余额不足（账户不可用或所有币种余额 ≤ 0）红色。

## API Key 从哪来

Host 端每次刷新通过凭证服务解析 `DEEPSEEK_API_KEY`（与 DeepSeek 模型提供方共用同一个引用——可在 Web 模型页面或启动环境中配置）。查询端点为 `GET {baseURL}/user/balance`，`baseURL` 默认 `https://api.deepseek.com`（可用 `DEEPSEEK_BASE_URL` 覆盖）。该接口为免费余额查询，**不消耗 token**。

## 目录结构

- `src/index.ts` — Host 端：设置命名空间注册 + 余额网关。
- `src/typert.host.ts` — Host typert 清单（`exports["./typert"]`）：`deepseekBalance/fetch` 的严格描述符，由 base 层 typert-loader 注册进共享的 `ctx.typert` 注册表，使 api-gateway 无需跨包 `@Remote` 标记发现即可认领并分发该端点。
- `src/client/` — 浏览器端：`index.ts`（apply）、`balance-badge.tsx`（角标 + 旋转刷新按钮）、`settings-tab.tsx`（间隔预设/自定义）、`locales.ts`（中英文案）。
- `build/tsdown.client.ts` — 客户端打包预设（镜像自 dsh-web-ui）。

## 构建与安装

```sh
pnpm install
pnpm build          # 产出 lib/index.js（Host）+ lib/typert.host.js + lib/client.js（浏览器）
dsh plugin --profile web add <本仓库路径>
```

然后重启 dsh web（`dsh web` 或你自己的启动脚本）。插件以 bundle 形式加入 profile：其 `cordis.patch.yml` 插入 loader 条目，`dsh.client` 声明合成浏览器端 bundle，base 层 typert-loader 读取 `./typert` 清单，api-gateway 即可服务 `deepseekBalance/fetch`。

## 必须的本地补丁：暴露设置命名空间

Web API 代理只对**显式白名单**内的设置命名空间提供服务（`@deepseek-ai/dsh-host-apiproxy/lib/index.js` 里的 `WEB_SETTINGS_NAMESPACES`）；白名单外的命名空间对浏览器不可读也不可写（读写都会被拒绝）。因此本插件需要在那个文件里打一个本地补丁（maid-atelier 皮肤已经在用同样的方式）：

```js
const WEB_SETTINGS_NAMESPACES = [
  // ...
  "ui-skin-maid-atelier",
  // Local patch: expose the DeepSeek balance monitor's refresh interval
  // (deepseek-balance-monitor).
  "deepseek-balance-monitor"
];
```

**注意：每次重装/升级 dsh 后需要重新打这个补丁**（该文件位于全局 npm 安装目录）。可用 `dsh web --dump-config` 验证（启动后命名空间应出现在 `settings.describe` 中）。

## 冒烟测试

```sh
node smoke-host.mjs       # 启动真实 cordis 根；用桩 fetch 驱动网关
node smoke-host2.mjs      # typert 清单 + 真实 api-gateway 认领/分发
node smoke-host3.mjs      # 真实 settings provider 注册/写入往返（隔离文件）
node smoke-host4.mjs      # 模拟 loader 的 ctx.plugin 挂载
node smoke-client.cjs     # 通过 mock __ModuleLoader__ 加载 lib/client.js；驱动角标/设置页逻辑
node smoke-client-real.cjs # 真实 SettingsScopeController + 真实 binder 端到端
```
