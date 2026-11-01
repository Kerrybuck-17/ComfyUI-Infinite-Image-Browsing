"""共享的 aiohttp 路由表：挂在 ComfyUI 的 PromptServer 上。"""
from __future__ import annotations

from aiohttp import web

try:  # ComfyUI 运行时
    from server import PromptServer

    routes = PromptServer.instance.routes
except Exception as err:  # pragma: no cover - 脱离 ComfyUI 时
    print(f"[IIB] 无法获取 ComfyUI 路由表: {err}")
    routes = web.RouteTableDef()
