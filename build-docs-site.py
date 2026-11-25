#!/usr/bin/env python3
"""Build the GitHub Pages legal docs site from TERMS.md, PRIVACY.md, PRICING.md.

Reads the three markdown files at the repo root, converts them to HTML with
the Python markdown library (tables extension for the Privacy table), and
writes docs/terms.html, docs/privacy.html, docs/pricing.html, plus a
docs/index.html landing page and docs/.nojekyll (so GitHub serves the HTML
as-is instead of running Jekyll).
"""
import os
import markdown

REPO = os.path.expanduser("~/workspace/comic-translate-ext")
DOCS = os.path.join(REPO, "docs")

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — Comic Translate 4 Free</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 0; padding: 0; font: 15px/1.6 system-ui, sans-serif; background: #141417; color: #e8e8ea; }}
  main {{ max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }}
  nav {{ max-width: 760px; margin: 0 auto; padding: 16px 20px 0; font-size: 14px; }}
  nav a {{ color: #8ab4f8; text-decoration: none; margin-right: 18px; }}
  nav a:hover {{ text-decoration: underline; }}
  h1 {{ font-size: 26px; color: #fff; margin: 8px 0 4px; }}
  h2 {{ font-size: 19px; color: #fff; margin: 28px 0 8px; }}
  h3 {{ font-size: 16px; color: #fff; margin: 20px 0 6px; }}
  p, li {{ color: #d6d6da; }}
  a {{ color: #8ab4f8; }}
  code {{ background: #232327; padding: 1px 5px; border-radius: 4px; font-size: 13px; }}
  table {{ border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }}
  th, td {{ border: 1px solid #3a3a40; padding: 8px 10px; text-align: left; vertical-align: top; }}
  th {{ background: #232327; color: #fff; }}
  ul, ol {{ padding-left: 24px; }}
  li {{ margin: 4px 0; }}
  @media (max-width: 600px) {{
    table, thead, tbody, th, td, tr {{ display: block; }}
    thead tr {{ display: none; }}
    tr {{ margin-bottom: 12px; border: 1px solid #3a3a40; border-radius: 8px; }}
    td {{ border: none; border-bottom: 1px solid #2e2e33; }}
    td:last-child {{ border-bottom: none; }}
  }}
</style>
</head>
<body>
<nav><a href="index.html">Comic Translate 4 Free</a><a href="terms.html">Terms and Conditions</a><a href="privacy.html">Privacy Policy</a><a href="pricing.html">Pricing</a></nav>
<main>
{body}
</main>
</body>
</html>
"""

INDEX_BODY = """<h1>Comic Translate 4 Free</h1>
<p>Translate manga and comics in your browser. Reads Japanese, English, Simplified/Traditional Chinese; translates into 114 languages.</p>
<ul>
<li><a href="terms.html">Terms and Conditions</a></li>
<li><a href="privacy.html">Privacy Policy</a></li>
<li><a href="pricing.html">Pricing</a></li>
</ul>
<p>Source code: <a href="https://github.com/jameslee0623/Comic-Translate-4-Free">github.com/jameslee0623/Comic-Translate-4-Free</a></p>
"""

PAGES = [
    ("TERMS.md", "terms.html", "Terms and Conditions"),
    ("PRIVACY.md", "privacy.html", "Privacy Policy"),
    ("PRICING.md", "pricing.html", "Pricing"),
]

os.makedirs(DOCS, exist_ok=True)

for src_name, out_name, title in PAGES:
    src_path = os.path.join(REPO, src_name)
    with open(src_path, encoding="utf-8") as f:
        md_text = f.read()
    body = markdown.markdown(md_text, extensions=["tables"])
    html = TEMPLATE.format(title=title, body=body)
    out_path = os.path.join(DOCS, out_name)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {out_name} ({len(html)} bytes) from {src_name}")

with open(os.path.join(DOCS, "index.html"), "w", encoding="utf-8") as f:
    f.write(TEMPLATE.format(title="Comic Translate 4 Free", body=INDEX_BODY))
print("wrote index.html")

with open(os.path.join(DOCS, ".nojekyll"), "w", encoding="utf-8") as f:
    f.write("")
print("wrote .nojekyll")
