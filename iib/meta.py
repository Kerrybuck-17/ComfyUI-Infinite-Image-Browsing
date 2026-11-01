"""图片元数据读取：PNG tEXt / EXIF / A1111 parameters / ComfyUI prompt。"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional

from .config import category_of, human_size

MAX_TEXT = 20000


def _safe_json(text: Optional[str]) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def _first_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        for item in value:
            text = _first_text(item)
            if text:
                return text
    if isinstance(value, dict):
        for key in ("text", "prompt", "string", "value"):
            if key in value:
                text = _first_text(value[key])
                if text:
                    return text
    return ""


def _collect_upstream_text(prompt: Dict[str, Any], node_id: Any, seen=None) -> List[str]:
    """顺着链路回溯，收集所有 CLIPTextEncode 的文本。"""
    if seen is None:
        seen = set()
    if node_id is None:
        return []
    key = str(node_id)
    if key in seen:
        return []
    seen.add(key)
    node = prompt.get(key)
    if not isinstance(node, dict):
        return []
    texts: List[str] = []
    class_type = str(node.get("class_type") or "")
    inputs = node.get("inputs") or {}
    text_value = inputs.get("text")
    text_ish = any(token in class_type for token in ("CLIPTextEncode", "Text", "Prompt", "Wildcard", "String"))
    if isinstance(text_value, str) and text_value.strip() and text_ish:
        texts.append(text_value.strip())
    for value in inputs.values():
        if isinstance(value, list) and value and isinstance(value[0], (str, int)):
            texts.extend(_collect_upstream_text(prompt, value[0], seen))
        elif isinstance(value, str) and value.isdigit() and value in prompt:
            texts.extend(_collect_upstream_text(prompt, value, seen))
    return texts


def _link_id(value: Any) -> Any:
    """ComfyUI 的连接值形如 ["12", 0]，取出节点 id。"""
    if isinstance(value, (list, tuple)) and value:
        return value[0]
    return value


def summarize_comfy_prompt(raw: Any) -> Dict[str, Any]:
    prompt = _safe_json(raw) if isinstance(raw, str) else raw
    if not isinstance(prompt, dict) or not prompt:
        return {}
    summary: Dict[str, Any] = {}
    sampler = None
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        inputs = node.get("inputs") or {}
        if sampler is None and "KSampler" in class_type:
            sampler = inputs
        if "CheckpointLoader" in class_type and inputs.get("ckpt_name"):
            summary.setdefault("模型", str(inputs["ckpt_name"]))
        if "LoraLoader" in class_type and inputs.get("lora_name"):
            summary.setdefault("LoRA", [])
            summary["LoRA"].append(str(inputs["lora_name"]))
        if "VAELoader" in class_type and inputs.get("vae_name"):
            summary.setdefault("VAE", str(inputs["vae_name"]))
        if "SaveImage" in class_type and inputs.get("filename_prefix"):
            summary.setdefault("文件名前缀", str(inputs["filename_prefix"]))
        if "EmptyLatentImage" in class_type or "EmptySD3LatentImage" in class_type:
            width, height = inputs.get("width"), inputs.get("height")
            if width and height and not isinstance(width, list) and not isinstance(height, list):
                summary.setdefault("尺寸", f"{width} × {height}")
    if sampler:
        mapping = {
            "steps": "步数",
            "cfg": "CFG",
            "seed": "种子",
            "sampler_name": "采样器",
            "scheduler": "调度器",
            "denoise": "降噪",
        }
        for key, label in mapping.items():
            if key in sampler and not isinstance(sampler[key], list):
                summary[label] = sampler[key]
        positive = _collect_upstream_text(prompt, _link_id(sampler.get("positive")))
        negative = _collect_upstream_text(prompt, _link_id(sampler.get("negative")))
        if positive:
            summary["正向提示词"] = "\n".join(dict.fromkeys(positive))
        if negative:
            summary["负向提示词"] = "\n".join(dict.fromkeys(negative))
    if "LoRA" in summary:
        summary["LoRA"] = list(dict.fromkeys(summary["LoRA"]))
    return summary


def read_metadata(path: str) -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "path": path,
        "name": os.path.basename(path),
        "kind": category_of(path),
        "exists": os.path.isfile(path),
    }
    try:
        stat = os.stat(path)
        info.update(
            {
                "size": stat.st_size,
                "sizeText": human_size(stat.st_size),
                "mtime": stat.st_mtime,
                "mtimeText": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
                "ctime": stat.st_ctime,
            }
        )
    except OSError as err:
        info["error"] = str(err)
        return info

    kind = info["kind"]
    if kind not in {"image"}:
        return info

    try:
        from PIL import Image

        with Image.open(path) as image:
            info["width"], info["height"] = image.size
            info["format"] = image.format or ""
            info["mode"] = image.mode
            image_info = dict(getattr(image, "info", {}) or {})
            exif_text = ""
            try:
                exif = image.getexif()
                if exif:
                    entries = {}
                    for tag, value in exif.items():
                        name = str(tag)
                        try:
                            from PIL.ExifTags import TAGS

                            name = TAGS.get(tag, str(tag))
                        except Exception:
                            pass
                        if isinstance(value, bytes):
                            value = value.decode("utf-8", "replace")[:2000] if value else ""
                        entries[name] = value
                    if entries:
                        info["exif"] = entries
                        exif_text = json.dumps(entries, ensure_ascii=False, default=str)
            except Exception:
                pass
    except Exception as err:
        info["error"] = f"无法解析图片: {err}"
        return info

    fields: List[Dict[str, str]] = []
    workflow_json = image_info.get("workflow")
    prompt_json = image_info.get("prompt")
    parameters = image_info.get("parameters") or image_info.get("Comment") or ""

    if parameters and not isinstance(parameters, str):
        parameters = str(parameters)
    if isinstance(parameters, bytes):
        parameters = parameters.decode("utf-8", "replace")

    comfy_summary = summarize_comfy_prompt(prompt_json) if prompt_json else {}
    if comfy_summary:
        for key, value in comfy_summary.items():
            if isinstance(value, list):
                value = ", ".join(str(item) for item in value)
            fields.append({"label": key, "value": str(value)[:MAX_TEXT]})
        info["comfy"] = comfy_summary

    if parameters:
        fields.append({"label": "生成参数", "value": parameters[:MAX_TEXT]})
        info["parameters"] = parameters
        lowered = parameters.lower()
        if "steps:" in lowered or "sampler:" in lowered:
            info["hasParameters"] = True

    if prompt_json:
        info["hasPrompt"] = True

    if workflow_json:
        workflow = _safe_json(workflow_json)
        if isinstance(workflow, dict):
            info["hasWorkflow"] = True
            info["workflowNodeCount"] = len(workflow.get("nodes") or [])

    if not fields:
        plain = {}
        for key, value in image_info.items():
            if key in {"dpi", "icc_profile", "transparency", "exif", "loop", "duration"}:
                continue
            if isinstance(value, (bytes, bytearray)):
                continue
            if isinstance(value, (str, int, float)) and str(value).strip():
                plain[key] = str(value)[:MAX_TEXT]
        if plain:
            fields.append({"label": "文件内文本", "value": json.dumps(plain, ensure_ascii=False, indent=1)})

    info["fields"] = fields
    return info


def raw_workflow(path: str) -> Optional[Dict[str, Any]]:
    try:
        from PIL import Image

        with Image.open(path) as image:
            raw = (getattr(image, "info", {}) or {}).get("workflow")
        return _safe_json(raw)
    except Exception:
        return None


def raw_workflow_prompt(path: str) -> Dict[str, Any]:
    """返回图片里的 workflow（画布格式）、prompt（API 格式）以及 WebUI 参数。"""
    result: Dict[str, Any] = {"workflow": None, "prompt": None, "parameters": ""}
    try:
        from PIL import Image

        with Image.open(path) as image:
            info = dict(getattr(image, "info", {}) or {})
        result["workflow"] = _safe_json(info.get("workflow"))
        result["prompt"] = _safe_json(info.get("prompt"))
        raw = info.get("parameters") or info.get("Parameters") or ""
        if not raw:
            try:
                from PIL import Image as _Image

                with _Image.open(path) as image:
                    exif = image.getexif()
                    raw = str(exif.get(0x9286) or "") if exif else ""
            except Exception:
                raw = ""
        result["parameters"] = str(raw or "")
    except Exception:
        pass
    return result


_SAMPLER_MAP = {
    "euler a": "euler_ancestral",
    "euler": "euler",
    "lms": "lms",
    "heun": "heun",
    "dpm2": "dpm_2",
    "dpm2 a": "dpm_2_ancestral",
    "dpm++ 2s a": "dpmpp_2s_ancestral",
    "dpm++ 2m": "dpmpp_2m",
    "dpm++ sde": "dpmpp_sde",
    "dpm++ 2m sde": "dpmpp_2m_sde",
    "dpm fast": "dpm_fast",
    "dpm adaptive": "dpm_adaptive",
    "ddim": "ddim",
    "unipc": "uni_pc",
    "lcm": "lcm",
}


def parse_a1111(parameters: str) -> Dict[str, Any]:
    """解析 WebUI 的 parameters 文本。"""
    text = str(parameters or "").replace("\r\n", "\n").strip()
    if not text:
        return {}
    result: Dict[str, Any] = {"positive": "", "negative": "", "raw": text}
    body = text
    if "\nNegative prompt:" in body:
        positive, rest = body.split("\nNegative prompt:", 1)
        result["positive"] = positive.strip()
        body = rest
    elif "Negative prompt:" in body:
        positive, rest = body.split("Negative prompt:", 1)
        result["positive"] = positive.strip()
        body = rest
    else:
        positive, _, rest = body.partition("\nSteps:")
        result["positive"] = positive.strip()
        body = "Steps:" + rest if rest else ""
    if "Steps:" in body:
        negative, _, meta = body.partition("Steps:")
        result["negative"] = negative.strip()
        body = "Steps:" + meta
    else:
        result["negative"] = body.strip()
        body = ""
    for part in body.split(","):
        if ":" not in part:
            continue
        key, value = part.split(":", 1)
        key = key.strip().lower()
        value = value.strip().strip('"')
        if key:
            result[key] = value
    return result


def a1111_to_prompt(parameters: str) -> Optional[Dict[str, Any]]:
    """把 WebUI 参数转换成 ComfyUI 的 API 格式工作流，便于直接载入画布。"""
    parsed = parse_a1111(parameters)
    if not parsed or not (parsed.get("positive") or parsed.get("steps")):
        return None

    def number(key: str, default: float, cast=float):
        try:
            return cast(str(parsed.get(key, default)).strip())
        except (TypeError, ValueError):
            return default

    size = str(parsed.get("size") or "512x512").lower()
    try:
        width, height = [int(part) for part in size.split("x", 1)]
    except Exception:
        width, height = 512, 512
    sampler_raw = str(parsed.get("sampler") or "euler a").strip().lower()
    sampler = _SAMPLER_MAP.get(sampler_raw, "euler")
    model = str(parsed.get("model") or "").strip()
    model_hash = str(parsed.get("model hash") or "").strip()
    if not model:
        model = "model.safetensors"
    seed = number("seed", 0, int)
    if seed < 0:
        seed = 0
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": parsed.get("positive", ""), "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": parsed.get("negative", ""), "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": number("steps", 20, int),
                "cfg": number("cfg scale", 7.0, float),
                "sampler_name": sampler,
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
            },
        },
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": "webui", "images": ["6", 0]}},
        "_meta": {"source": "a1111", "modelHash": model_hash},
    }
