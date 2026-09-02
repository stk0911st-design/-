"""共通ユーティリティ（標準ライブラリのみ）。"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
EXPORT_DIR = DATA_DIR / "reins_export"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
REPORT_DIR = DATA_DIR / "reports"
PUBLIC_DIR = DATA_DIR / "public"

# レインズCSVでよく使われるエンコーディング（Windows出力はほぼ cp932）
ENCODINGS = ("cp932", "utf-8-sig", "utf-8", "euc_jp")


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def load_criteria() -> dict:
    return load_json(CONFIG_DIR / "search_criteria.json")


def load_field_mapping() -> dict:
    mapping = load_json(CONFIG_DIR / "field_mapping.json")
    return {k: v for k, v in mapping.items() if not k.startswith("_")}


def read_text_any_encoding(path: Path) -> tuple[str, str]:
    """CSVを文字化けさせずに読む。(本文, 使ったエンコーディング) を返す。"""
    raw = path.read_bytes()
    for enc in ENCODINGS:
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode("cp932", errors="replace"), "cp932(replace)"


_NUM_RE = re.compile(r"-?[\d,]+(?:\.\d+)?")


def _first_number(text: str) -> float | None:
    m = _NUM_RE.search(text)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def parse_price_man(value) -> float | None:
    """価格を「万円」単位の数値に正規化する。'1億2,000万円' -> 12000.0"""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None

    oku = 0.0
    if "億" in s:
        head, s = s.split("億", 1)
        n = _first_number(head)
        if n is None:
            return None
        oku = n * 10000

    n = _first_number(s)
    if n is None:
        return oku or None
    if "円" in s and "万" not in s and oku == 0 and n >= 100000:
        # 「35,000,000円」のような円単位表記
        return n / 10000
    return oku + n


def parse_number(value) -> float | None:
    if value is None:
        return None
    return _first_number(str(value))


def parse_built_year(value) -> int | None:
    """築年月から西暦の年を取り出す。和暦（令和/平成/昭和）にも対応。"""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    for era, base in (("令和", 2018), ("平成", 1988), ("昭和", 1925)):
        if era in s:
            n = _first_number(s.split(era, 1)[1])
            if n is not None:
                return base + int(n)
    n = _first_number(s)
    if n is None:
        return None
    n = int(n)
    return n if 1900 <= n <= 2100 else None


def today_str() -> str:
    return date.today().isoformat()


def latest_snapshots(limit: int = 2) -> list[Path]:
    """新しい順にスナップショットを返す。"""
    return sorted(SNAPSHOT_DIR.glob("*.json"), reverse=True)[:limit]


def _haystack(item: dict) -> str:
    parts = [str(v) for k, v in item.items() if k != "_raw" and v is not None]
    parts += [str(v) for v in (item.get("_raw") or {}).values()]
    return " ".join(parts)


def matches_criteria(item: dict, cr: dict) -> bool:
    """config/search_criteria.json の条件に合う物件かどうか。null/空の条件は無視する。"""
    location = " ".join(str(item.get(k) or "") for k in ("address", "line", "station"))

    areas = cr.get("areas") or []
    if areas and not any(a in location for a in areas):
        return False
    if any(a in location for a in (cr.get("area_exclude") or [])):
        return False

    types = cr.get("property_types") or []
    if types:
        ptype = str(item.get("property_type") or "")
        if not any(t in ptype for t in types):
            return False

    price = item.get("price_man")
    if cr.get("price_min_man") is not None and (price is None or price < cr["price_min_man"]):
        return False
    if cr.get("price_max_man") is not None and (price is None or price > cr["price_max_man"]):
        return False

    for key, field in (
        ("land_area_min_sqm", "land_sqm"),
        ("building_area_min_sqm", "building_sqm"),
        ("built_year_min", "built_year"),
    ):
        if cr.get(key) is not None:
            value = item.get(field)
            if value is None or value < cr[key]:
                return False

    if cr.get("walk_minutes_max") is not None:
        walk = item.get("walk_min")
        if walk is None or walk > cr["walk_minutes_max"]:
            return False

    hay = _haystack(item)
    any_kw = cr.get("keywords_any") or []
    if any_kw and not any(k in hay for k in any_kw):
        return False
    if any(k in hay for k in (cr.get("keywords_none") or [])):
        return False

    return True
