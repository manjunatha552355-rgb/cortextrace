"""Contact sheets of rendered PDF pages for visual QA."""
import glob, math, os, pathlib
from PIL import Image

prev = pathlib.Path(__file__).resolve().parent.parent / "build" / "preview"
for f in prev.glob("sheet-*.png"):
    f.unlink()
pages = sorted(glob.glob(str(prev / "page-*.png")))
per = 8
for s in range(math.ceil(len(pages) / per)):
    ims = [Image.open(p) for p in pages[s * per:(s + 1) * per]]
    w, h = ims[0].size
    tw, th = int(w * 0.62), int(h * 0.62)
    sheet = Image.new("RGB", (tw * 4 + 50, th * 2 + 30), (120, 120, 120))
    for i, im in enumerate(ims):
        sheet.paste(im.resize((tw, th)), (10 + (i % 4) * (tw + 10), 10 + (i // 4) * (th + 10)))
    sheet.save(prev / f"sheet-{s + 1}.png")
print(len(pages), "pages")
