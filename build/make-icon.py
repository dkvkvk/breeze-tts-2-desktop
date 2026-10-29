# -*- coding: utf-8 -*-
"""生成 Breeze TTS 2 图标：黑底圆角方块 + 白色字母 B。"""
import os, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from PIL import Image, ImageDraw, ImageFont

BLACK = (10, 10, 10, 255)
WHITE = (255, 255, 255, 255)
MASTER = 1024

def find_font(size):
    cands = [r"C:\Windows\Fonts\seguisb.ttf", r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"]
    for c in cands:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()

img = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# 圆角方块：半径约为边长的 22%
r = int(MASTER * 0.22)
d.rounded_rectangle([0, 0, MASTER - 1, MASTER - 1], radius=r, fill=BLACK)

# 字母 B：按目标高度反推字号，再居中到光学中心
target_h = int(MASTER * 0.56)
best = None
for size in range(int(MASTER * 0.9), 10, -1):
    f = find_font(size)
    box = d.textbbox((0, 0), "B", font=f)
    h = box[3] - box[1]
    if h <= target_h:
        best = (f, box, size)
        break
f, box, size = best
tw, th = box[2] - box[0], box[3] - box[1]
x = (MASTER - tw) / 2 - box[0]
y = (MASTER - th) / 2 - box[1]
d.text((x, y), "B", font=f, fill=WHITE)

os.makedirs("assets", exist_ok=True)
sizes = [256, 128, 96, 64, 48, 40, 32, 24, 20, 16]
frames = [(img.resize((s, s), Image.LANCZOS)) for s in sizes]
frames[0].save("assets/icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])

img.resize((256, 256), Image.LANCZOS).save("assets/icon-256.png")
strip = Image.new("RGBA", (320, 96), (255, 255, 255, 255))
x = 8
for s in (16, 24, 32, 48, 64):
    im = img.resize((s, s), Image.LANCZOS)
    strip.paste(im, (x, (96 - s) // 2), im)
    x += s + 10
strip.save("assets/icon-sizes.png")
print("ico", os.path.getsize("assets/icon.ico"), "bytes; sizes", sizes)
