"""后台索引器：扫描目录 -> 读取元数据 -> 写入 SQLite -> 生成自动标签。"""
from __future__ import annotations

import os
import re
import threading
import time
import traceback
from typing import Any, Dict, List, Optional

from . import db
from .config import get_roots, load_settings
from .meta import summarize_comfy_prompt

_state: Dict[str, Any] = {
    "status": "idle",          # idle | scanning | canceling
    "rootId": "",
    "rootLabel": "",
    "scanned": 0,
    "added": 0,
    "updated": 0,
    "removed": 0,
    "errors": 0,
    "current": "",
    "startedAt": 0,
    "finishedAt": 0,
    "message": "",
}
_thread: Optional[threading.Thread] = None
_cancel = threading.Event()
_lock = threading.RLock()

_LORA_RE = re.compile(r"<lora:([^:>]+)(?::[^>]*)?>", re.IGNORECASE)
_WEIGHT_RE = re.compile(r":\s*[0-9]*\.?[0-9]+\s*$")
_BRACKET_RE = re.compile(r"[()\[\]{}]")


def status() -> Dict[str, Any]:
    with _lock:
        data = dict(_state)
    try:
        db.init()
        conn = db.connect()
        try:
            data["indexed"] = db.file_count(conn)
            data["dbBytes"] = os.path.getsize(db.db_path()) if os.path.exists(db.db_path()) else 0
            last = conn.execute("SELECT * FROM scan_log ORDER BY id DESC LIMIT 1").fetchone()
            data["last"] = dict(last) if last else None
        finally:
            conn.close()
    except Exception as err:
        data["indexed"] = 0
        data["error"] = str(err)
    return data


def is_running() -> bool:
    return _thread is not None and _thread.is_alive()


def start(force: bool = False, roots: Optional[List[str]] = None) -> bool:
    global _thread
    with _lock:
        if is_running():
            return False
        _cancel.clear()
        for key in ("scanned", "added", "updated", "removed", "errors"):
            _state[key] = 0
        _state.update({
            "status": "scanning",
            "startedAt": time.time(),
            "finishedAt": 0,
            "message": "",
            "current": "",
            "force": bool(force),
            "onlyRoots": roots or [],
        })
    _thread = threading.Thread(target=_run, args=(bool(force), roots or []), name="iib-indexer", daemon=True)
    _thread.start()
    return True


def stop() -> bool:
    if not is_running():
        return False
    _cancel.set()
    with _lock:
        _state["status"] = "canceling"
    return True


def _auto_tags(prompt: str, model: str, loras: List[str]) -> List[str]:
    tags: List[str] = []

    def push(value: str) -> None:
        value = _BRACKET_RE.sub("", value).strip().strip(",")
        value = _WEIGHT_RE.sub("", value).strip()
        value = re.sub(r"\s+", " ", value)
        if not value or len(value) > 40:
            return
        lowered = value.lower()
        if lowered in {"masterpiece", "best quality", "highres", "absurdres", "very awa"}:
            tags.append(value)
            return
        if len(value) < 2:
            return
        tags.append(value)

    if model:
        push(os.path.splitext(os.path.basename(model))[0])
    for lora in loras:
        push(os.path.splitext(os.path.basename(lora))[0])
    text = _LORA_RE.sub("", prompt or "")
    for index, part in enumerate(text.split(",")):
        if index >= 12:
            break
        push(part)
    seen = set()
    result = []
    for tag in tags:
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(tag)
    return result[:18]


def _phash(image) -> str:
    try:
        from PIL import Image

        small = image.convert("L").resize((16, 16), Image.Resampling.LANCZOS)
        pixels = list(small.getdata())
        average = sum(pixels) / len(pixels)
        bits = "".join("1" if value > average else "0" for value in pixels)
        return f"{int(bits, 2):064x}"
    except Exception:
        return ""


