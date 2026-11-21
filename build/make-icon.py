"""Generate the VoiceTrack Studio icon and installer artwork."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "shell" / "build"
BLACK = (11, 11, 11)
WHITE = (255, 255, 255)
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def draw_mark(draw, left, top, size):
    widths = size * 0.095
    for index, height in enumerate((0.23, 0.46, 0.65, 0.43, 0.21)):
        x = left + size * (0.18 + index * 0.135)
        y = top + size * (1 - height) / 2
        draw.rounded_rectangle((x, y, x + widths, y + size * height), radius=widths / 2, fill=WHITE)


def text_font(size):
    return ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", size)


def main():
    icon = Image.new("RGBA", (1024, 1024))
    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle((0, 0, 1023, 1023), radius=216, fill=BLACK)
    draw_mark(draw, 0, 0, 1024)
    for filename in ("assets/icon.ico", "shell/assets/icon.ico", "shell/build/installerHeaderIcon.ico"):
        icon.save(ROOT / filename, sizes=[(n, n) for n in SIZES])
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(ROOT / "docs/icon.png")
    strip = Image.new("RGB", (320, 96), WHITE)
    x = 8
    for size in (16, 24, 32, 48, 64):
        frame = icon.resize((size, size), Image.Resampling.LANCZOS)
        strip.paste(frame, (x, (96 - size) // 2), frame)
        x += size + 10
    strip.save(ROOT / "docs/icon-sizes.png")

    header = Image.new("RGB", (150, 57), WHITE)
    draw = ImageDraw.Draw(header)
    draw.rectangle((0, 0, 149, 2), fill=BLACK)
    draw.text((75, 29), "声轨工坊", font=text_font(17), fill=BLACK, anchor="mm")
    header.save(BUILD / "installerHeader.bmp")

    sidebar = Image.new("RGB", (164, 314), BLACK)
    draw = ImageDraw.Draw(sidebar)
    draw.line((22, 40, 142, 40), fill=(58, 58, 58))
    draw_mark(draw, 50, 97, 64)
    draw.text((82, 184), "声轨工坊", font=text_font(18), fill=WHITE, anchor="mm")
    draw.line((22, 250, 142, 250), fill=(58, 58, 58))
    draw.text((82, 270), "本地配音", font=text_font(12), fill=(154, 154, 154), anchor="mm")
    sidebar.save(BUILD / "installerSidebar.bmp")


if __name__ == "__main__":
    main()
