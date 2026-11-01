"""缩略图生成 + 磁盘缓存（含视频封面，尽力而为）。"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
from typing import Optional

from .config import category_of, thumb_dir

_MEM: dict[str, str] = {}
_MAX_MEM = 4096


def _key(path: str, size: int, mtime: float) -> str:
    raw = f"{os.path.normcase(os.path.abspath(path))}|{int(size)}|{int(mtime)}"
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()


def cache_file(path: str, size: int, mtime: float, ext: str = ".webp") -> str:
    return os.path.join(thumb_dir(), _key(path, size, mtime) + ext)


def _render_image(src: str, dst: str, size: int) -> bool:
    from PIL import Image, ImageOps

    with Image.open(src) as image:
        try:
            image = ImageOps.exif_transpose(image)
        except Exception:
            pass
        if getattr(image, "is_animated", False):
            try:
                image.seek(0)
            except Exception:
                pass
        frame = image.convert("RGB")
        if frame.width < 4 or frame.height < 4:
            frame = frame.resize((max(frame.width, 4), max(frame.height, 4)))
        thumb = ImageOps.fit(frame, (size, size), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        tmp = dst + ".tmp"
        thumb.save(tmp, "WEBP", quality=82, method=4)
        os.replace(tmp, dst)
    return True


def _find_ffmpeg() -> Optional[str]:
    for name in ("ffmpeg", "ffmpeg.exe"):
        found = shutil.which(name)
        if found:
            return found
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _render_video(src: str, dst: str, size: int) -> bool:
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        return False
    with tempfile.TemporaryDirectory() as tmpdir:
        frame_path = os.path.join(tmpdir, "frame.png")
        cmd = [
            ffmpeg, "-y", "-loglevel", "error", "-ss", "0.5", "-i", src,
            "-frames:v", "1", "-vf", f"scale={size}:{size}:force_original_aspect_ratio=increase,crop={size}:{size}",
            frame_path,
        ]
        try:
            subprocess.run(cmd, check=True, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            return False
        if not os.path.isfile(frame_path):
            return False
        return _render_image(frame_path, dst, size)


def ensure_thumb(path: str, size: int = 256) -> Optional[str]:
    """返回缩略图文件路径；失败返回 None。"""
    size = max(32, min(int(size or 256), 1024))
    try:
        stat = os.stat(path)
    except OSError:
        return None
    key = _key(path, size, stat.st_mtime)
    cached = _MEM.get(key)
    if cached and os.path.isfile(cached):
        return cached

    kind = category_of(path)
    if kind == "video":
        target = cache_file(path, size, stat.st_mtime)
        if not (os.path.isfile(target) and os.path.getsize(target) > 0):
            if not _render_video(path, target, size):
                return None
    elif kind == "image":
        target = cache_file(path, size, stat.st_mtime)
        if not (os.path.isfile(target) and os.path.getsize(target) > 0):
            try:
                _render_image(path, target, size)
            except Exception:
                try:
                    if os.path.exists(target + ".tmp"):
                        os.remove(target + ".tmp")
                except OSError:
                    pass
                return None
    else:
        return None

    if len(_MEM) > _MAX_MEM:
        _MEM.clear()
    _MEM[key] = target
    return target


def _dir_signature(folder: str) -> tuple:
    names = []
    try:
        with os.scandir(folder) as iterator:
            for entry in iterator:
                if entry.name.startswith(".") or entry.name.startswith("$"):
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif", ".jfif"}:
                    try:
                        if entry.is_file():
                            names.append((entry.name, entry.stat().st_mtime))
                    except OSError:
                        continue
    except OSError:
        return ()
    names.sort()
    return tuple(names[:8])


def dir_cover(folder: str, size: int = 256) -> Optional[str]:
    """目录封面：把目录里最多 4 张图片拼成 2x2 拼图（类似原版 IIB）。"""
    size = max(64, min(int(size or 256), 512))
    if not os.path.isdir(folder):
        return None
    signature = _dir_signature(folder)
    if not signature:
        return None
    raw = f"dir|{os.path.normcase(os.path.abspath(folder))}|{size}|{signature}"
    digest = hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()
    target = os.path.join(thumb_dir(), f"dir_{digest}.webp")
    if os.path.isfile(target) and os.path.getsize(target) > 0:
        return target

    try:
        from PIL import Image, ImageDraw, ImageOps
    except Exception:
        return None

    cell = size // 2
    canvas = Image.new("RGB", (size, size), (32, 32, 32))
    picks = [name for name, _ in signature[:4]]
    while len(picks) < 4:
        picks.append("")
    for index, name in enumerate(picks):
        if not name:
            continue
        source = os.path.join(folder, name)
        try:
            with Image.open(source) as image:
                try:
                    image = ImageOps.exif_transpose(image)
                except Exception:
                    pass
                tile = ImageOps.fit(image.convert("RGB"), (cell, cell), method=Image.Resampling.LANCZOS)
                canvas.paste(tile, ((index % 2) * cell, (index // 2) * cell))
        except Exception:
            continue

    if all(not name for name in picks):
        return None
    try:
        canvas.save(target, "WEBP", quality=82, method=4)
    except Exception:
        return None
    return target


def cache_stats() -> dict:
    folder = thumb_dir()
    total = 0
    count = 0
    for name in os.listdir(folder):
        full = os.path.join(folder, name)
        if os.path.isfile(full):
            count += 1
            total += os.path.getsize(full)
    return {"count": count, "bytes": total, "path": folder}


def clear_cache() -> int:
    folder = thumb_dir()
    removed = 0
    for name in os.listdir(folder):
        full = os.path.join(folder, name)
        try:
            if os.path.isfile(full):
                os.remove(full)
                removed += 1
        except OSError:
            pass
    _MEM.clear()
    return removed
