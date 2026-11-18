"""Build _site for GitHub Pages.

For every shops/<id>.json this writes:
  s/<id>/index.html  app.html + <base href="../../"> + shop title and
                     og:title / og:description / og:image tags
  s/<id>/og.png      1200x630 link-preview image with the shop name
so /s/<id>/ answers HTTP 200 and shows a proper preview in LINE, Instagram,
Google Maps menu links etc. Adding a shop = adding its JSON.

Shop JSON fields used (all optional except name.ja):
  name.ja / name.en        full name
  shortName.ja             short name for titles (e.g. "とり乃屋"); falls back to name.ja
  accent                   "#RRGGBB" colour for the image
  ownerPicks + items       picks are listed in og:description

Usage: python3 build_site.py [base_url]
Needs Pillow and a Noto Sans CJK font (installed by the workflow).
"""
import glob
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(".")
OUT = ROOT / "_site"
BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else "").rstrip("/")
ID_RE = re.compile(r"[A-Za-z0-9_-]+")
HEX_RE = re.compile(r"#[0-9A-Fa-f]{6}")

TITLE_SUFFIX = "メニュー | Menu · 메뉴 · 菜单"
OG_W, OG_H = 1200, 630
BG, INK, MUTED, DEFAULT_ACCENT = "#F7F6F2", "#1C2430", "#5F6875", "#2B4C7E"


def fail(path, msg):
    print(f"::error file={path}::{msg}")
    sys.exit(1)


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        fail(path, f"invalid JSON: {e}")


def attr(s):
    return html.escape(str(s), quote=True)


def find_font():
    for pat in ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
                "/usr/share/fonts/**/NotoSansCJK*-Bold.ttc",
                "/usr/share/fonts/**/NotoSansCJK*.ttc"):
        hits = sorted(glob.glob(pat, recursive=True))
        if hits:
            return hits[0]
    fail("build_site.py", "Noto Sans CJK font not found (apt-get install fonts-noto-cjk)")


FONT_PATH = find_font()


def font(size):
    return ImageFont.truetype(FONT_PATH, size, index=0)  # index 0 = JP


def fit_font(draw, text, max_w, start, minimum):
    size = start
    while size > minimum and draw.textlength(text, font=font(size)) > max_w:
        size -= 4
    return font(size)


def make_og_image(path, title_name, full_name, accent):
    img = Image.new("RGB", (OG_W, OG_H), BG)
    d = ImageDraw.Draw(img)
    pad, max_w = 80, OG_W - 160
    d.rectangle([0, 0, OG_W, 18], fill=accent)
    d.text((pad, 80), "Yomeru · ヨメル", font=font(34), fill=MUTED)
    d.text((pad, 150), title_name, font=fit_font(d, title_name, max_w, 120, 56), fill=INK)
    if full_name != title_name:
        d.text((pad, 335), full_name, font=fit_font(d, full_name, max_w, 40, 28), fill=MUTED)
    d.text((pad, 410), "メニュー · Menu · 메뉴 · 菜单",
           font=fit_font(d, "メニュー · Menu · 메뉴 · 菜单", max_w, 60, 36), fill=accent)
    d.text((pad, 530), "日本語 · English · 한국어 · 简体中文 · 繁體中文", font=font(32), fill=MUTED)
    img.save(path, "PNG", optimize=True)


