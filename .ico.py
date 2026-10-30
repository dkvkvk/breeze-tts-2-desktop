import os, sys
from PIL import Image, ImageDraw, ImageFont
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BLACK = (10, 10, 10); WHITE = (255, 255, 255)
def font(size, bold=False):
    for name in (['msyhbd.ttc','msyh.ttc'] if bold else ['msyh.ttc','msyhl.ttc']):
        p = os.path.join(os.environ.get('WINDIR','C:\\Windows'), 'Fonts', name)
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except Exception: pass
    return ImageFont.load_default()

sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = []
for s in sizes:
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s-1, s-1], radius=max(2, int(s*0.18)), fill=BLACK)
    f = font(max(8, int(s*0.62)), True)
    bb = d.textbbox((0, 0), 'B', font=f)
    d.text(((s-(bb[2]-bb[0]))/2 - bb[0], (s-(bb[3]-bb[1]))/2 - bb[1]), 'B', font=f, fill=WHITE)
    imgs.append(im)
out = os.path.join('shell', 'build', 'installerHeaderIcon.ico')
imgs[-1].save(out, format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
print('installerHeaderIcon.ico', os.path.getsize(out), 'bytes,', len(sizes), 'sizes')
