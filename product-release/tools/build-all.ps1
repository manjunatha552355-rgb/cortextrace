# Rebuilds diagrams, the PDF (two passes for TOC page numbers), previews and the DOCX.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo
$env:ELECTRON_RUN_AS_NODE = $null
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
node product-release/tools/diagrams.mjs
Start-Process -FilePath $electron -ArgumentList 'product-release/tools/render-svg.cjs' -NoNewWindow -Wait
foreach ($pass in 1, 2) {
  node product-release/tools/build-doc.mjs
  Start-Process -FilePath $electron -ArgumentList 'product-release/tools/print-pdf.cjs' -NoNewWindow -Wait
  python product-release/tools/finalize_pdf.py
}
python product-release/tools/finalize_pdf.py --merge
python product-release/tools/sheets.py
if (Test-Path product-release/tools/build_docx.py) { python product-release/tools/build_docx.py }