def missing_hant(node, path="$"):
    """Yield JSON paths of objects that have "zh" but no "zh-Hant"."""
    if isinstance(node, dict):
        if "zh" in node and "zh-Hant" not in node:
            yield path
        for k, v in node.items():
            yield from missing_hant(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from missing_hant(v, f"{path}[{i}]")


for f in sorted((ROOT / "i18n").glob("*.json")):
    load_json(f)

shutil.rmtree(OUT, ignore_errors=True)
OUT.mkdir()
for name in ["404.html", ".nojekyll"]:
    shutil.copy(ROOT / name, OUT / name)
for name in ["assets", "i18n", "shops", "lp"]:
    shutil.copytree(ROOT / name, OUT / name)

# Version the CSS/JS addresses per deploy so a phone never mixes a new page
# with an old cached script (GitHub Pages lets browsers cache for 10 minutes).
VERSION = (os.environ.get("GITHUB_SHA") or "dev")[:8]

# app.html = the guest menu app; every /s/<id>/ page is built from it.
template = (ROOT / "app.html").read_text(encoding="utf-8")
for asset in ("assets/style.css", "assets/app.js"):
    if f'{asset}"' not in template:
        fail("app.html", f"expected a reference to {asset}")
    template = template.replace(f'{asset}"', f'{asset}?v={VERSION}"')
(OUT / "app.html").write_text(template, encoding="utf-8")

# index.html = the intro page for shop owners (site root).
landing = (ROOT / "index.html").read_text(encoding="utf-8")
landing = re.sub(r'(href|src)="(lp/[^"?]+\.(?:css|js))"', rf'\1="\2?v={VERSION}"', landing)
(OUT / "index.html").write_text(landing, encoding="utf-8")

for f in sorted((ROOT / "shops").glob("*.json")):
    sid = f.stem
    if not ID_RE.fullmatch(sid):
        fail(f, "shop id (file name) must use only A-Z a-z 0-9 _ -")
    shop = load_json(f)
    gaps = list(missing_hant(shop))
    if gaps:
        print(f"::warning file={f}::{len(gaps)} text(s) have zh but no zh-Hant (Simplified is shown instead), e.g. {gaps[0]}")
    names = shop.get("name") or {}
    full_ja = names.get("ja")
    if not full_ja:
        fail(f, "missing name.ja")
    full_en = names.get("en") or full_ja
    short_ja = (shop.get("shortName") or {}).get("ja") or full_ja
    accent = shop.get("accent") if HEX_RE.fullmatch(str(shop.get("accent", ""))) else DEFAULT_ACCENT

    items = {i.get("id"): i for i in shop.get("items", [])}
    picks = [items[p]["name"]["ja"] for p in shop.get("ownerPicks", [])
             if p in items and (items[p].get("name") or {}).get("ja")][:3]

    title = f"{short_ja} {TITLE_SUFFIX}"
    desc = f"{full_ja}のメニューを日本語・English・한국어・中文（简体・繁體）で見られます。"
    if picks:
        desc += "おすすめ：" + "・".join(picks) + "。"
    desc += f" See the {full_en} menu in English, Korean and Chinese (Simplified & Traditional)."

    dest = OUT / "s" / sid
    dest.mkdir(parents=True, exist_ok=True)
    make_og_image(dest / "og.png", short_ja, full_ja, accent)

    page_url = f"{BASE_URL}/s/{sid}/" if BASE_URL else ""
    image_url = f"{page_url}og.png" if BASE_URL else "og.png"
    meta = [
        '<base href="../../">',
        f'<meta name="description" content="{attr(desc)}">',
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Yomeru">',
        f'<meta property="og:title" content="{attr(title)}">',
        f'<meta property="og:description" content="{attr(desc)}">',
        f'<meta property="og:image" content="{attr(image_url)}">',
        f'<meta property="og:image:width" content="{OG_W}">',
        f'<meta property="og:image:height" content="{OG_H}">',
        f'<meta property="og:image:alt" content="{attr(title)}">',
        '<meta name="twitter:card" content="summary_large_image">',
    ]
    if page_url:
        meta.append(f'<meta property="og:url" content="{attr(page_url)}">')

    page = template.replace("<head>", "<head>\n" + "\n".join(meta), 1)
    page = re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", page, count=1)
    (dest / "index.html").write_text(page, encoding="utf-8")
    print(f"built /s/{sid}/  title={title!r}  picks={picks}")
