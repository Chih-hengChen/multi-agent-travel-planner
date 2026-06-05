"""XHS API client - wraps Spider_XHS for clean integration."""

import os
import sys
from typing import List, Dict, Any
from pathlib import Path

try:
    from curl_cffi import requests as curl_requests
    sys.modules['requests'] = curl_requests
except ImportError:
    pass

_COOKIE = os.environ.get("XHS_COOKIE", "")

_SPIDER_DIR = os.environ.get("SPIDER_XHS_DIR", str(Path(__file__).parent / "spider_xhs"))
if _SPIDER_DIR not in sys.path and os.path.isdir(_SPIDER_DIR):
    sys.path.insert(0, _SPIDER_DIR)


def _ensure_cookie():
    if not _COOKIE.strip():
        raise ConnectionError("XHS_COOKIE environment variable not set or empty")


def _get_api():
    try:
        from apis.xhs_pc_apis import XHS_Apis
    except ImportError as e:
        raise ConnectionError(
            f"Spider_XHS import failed: {e}. "
            "Set SPIDER_XHS_DIR or place Spider_XHS code in ./spider_xhs/. "
            "Ensure dependencies are installed: pip install -r requirements.txt"
        )
    return XHS_Apis()


def search_notes(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    _ensure_cookie()
    api = _get_api()

    success, msg, raw_notes = api.search_some_note(
        query=query,
        require_num=limit,
        cookies_str=_COOKIE,
        sort_type_choice=2,
        note_type=0,
    )

    if not success:
        raise RuntimeError(f"Search failed: {msg}")

    results = []
    for item in raw_notes[:limit]:
        note_card = item.get("note_card", item)
        model_type = item.get("model_type", "note")

        if model_type != "note":
            continue

        note_id = item.get("id", "")
        xsec_token = item.get("xsec_token", "")
        user_info = note_card.get("user", {})
        interact = note_card.get("interact_info", {})

        results.append({
            "id": note_id,
            "title": note_card.get("title", ""),
            "desc": note_card.get("desc", ""),
            "nickname": user_info.get("nickname", ""),
            "liked_count": _parse_count(interact.get("liked_count", "0")),
            "collected_count": _parse_count(interact.get("collected_count", "0")),
            "tags": [t.get("name", "") for t in note_card.get("tag_list", []) if isinstance(t, dict)],
            "url": f"https://www.xiaohongshu.com/explore/{note_id}?xsec_token={xsec_token}&xsec_token_source=pc_search"
                   if note_id else "",
            "upload_time": note_card.get("time", ""),
        })

    return results


def get_note_detail(url: str) -> Dict[str, Any]:
    _ensure_cookie()
    api = _get_api()

    success, msg, data = api.get_note_info(url, _COOKIE)
    if not success:
        raise RuntimeError(f"Get note failed: {msg}")

    items = data.get("data", {}).get("items", [])
    if not items:
        return {}

    note_card = items[0].get("note_card", items[0])
    return {
        "title": note_card.get("title", ""),
        "desc": note_card.get("desc", ""),
        "image_list": [
            img.get("url_default", img.get("url", ""))
            for img in note_card.get("image_list", [])
        ],
        "tags": [t.get("name", "") for t in note_card.get("tag_list", []) if isinstance(t, dict)],
    }


def _parse_count(val) -> int:
    if isinstance(val, int):
        return val
    if isinstance(val, str):
        val = val.replace("万", "0000").replace(",", "")
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return 0
    return 0
