# 读第一章 · 石碑上的成绩

以天蚕土豆《斗破苍穹》第一章《陨落的天才》的开场为例，演示如何在连续正文里识别对白、标注说话人并导出有角色名的字幕。示例含一处开篇短引，其余台词为原创导读。[第一章出处](https://book.washai.net/book/1262260513468564078/2039351400475858722.html)

[试听约 30 秒的四角色 WAV](https://raw.githubusercontent.com/dkvkvk/breeze-tts-2-desktop/main/docs/examples/first-chapter/chapter-one.wav) · [导入用 TXT](chapter-one.txt) · [角色字幕 SRT](chapter-one.srt)

1. 打开声轨工坊 2.5.0 或更高版本，在「章节配音」中导入 TXT，点击「识别对白并标注」。
2. 林同学和周老师有明确的说话人提示，会在正文中自动标记。开篇短引和后面的追问需要确认。选中开篇短引后，用「新建音色」创建读牌人。将后面的追问分配给林同学。
3. 为角色选用音色库里的音色，或在选字弹窗新建音色。示例含旁白、读牌人、林同学和周老师四种合成音色。
4. 将段间停顿设为 0.25 秒，勾选「字幕显示角色名」，即可用相同的设置导出 WAV 和 SRT。

样音由本地 Breeze TTS 2 Q4_K 模型合成，包含 24 kHz 单声道音频和按实测时长对齐的字幕。示例供非商业试用。 [模型许可](https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/LICENSE)