def _extract(path: str) -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "width": 0, "height": 0, "prompt": "", "negative": "", "model": "",
        "loras": "", "sampler": "", "steps": 0, "cfg": 0.0, "seed": "", "phash": "",
    }
    ext = os.path.splitext(path)[1].lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".avif"}:
        return info
    try:
        from PIL import Image

        with Image.open(path) as image:
            info["width"], info["height"] = image.size
            info["phash"] = _phash(image)
            raw = (getattr(image, "info", {}) or {}).get("prompt")
            if not raw:
                return info
            import json

            prompt_json = json.loads(raw) if isinstance(raw, str) else raw
            summary = summarize_comfy_prompt(prompt_json)
            info["prompt"] = str(summary.get("正向提示词") or "")
            info["negative"] = str(summary.get("负向提示词") or "")
            info["model"] = str(summary.get("模型") or "")
            loras = summary.get("LoRA") or []
            if isinstance(loras, list):
                info["loras"] = "\n".join(str(item) for item in loras)
            info["sampler"] = str(summary.get("采样器") or "")
            info["steps"] = int(summary.get("步数") or 0) if str(summary.get("步数") or "0").isdigit() else 0
            try:
                info["cfg"] = float(summary.get("CFG") or 0)
            except (TypeError, ValueError):
                info["cfg"] = 0.0
            info["seed"] = str(summary.get("种子") or "")
    except Exception:
        pass
    return info


