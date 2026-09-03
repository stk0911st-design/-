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

# レインズの検索は「売出（販売中）」と「成約」で画面が分かれているので、
# エクスポート先フォルダもそれに合わせて分ける。
DATASETS = ("売出", "成約")

# レインズCSVでよく使われるエンコーディング（Windows出力はほぼ cp932）
ENCODINGS = ("cp932", "utf-8-sig", "utf-8", "euc_jp")


# ---------------------------------------------------------------- 入出力

def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def load_config() -> dict:
    return load_json(CONFIG_DIR / "watchlists.json")


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
    return raw.decode("cp932", errors="replace"), "cp932(置換あり)"


def today_str() -> str:
    return date.today().isoformat()


def latest_snapshots(limit: int = 2) -> list[Path]:
    """新しい順にスナップショットを返す。"""
    return sorted(SNAPSHOT_DIR.glob("*.json"), reverse=True)[:limit]


# ---------------------------------------------------------------- 値の正規化

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


def 金額表示(万円: float | None) -> str:
    """万円単位の数値を『3億2,000万円』のように読みやすく整形する。"""
    if not 万円:
        return "―"
    if 万円 >= 10000:
        億 = int(万円 // 10000)
        残り = 万円 - 億 * 10000
        return f"{億}億{残り:,.0f}万円" if 残り else f"{億}億円"
    return f"{万円:,.0f}万円"


def parse_number(value) -> float | None:
    if value is None:
        return None
    return _first_number(str(value))


def parse_built_year(value) -> int | None:
    """築年月から西暦の年を取り出す。和暦（令和・平成・昭和）にも対応。"""
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


# ---------------------------------------------------------------- 監視リスト

def _rule_matches(rule, text: str) -> bool:
    """rule が文字列なら単独一致、配列ならすべて含む(AND)。"""
    if isinstance(rule, (list, tuple)):
        return all(str(term) in text for term in rule)
    return str(rule) in text


def resolve_watchlists(config: dict | None = None) -> list[dict]:
    """設定ファイルの日本語キーを、扱いやすい形に展開する。"""
    config = config or load_config()
    groups = config.get("エリアグループ") or {}
    resolved = []

    for wl in config.get("監視リスト") or []:
        if not wl.get("有効", True):
            continue
        group = groups.get(wl.get("エリアグループ")) or {}
        resolved.append({
            "id": wl.get("id") or wl.get("名称"),
            "名称": wl.get("名称", ""),
            "エリア名": group.get("名称", wl.get("エリアグループ", "")),
            "対象データ": tuple(wl.get("対象データ") or ["売出"]),
            "含むエリア": group.get("含む") or [],
            "除外エリア": group.get("除外") or [],
            "物件種目": wl.get("物件種目") or [],
            "価格下限": wl.get("価格下限"),
            "価格上限": wl.get("価格上限"),
            "土地面積下限": wl.get("土地面積下限"),
            "建物面積下限": wl.get("建物面積下限"),
            "駅徒歩上限": wl.get("駅徒歩上限"),
            "築年下限": wl.get("築年下限"),
            "含むキーワード": wl.get("含むキーワード") or [],
            "除くキーワード": wl.get("除くキーワード") or [],
        })
    return resolved


def _haystack(item: dict) -> str:
    parts = [str(v) for k, v in item.items() if not k.startswith("_") and v is not None]
    parts += [str(v) for v in (item.get("_raw") or {}).values()]
    return " ".join(parts)


def matches(item: dict, wl: dict) -> bool:
    """物件が監視リストの条件に合うか。未設定(null/空)の条件は無視する。"""
    location = " ".join(str(item.get(k) or "") for k in ("所在地", "沿線", "駅"))

    include = wl.get("含むエリア") or []
    if include and not any(_rule_matches(r, location) for r in include):
        return False
    if any(_rule_matches(r, location) for r in (wl.get("除外エリア") or [])):
        return False

    types = wl.get("物件種目") or []
    if types:
        ptype = str(item.get("物件種目") or "")
        if not any(t in ptype for t in types):
            return False

    price = item.get("価格万円")
    if wl.get("価格下限") is not None and (price is None or price < wl["価格下限"]):
        return False
    if wl.get("価格上限") is not None and (price is None or price > wl["価格上限"]):
        return False

    for key, field in (
        ("土地面積下限", "土地面積㎡"),
        ("建物面積下限", "建物面積㎡"),
        ("築年下限", "築年"),
    ):
        if wl.get(key) is not None:
            value = item.get(field)
            if value is None or value < wl[key]:
                return False

    if wl.get("駅徒歩上限") is not None:
        walk = item.get("徒歩分")
        if walk is None or walk > wl["駅徒歩上限"]:
            return False

    hay = _haystack(item)
    any_kw = wl.get("含むキーワード") or []
    if any_kw and not any(k in hay for k in any_kw):
        return False
    if any(k in hay for k in (wl.get("除くキーワード") or [])):
        return False

    return True
