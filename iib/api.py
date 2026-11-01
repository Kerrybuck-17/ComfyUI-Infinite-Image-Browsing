"""ComfyUI 后端路由：浏览 / 缩略图 / 元数据 / 文件操作。"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from typing import Any, Dict, Iterable, List, Optional, Tuple

from aiohttp import web

from . import thumb as thumb_mod
from .config import (
    IMAGE_EXTS,
    MEDIA_EXTS,
    VIDEO_EXTS,
    category_of,
    find_root,
    get_roots,
    human_size,
    is_within,
    load_settings,
    save_settings,
)
from .meta import raw_workflow, read_metadata

VERSION = "1.0.0"
PREFIX = "/iib"

from .routes import routes  # noqa: E402  (共享路由表)


# ---------------------------------------------------------------- helpers


def json_ok(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, dumps=lambda obj: json.dumps(obj, ensure_ascii=False))


def json_err(message: str, status: int = 400) -> web.Response:
    return json_ok({"ok": False, "error": message}, status=status)


def _resolve(query: Dict[str, str], cfg: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str], Optional[web.Response]]:
    """把 root + path 解析成磁盘上的绝对路径，并确保没有越界。"""
    root_id = query.get("root") or ""
    raw_path = query.get("path") or ""
    root = find_root(root_id, cfg) if root_id else None
    if root is None:
        roots = get_roots(cfg)
        root = roots[0] if roots else None
    if root is None:
        return None, None, json_err("没有可浏览的目录，请在设置里添加附加目录", 404)

    base = root["path"]
    if raw_path:
        candidate = raw_path if os.path.isabs(raw_path) else os.path.join(base, raw_path)
    else:
        candidate = base
    candidate = os.path.abspath(candidate)
    if not is_within(base, candidate):
        return root, None, json_err("路径超出根目录范围", 403)
    return root, candidate, None


def _allowed_anywhere(path: str, cfg: Dict[str, Any]) -> bool:
    return any(is_within(root["path"], path) for root in get_roots(cfg))


def _rel_of(root: Dict[str, Any], path: str) -> str:
    try:
        rel = os.path.relpath(path, root["path"])
        return "" if rel == "." else rel.replace("\\", "/")
    except Exception:
        return ""


def _thumb_url(path: str, mtime: float, size: int) -> str:
    query = urllib.parse.urlencode({"path": path, "size": int(size), "v": int(mtime or 0)})
    return f"{PREFIX}/thumb?{query}"


def _file_url(path: str, mtime: float, download: bool = False) -> str:
    params = {"path": path, "v": int(mtime or 0)}
    if download:
        params["download"] = "1"
    return f"{PREFIX}/file?{urllib.parse.urlencode(params)}"


def _entry(path: str, root: Dict[str, Any], cfg: Dict[str, Any], is_dir: bool) -> Dict[str, Any]:
    try:
        stat = os.stat(path)
        mtime = stat.st_mtime
        size = 0 if is_dir else stat.st_size
    except OSError:
        mtime, size = 0, 0
    item = {
        "name": os.path.basename(path),
        "abs": path,
        "rel": _rel_of(root, path),
        "isDir": is_dir,
        "size": size,
        "sizeText": human_size(size),
        "mtime": mtime,
        "mtimeText": time.strftime("%Y-%m-%d %H:%M", time.localtime(mtime)) if mtime else "",
        "kind": "dir" if is_dir else category_of(path),
    }
    if not is_dir and item["kind"] in {"image", "video"}:
        item["thumb"] = _thumb_url(path, mtime, int(cfg.get("thumbSize") or 256))
        item["url"] = _file_url(path, mtime)
    return item


def _sort_key(sort: str):
    reverse = True
    key = "mtime"
    if sort:
        parts = sort.split("_")
        key = parts[0]
        reverse = len(parts) > 1 and parts[1] == "desc"
    if key == "name":
        return (lambda entry: entry["name"].lower()), reverse
    if key == "size":
        return (lambda entry: entry["size"]), reverse
    if key == "ctime":
        return (lambda entry: entry["mtime"]), reverse
    return (lambda entry: entry["mtime"]), reverse


def _matches_kind(kind: str, kind_filter: str, show_videos: bool) -> bool:
    if kind_filter == "dir":
        return kind == "dir"
    if kind not in {"image", "video"}:
        return False
    if kind == "video" and not show_videos:
        return False
    if kind_filter in {"", "all", "media"}:
        return True
    return kind == kind_filter


def _walk_files(base: str, max_depth: int, limit: int = 4000) -> Iterable[str]:
    base_depth = base.rstrip("\\/").count(os.sep)
    for current, dirs, files in os.walk(base):
        depth = current.rstrip("\\/").count(os.sep) - base_depth
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not d.startswith("$"))
        if depth >= max_depth:
            dirs[:] = []
        for name in sorted(files):
            if name.startswith("."):
                continue
            if os.path.splitext(name)[1].lower() in MEDIA_EXTS:
                yield os.path.join(current, name)
                limit -= 1
                if limit <= 0:
                    return


# ---------------------------------------------------------------- routes


@routes.get(f"{PREFIX}/ping")
async def iib_ping(request: web.Request) -> web.Response:
    return json_ok({"ok": True, "version": VERSION, "time": time.time()})


@routes.get(f"{PREFIX}/config")
async def iib_config(request: web.Request) -> web.Response:
    cfg = load_settings()
    return json_ok(
        {
            "ok": True,
            "version": VERSION,
            "settings": cfg,
            "roots": get_roots(cfg),
            "cache": thumb_mod.cache_stats(),
        }
    )


@routes.post(f"{PREFIX}/settings")
async def iib_settings(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    values = payload.get("settings") if isinstance(payload, dict) and "settings" in payload else payload
    cfg = save_settings(values if isinstance(values, dict) else {})
    return json_ok({"ok": True, "settings": cfg, "roots": get_roots(cfg)})


@routes.get(f"{PREFIX}/roots")
async def iib_roots(request: web.Request) -> web.Response:
    return json_ok({"ok": True, "roots": get_roots(load_settings())})


@routes.get(f"{PREFIX}/list")
async def iib_list(request: web.Request) -> web.Response:
    cfg = load_settings()
    query = dict(request.query)
    root, target, error = _resolve(query, cfg)
    if error is not None:
        return error
    assert root is not None and target is not None
    if not os.path.isdir(target):
        return json_err("目录不存在或不可访问", 404)

    try:
        page = max(1, int(query.get("page") or 1))
    except ValueError:
        page = 1
    try:
        page_size = int(query.get("size") or cfg.get("pageSize") or 120)
    except ValueError:
        page_size = int(cfg.get("pageSize") or 120)
    page_size = max(1, min(page_size, 1000))

    sort = query.get("sort") or str(cfg.get("sort") or "mtime_desc")
    kind_filter = (query.get("kind") or "all").lower()
    keyword = (query.get("q") or "").strip()
    show_videos = bool(cfg.get("showVideos", True))

    dirs: List[Dict[str, Any]] = []
    items: List[Dict[str, Any]] = []
    total = 0
    searching = bool(keyword)

    if searching:
        pattern = re.compile(re.escape(keyword), re.IGNORECASE)
        search_meta = bool(cfg.get("searchMetadata", False))
        collected: List[Dict[str, Any]] = []
        max_depth = int(cfg.get("scanDepth") or 4)
        for file_path in _walk_files(target, max_depth):
            kind = category_of(file_path)
            if not _matches_kind(kind, kind_filter, show_videos):
                continue
            name_hit = bool(pattern.search(os.path.basename(file_path)))
            if not name_hit and search_meta:
                try:
                    info = read_metadata(file_path)
                    haystack = json.dumps(info.get("fields", []), ensure_ascii=False)
                    name_hit = bool(pattern.search(haystack))
                except Exception:
                    name_hit = False
            if name_hit:
                collected.append(_entry(file_path, root, cfg, False))
                if len(collected) >= 3000:
                    break
        collected.sort(key=lambda entry: entry["mtime"], reverse=(sort.endswith("desc")))
        total = len(collected)
        start = (page - 1) * page_size
        items = collected[start : start + page_size]
    else:
        walk_mode = str(query.get("walk") or "").lower() in {"1", "true", "yes"}
        if walk_mode:
            # 递归列出当前目录（含子文件夹）里的所有媒体文件
            collected: List[Dict[str, Any]] = []
            try:
                for current, sub_dirs, files in os.walk(target):
                    sub_dirs[:] = sorted(
                        name for name in sub_dirs if not name.startswith(".") and not name.startswith("$")
                    )
                    for name in sorted(files):
                        if name.startswith(".") or name.startswith("$"):
                            continue
                        if os.path.splitext(name)[1].lower() not in MEDIA_EXTS:
                            continue
                        kind = category_of(name)
                        if not _matches_kind(kind, kind_filter, show_videos):
                            continue
                        if keyword and keyword.lower() not in name.lower():
                            continue
                        collected.append(_entry(os.path.join(current, name), root, cfg, False))
                        if len(collected) >= 20000:
                            break
                    if len(collected) >= 20000:
                        break
            except Exception as err:
                return json_err(f"读取目录失败: {err}", 500)
            keyfn, reverse = _sort_key(sort)
            collected.sort(key=keyfn, reverse=reverse)
            total = len(collected)
            start = (page - 1) * page_size
            items = collected[start : start + page_size]
            dirs = []
        else:
            try:
                with os.scandir(target) as iterator:
                    entries = list(iterator)
            except PermissionError:
                return json_err("没有访问该目录的权限", 403)

            for entry in entries:
                if entry.name.startswith(".") or entry.name.startswith("$"):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        dirs.append(_entry(entry.path, root, cfg, True))
                        continue
                except OSError:
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext not in MEDIA_EXTS:
                    continue
                kind = category_of(entry.name)
                if not _matches_kind(kind, kind_filter, show_videos):
                    continue
                items.append(_entry(entry.path, root, cfg, False))

            if kind_filter in {"image", "video"}:
                dirs = [
                    entry for entry in dirs
                    if _dir_has_kind(entry["abs"], kind_filter, show_videos)
                ]
            keyfn, reverse = _sort_key(sort)
            if sort.startswith("size"):
                dirs.sort(key=lambda entry: entry["mtime"], reverse=reverse)
            else:
                dirs.sort(key=keyfn, reverse=reverse)
            items.sort(key=keyfn, reverse=reverse)
            total = len(items)
            start = (page - 1) * page_size
            items = items[start : start + page_size]

    # 标记收藏
    try:
        from . import db as _db

        conn = _db.connect()
        try:
            _db.init()
            paths = [item["abs"] for item in items]
            if paths:
                marks = ",".join("?" for _ in paths)
                favorites = {
                    row["path"]
                    for row in conn.execute(f"SELECT path FROM favorites WHERE path IN ({marks})", paths)
                }
                for item in items:
                    item["favorited"] = item["abs"] in favorites
        finally:
            conn.close()
    except Exception:
        pass

    parent_rel: Optional[str] = None
    if os.path.normcase(target) != os.path.normcase(root["path"]):
        parent = os.path.dirname(target)
        parent_rel = _rel_of(root, parent) if is_within(root["path"], parent) else ""
    rel = _rel_of(root, target)
    return json_ok(
        {
            "ok": True,
            "root": root,
            "path": target,
            "rel": rel,
            "parentRel": parent_rel,
            "dirs": dirs,
            "items": items,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "search": searching,
            "sort": sort,
            "kind": kind_filter,
        }
    )


def _has_subdir(path: str) -> bool:
    """目录下是否还有子目录（用于决定树节点是否显示展开箭头）。"""
    try:
        with os.scandir(path) as iterator:
            for entry in iterator:
                if entry.name.startswith(".") or entry.name.startswith("$"):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        return True
                except OSError:
                    continue
    except OSError:
        return False
    return False


_DIR_KIND_CACHE: Dict[str, Any] = {}
_DIR_KIND_LOCK = threading.Lock()
_DIR_KIND_TTL = 30.0


def _dir_has_kind(path: str, kind: str, show_videos: bool, depth: int = 6) -> bool:
    """递归检查目录里是否包含指定类型的媒体（带 30 秒缓存）。"""
    now = time.time()
    key = f"{path}|{kind}|{show_videos}"
    with _DIR_KIND_LOCK:
        cached = _DIR_KIND_CACHE.get(key)
        if cached and now - cached[0] < _DIR_KIND_TTL:
            return cached[1]
    found = False
    base_depth = path.rstrip("\\/").count(os.sep)
    try:
        for current, sub_dirs, files in os.walk(path):
            level = current.rstrip("\\/").count(os.sep) - base_depth
            sub_dirs[:] = [
                name for name in sub_dirs
                if not name.startswith(".") and not name.startswith("$")
            ]
            if level >= depth:
                sub_dirs[:] = []
            for name in files:
                category = category_of(name)
                if kind == "video":
                    if category == "video":
                        found = True
                        break
                elif category == "image":
                    found = True
                    break
            if found:
                break
    except OSError:
        pass
    with _DIR_KIND_LOCK:
        if len(_DIR_KIND_CACHE) > 4000:
            _DIR_KIND_CACHE.clear()
        _DIR_KIND_CACHE[key] = (now, found)
    return found


@routes.get(f"{PREFIX}/tree")
async def iib_tree(request: web.Request) -> web.Response:
    cfg = load_settings()
    query = dict(request.query)
    root, target, error = _resolve(query, cfg)
    if error is not None:
        return error
    assert root is not None and target is not None
    children: List[Dict[str, Any]] = []
    try:
        with os.scandir(target) as iterator:
            for entry in iterator:
                if entry.name.startswith(".") or entry.name.startswith("$"):
                    continue
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                children.append({
                    "name": entry.name,
                    "rel": _rel_of(root, entry.path),
                    "hasChildren": _has_subdir(entry.path),
                })
    except Exception as err:
        return json_err(f"读取目录失败: {err}", 500)
    children.sort(key=lambda item: item["name"].lower())
    return json_ok({
        "ok": True,
        "root": root,
        "rel": _rel_of(root, target),
        "dirs": children[:1000],
        "hasChildren": bool(children),
    })


@routes.get(f"{PREFIX}/thumb")
async def iib_thumb(request: web.Request) -> web.Response:
    cfg = load_settings()
    path = request.query.get("path") or ""
    if not path or not os.path.isfile(path):
        return json_err("文件不存在", 404)
    if not _allowed_anywhere(path, cfg):
        return json_err("路径超出允许范围", 403)
    try:
        size = int(request.query.get("size") or cfg.get("thumbSize") or 256)
    except ValueError:
        size = 256
    file_path = thumb_mod.ensure_thumb(path, size)
    if not file_path:
        return json_err("无法生成缩略图", 415)
    response = web.FileResponse(file_path)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    response.headers["Content-Type"] = "image/webp"
    return response


@routes.get(f"{PREFIX}/dircover")
async def iib_dircover(request: web.Request) -> web.Response:
    cfg = load_settings()
    path = request.query.get("path") or ""
    if not path or not os.path.isdir(path):
        return json_err("目录不存在", 404)
    if not _allowed_anywhere(path, cfg):
        return json_err("路径超出允许范围", 403)
    try:
        size = int(request.query.get("size") or 220)
    except ValueError:
        size = 220
    file_path = thumb_mod.dir_cover(path, size)
    if not file_path:
        return json_err("这个目录里没有图片", 404)
    response = web.FileResponse(file_path)
    response.headers["Cache-Control"] = "public, max-age=1800"
    response.headers["Content-Type"] = "image/webp"
    return response


@routes.get(f"{PREFIX}/file")
async def iib_file(request: web.Request) -> web.StreamResponse:
    cfg = load_settings()
    path = request.query.get("path") or ""
    if not path or not os.path.isfile(path):
        raise web.HTTPNotFound(text="文件不存在")
    if not _allowed_anywhere(path, cfg):
        raise web.HTTPForbidden(text="路径超出允许范围")
    response = web.FileResponse(path)
    if request.query.get("download"):
        name = urllib.parse.quote(os.path.basename(path))
        response.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{name}"
    response.headers["Cache-Control"] = "public, max-age=600"
    return response


@routes.get(f"{PREFIX}/info")
async def iib_info(request: web.Request) -> web.Response:
    cfg = load_settings()
    path = request.query.get("path") or ""
    if not path or not os.path.isfile(path):
        return json_err("文件不存在", 404)
    if not _allowed_anywhere(path, cfg):
        return json_err("路径超出允许范围", 403)
    info = read_metadata(path)
    info["url"] = _file_url(path, info.get("mtime") or 0)
    info["downloadUrl"] = _file_url(path, info.get("mtime") or 0, True)
    info["ok"] = True
    return json_ok(info)


@routes.get(f"{PREFIX}/workflow")
async def iib_workflow(request: web.Request) -> web.Response:
    cfg = load_settings()
    path = request.query.get("path") or ""
    if not path or not os.path.isfile(path):
        return json_err("文件不存在", 404)
    if not _allowed_anywhere(path, cfg):
        return json_err("路径超出允许范围", 403)
    from .meta import a1111_to_prompt, raw_workflow_prompt

    payload = raw_workflow_prompt(path)
    workflow = payload.get("workflow")
    prompt = payload.get("prompt")
    parameters = payload.get("parameters") or ""
    a1111 = False
    if not workflow and not prompt and parameters:
        prompt = a1111_to_prompt(parameters)
        a1111 = bool(prompt)
    if not workflow and not prompt:
        return json_err("这张图片里没有嵌入工作流", 404)
    return json_ok({
        "ok": True,
        "workflow": workflow,
        "prompt": prompt,
        "parameters": parameters[:4000],
        "a1111": a1111,
        "mode": "workflow" if workflow else ("a1111" if a1111 else "prompt"),
    })


async def _op_guard(request: web.Request, handler) -> web.Response:
    cfg = load_settings()
    if not cfg.get("enableFileOps", True):
        return json_err("设置中已禁用文件操作", 403)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    try:
        return await handler(payload or {}, cfg)
    except Exception as err:
        return json_err(f"操作失败: {err}", 500)


@routes.post(f"{PREFIX}/delete")
async def iib_delete(request: web.Request) -> web.Response:
    async def handler(payload: Dict[str, Any], cfg: Dict[str, Any]) -> web.Response:
        paths = payload.get("paths") or []
        if isinstance(paths, str):
            paths = [paths]
        removed, failed = [], []
        for path in paths:
            if not _allowed_anywhere(path, cfg):
                failed.append({"path": path, "error": "超出允许范围"})
                continue
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path)
                else:
                    os.remove(path)
                removed.append(path)
            except Exception as err:
                failed.append({"path": path, "error": str(err)})
        return json_ok({"ok": True, "removed": removed, "failed": failed})

    return await _op_guard(request, handler)


@routes.post(f"{PREFIX}/rename")
async def iib_rename(request: web.Request) -> web.Response:
    async def handler(payload: Dict[str, Any], cfg: Dict[str, Any]) -> web.Response:
        path = payload.get("path") or ""
        new_name = (payload.get("name") or "").strip()
        if not path or not os.path.exists(path):
            return json_err("路径不存在", 404)
        if not _allowed_anywhere(path, cfg):
            return json_err("超出允许范围", 403)
        if not new_name or any(char in new_name for char in '\\/:*?"<>|'):
            return json_err("名称不合法", 400)
        target = os.path.join(os.path.dirname(path), new_name)
        if os.path.exists(target) and os.path.normcase(target) != os.path.normcase(path):
            return json_err("同名文件已存在", 409)
        os.rename(path, target)
        return json_ok({"ok": True, "path": target})

    return await _op_guard(request, handler)


@routes.post(f"{PREFIX}/mkdir")
async def iib_mkdir(request: web.Request) -> web.Response:
    async def handler(payload: Dict[str, Any], cfg: Dict[str, Any]) -> web.Response:
        parent = payload.get("parent") or ""
        name = (payload.get("name") or "").strip()
        if not parent or not os.path.isdir(parent):
            return json_err("父目录不存在", 404)
        if not _allowed_anywhere(parent, cfg):
            return json_err("超出允许范围", 403)
        if not name or any(char in name for char in '\\/:*?"<>|'):
            return json_err("名称不合法", 400)
        target = os.path.join(parent, name)
        os.makedirs(target, exist_ok=True)
        return json_ok({"ok": True, "path": target})

    return await _op_guard(request, handler)


@routes.post(f"{PREFIX}/move")
async def iib_move(request: web.Request) -> web.Response:
    async def handler(payload: Dict[str, Any], cfg: Dict[str, Any]) -> web.Response:
        paths = payload.get("paths") or []
        target_dir = payload.get("target") or ""
        copy_mode = bool(payload.get("copy"))
        if isinstance(paths, str):
            paths = [paths]
        if not target_dir and payload.get("targetRoot"):
            root = find_root(str(payload.get("targetRoot")), cfg)
            if root:
                rel = str(payload.get("targetRel") or "").replace("/", os.sep)
                target_dir = os.path.join(root["path"], rel) if rel else root["path"]
        if not target_dir or not os.path.isdir(target_dir):
            return json_err("目标目录不存在", 404)
        if not _allowed_anywhere(target_dir, cfg):
            return json_err("超出允许范围", 403)
        moved, failed = [], []
        for path in paths:
            if not _allowed_anywhere(path, cfg):
                failed.append({"path": path, "error": "超出允许范围"})
                continue
            try:
                destination = os.path.join(target_dir, os.path.basename(path.rstrip("\\/")))
                if os.path.normcase(destination) == os.path.normcase(path):
                    failed.append({"path": path, "error": "源和目标是同一个位置"})
                    continue
                if copy_mode:
                    if os.path.isdir(path):
                        shutil.copytree(path, destination, dirs_exist_ok=True)
                    else:
                        shutil.copy2(path, destination)
                else:
                    shutil.move(path, destination)
                moved.append(destination)
            except Exception as err:
                failed.append({"path": path, "error": str(err)})
        return json_ok({"ok": True, "paths": moved, "failed": failed})

    return await _op_guard(request, handler)


@routes.post(f"{PREFIX}/send-to-input")
async def iib_send_to_input(request: web.Request) -> web.Response:
    cfg = load_settings()
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    path = payload.get("path") or ""
    if not path or not os.path.isfile(path):
        return json_err("文件不存在", 404)
    if not _allowed_anywhere(path, cfg):
        return json_err("超出允许范围", 403)
    try:
        import folder_paths  # noqa: WPS433

        input_dir = folder_paths.get_input_directory()
    except Exception:
        input_dir = os.path.join(os.getcwd(), "input")
    os.makedirs(input_dir, exist_ok=True)
    subfolder = payload.get("subfolder") or "iib"
    target_dir = os.path.join(input_dir, subfolder)
    os.makedirs(target_dir, exist_ok=True)
    name = os.path.basename(path)
    stem, ext = os.path.splitext(name)
    candidate = os.path.join(target_dir, name)
    index = 1
    while os.path.exists(candidate):
        candidate = os.path.join(target_dir, f"{stem}_{index}{ext}")
        index += 1
    shutil.copy2(path, candidate)
    return json_ok(
        {
            "ok": True,
            "name": os.path.basename(candidate),
            "subfolder": subfolder,
            "value": f"{subfolder}/{os.path.basename(candidate)}",
            "path": candidate,
        }
    )


@routes.post(f"{PREFIX}/reveal")
async def iib_reveal(request: web.Request) -> web.Response:
    cfg = load_settings()
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    path = payload.get("path") or ""
    if not path or not os.path.exists(path):
        return json_err("路径不存在", 404)
    if not _allowed_anywhere(path, cfg):
        return json_err("超出允许范围", 403)
    if sys.platform.startswith("win"):
        try:
            if os.path.isdir(path):
                os.startfile(path)  # type: ignore[attr-defined]
            else:
                subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        except Exception as err:
            return json_err(f"无法打开资源管理器: {err}", 500)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path)])
    return json_ok({"ok": True})


@routes.post(f"{PREFIX}/cache/clear")
async def iib_cache_clear(request: web.Request) -> web.Response:
    removed = thumb_mod.clear_cache()
    return json_ok({"ok": True, "removed": removed, "cache": thumb_mod.cache_stats()})


# 扩展接口（索引 / 标签 / 搜索 / 统计 / 整理 / 批下载 / 备份），导入即注册路由
from . import api_extra as _api_extra  # noqa: E402,F401
