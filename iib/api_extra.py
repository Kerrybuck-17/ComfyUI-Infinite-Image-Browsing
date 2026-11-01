"""索引 / 标签 / 搜索 / 统计 / 整理 / 批下载 / 备份 等扩展接口。"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import shutil
import tempfile
import time
import urllib.parse
import zipfile
from typing import Any, Dict, List, Optional

from aiohttp import web

from . import db, indexer
from .config import (
    category_of,
    data_dir,
    find_root,
    get_roots,
    human_size,
    is_within,
    load_settings,
)
from .meta import raw_workflow
from .routes import routes

PREFIX = "/iib"


def json_ok(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, dumps=lambda obj: json.dumps(obj, ensure_ascii=False))


def json_err(message: str, status: int = 400) -> web.Response:
    return json_ok({"ok": False, "error": message}, status=status)


def _allowed(path: str) -> bool:
    try:
        return any(is_within(root["path"], path) for root in get_roots(load_settings()))
    except Exception:
        return False


def _thumb_url(path: str, mtime: float, size: int) -> str:
    query = urllib.parse.urlencode({"path": path, "size": int(size), "v": int(mtime or 0)})
    return f"{PREFIX}/thumb?{query}"


def _file_url(path: str, mtime: float, download: bool = False) -> str:
    params = {"path": path, "v": int(mtime or 0)}
    if download:
        params["download"] = "1"
    return f"{PREFIX}/file?{urllib.parse.urlencode(params)}"


def _row_item(row, thumb_size: int) -> dict:
    path = row["path"]
    mtime = float(row["mtime"] or 0)
    kind = row["kind"] or category_of(path)
    item = {
        "id": row["id"],
        "name": row["name"] or os.path.basename(path),
        "abs": path,
        "rel": row["rel"] or "",
        "isDir": False,
        "size": int(row["size"] or 0),
        "sizeText": human_size(int(row["size"] or 0)),
        "mtime": mtime,
        "mtimeText": time.strftime("%Y-%m-%d %H:%M", time.localtime(mtime)) if mtime else "",
        "kind": kind,
        "width": int(row["width"] or 0),
        "height": int(row["height"] or 0),
        "model": row["model"] or "",
        "prompt": (row["prompt"] or "")[:4000],
        "tags": [],
        "favorited": False,
    }
    if kind in {"image", "video"}:
        item["thumb"] = _thumb_url(path, mtime, thumb_size)
        item["url"] = _file_url(path, mtime)
    return item


# ---------------------------------------------------------------- 索引


@routes.get(f"{PREFIX}/index/status")
async def iib_index_status(request: web.Request) -> web.Response:
    data = await asyncio.to_thread(indexer.status)
    data["ok"] = True
    data["dbPath"] = db.db_path()
    return json_ok(data)


@routes.post(f"{PREFIX}/index/scan")
async def iib_index_scan(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    force = bool(payload.get("force"))
    roots = payload.get("roots") or []
    started = await asyncio.to_thread(indexer.start, force, roots)
    if not started:
        return json_err("索引已经在运行中", 409)
    return json_ok({"ok": True, "started": True, **await asyncio.to_thread(indexer.status)})


@routes.post(f"{PREFIX}/index/stop")
async def iib_index_stop(request: web.Request) -> web.Response:
    stopped = await asyncio.to_thread(indexer.stop)
    return json_ok({"ok": True, "stopped": stopped})


@routes.post(f"{PREFIX}/index/clear")
async def iib_index_clear(request: web.Request) -> web.Response:
    if indexer.is_running():
        return json_err("索引运行中，无法清空", 409)

    def _clear() -> dict:
        conn = db.connect()
        try:
            db.init()
            conn.execute("DELETE FROM file_tags")
            conn.execute("DELETE FROM files")
            conn.execute("DELETE FROM tags")
            conn.commit()
            return {"files": 0}
        finally:
            conn.close()

    await asyncio.to_thread(_clear)
    return json_ok({"ok": True})


@routes.get(f"{PREFIX}/index/log")
async def iib_index_log(request: web.Request) -> web.Response:
    def _load() -> List[dict]:
        conn = db.connect()
        try:
            db.init()
            rows = conn.execute("SELECT * FROM scan_log ORDER BY id DESC LIMIT 50").fetchall()
            return [dict(row) for row in rows]
        finally:
            conn.close()

    return json_ok({"ok": True, "logs": await asyncio.to_thread(_load)})


# ---------------------------------------------------------------- 标签


@routes.get(f"{PREFIX}/tags")
async def iib_tags(request: web.Request) -> web.Response:
    query = request.query.get("q") or ""
    limit = int(request.query.get("limit") or 400)
    sort = request.query.get("sort") or "count"

    def _load() -> List[dict]:
        conn = db.connect()
        try:
            db.init()
            return db.list_tags(conn, query, limit, sort)
        finally:
            conn.close()

    return json_ok({"ok": True, "tags": await asyncio.to_thread(_load)})


@routes.post(f"{PREFIX}/tags/create")
async def iib_tags_create(request: web.Request) -> web.Response:
    payload = await request.json()
    name = (payload.get("name") or "").strip()
    if not name:
        return json_err("标签名不能为空")

    def _create() -> int:
        conn = db.connect()
        try:
            db.init()
            tag_id = db.ensure_tag(conn, name, payload.get("color") or "")
            conn.commit()
            return tag_id
        finally:
            conn.close()

    tag_id = await asyncio.to_thread(_create)
    return json_ok({"ok": True, "id": tag_id, "name": name})


@routes.post(f"{PREFIX}/tags/rename")
async def iib_tags_rename(request: web.Request) -> web.Response:
    payload = await request.json()
    tag_id = int(payload.get("id") or 0)
    name = (payload.get("name") or "").strip()
    if not tag_id or not name:
        return json_err("参数错误")

    def _rename() -> bool:
        conn = db.connect()
        try:
            db.init()
            ok = db.rename_tag(conn, tag_id, name)
            conn.commit()
            return ok
        finally:
            conn.close()

    ok = await asyncio.to_thread(_rename)
    if not ok:
        return json_err("重命名失败（可能重名）", 409)
    return json_ok({"ok": True})


@routes.post(f"{PREFIX}/tags/delete")
async def iib_tags_delete(request: web.Request) -> web.Response:
    payload = await request.json()
    tag_id = int(payload.get("id") or 0)
    if not tag_id:
        return json_err("参数错误")

    def _delete() -> None:
        conn = db.connect()
        try:
            db.init()
            db.delete_tag(conn, tag_id)
            conn.commit()
        finally:
            conn.close()

    await asyncio.to_thread(_delete)
    return json_ok({"ok": True})


@routes.get(f"{PREFIX}/tags/of")
async def iib_tags_of(request: web.Request) -> web.Response:
    path = request.query.get("path") or ""

    def _load() -> List[dict]:
        conn = db.connect()
        try:
            db.init()
            row = db.get_file(conn, path)
            if not row:
                return []
            return db.tags_of_file(conn, int(row["id"]))
        finally:
            conn.close()

    return json_ok({"ok": True, "tags": await asyncio.to_thread(_load)})


@routes.post(f"{PREFIX}/tags/assign")
async def iib_tags_assign(request: web.Request) -> web.Response:
    payload = await request.json()
    paths = payload.get("paths") or []
    names = payload.get("tags") or []
    action = payload.get("action") or "add"
    if isinstance(paths, str):
        paths = [paths]
    if isinstance(names, str):
        names = [names]
    if not paths:
        return json_err("没有选择文件")

    def _apply() -> dict:
        conn = db.connect()
        try:
            db.init()
            changed = 0
            for path in paths:
                row = db.get_file(conn, path)
                if not row:
                    continue
                for name in names:
                    if action == "remove":
                        tag_row = conn.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()
                        if tag_row:
                            db.unassign_tag(conn, int(row["id"]), int(tag_row["id"]))
                            changed += 1
                    else:
                        tag_id = db.ensure_tag(conn, name)
                        db.assign_tag(conn, int(row["id"]), tag_id, source="manual")
                        changed += 1
            conn.commit()
            return {"changed": changed}
        finally:
            conn.close()

    result = await asyncio.to_thread(_apply)
    return json_ok({"ok": True, **result})


@routes.get(f"{PREFIX}/tag/graph")
async def iib_tag_graph(request: web.Request) -> web.Response:
    limit = int(request.query.get("limit") or 60)
    min_edge = int(request.query.get("minEdge") or 2)

    def _load() -> dict:
        conn = db.connect()
        try:
            db.init()
            return db.tag_graph(conn, limit, min_edge)
        finally:
            conn.close()

    return json_ok({"ok": True, **await asyncio.to_thread(_load)})


# ---------------------------------------------------------------- 搜索


def _search_sync(params: Dict[str, Any]) -> dict:
    conn = db.connect()
    try:
        db.init()
        cfg = load_settings()
        thumb_size = int(cfg.get("thumbSize") or 256)
        where = ["1=1"]
        args: List[Any] = []
        q = (params.get("q") or "").strip()
        if q:
            where.append("(name LIKE ? OR prompt LIKE ? OR negative LIKE ? OR model LIKE ? OR loras LIKE ?)")
            like = f"%{q}%"
            args += [like, like, like, like, like]
        model = (params.get("model") or "").strip()
        if model:
            where.append("model LIKE ?")
            args.append(f"%{model}%")
        kind = (params.get("type") or "").strip()
        if kind in {"image", "video"}:
            where.append("kind=?")
            args.append(kind)
        dir_param = (params.get("dir") or "").strip()
        if dir_param:
            prefix = dir_param.rstrip("\\/") + os.sep + "%"
            where.append("path LIKE ?")
            args.append(prefix)
        try:
            from_ts = float(params.get("from") or 0)
            if from_ts:
                where.append("mtime>=?")
                args.append(from_ts)
            to_ts = float(params.get("to") or 0)
            if to_ts:
                where.append("mtime<=?")
                args.append(to_ts)
        except (TypeError, ValueError):
            pass
        try:
            min_size = int(params.get("minSize") or 0)
            if min_size:
                where.append("size>=?")
                args.append(min_size)
            max_size = int(params.get("maxSize") or 0)
            if max_size:
                where.append("size<=?")
                args.append(max_size)
        except (TypeError, ValueError):
            pass

        tags = [tag for tag in (params.get("tags") or "").split(",") if tag]
        if tags:
            placeholders = ",".join("?" for _ in tags)
            if (params.get("tagMode") or "any") == "all":
                where.append(
                    f"(SELECT COUNT(DISTINCT t.id) FROM file_tags ft JOIN tags t ON t.id=ft.tag_id "
                    f"WHERE ft.file_id=files.id AND t.name IN ({placeholders})) = ?"
                )
                args += tags + [len(tags)]
            else:
                where.append(
                    f"EXISTS(SELECT 1 FROM file_tags ft JOIN tags t ON t.id=ft.tag_id "
                    f"WHERE ft.file_id=files.id AND t.name IN ({placeholders}))"
                )
                args += tags

        if str(params.get("favorites") or "") in {"1", "true", "yes"}:
            where.append("EXISTS(SELECT 1 FROM favorites f WHERE f.path=files.path)")

        sort = params.get("sort") or "mtime_desc"
        order = "mtime DESC"
        if sort == "mtime_asc":
            order = "mtime ASC"
        elif sort == "name_asc":
            order = "name COLLATE NOCASE ASC"
        elif sort == "name_desc":
            order = "name COLLATE NOCASE DESC"
        elif sort == "size_desc":
            order = "size DESC"
        elif sort == "random":
            order = "RANDOM()"
        elif sort == "relevance" and q:
            order = "CASE WHEN name LIKE ? THEN 0 ELSE 1 END, mtime DESC"

        page = max(1, int(params.get("page") or 1))
        size = max(1, min(int(params.get("size") or 120), 1000))
        offset = (page - 1) * size

        where_sql = " AND ".join(where)
        total = conn.execute(f"SELECT COUNT(*) c FROM files WHERE {where_sql}", args).fetchone()["c"]
        order_args = list(args)
        if sort == "relevance" and q:
            order_args = [f"%{q}%"] + order_args
        rows = conn.execute(
            f"SELECT * FROM files WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
            order_args + [size, offset],
        ).fetchall()
        items = [_row_item(row, thumb_size) for row in rows]
        if rows:
            marks = ",".join("?" for _ in rows)
            favorites = {
                fav["path"]
                for fav in conn.execute(
                    f"SELECT path FROM favorites WHERE path IN ({marks})",
                    [row["path"] for row in rows],
                )
            }
            for item in items:
                item["favorited"] = item["abs"] in favorites
        return {
            "total": int(total),
            "items": items,
            "page": page,
            "pageSize": size,
        }
    finally:
        conn.close()


@routes.get(f"{PREFIX}/search")
async def iib_search(request: web.Request) -> web.Response:
    params = dict(request.query)
    try:
        data = await asyncio.to_thread(_search_sync, params)
    except Exception as err:
        return json_err(f"搜索失败: {err}", 500)
    return json_ok({"ok": True, **data, "query": params})


@routes.get(f"{PREFIX}/search/suggest")
async def iib_search_suggest(request: web.Request) -> web.Response:
    q = (request.query.get("q") or "").strip()
    if not q:
        return json_ok({"ok": True, "tags": [], "models": []})

    def _load() -> dict:
        conn = db.connect()
        try:
            db.init()
            tags = [dict(row) for row in conn.execute(
                "SELECT t.name, COUNT(*) c FROM tags t JOIN file_tags ft ON ft.tag_id=t.id "
                "WHERE t.name LIKE ? GROUP BY t.id ORDER BY c DESC LIMIT 12", (f"%{q}%",)
            )]
            models = [dict(row) for row in conn.execute(
                "SELECT model name, COUNT(*) c FROM files WHERE model LIKE ? AND model<>'' "
                "GROUP BY model ORDER BY c DESC LIMIT 8", (f"%{q}%",)
            )]
            return {"tags": tags, "models": models}
        finally:
            conn.close()

    return json_ok({"ok": True, **await asyncio.to_thread(_load)})


# ---------------------------------------------------------------- 统计 / 相似


@routes.get(f"{PREFIX}/stats")
async def iib_stats(request: web.Request) -> web.Response:
    days = int(request.query.get("days") or 30)

    def _load() -> dict:
        conn = db.connect()
        try:
            db.init()
            return db.stats_summary(conn, days)
        finally:
            conn.close()

    return json_ok({"ok": True, **await asyncio.to_thread(_load)})


@routes.get(f"{PREFIX}/similar")
async def iib_similar(request: web.Request) -> web.Response:
    path = request.query.get("path") or ""
    limit = int(request.query.get("limit") or 24)
    distance = int(request.query.get("distance") or 999)
    if not path:
        return json_err("缺少 path")
    items = await asyncio.to_thread(indexer.similar_files, path, limit, distance)
    cfg = load_settings()
    thumb_size = int(cfg.get("thumbSize") or 256)
    result = []
    for item in items:
        result.append({
            **item,
            "abs": item["path"],
            "sizeText": human_size(item["size"]),
            "mtimeText": time.strftime("%Y-%m-%d %H:%M", time.localtime(item["mtime"])) if item["mtime"] else "",
            "kind": category_of(item["path"]),
            "thumb": _thumb_url(item["path"], item["mtime"], thumb_size),
            "url": _file_url(item["path"], item["mtime"]),
        })
    return json_ok({"ok": True, "items": result})


@routes.get(f"{PREFIX}/duplicates")
async def iib_duplicates(request: web.Request) -> web.Response:
    distance = int(request.query.get("distance") or 6)
    groups = await asyncio.to_thread(indexer.duplicate_groups, distance)
    return json_ok({"ok": True, "groups": groups})


# ---------------------------------------------------------------- 批量下载


@routes.post(f"{PREFIX}/zip")
async def iib_zip(request: web.Request) -> web.StreamResponse:
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    paths = payload.get("paths") or []
    if not paths:
        return json_err("没有选择文件")
    paths = [path for path in paths if os.path.isfile(path) and _allowed(path)]
    if not paths:
        return json_err("没有可打包的文件")

    def _build() -> str:
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".zip", dir=data_dir())
        temp_file.close()
        with zipfile.ZipFile(temp_file.name, "w", zipfile.ZIP_DEFLATED, compresslevel=4) as archive:
            used: Dict[str, int] = {}
            for path in paths:
                name = os.path.basename(path)
                if name in used:
                    used[name] += 1
                    stem, ext = os.path.splitext(name)
                    name = f"{stem}_{used[name]}{ext}"
                else:
                    used[name] = 1
                try:
                    archive.write(path, arcname=name)
                except Exception:
                    continue
        return temp_file.name

    archive_path = await asyncio.to_thread(_build)
    filename = time.strftime("iib-%Y%m%d-%H%M%S.zip")
    loop = asyncio.get_event_loop()
    loop.call_later(600, lambda: os.path.exists(archive_path) and os.remove(archive_path))
    return web.FileResponse(
        archive_path,
        headers={
            "Content-Type": "application/zip",
            "Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(filename)}",
        },
    )


@routes.get(f"{PREFIX}/random")
async def iib_random(request: web.Request) -> web.Response:
    count = max(1, min(int(request.query.get("count") or 20), 200))

    def _load() -> List[dict]:
        conn = db.connect()
        try:
            db.init()
            cfg = load_settings()
            thumb_size = int(cfg.get("thumbSize") or 256)
            rows = conn.execute("SELECT * FROM files ORDER BY RANDOM() LIMIT ?", (count,)).fetchall()
            return [_row_item(row, thumb_size) for row in rows]
        finally:
            conn.close()

    return json_ok({"ok": True, "items": await asyncio.to_thread(_load)})


# ---------------------------------------------------------------- 整理


def _group_key(row, by: str, conn) -> str:
    if by == "model":
        return (row["model"] or "未标注模型").rstrip()
    if by == "date":
        return time.strftime("%Y-%m-%d", time.localtime(float(row["mtime"] or 0)))
    if by == "month":
        return time.strftime("%Y-%m", time.localtime(float(row["mtime"] or 0)))
    if by == "type":
        return row["kind"] or "unknown"
    if by == "tag":
        tags = db.tags_of_file(conn, int(row["id"]))
        manual = [tag for tag in tags if tag.get("source") == "manual"]
        if manual:
            return manual[0]["name"]
        return tags[0]["name"] if tags else "未标注标签"
    if by == "folder":
        return os.path.basename(os.path.dirname(row["path"])) or "根目录"
    return "全部"


def _sanitize(name: str) -> str:
    cleaned = "".join("_" if char in '\\/:*?"<>|' else char for char in str(name)).strip()
    return cleaned[:80] or "未命名"


@routes.post(f"{PREFIX}/organize/preview")
async def iib_organize_preview(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    by = payload.get("by") or "model"
    paths = payload.get("paths") or []
    dir_param = str(payload.get("dir") or "").strip()

    def _load() -> dict:
        conn = db.connect()
        try:
            db.init()
            if paths:
                marks = ",".join("?" for _ in paths)
                rows = conn.execute(f"SELECT * FROM files WHERE path IN ({marks})", paths).fetchall()
            elif dir_param:
                prefix = dir_param.rstrip("\\/") + os.sep + "%"
                rows = conn.execute(
                    "SELECT * FROM files WHERE path LIKE ? ORDER BY mtime DESC LIMIT 5000",
                    (prefix,),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM files ORDER BY mtime DESC LIMIT 5000").fetchall()
            groups: Dict[str, List[dict]] = {}
            for row in rows:
                key = _sanitize(_group_key(row, by, conn))
                groups.setdefault(key, []).append({
                    "name": row["name"],
                    "path": row["path"],
                    "size": row["size"],
                    "mtime": row["mtime"],
                })
            result = [
                {"name": key, "count": len(items), "files": items[:2000]}
                for key, items in sorted(groups.items(), key=lambda item: len(item[1]), reverse=True)
            ]
            return {"groups": result, "by": by, "total": len(rows)}
        finally:
            conn.close()

    return json_ok({"ok": True, **await asyncio.to_thread(_load)})


@routes.post(f"{PREFIX}/organize/apply")
async def iib_organize_apply(request: web.Request) -> web.Response:
    cfg = load_settings()
    if not cfg.get("enableFileOps", True):
        return json_err("设置中已禁用文件操作", 403)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    groups = payload.get("groups") or []
    root_id = payload.get("targetRoot") or ""
    target_rel = (payload.get("targetRel") or "").replace("/", os.sep)
    copy_mode = bool(payload.get("copy"))
    force = bool(payload.get("force"))
    root = find_root(root_id)
    if not root:
        return json_err("目标目录不存在", 404)
    base = os.path.join(root["path"], target_rel) if target_rel else root["path"]
    if not is_within(root["path"], base):
        return json_err("目标目录越界", 403)

    def _apply() -> dict:
        moved = 0
        failed: List[dict] = []
        os.makedirs(base, exist_ok=True)
        for group in groups:
            if not group.get("apply", True):
                continue
            folder = os.path.join(base, _sanitize(group.get("name") or "未命名"))
            for item in group.get("files") or []:
                source = item.get("path") or item
                if not isinstance(source, str) or not os.path.isfile(source) or not _allowed(source):
                    failed.append({"path": str(source), "error": "文件不存在或越界"})
                    continue
                os.makedirs(folder, exist_ok=True)
                destination = os.path.join(folder, os.path.basename(source))
                if os.path.normcase(destination) == os.path.normcase(source):
                    continue
                if os.path.exists(destination) and not force:
                    stem, ext = os.path.splitext(os.path.basename(source))
                    index = 1
                    while os.path.exists(os.path.join(folder, f"{stem}_{index}{ext}")):
                        index += 1
                    destination = os.path.join(folder, f"{stem}_{index}{ext}")
                try:
                    if copy_mode:
                        shutil.copy2(source, destination)
                    else:
                        shutil.move(source, destination)
                    moved += 1
                except Exception as err:
                    failed.append({"path": source, "error": str(err)})
        return {"moved": moved, "failed": failed, "target": base}

    result = await asyncio.to_thread(_apply)
    return json_ok({"ok": True, **result})


# ---------------------------------------------------------------- 提示词写回


@routes.post(f"{PREFIX}/prompt")
async def iib_prompt_write(request: web.Request) -> web.Response:
    cfg = load_settings()
    if not cfg.get("enableFileOps", True):
        return json_err("设置中已禁用文件操作", 403)
    try:
        payload = await request.json()
    except Exception:
        return json_err("参数错误")
    path = payload.get("path") or ""
    new_prompt = payload.get("prompt")
    if not path or not os.path.isfile(path) or not _allowed(path):
        return json_err("文件不存在或越界", 404)
    if not isinstance(new_prompt, str):
        return json_err("prompt 必须是字符串")

    def _write() -> dict:
        from PIL import Image, PngImagePlugin

        with Image.open(path) as image:
            if image.format != "PNG":
                raise ValueError("目前只支持写回 PNG")
            info = dict(getattr(image, "info", {}) or {})
            raw = info.get("prompt")
            if not raw:
                raise ValueError("这张图片没有嵌入 ComfyUI prompt")
            prompt_json = json.loads(raw) if isinstance(raw, str) else raw
            updated = False
            for node in prompt_json.values():
                if not isinstance(node, dict):
                    continue
                class_type = str(node.get("class_type") or "")
                inputs = node.get("inputs") or {}
                if "CLIPTextEncode" in class_type and isinstance(inputs.get("text"), str) and inputs["text"].strip():
                    if not updated:
                        inputs["text"] = new_prompt
                        updated = True
            if not updated:
                raise ValueError("没有找到可写的正向提示词节点")

            pnginfo = PngImagePlugin.PngInfo()
            for key, value in info.items():
                if isinstance(value, str):
                    try:
                        pnginfo.add_text(key, value)
                    except Exception:
                        pass
            pnginfo.add_text("prompt", json.dumps(prompt_json, ensure_ascii=False))
            temp_path = path + ".iib-tmp"
            save_kwargs = {"pnginfo": pnginfo}
            if info.get("icc_profile"):
                save_kwargs["icc_profile"] = info["icc_profile"]
            image.save(temp_path, "PNG", **save_kwargs)
        os.replace(temp_path, path)
        return {"path": path, "prompt": new_prompt}

    try:
        result = await asyncio.to_thread(_write)
    except Exception as err:
        return json_err(f"写入失败: {err}", 500)
    return json_ok({"ok": True, **result})


# ---------------------------------------------------------------- 收藏


@routes.get(f"{PREFIX}/favorites")
async def iib_favorites_list(request: web.Request) -> web.Response:
    page = max(1, int(request.query.get("page") or 1))
    size = max(1, min(int(request.query.get("size") or 120), 1000))

    def _load() -> dict:
        conn = db.connect()
        try:
            db.init()
            thumb_size = int(load_settings().get("thumbSize") or 256)
            rows = conn.execute(
                "SELECT path FROM favorites ORDER BY created_at DESC"
            ).fetchall()
            paths = [row["path"] for row in rows if os.path.isfile(row["path"])]
            total = len(paths)
            start = (page - 1) * size
            items = []
            for path in paths[start:start + size]:
                try:
                    stat = os.stat(path)
                except OSError:
                    continue
                name = os.path.basename(path)
                item = {
                    "name": name,
                    "abs": path,
                    "rel": "",
                    "isDir": False,
                    "size": stat.st_size,
                    "sizeText": human_size(stat.st_size),
                    "mtime": stat.st_mtime,
                    "mtimeText": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
                    "kind": category_of(path),
                    "width": 0,
                    "height": 0,
                    "model": "",
                    "prompt": "",
                    "tags": [],
                    "favorited": True,
                }
                if item["kind"] in {"image", "video"}:
                    item["thumb"] = _thumb_url(path, stat.st_mtime, thumb_size)
                    item["url"] = _file_url(path, stat.st_mtime)
                items.append(item)
            return {"total": total, "items": items, "page": page, "pageSize": size}
        finally:
            conn.close()

    return json_ok({"ok": True, **await asyncio.to_thread(_load)})


@routes.post(f"{PREFIX}/favorites/toggle")
async def iib_favorites_toggle(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    path = payload.get("path") or ""
    if not path or not os.path.isfile(path) or not _allowed(path):
        return json_err("文件不存在或越界", 404)

    def _toggle() -> bool:
        conn = db.connect()
        try:
            db.init()
            row = conn.execute("SELECT path FROM favorites WHERE path=?", (path,)).fetchone()
            if row:
                conn.execute("DELETE FROM favorites WHERE path=?", (path,))
                favorited = False
            else:
                conn.execute("INSERT INTO favorites(path, created_at) VALUES(?,?)", (path, time.time()))
                favorited = True
            conn.commit()
            return favorited
        finally:
            conn.close()

    favorited = await asyncio.to_thread(_toggle)
    return json_ok({"ok": True, "favorited": favorited, "path": path})


@routes.get(f"{PREFIX}/favorites/has")
async def iib_favorites_has(request: web.Request) -> web.Response:
    path = request.query.get("path") or ""

    def _has() -> bool:
        conn = db.connect()
        try:
            db.init()
            return conn.execute("SELECT 1 FROM favorites WHERE path=?", (path,)).fetchone() is not None
        finally:
            conn.close()

    return json_ok({"ok": True, "favorited": await asyncio.to_thread(_has)})


# ---------------------------------------------------------------- 导出 / 备份


@routes.get(f"{PREFIX}/export")
async def iib_export(request: web.Request) -> web.StreamResponse:
    fmt = (request.query.get("format") or "json").lower()

    def _rows() -> List[dict]:
        conn = db.connect()
        try:
            db.init()
            return [dict(row) for row in conn.execute("SELECT * FROM files ORDER BY mtime DESC").fetchall()]
        finally:
            conn.close()

    rows = await asyncio.to_thread(_rows)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    if fmt == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["path", "name", "kind", "size", "mtime", "width", "height", "model", "loras", "sampler", "steps", "cfg", "seed", "prompt"])
        for row in rows:
            writer.writerow([row.get(key, "") for key in ("path", "name", "kind", "size", "mtime", "width", "height", "model", "loras", "sampler", "steps", "cfg", "seed", "prompt")])
        data = buffer.getvalue().encode("utf-8-sig")
        return web.Response(
            body=data,
            headers={
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": f"attachment; filename*=UTF-8''iib-metadata-{stamp}.csv",
            },
        )
    data = json.dumps({"exportedAt": time.time(), "count": len(rows), "files": rows}, ensure_ascii=False, indent=1).encode("utf-8")
    return web.Response(
        body=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": f"attachment; filename*=UTF-8''iib-metadata-{stamp}.json",
        },
    )


@routes.post(f"{PREFIX}/backup/export")
async def iib_backup(request: web.Request) -> web.StreamResponse:
    def _copy() -> str:
        db.init()
        target = os.path.join(data_dir(), "iib-backup.db")
        source = db.connect()
        try:
            destination = __import__("sqlite3").connect(target)
            with destination:
                source.backup(destination)
            destination.close()
        finally:
            source.close()
        return target

    path = await asyncio.to_thread(_copy)
    filename = time.strftime("iib-backup-%Y%m%d-%H%M%S.db")
    return web.FileResponse(
        path,
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
        },
    )
