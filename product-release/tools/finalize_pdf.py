"""Merges cover + body, records section page numbers for the TOC, adds bookmarks and metadata, renders previews."""
import json, sys, pathlib
import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
model = json.loads((BUILD / "doc-model.json").read_text(encoding="utf-8"))
meta = model["meta"]

body = fitz.open(BUILD / "body.pdf")
pages = {}
for entry in model["toc"]:
    needle = entry["title"]
    for i, page in enumerate(body):
        if i == 0:
            continue  # contents page lists every title
        if page.search_for(f"{entry['num']}") and page.search_for(needle):
            # chapter heads are the first large heading on their page
            blocks = page.get_text("dict")["blocks"]
            big = [s for b in blocks for l in b.get("lines", []) for s in l["spans"] if s["size"] > 20]
            if any(needle in s["text"] for s in big):
                pages[entry["id"]] = i + 1
                break
missing = [e["id"] for e in model["toc"] if e["id"] not in pages]
(BUILD / "toc-pages.json").write_text(json.dumps(pages, indent=2))
print("section pages:", pages, "missing:", missing)

if "--merge" in sys.argv:
    out = fitz.open(BUILD / "cover.pdf")
    out.insert_pdf(body, links=True)
    toc = [[1, "Cover", 1], [1, "Contents", 2]] + [[1, f"{e['num']} {e['title']}", pages[e["id"]] + 1] for e in model["toc"] if e["id"] in pages]
    out.set_toc(toc)
    # Clickable contents: each row links to its chapter (merged index = body page number, cover is index 0).
    contents = out[1]
    width = contents.rect.width
    for e in model["toc"]:
        if e["id"] not in pages:
            continue
        hits = contents.search_for(e["title"])
        if hits:
            r = hits[0]
            row = fitz.Rect(40, r.y0 - 3, width - 40, r.y1 + 3)
            contents.insert_link({"kind": fitz.LINK_GOTO, "from": row, "page": pages[e["id"]], "to": fitz.Point(0, 0)})
    out.set_metadata({
        "title": meta["title"], "author": meta["author"], "subject": f"{meta['product']} {meta['version']} — {meta['release_designation']}",
        "keywords": "Cortextrace, AI agents, observability, security, release", "creator": "Cortextrace documentation build", "producer": "Chromium + PyMuPDF",
    })
    target = ROOT / f"Cortextrace_Product_Release_Document_v{meta['version']}.pdf"
    out.save(target, garbage=3, deflate=True)
    print("saved", target, out.page_count, "pages")
    prev = ROOT / "build" / "preview"
    prev.mkdir(exist_ok=True)
    for old in prev.glob("page-*.png"):
        old.unlink()
    for i, page in enumerate(out):
        page.get_pixmap(matrix=fitz.Matrix(1.1, 1.1)).save(prev / f"page-{i + 1:02d}.png")
    fonts = sorted({f[3] for p in out for f in p.get_fonts()})
    print("embedded fonts:", fonts)