def _scan_roots(force: bool) -> None:
    cfg = load_settings()
    roots = get_roots(cfg)
    only = _state.get("onlyRoots") or []
    if only:
        roots = [root for root in roots if root["id"] in only]

    db.init()
    conn = db.connect()
    started = time.time()
    seen: set = set()
    log_added = log_updated = log_removed = log_errors = 0

    try:
        for root in roots:
            if _cancel.is_set():
                break
            with _lock:
                _state["rootId"] = root["id"]
                _state["rootLabel"] = root["label"]
            base = root["path"]
            if not os.path.isdir(base):
                continue
            for current, dirs, files in os.walk(base):
                if _cancel.is_set():
                    break
                dirs[:] = [d for d in dirs if not d.startswith(".") and not d.startswith("$")]
                with _lock:
                    _state["current"] = current
                for name in files:
                    if _cancel.is_set():
                        break
                    if name.startswith(".") or name.startswith("$"):
                        continue
                    path = os.path.join(current, name)
                    try:
                        stat = os.stat(path)
                    except OSError:
                        continue
                    seen.add(os.path.normcase(path))
                    with _lock:
                        _state["scanned"] += 1

                    try:
                        existing = db.get_file(conn, path)
                        if existing and not force:
                            same = (
                                int(existing["size"]) == stat.st_size
                                and abs(float(existing["mtime"]) - stat.st_mtime) < 0.5
                            )
                            if same:
                                continue
                        meta = _extract(path)
                        payload = {
                            "path": path,
                            "root_id": root["id"],
                            "rel": os.path.relpath(path, base).replace("\\", "/"),
                            "name": name,
                            "ext": os.path.splitext(name)[1].lower(),
                            "kind": "video" if os.path.splitext(name)[1].lower() in {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"} else "image",
                            "size": stat.st_size,
                            "mtime": stat.st_mtime,
                            "width": meta["width"],
                            "height": meta["height"],
                            "prompt": meta["prompt"],
                            "negative": meta["negative"],
                            "model": meta["model"],
                            "loras": meta["loras"],
                            "sampler": meta["sampler"],
                            "steps": meta["steps"],
                            "cfg": meta["cfg"],
                            "seed": meta["seed"],
                            "phash": meta["phash"],
                            "indexed_at": time.time(),
                        }
                        file_id = db.upsert_file(conn, payload)
                        # 自动标签
                        conn.execute("DELETE FROM file_tags WHERE file_id=? AND source='auto'", (file_id,))
                        loras = [item for item in str(meta["loras"]).split("\n") if item]
                        for tag in _auto_tags(meta["prompt"], meta["model"], loras):
                            tag_id = db.ensure_tag(conn, tag)
                            db.assign_tag(conn, file_id, tag_id, source="auto")
                        if existing:
                            with _lock:
                                _state["updated"] += 1
                            log_updated += 1
                        else:
                            with _lock:
                                _state["added"] += 1
                            log_added += 1
                        if _state["scanned"] % 40 == 0:
                            conn.commit()
                    except Exception:
                        with _lock:
                            _state["errors"] += 1
                        log_errors += 1
                        continue

        conn.commit()

        # 清理不存在的文件（只处理本次扫描的根）
        if not _cancel.is_set():
            rows = conn.execute("SELECT id, path, root_id FROM files").fetchall()
            root_ids = {root["id"] for root in roots}
            for row in rows:
                if row["root_id"] not in root_ids:
                    continue
                key = os.path.normcase(row["path"])
                if key in seen:
                    continue
                if not os.path.exists(row["path"]):
                    conn.execute("DELETE FROM file_tags WHERE file_id=?", (row["id"],))
                    conn.execute("DELETE FROM files WHERE id=?", (row["id"],))
                    log_removed += 1
                    with _lock:
                        _state["removed"] += 1
            conn.execute("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM file_tags)")
            conn.commit()

        cur = conn.execute(
            "INSERT INTO scan_log(started, finished, added, updated, removed, errors, total, note) VALUES(?,?,?,?,?,?,?,?)",
            (started, time.time(), log_added, log_updated, log_removed, log_errors, _state["scanned"],
             "canceled" if _cancel.is_set() else ""),
        )
        db.set_meta(conn, "last_index_at", time.time())
        conn.commit()
        with _lock:
            _state["message"] = f"新增 {log_added}，更新 {log_updated}，移除 {log_removed}，错误 {log_errors}"
    except Exception as err:
        with _lock:
            _state["message"] = f"索引失败: {err}"
            _state["errors"] += 1
        traceback.print_exc()
    finally:
        conn.close()
        with _lock:
            _state["status"] = "idle"
            _state["finishedAt"] = time.time()
            _state["current"] = ""


def _run(force: bool, roots: List[str]) -> None:
    try:
        _scan_roots(force)
    except Exception:
        traceback.print_exc()
        with _lock:
            _state["status"] = "idle"


def similar_files(path: str, limit: int = 24, max_distance: int = 999) -> List[dict]:
    conn = db.connect()
    try:
        row = db.get_file(conn, path)
        if not row or not row["phash"]:
            return []
        target = int(row["phash"], 16)
        results = []
        for candidate in conn.execute(
            "SELECT id, path, name, size, mtime, phash, width, height FROM files "
            "WHERE path<>? AND phash<>'' LIMIT 50000",
            (path,),
        ):
            distance = bin(target ^ int(candidate["phash"], 16)).count("1")
            if distance <= max_distance:
                results.append({
                    "id": candidate["id"],
                    "path": candidate["path"],
                    "name": candidate["name"],
                    "size": candidate["size"],
                    "mtime": candidate["mtime"],
                    "distance": distance,
                    "width": candidate["width"],
                    "height": candidate["height"],
                })
        results.sort(key=lambda item: item["distance"])
        return results[: max(1, int(limit))]
    finally:
        conn.close()


def duplicate_groups(max_distance: int = 6, limit: int = 50) -> List[List[dict]]:
    conn = db.connect()
    try:
        rows = conn.execute("SELECT id, path, name, size, mtime, phash FROM files WHERE phash<>''").fetchall()
        used = set()
        groups = []
        for index, row in enumerate(rows):
            if row["id"] in used:
                continue
            group = [{"id": row["id"], "path": row["path"], "name": row["name"], "size": row["size"], "mtime": row["mtime"], "distance": 0}]
            value = int(row["phash"], 16)
            for other in rows[index + 1:]:
                if other["id"] in used:
                    continue
                distance = bin(value ^ int(other["phash"], 16)).count("1")
                if distance <= max_distance:
                    used.add(other["id"])
                    group.append({"id": other["id"], "path": other["path"], "name": other["name"], "size": other["size"], "mtime": other["mtime"], "distance": distance})
            if len(group) > 1:
                used.add(row["id"])
                groups.append(group)
                if len(groups) >= limit:
                    break
        return groups
    finally:
        conn.close()
