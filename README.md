<div align="center">

# Claude Science Switch

Claude Science 的本地模型切换器。目标是用本地 loopback switch 接管 Claude 风格请求，路由到你自己的模型 API。

[![Status](https://img.shields.io/badge/status-source%20preview-yellow.svg)](https://github.com/yykuma/claude-science-switch)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/yykuma/claude-science-switch)
[![Desktop](https://img.shields.io/badge/desktop-Tauri%202-orange.svg)](https://tauri.app/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

## 当前状态

这个仓库目前是源码预览，还没有公开 release。

之前的 alpha 包已经撤下：macOS app 里额外打进了一个 Bun native 代理二进制，体积不够干净。下一版会把 Claude Science 代理能力收进现有 Rust/Tauri 代理栈，做成真正自包含、体积正常的桌面包。

已经在本地跑通过的部分：

- Claude Science 临时隔离 profile
- `cliproxyapi -> gpt-5.5`
- Anthropic Messages 兼容入口
- OpenAI Chat / OpenAI Responses / Gemini Native 转换
- cc-switch 风格 provider 配置导入
- 真实模型名展示和按 upstream model 去重

仍在整理的部分：

- 桌面包瘦身：去掉额外 Bun runtime
- provider preset 全量 smoke
- Linux 桌面打包
- 签名、公证、自动构建

## 安全边界

默认策略比较保守：

- 只监听 loopback。
- 不读取真实 Claude Science 登录态。
- smoke/live 使用临时 `HOME`、`XDG_*`、`--data-dir`、`--config`。
- 如果临时 profile 指向真实 `~/.claude-science`，直接拒绝启动。
- 官方 Anthropic upstream 默认拒绝。
- 管理型 OAuth provider 默认拒绝。
- 未知模型默认 400，不静默落到 default，除非显式开启 `models.fallbackUnknownToDefault`。

这个项目不是 Anthropic 或 Claude Science 官方项目。

## CLI 试跑

要求：

- Node.js 20+
- 本机已有 Claude Science CLI
- 可用的上游 provider

默认例子使用本机 `cliproxyapi`：

```bash
npm install
npm run doctor
npm run serve
```

打开控制台：

```text
http://127.0.0.1:17777/
```

端到端 smoke：

```bash
node bin/claude-science-switch.js science-smoke \
  --config examples/cliproxy-gpt55.json \
  --temp-oauth-token \
  --probe-message
```

保持临时会话方便手动试：

```bash
node bin/claude-science-switch.js science-smoke \
  --config examples/cliproxy-gpt55.json \
  --temp-oauth-token \
  --probe-message \
  --hold
```

## 模型目录

Claude Science 前端只认 Claude-compatible model id。Switch 会编译一个模型目录：

- 按真实 upstream model 去重。
- 每个可见模型分配一个 Claude-compatible id。
- UI label 显示真实模型名。
- 路由同时接受可见 id、role alias、真实 upstream id。

例如单模型 `gpt-5.5` 会暴露成：

```json
{
  "id": "claude-opus-4-8",
  "display_name": "gpt-5.5",
  "name": "gpt-5.5",
  "label": "gpt-5.5"
}
```

实际请求仍路由到：

```text
claude-opus-4-8 -> gpt-5.5
```

## Provider 配置

支持的 `apiFormat`：

- `anthropic`
- `openai_chat`
- `openai_responses`
- `gemini_native`

列出 provider：

```bash
node bin/claude-science-switch.js providers --config examples/science-provider-presets.json
```

切换 active provider：

```bash
node bin/claude-science-switch.js use cliproxy-gpt55 --config examples/multi-provider.json
```

临时指定 provider：

```bash
node bin/claude-science-switch.js serve \
  --config examples/multi-provider.json \
  --provider cliproxy-gpt55
```

## 本地检查

```bash
npm run check
npm test -- --runInBand
```

打本机 native proxy：

```bash
npm run build:native
```

打 Linux x64 CLI 包：

```bash
npm run package:linux-x64
```

## 发布前原则

公开 release 之前需要满足：

- macOS app 不依赖用户预装 Node。
- 不额外塞 Bun native proxy。
- 没有 release 目录、DMG、native 生成物进仓库。
- 没有真实登录态、token、OAuth material、临时 profile 进仓库。
- README 和 release 页面只描述真实可下载内容。

## License

MIT
