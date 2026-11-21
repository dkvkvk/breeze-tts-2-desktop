# 配音示例

## 末班渡船的蓝信封

完整原创短篇，演示从导入正文、校对对白到生成四角色配音。包含全文 TXT、完整 WAV、角色字幕和实际标注截图。 [查看完整示例](blue-envelope/README.md)

## 城市漫步

这是声轨工坊 2.3.0 的非商业功能示例。三段原创旁白由 BreezeBlue 的 Breeze TTS 2 模型（Q4_K 量化档）在本机合成。音频为合成语音，未使用人物参考录音。

- [试听 WAV](https://raw.githubusercontent.com/dkvkvk/breeze-tts-2-desktop/main/docs/examples/quickstart.wav)
- [原稿 TXT](quickstart.txt)
- [字幕 SRT](quickstart.srt)

在「长文配音」中导入 TXT，填写音色描述「语速从容、吐字清楚的中文旁白」，设置 0.5 秒段间停顿。点击生成后可另行导出 WAV 和 SRT。合成结果随模型和推理条件而变化。示例输出遵循 [BreezeBlue 研究与非商业许可](https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/LICENSE)。

## 雨后的末班车

声轨工坊 2.4.0 的多角色示例有十段台词，包含旁白、林夏、周明和车站值班员。四个参考音色均由本地 Q4_K 模型合成。字幕包含角色名，按输出音频实际时长计算。示例使用原创台词，供非商业试用。

- [试听约 34 秒 WAV](chapter-demo.wav)
- [原稿 TXT](chapter-demo.txt)
- [配套字幕 SRT](chapter-demo.srt)
