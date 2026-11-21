# 本机 Agent 接入

声轨工坊可以在已加载模型的 Windows 应用中接收长文和多角色配音任务。HTTP 和 MCP 共用同一个后台队列。任务数据与已生成片段保存在安装数据目录的 `chapter-jobs/` 中。

## 启用

退出正在运行的声轨工坊。在 PowerShell 7 中生成一个仅用于本机接入的令牌，再启动应用。

```powershell
$env:VOICETRACK_AGENT_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
& 'D:\BreezeTTS2\VoiceTrackStudio.exe'
```

令牌由当前应用进程和获授权的本机客户端使用。Agent 接口默认关闭。服务只监听本机回环地址，客户端使用 `Authorization: Bearer …`。实际端口可在声轨工坊右上方的「API」面板查看。

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

## MCP

使用支持 stdio 的客户端启动 Node.js 22 或更高版本。安装版适配器位于 `resources\agent\voicetrack-mcp.cjs`。源码调试时可在 `shell` 目录运行 `npm run build:mcp` 生成相同的单文件适配器。

在客户端传入环境变量 `VOICETRACK_AGENT_TOKEN` 和 `VOICETRACK_API_BASE`。后者默认取 `http://127.0.0.1:18080/`。请在可信的客户端配置中设置令牌。

工具提供 `breeze_get_status`、`breeze_list_voices`、`breeze_create_job`、`breeze_get_job`、`breeze_cancel_job`、`breeze_resume_job` 和 `breeze_get_artifacts`。先查询音色，再提交原文或已核对的角色与台词列表。完成后用本机链接下载产物。
