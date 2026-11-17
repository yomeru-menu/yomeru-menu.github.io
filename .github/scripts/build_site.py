"""Build _site for GitHub Pages.

For every shops/<id>.json this writes s/<id>/index.html: a copy of index.html
with <base href="../../">, a shop-specific <title>, and og:/description meta
tags so link previews (LINE, Instagram, Google Maps menu link) show the shop
name. /s/<id>/ then answers HTTP 200. Adding a shop = adding its JSON.

Usage: python3 build_site.py [base_url]
"""
import html
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(".")
OUT = ROOT / "_site"
BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else "").rstrip("/")
ID_RE = re.compile(r"[A-Za-z0-9_-]+")


def fail(path, msg):
    print(f"::error file={path}::{msg}")
    sys.exit(1)


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        fail(path, f"invalid JSON: {e}")


def attr(s):
    return html.escape(s, quote=True)


for f in sorted((ROOT / "i18n").glob("*.json")):
    load_json(f)

shutil.rmtree(OUT, ignore_errors=True)
OUT.mkdir()
for name in ["index.html", "404.html", ".nojekyll"]:
    shutil.copy(ROOT / name, OUT / name)
for name in ["assets", "i18n", "shops"]:
    shutil.copytree(ROOT / name, OUT / name)

template = (ROOT / "index.html").read_text(encoding="utf-8")

for f in sorted((ROOT / "shops").glob("*.json")):
    sid = f.stem
    if not ID_RE.fullmatch(sid):
        fail(f, "shop id (file name) must use only A-Z a-z 0-9 _ -")
    shop = load_json(f)
    names = shop.get("name") or {}
    ja = names.get("ja")
    if not ja:
        fail(f, 'missing name.ja')
    en = names.get("en") or ja

    title = f"{ja} | メニュー · Menu · 메뉴 · 菜单"
    desc = (f"{ja}のメニューを日本語・English・한국어・中文で。"
            f"See the {en} menu in English, Korean and Chinese.")
    meta = [
        '<base href="../../">',
        f'<meta name="description" content="{attr(desc)}">',
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Yomeru">',
        f'<meta property="og:title" content="{attr(title)}">',
        f'<meta property="og:description" content="{attr(desc)}">',
        '<meta name="twitter:card" content="summary">',
    ]
    if BASE_URL:
        meta.append(f'<meta property="og:url" content="{attr(BASE_URL)}/s/{sid}/">')

    page = template.replace("<head>", "<head>\n" + "\n".join(meta), 1)
    page = re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", page, count=1)

    dest = OUT / "s" / sid
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "index.html").write_text(page, encoding="utf-8")
    print(f"built /s/{sid}/  ({ja})")
