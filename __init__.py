"""ComfyUI-Infinite-Image-Browsing

把 sd-webui-infinite-image-browsing 的核心浏览体验移植到 ComfyUI：
左侧边栏的「资产」按钮不再展开原生侧栏，而是打开一个与「模板」同款的大窗口，
窗口内的全部界面使用 ComfyUI 原生的 UI 体系（CSS 变量、material 图标、原生设置项）。

仅提供前端与 HTTP 路由，不注册任何节点。
"""
from __future__ import annotations

import os

from .iib import api as _api  # noqa: F401  导入即注册 /iib 路由

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print("[IIB] Infinite Image Browsing (ComfyUI port) 已加载，版本", _api.VERSION)
