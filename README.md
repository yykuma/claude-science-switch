<div align="center">

# Claude Science Switch

### Claude Science 的本地模型切换器

[![Release](https://img.shields.io/github/v/release/yykuma/claude-science-switch)](https://github.com/yykuma/claude-science-switch/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/yykuma/claude-science-switch)
[![Tauri](https://img.shields.io/badge/Tauri-2-orange.svg)](https://tauri.app/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

Claude Science Switch 通过本地 loopback 代理接管 Claude Science 请求，把推理切到你自己的模型 API。你可以在多个 provider 之间切换，并在 Claude Science 的模型选择器里看到真实上游模型名。

```text
Claude Science
   |
   | ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/<secret>
   v
Claude Science Switch
   |
   | provider routing / model catalog / protocol conversion
   v
OpenAI-compatible / OpenAI Chat / OpenAI Responses / Gemini Native / Anthropic-compatible
```

## 官方渠道

| 类别 | 地址 |
| --- | --- |
| 源码 | [github.com/yykuma/claude-science-switch](https://github.com/yykuma/claude-science-switch) |
| 下载 | [GitHub Releases](https://github.com/yykuma/claude-science-switch/releases) |
| 问题反馈 | [GitHub Issues](https://github.com/yykuma/claude-science-switch/issues) |

## 核心能力

- **本地代理**：只监听 loopback，把 Claude Science 请求转发到你配置的 provider。
- **多 provider 切换**：支持 cc-switch 风格 provider 配置，便于迁移和复用。
- **协议转换**：支持 `anthropic`、`openai_chat`、`openai_responses`、`gemini_native`。
- **真实模型名显示**：模型列表显示真实 upstream model，不再把多个模型显示成 `Default`。
- **模型去重**：按真实 upstream model 去重，避免同一个模型重复出现在选择器里。
- **隔离运行**：smoke / live profile 使用临时目录，不读取或修改真实 Claude Science 登录态。

## 下载与安装

访问 [Releases](https://github.com/yykuma/claude-science-switch/releases/latest) 下载对应版本。

### macOS

| 系统 | 架构 | 安装包 |
| --- | --- | --- |
| macOS 12+ | Apple Silicon | `Claude.Science.Switch_0.1.0_aarch64.dmg` |

下载 DMG 后，把 `Claude Science Switch.app` 拖入「应用程序」。首次打开如被系统拦截，右键应用选择「打开」。

### Linux

| 系统 | 架构 | 安装包 |
| --- | --- | --- |
| Linux | x86_64 | `claude-science-switch_0.1.0_linux-x64.tar.gz` |

```bash
curl -L -o claude-science-switch_0.1.0_linux-x64.tar.gz \
  https://github.com/yykuma/claude-science-switch/releases/download/v0.1.0/claude-science-switch_0.1.0_linux-x64.tar.gz

tar -xzf claude-science-switch_0.1.0_linux-x64.tar.gz
cd linux-x64
./bin/claude-science-switch doctor --config examples/cliproxy-gpt55.json
./bin/claude-science-switch serve --config examples/cliproxy-gpt55.json
```

控制台默认地址：

```text
http://127.0.0.1:17777/
```

## 使用示例

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

隔离 profile smoke：

```bash
node bin/claude-science-switch.js science-smoke \
  --config examples/cliproxy-gpt55.json \
  --temp-oauth-token \
  --probe-message
```

## Provider 配置

当前支持的 `apiFormat`：

- `anthropic`
- `openai_chat`
- `openai_responses`
- `gemini_native`

OpenAI-compatible provider 通常走 `openai_chat` 或 `openai_responses`，具体取决于上游端点能力。

## 模型目录

Claude Science 前端需要 Claude-compatible model id。Claude Science Switch 会生成兼容目录，同时显示真实上游模型名。

例如上游模型 `gpt-5.5` 会显示为：

```json
{
  "id": "claude-opus-4-8",
  "display_name": "gpt-5.5",
  "name": "gpt-5.5",
  "label": "gpt-5.5"
}
```

实际请求仍路由到真实模型：

```text
claude-opus-4-8 -> gpt-5.5
```

## 安全说明

- 本地服务只监听 loopback。
- 临时 profile 与真实 Claude Science profile 隔离。
- 如果临时 profile 指向真实 `~/.claude-science`，程序会拒绝启动。
- 官方 Anthropic upstream 默认拒绝，避免误走真实账号通道。
- 未知模型默认拒绝，除非显式开启 fallback。

使用第三方 provider 时，请确认你了解对应 provider 的计费、数据保留和服务条款。

## 开发

```bash
npm install
npm run check
npm test -- --runInBand
npm run build:native
npm run package:linux-x64
```

## License

MIT
