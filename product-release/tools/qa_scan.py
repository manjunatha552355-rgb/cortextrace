"""Final QA scan: page count, embedded fonts, links, outline, privacy patterns in PDF and DOCX text."""
import re, zipfile, pathlib, json
import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
import getpass
PATTERNS = {"windows_username": r"\b" + re.escape(getpass.getuser()) + r"\b", "user_profile_path": r"C:\\Users\\", "email_domain": r"gmail\.com",
            "github_token": r"ghp_[A-Za-z0-9]{20,}", "openai_key": r"sk-[A-Za-z0-9]{20,}", "aws_key": r"AKIA[0-9A-Z]{16}"}
report = {}
pdf = fitz.open(ROOT / "Cortextrace_Product_Release_Document_v0.1.0.pdf")
text = "".join(p.get_text() for p in pdf)
report["pdf"] = {
    "pages": pdf.page_count,
    "outline_entries": len(pdf.get_toc()),
    "internal_links": sum(1 for p in pdf for l in p.get_links() if l.get("kind") in (fitz.LINK_GOTO, fitz.LINK_NAMED)),
    "fonts": sorted({f[3].split("+")[-1] for p in pdf for f in p.get_fonts() if f[3]}),
    "images": sum(len(p.get_images()) for p in pdf),
    "privacy_hits": {k: len(re.findall(v, text, re.I)) for k, v in PATTERNS.items()},
    "placeholders": sorted(set(re.findall(r"\[[A-Z_]+\]", text))),
    "metadata": {k: pdf.metadata.get(k) for k in ("title", "author", "subject")},
}
docx = ROOT / "Cortextrace_Product_Release_Document_v0.1.0.docx"
if docx.exists():
    z = zipfile.ZipFile(docx)
    x = z.read("word/document.xml").decode("utf-8")
    report["docx"] = {"media_files": len([n for n in z.namelist() if n.startswith("word/media/")]),
                      "privacy_hits": {k: len(re.findall(v, x, re.I)) for k, v in PATTERNS.items()},
                      "contents_links": len(set(re.findall(r'w:anchor="(s\d\d)"', x))),
                      "bookmarks": len(set(re.findall(r'w:name="(s\d\d)"', x))),
                      "all_links_resolve": set(re.findall(r'w:anchor="(s\d\d)"', x)) <= set(re.findall(r'w:name="(s\d\d)"', x))}
(ROOT / "build" / "qa-report.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
