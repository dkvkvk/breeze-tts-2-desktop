# 声轨工坊开发文档

[返回产品首页](../README.md) · [使用手册](guide.md)

AI Agent 和脚本可参阅[本机 Agent 接入](agent-api.md)，包括角色音色、章节队列和产物下载。

## 本机 API

打开界面右上角的「API」可以复制当前地址。界面服务通常从 `http://127.0.0.1:18080` 启动，端口占用时会尝试顺延。推理服务默认使用 `18099`，界面服务将 `/api/*` 代理到本机推理后端。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 查询推理服务是否就绪 |
| POST | `/api/audio/speech` | 流式合成，返回 24 kHz 单声道 `audio/pcm`，样本为 16 位小端序 |
| POST | `/api/voices` | 注册音色，使用 `ref_audio`、`ref_text` 和 `name` |
| GET | `/api/voices` | 列出音色 |
| DELETE | `/api/voices/<id>` | 从当前音色列表移除 |
| POST | `/api/audio/convert` | 将源录音转换为选定的目标音色 |

界面和推理服务只监听本机回环地址，且没有内置鉴权。在受控网络环境中集成时，请在应用外部配置访问控制。

## 本地开发

使用 Windows 和 Node.js 24。在 `shell` 目录运行以下命令。将 `BREEZE_RUNTIME` 指向含有 `breeze-server.exe` 的实际目录，再选择已有模型或通过界面下载。

```powershell
cd shell
npm ci
npm test
$env:BREEZE_RUNTIME = (Resolve-Path .\runtime).Path
npm start
```

`npm test` 包含脚本分段、失败续跑、取消、草稿导入、WAV 和 SRT 时间轴，以及停止请求时的代理连接清理。已有本地模型和运行时时可运行 `npm run selftest`，验证推理服务与应用界面。

检查无模型首次启动时，运行时目录应没有模型，并使用以下命令指定独立数据目录。

```powershell
Remove-Item Env:BREEZE_MODEL -ErrorAction SilentlyContinue
$env:BREEZE_DATA = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
npm run selftest:offline
```

## Windows 安装包

[GitHub Actions 构建工作流](../.github/workflows/build.yml)下载上游 `v0.1.3` Windows x64 Vulkan 运行时，执行 `npm ci`、`npm test` 和 `npm run dist`，再静默安装并运行首次启动自检。产物 `VoiceTrackStudio-Setup` 包含安装包和 `SHA256SUMS.txt`。以 `v` 开头的 Git 标签会触发产物上传到对应 Release。

如需本地构建，将准备好的运行时放入 `shell/runtime/`，在 Windows 下运行 `npm run dist`。优先选择纯 ASCII 字符的源码路径，便于使用 Electron 和 NSIS 工具。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [`shell/main.js`](../shell/main.js) | Electron 窗口、托盘、生命周期和首启自检 |
| [`shell/backend.js`](../shell/backend.js) | 推理进程、模型选择和下载 |
| [`shell/server.js`](../shell/server.js) | 静态界面、API 反向代理和本地控制接口 |
| [`src/ui/`](../src/ui/) | 原生 HTML、CSS 和 JavaScript 界面 |
| [`shell/test/`](../shell/test/) | 基础功能和代理自动测试 |
| [`src/launcher/`](../src/launcher/) 与 [`src/setup/`](../src/setup/) | v1.x 的 C# 与 WebView2 版本，保留供参考 |

前端源码位于 `src/ui/`。`npm start` 和 `npm run dist` 会在运行前同步到 `shell/ui/`。图标脚本位于 [`build/make-icon.py`](../build/make-icon.py)，依赖 Pillow。

## 早期性能记录

以下是早期版本在 Radeon 780M 核显与 16 核 CPU 上使用 Q4_K 的样例数据。实际表现随硬件、模型、文本和运行时变化。

| 场景 | Vulkan | CPU |
| --- | --- | --- |
| 约 11.4 秒音频 | 约 35.3 秒 | 约 77.6 秒 |
| 约 3.3 秒音频 | 约 21.9 秒，首音 10.5 秒 | 约 24.8 秒，首音 2.7 秒 |

当前启动器给推理程序传入 `--no-warmup`，以缩短早期机器测试中观察到的启动预热时间。
