"""配置与根目录解析。

所有设置最终都会由前端（ComfyUI 设置面板）写入本文件保存的 settings.json，
后端只负责持久化和把"附加目录"展开成可浏览的根目录。
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, List, Optional

_LOCK = threading.RLock()
_CACHE: Dict[str, Any] = {}

DEFAULTS: Dict[str, Any] = {
    "extraDirs": "",
    "includeInput": True,
    "includeTemp": False,
    "pageSize": 120,
    "thumbSize": 256,
    "gridSize": 180,
    "scanDepth": 4,
    "enableFileOps": True,
    "showVideos": True,
    "sort": "mtime_desc",
    "rememberLastPath": True,
    "searchMetadata": False,
    "autoIndex": False,
    "autoRefresh": 0,
    "autoHidePath": True,
    "useThumbnails": True,
    "originalRatio": False,
    "savePrefix": "%year%-%month%-%day%/ComfyUI",
}

IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".tif",
    ".avif", ".jfif", ".ico", ".jxl",
}
VIDEO_EXTS = {
    ".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".wmv", ".flv", ".mpg", ".mpeg",
}
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus", ".aac"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS


def _user_dir() -> str:
    try:
        import folder_paths  # noqa: WPS433  (ComfyUI 运行时才可导入)
        return folder_paths.get_user_directory()
    except Exception:
        return os.path.join(os.path.expanduser("~"), ".comfyui-iib")


def data_dir() -> str:
    path = os.path.join(_user_dir(), "iib")
    os.makedirs(path, exist_ok=True)
    return path


def settings_path() -> str:
    return os.path.join(data_dir(), "settings.json")


def thumb_dir() -> str:
    path = os.path.join(data_dir(), "thumbs")
    os.makedirs(path, exist_ok=True)
    return path


def load_settings() -> Dict[str, Any]:
    with _LOCK:
        if _CACHE.get("settings") is not None:
            return dict(_CACHE["settings"])
        data = dict(DEFAULTS)
        try:
            with open(settings_path(), "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                for key, value in stored.items():
                    if key in DEFAULTS:
                        data[key] = value
        except FileNotFoundError:
            pass
        except Exception as err:  # 配置坏了也不能影响启动
            print(f"[IIB] 读取设置失败: {err}")
        _CACHE["settings"] = data
        return dict(data)


def save_settings(values: Dict[str, Any]) -> Dict[str, Any]:
    with _LOCK:
        data = load_settings()
        for key, value in (values or {}).items():
            if key in DEFAULTS:
                data[key] = value
        _CACHE["settings"] = data
        try:
            with open(settings_path(), "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
        except Exception as err:
            print(f"[IIB] 保存设置失败: {err}")
        return dict(data)


def parse_extra_dirs(raw: str) -> List[Dict[str, str]]:
    """支持 `名称::路径`、`名称=路径` 或纯路径，多项用换行/分号分隔。"""
    items: List[Dict[str, str]] = []
    if not raw:
        return items
    text = str(raw).replace("\r", "\n")
    for chunk in text.replace(";", "\n").split("\n"):
        chunk = chunk.strip()
        if not chunk:
            continue
        label = ""
        path = chunk
        for sep in ("::", "=>"):
            if sep in chunk:
                head, tail = chunk.split(sep, 1)
                if tail.strip():
                    label, path = head.strip(), tail.strip()
                break
        path = os.path.expandvars(os.path.expanduser(path.strip('"').strip("'")))
        if not path:
            continue
        if not label:
            base = os.path.basename(os.path.normpath(path)) or path
            drive = os.path.splitdrive(path)[0]
            label = f"{base} ({drive})" if drive else base
        label = "".join(char for char in label if char.isprintable()).strip()[:40] or path
        items.append({"label": label, "path": path})
    return items


def comfy_directory(name: str, fallback: str) -> str:
    try:
        import folder_paths  # noqa: WPS433
        getter = {
            "output": folder_paths.get_output_directory,
            "input": folder_paths.get_input_directory,
            "temp": folder_paths.get_temp_directory,
        }.get(name)
        if getter:
            return os.path.abspath(getter())
    except Exception:
        pass
    return os.path.abspath(fallback)


def get_roots(cfg: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    cfg = cfg or load_settings()
    roots: List[Dict[str, Any]] = []

    def add(rid: str, label: str, path: str) -> None:
        if not path or not os.path.isdir(path):
            return
        norm = os.path.normcase(os.path.abspath(path))
        if any(os.path.normcase(r["path"]) == norm for r in roots):
            return
        roots.append({"id": rid, "label": label, "path": os.path.abspath(path)})

    add("output", "输出目录", comfy_directory("output", os.path.join(os.getcwd(), "output")))
    if cfg.get("includeInput", True):
        add("input", "输入目录", comfy_directory("input", os.path.join(os.getcwd(), "input")))
    if cfg.get("includeTemp", False):
        add("temp", "临时目录", comfy_directory("temp", os.path.join(os.getcwd(), "temp")))

    for index, item in enumerate(parse_extra_dirs(str(cfg.get("extraDirs") or ""))):
        add(f"extra:{index}", item["label"], item["path"])
    return roots


def find_root(root_id: str, cfg: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    for root in get_roots(cfg):
        if root["id"] == root_id:
            return root
    return None


def is_within(base: str, target: str) -> bool:
    try:
        base_abs = os.path.normcase(os.path.abspath(base))
        target_abs = os.path.normcase(os.path.abspath(target))
        return os.path.commonpath([base_abs, target_abs]) == base_abs
    except Exception:
        return False


def category_of(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return "file"


def human_size(size: int) -> str:
    value = float(size or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"
