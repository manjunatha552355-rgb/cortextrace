# Cortextrace 0.1.0: product release documentation package

## Deliverables

| File / folder | Contents |
|---|---|
| `Cortextrace_Product_Release_Document_v0.1.0.pdf` | Print-ready A4 document (56 pages): cover, clickable contents, 21 chapters, bookmarks, embedded Segoe UI fonts, vector diagrams |
| `Cortextrace_Product_Release_Document_v0.1.0.docx` | Editable Word version of the same content: Word heading styles, hyperlinked contents, tables, 41 embedded images |
| `Cortextrace_Screenshots/` | 32 original screenshots captured from the running application (2880×1800) |
| `Cortextrace_Annotated_Screenshots/` | 31 annotated versions with numbered callouts (the dark-theme shot has no annotations) |
| `Cortextrace_Architecture_Diagrams/` | 8 diagrams, each as SVG (vector) and PNG (2×) |
| `FEATURE_INVENTORY.md` | Classification of 31 feature areas, with evidence for each |
| `FACT_VALIDATION.md` | Claim → source → verified → document location; corrections and privacy review |
| `build/preview/` | Rendered PNG preview of every PDF page, plus contact sheets |
| `build/qa-report.json` | Automated QA results: pages, fonts, links, outline, privacy scan |

## Publisher

Manjunatha M, AI and ML consultants: <https://aiandmlconsultants.com/>, <Manjunatha@aiandmlconsultants.com>
Source code and releases: <https://github.com/manjunatha552355-rgb/cortextrace>

The contact details are stored in `META` in `tools/doc-content.mjs`. After changing them, rebuild. `build/` is generated locally and is not committed.

## Notes

- **DOCX contents page numbers.** The DOCX contents list is hyperlinked but has no page numbers. To add them, open the file in Word and use References → Table of Contents.
- **Link check.** `python product-release/tools/check_links.py` lists the external links in both files.

## Rebuilding

```powershell
# Screenshots (full capture, about 7 minutes). Uses an isolated demo profile under F:\CortextraceDemo.
node --no-warnings product-release/tools/capture.mjs

# Diagrams, PDF (two passes for contents page numbers), previews, DOCX
powershell -File product-release/tools/build-all.ps1

# QA scan
python product-release/tools/qa_scan.py
```

## How the screenshots were produced

- The real Cortextrace application was launched with `--user-data-dir` and a demonstration `HOME`/`APPDATA`, and driven through the Chrome DevTools Protocol.
- Demonstration data came from the bundled synthetic generator. It was sent through the application's real hook, OTLP and REST endpoints, and each synthetic event is labelled `source: synthetic` or arrives as hook/OTLP.
- The process-tree view uses a harmless demonstration agent process: Node scripts that only sleep.
- Callouts are drawn over the bounding boxes of the live DOM elements.
- The document states all of this in section 02.
