"""Lists external links in the built PDF and DOCX (release check)."""
import pathlib, re, zipfile
import fitz

OUT = pathlib.Path(__file__).resolve().parent.parent
pdf = fitz.open(OUT / "Cortextrace_Product_Release_Document_v0.1.0.pdf")
print("PDF pages:", pdf.page_count)
print("PDF URI links:", sorted({l["uri"] for p in pdf for l in p.get_links() if l.get("uri")}))
rels = zipfile.ZipFile(OUT / "Cortextrace_Product_Release_Document_v0.1.0.docx").read("word/_rels/document.xml.rels").decode()
print("DOCX external links:", sorted(set(re.findall(r'Target="((?:https?|mailto)[^"]+)"', rels))))
