/**
 * 共享 UI 工具：DOM 构建、图标、格式化、请求、toast。
 * 被 iib.js（主窗口）与 iib-panels.js（标签/搜索/统计等面板）共用。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export const PREFIX = "/iib";

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && key !== "list" && typeof value !== "object") {
        try { node[key] = value; } catch { node.setAttribute(key, value); }
      } else {
        node.setAttribute(key, value);
      }
    }
  }
  for (const child of children.flat(4)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, extra = "") {
  return el("i", { class: `mdi mdi-${name} ${extra}`.trim() });
}

export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function fmtTime(seconds) {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtSize(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index === 0 ? `${value} B` : `${value.toFixed(1)} ${units[index]}`;
}

export function toast(kind, summary, description) {
  try {
    const service = app.extensionManager?.toast;
    if (service && typeof service[kind] === "function") {
      service[kind](summary, description ? { description } : undefined);
      return;
    }
  } catch (err) {
    console.warn("[IIB] toast 调用失败", err);
  }
  console.log(`[IIB] ${summary}${description ? ` - ${description}` : ""}`);
}

export async function jfetch(path, options) {
  const response = await api.fetchApi(PREFIX + path, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    throw new Error(data?.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

export function postJSON(path, body) {
  return jfetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

/** 简易三选一弹窗（确认 / 取消），供面板复用。 */
export function confirmDialog(message, { title = "确认操作", danger = true, confirmText = "确定" } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "iib-modal iib-scope" });
    const card = el("div", { class: "iib-modal-card" });
    const close = (value) => { overlay.remove(); resolve(value); };
    card.append(el("div", { class: "iib-modal-title", text: title }));
    card.append(el("div", { class: "iib-modal-msg", text: message }));
    card.append(el("div", { class: "iib-modal-actions" },
      el("button", { class: "iib-btn", onclick: () => close(false) }, "取消"),
      el("button", { class: `iib-btn ${danger ? "danger" : "primary"}`, onclick: () => close(true) }, confirmText),
    ));
    overlay.append(card);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(false); });
    document.body.append(overlay);
  });
}

/** 简易输入弹窗，返回字符串或 null。 */
export function promptDialog(title, { label = "", value = "", placeholder = "" } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "iib-modal iib-scope" });
    const card = el("div", { class: "iib-modal-card" });
    const input = el("input", { class: "iib-input", value, placeholder });
    const close = (result) => { overlay.remove(); resolve(result); };
    card.append(el("div", { class: "iib-modal-title", text: title }));
    if (label) card.append(el("div", { class: "iib-modal-msg", text: label }));
    card.append(input);
    card.append(el("div", { class: "iib-modal-actions" },
      el("button", { class: "iib-btn", onclick: () => close(null) }, "取消"),
      el("button", { class: "iib-btn primary", onclick: () => close(input.value.trim()) }, "确定"),
    ));
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") close(input.value.trim());
      if (event.key === "Escape") close(null);
    });
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(null); });
    document.body.append(overlay);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
