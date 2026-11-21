# 本机 Agent 接入

声轨工坊可以在已加载模型的 Windows 应用中接收长文和多角色配音任务。桌面「章节配音」、HTTP 和 MCP 共用同一个后台队列。在桌面项目历史中可打开 Agent 提交的章节，编辑台词、继续合成和导出。任务数据与已生成片段保存在安装数据目录的 `chapter-jobs/` 中。

## 启用

退出正在运行的声轨工坊。在 PowerShell 7 中生成一个仅用于本机接入的令牌，再启动应用。

```powershell
$env:VOICETRACK_AGENT_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
& 'D:\BreezeTTS2\VoiceTrackStudio.exe'
```

令牌由当前应用进程和获授权的本机客户端使用。Agent 接口默认关闭，桌面保存与生成章节无需配置令牌。服务只监听本机回环地址，客户端使用 `Authorization: Bearer …`。实际端口可在声轨工坊右上方的「API」面板查看。

## HTTP

| 方法与路径 | 用途 |
| --- | --- |
| GET `/api/v1/health` | 查看模型是否加载 |
| GET `/api/v1/voices` | 取得已保存的参考音色 ID |
| POST `/api/v1/jobs` | 提交配音任务并取得任务 ID |
| GET `/api/v1/jobs/{id}` | 查询进度和错误 |
| POST `/api/v1/jobs/{id}/cancel` | 停止任务并保留已完成片段 |
| POST `/api/v1/jobs/{id}/resume` | 使用原模型继续未完成的任务 |
| GET `/api/v1/jobs/{id}/artifacts` | 获取成品列表和下载路径 |

提交单音色长文时可发送 `{"text":"这里是旁白。","pauseMs":500}`。多角色章节可按以下格式提交。先从音色列表读取实际 ID，再替换例子中的 `linxia-saved-voice`。

```json
{
  "title": "第三章 走廊",
  "pauseMs": 500,
  "includeSpeakers": true,
  "roles": [
    {"id":"narrator","name":"旁白","voiceId":"","instruction":""},
    {"id":"linxia","name":"林夏","voiceId":"linxia-saved-voice","instruction":""}
  ],
  "segments": [
    {"speakerId":"narrator","text":"走廊里安静下来。"},
    {"speakerId":"linxia","text":"你终于来了。"}
  ]
}
```

创建任务时可使用 `Idempotency-Key`。同一标识重试相同内容会返回原任务 ID。任务完成后用同一个令牌访问返回的 WAV 和 SRT 路径。

在启动应用的 PowerShell 会话中可试跑以下单音色任务。任务状态为 `complete` 后再下载，两次请求均使用同一个令牌。

```powershell
$base = 'http://127.0.0.1:18080/api/v1'
$headers = @{ Authorization = "Bearer $env:VOICETRACK_AGENT_TOKEN" }
$job = Invoke-RestMethod "$base/jobs" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body '{"title":"接入测试","text":"列车即将到站。","pauseMs":500}'
do {
  Start-Sleep -Milliseconds 750
  $progress = Invoke-RestMethod "$base/jobs/$($job.id)" -Headers $headers
} while ($progress.state -in @('queued', 'running'))
if ($progress.state -ne 'complete') { throw "任务状态为 $($progress.state)。$($progress.error)" }
Invoke-WebRequest "$base/jobs/$($job.id)/artifacts/chapter.wav" -Headers $headers -OutFile 'chapter.wav'
```

## MCP

使用支持 stdio 的客户端启动 Node.js 22 或更高版本。安装版适配器位于 `resources\agent\voicetrack-mcp.cjs`。源码调试时可在 `shell` 目录运行 `npm run build:mcp` 生成相同的单文件适配器。

在客户端传入环境变量 `VOICETRACK_AGENT_TOKEN` 和 `VOICETRACK_API_BASE`。后者默认取 `http://127.0.0.1:18080/`。请在可信的客户端配置中设置令牌。

工具提供 `breeze_get_status`、`breeze_list_voices`、`breeze_create_job`、`breeze_get_job`、`breeze_cancel_job`、`breeze_resume_job` 和 `breeze_get_artifacts`。先查询音色，再提交原文或已核对的角色与台词列表。完成后用本机链接下载产物。

采用 `mcpServers` 配置的客户端可按下面的结构填写，替换安装路径、令牌和实际端口。

```json
{
  "mcpServers": {
    "voicetrack-studio": {
      "command": "node",
      "args": ["D:\\BreezeTTS2\\resources\\agent\\voicetrack-mcp.cjs"],
      "env": {
        "VOICETRACK_AGENT_TOKEN": "填入启动桌面应用时使用的令牌",
        "VOICETRACK_API_BASE": "http://127.0.0.1:18080/"
      }
    }
  }
}
```

## 单章标定

桌面用户在「AI 标定」点击「复制 Agent 任务」，获得限这一章、有效 30 分钟的令牌。Agent 建议会暂存到桌面预览，用户确认后生效。用户可随时结束授权。

| HTTP | MCP | 用途 |
| --- | --- | --- |
| `GET /api/v1/chapter-review` | `breeze_read_chapter_review` | 读取章节片段、已有角色和可用音色。 |
| `POST /api/v1/chapter-review` | `breeze_submit_chapter_review` | 提交待确认对白的说话人和角色音色建议。 |

HTTP 使用 `Authorization: Bearer <单章令牌>`。MCP 将单章令牌作为工具的 `token` 参数，可省略合成任务所用的全局环境变量。使用与桌面一致的本机端口。提交格式如下，`index` 使用读取结果里的数字索引。已有角色只填 `id` 和拟使用的 `voiceId`，新角色需附 `name` 且 ID 以 `ai-` 开头。

```json
{
  "roles": [{"id": "ai-1", "name": "林夏", "voiceId": "voicetrack-young-woman"}],
  "marks": [{"index": 3, "speakerId": "ai-1"}]
}
```

## 排查

| 情况 | 处理 |
| --- | --- |
| 连不上应用 | 确认桌面应用仍在运行，并查看「API」面板的实际端口。 |
| `agent_disabled` 或 `invalid_token` | 用同一个令牌启动应用所在进程和 Agent 客户端。已经打开的应用需要完全退出再启动。 |
| `engine_unavailable` | 等桌面应用加载本地模型后重试。 |
| `model_changed` | 在桌面切回项目原来使用的模型，再继续未完成任务。 |
| 成品列表为空 | 查询任务状态。`failed` 时查看 `error` 字段。`complete` 后可获取 WAV 和 SRT。 |
