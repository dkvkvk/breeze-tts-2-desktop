# Breeze TTS 2 桌面版

给 [Breeze TTS 2](https://github.com/HoppouAI/Breeze-TTS-2.cpp) 做的 Windows 桌面程序：**Electron 外壳**，自带 Chromium 与 Node。双击装完就是它自己的窗口——不依赖系统 WebView2，也不会退回浏览器；后端进程随应用启动、随应用退出。

后端是原版 `breeze-server` 的量化版（Q4_K），本项目**不含模型权重**，首次启动时下载。

![界面](docs/screenshot.png)

## 它做了什么

原版只有命令行和编译期嵌死的英文 WebUI。这个项目补上三件事：

1. **一个安装包**——`BreezeTTS2-Setup-*.exe`：可选安装目录、自动创建桌面与开始菜单快捷方式、自带运行时（不用另装 WebView2 或 .NET），不带 2.4 GB 权重。
2. **一个中文界面**——音色设计 / 音色克隆 / 表演指挥 / 变声转换 / 音色库，五页全中文，另有音色导入和 API 说明面板。
3. **一个真正的外壳**——托盘图标、原生菜单（文件 / 视图 / 帮助）、单实例（再点一次唤起已有窗口）、后端随应用启停、模型下载断点续传。

## 图标

黑底圆角方块 + 白色字母 B，只有两个颜色，16 px 到 256 px 都能读。图标由 `build/make-icon.py` 用几何方式生成（Pillow 渲染 → 多尺寸 `.ico`），改风格改脚本重跑即可：

```powershell
python build/make-icon.py     # 产出 assets/icon.ico
```

![图标](docs/icon-sizes.png)

图标编进两个 exe，所以开始菜单、桌面快捷方式、任务栏、窗口标题栏都自动用它。

## 界面

黑白两色，等宽字体做标注，没有渐变、阴影和圆角。五个功能页面对应后端的三组能力：

| 页面 | 接口 | 说明 |
| --- | --- | --- |
| 音色设计 | `POST /v1/audio/speech` | 用自然语言描述声音，直接合成 |
| 音色克隆 | `POST /v1/voices` | 上传参考音频 + 文本，注册成音色 |
| 表演指挥 | `POST /v1/audio/speech` | 文本与描述分离，边改边听 |
| 变声转换 | `POST /v1/audio/convert` | 保留内容，换音色 |
| 音色库 | `GET/DELETE /v1/voices` | 管理已注册音色 |

音频是**流式**的：后端以 `audio/pcm` 分块返回（24 kHz / s16le / 单声道），前端边收边播，第一块到了就开始出声，不等整段生成完。

## 导入音色

音色库页面的「导入音色」区可以把音频直接拖进去（或点「选择文件」），支持多选、批量导入。

- **格式**：`wav` / `mp3` / `m4a` / `flac` / `ogg` —— 凡是浏览器能解码的都行，导入时统一转成后端要的 **24 kHz 单声道 16-bit WAV**（44.1k/48k、立体声、各种码率都不用管）。
- **参考文本**：每个文件都要填和录音逐字一致的文本，这是克隆质量的关键；建议 6–15 秒干净单人声，超过 30 秒自动截断。
- **`.btv` 音色包**：zip 里放 `voice.json` + 参考音频，方便分享给别人直接导入：

  ```json
  { "name": "narrator", "ref_text": "参考音频的逐字文本", "description": "低沉男声", "audio": "ref.wav" }
  ```

免费音色素材（都能直接下参考音频，注意各自许可）：

| 来源 | 语言 | 许可 | 备注 |
| --- | --- | --- | --- |
| [AISHELL-3](https://huggingface.co/datasets/AISHELL/AISHELL-3) | 中文 | Apache-2.0 | 218 位说话人、带转录，最适合找中文音色 |
| [CSTR-Edinburgh/vctk](https://huggingface.co/datasets/CSTR-Edinburgh/vctk) | 英文 | CC BY 4.0 | 上百位说话人，录音干净 |
| [openslr/librispeech_asr](https://huggingface.co/datasets/openslr/librispeech_asr) | 英文 | CC BY 4.0 | 有声书朗读，附 `.trans.txt` 转录 |
| [Mozilla Common Voice](https://commonvoice.mozilla.org/datasets) | 多语种 | CC0 | 众包录音，质量参差，附 `.tsv` 句子 |

> 上面的许可只约束**素材本身**；合成出来的音频还要另外遵守 Breeze TTS 2 权重的非商业条款。

## 本机接口

界面右上角「API」按钮能查看接口地址并一键复制。程序运行期间在本机开三个端口：

| 端口 | 用途 |
| --- | --- |
| `18080` | 界面 + 反代，`/api/*` 转发到后端 `/v1/*` |
| `18099` | 后端 REST |
| `18100` | WebSocket（HTTP 端口 + 1） |

```
GET    /api/health              健康检查
POST   /api/audio/speech        合成，返回 24 kHz 单声道 PCM（audio/pcm）
POST   /api/voices              注册音色：ref_audio + ref_text + name
GET    /api/voices              列出音色
DELETE /api/voices/<id>         移除音色
POST   /api/audio/convert       变声转换
```

两个端口都没有鉴权，只绑 `127.0.0.1`；要给局域网调用，得自己加一层反代和鉴权。

## 安装

1. 从 [Releases](https://github.com/dkvkvk/breeze-tts-2-desktop/releases) 下载 `BreezeTTS2-Setup-2.0.0.exe`。
2. 双击安装。默认装到 `%LOCALAPPDATA%\Programs\Breeze TTS 2`，**点「浏览…」可以装到任意目录**（比如 D 盘）；装完自动创建**桌面快捷方式**和开始菜单项，卸载项进「设置 → 应用」。
3. 首次启动会下载 `breeze-tts-2-q4_k.gguf`（约 2.4 GB），断点续传 + 镜像回退，界面上有进度。
4. 模型就位后自动拉起后端，窗口里五页可用；关窗口 = 退出，后端进程一并结束。最小化到托盘后可右键菜单重新打开。
5. 想换量化档（比如 Q6_K）：把新 gguf 放进 `%LOCALAPPDATA%\BreezeTTS2\models\`，**改名为 `breeze-tts-2-q4_k.gguf`** 即可——外壳按文件名找模型，换档前先退出程序。

卸载走「设置 → 应用 → Breeze TTS 2」，或运行安装目录下的 `BreezeTTS2.exe --uninstall`。

## 构建

**不在本地打包**，全部走 GitHub Actions（`.github/workflows/build.yml`）：push 到 `main` 或手动 `workflow_dispatch` 触发，跑完在 Actions 的 Artifacts 里取 `BreezeTTS2-Setup-*.exe`；打 tag 会自动挂到 Release。

CI 的步骤：下载上游官方 Windows 运行时包（`HoppouAI/Breeze-TTS-2.cpp` 的 `v0.1.3-windows-x64-vulkan.zip`）→ 解到 `shell/runtime/` → `npm ci` → `electron-builder --win nsis` → 校验产物并打印 sha256。

本地只想调界面（不产安装包）：

```powershell
cd shell
npm install
npm start        # 先同步 src/ui → shell/ui，再 electron .
npm run selftest # 不开窗口：跑主进程 + 本地服务 + 后端 + 界面自检
```

## 目录

```
shell/main.js         Electron 主进程：窗口 / 托盘 / 菜单 / 单实例 / 自检
shell/backend.js      后端进程管理 + 模型下载（纯 Node，可单独跑）
shell/server.js       本地 UI 服务 + /api 反代 + /local/* 控制面
shell/sync-ui.js      把 src/ui 同步进应用（前端只有一份源）
src/ui/               界面（原生 HTML/CSS/JS，无框架、无构建）
src/launcher, src/setup, build/    v1.x 的 C# + WebView2 外壳，保留作参考
```

外壳是唯一 origin：它把 `/api/*` 反代到后端的 `:18099`，所以**不需要给后端开 `--cors`**，也不会撞上跨域限制。

### 为什么从 WebView2 换成 Electron

v1.x 用 C# + 系统 WebView2：安装包 56 MB，但依赖系统运行时，缺运行时只能退回浏览器打开，用起来像网页。v2 换到 Electron——和 DeepSeek Harness 桌面端同一套方案：自带 Chromium/Node，窗口、托盘、菜单、快捷方式、后端生命周期全在自己手里，代价是安装包大一圈。

## 实测性能

AMD Radeon 780M 核显 / Q4_K / 16 核 CPU：

| 场景 | Vulkan | CPU |
| --- | --- | --- |
| 长文本（11.4 s 音频） | RTF 3.08（35.3 s） | RTF 6.60（77.6 s） |
| 短句（3.3 s 音频） | RTF 6.7（21.9 s），首音 10.5 s | RTF 7.6（24.8 s），首音 2.7 s |

长文本走 Vulkan 快一倍，短句 CPU 首音更快。启动器默认加 `--no-warmup`。

## 两个坑

- **不要开 warmup**。默认预热在核显上会连续占用 CPU/GPU 十几分钟（实测 CPU 100%、73 °C），而它换来的只是首音快几秒。启动器已经固定关闭。
- **量化档不是越低越快**。声码器权重钉死 F32、不参与量化，降档只掉质量不提速。

## 许可证

- 本项目代码：[Apache-2.0](LICENSE)。
- Breeze TTS 2 模型权重：**BreezeBlue Research and Non-Commercial License**，仅限非商业研究用途。本项目不打包权重，下载行为由使用者自行承担合规责任。
- 后端 `breeze-server` 及其二进制来自 [HoppouAI/Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp)，许可见 THIRD_PARTY_NOTICES。

非官方项目，与上游作者无关。
