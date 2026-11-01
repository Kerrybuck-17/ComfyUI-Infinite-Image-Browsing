/**
 * Infinite Image Browsing for ComfyUI —— 前端扩展
 *
 * 行为：
 *  - 接管左侧边栏「资产」按钮：不再展开原生资产侧栏，而是打开一个与「模板」按钮
 *    同款的大窗口（模态、圆角、带遮罩），窗口内的界面全部使用 ComfyUI 原生 UI 体系。
 *  - 所有设置项注册到 ComfyUI 设置面板的「无限图像浏览」分组下。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PREFIX = "/iib";
const EXT_NAME = "ComfyUI.InfiniteImageBrowsing";
const CSS_URL = new URL("./iib.css", import.meta.url).href;

const SORT_OPTIONS = [
  { label: "修改时间 ↓", value: "mtime_desc" },
  { label: "修改时间 ↑", value: "mtime_asc" },
  { label: "名称 A→Z", value: "name_asc" },
  { label: "名称 Z→A", value: "name_desc" },
  { label: "大小 ↓", value: "size_desc" },
];

const KIND_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "图片", value: "image" },
  { label: "视频", value: "video" },
];

const MODES = [
  { id: "browse", label: "浏览", icon: "image-multiple-outline" },
  { id: "search", label: "搜索", icon: "database-search-outline" },
  { id: "stats", label: "统计", icon: "chart-bar" },
  { id: "organize", label: "整理", icon: "folder-move-outline" },
];

/* ------------------------------------------------------------------ 基础工具 */

function el(tag, props, ...children) {
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

function icon(name, extra = "") {
  return el("i", { class: `mdi mdi-${name} ${extra}`.trim() });
}

function debounce(fn, wait) {
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

function fmtTime(seconds) {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtSize(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index === 0 ? `${value} B` : `${value.toFixed(1)} ${units[index]}`;
}

function toast(kind, summary, description) {
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

async function jfetch(path, options) {
  const response = await api.fetchApi(PREFIX + path, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    throw new Error(data?.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

function postJSON(path, body) {
  return jfetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

function injectCSS() {
  if (document.getElementById("iib-style")) return;
  const link = document.createElement("link");
  link.id = "iib-style";
  link.rel = "stylesheet";
  link.href = CSS_URL;
  document.head.append(link);
}

/* ------------------------------------------------------------------ 设置项 */

const SETTING_DEFS = [
  {
    id: "IIB.IncludeInput", key: "includeInput", type: "boolean", defaultValue: true,
    category: ["无限图像浏览", "目录", "显示输入目录"], name: "显示输入目录（input）",
    tooltip: "在左侧目录树中显示 ComfyUI 的 input 目录。",
  },
  {
    id: "IIB.IncludeTemp", key: "includeTemp", type: "boolean", defaultValue: false,
    category: ["无限图像浏览", "目录", "显示临时目录"], name: "显示临时目录（temp）",
    tooltip: "在左侧目录树中显示 ComfyUI 的 temp 目录（通常存放预览图）。",
  },
  {
    id: "IIB.ExtraDirs", key: "extraDirs", type: "text", defaultValue: "",
    category: ["无限图像浏览", "目录", "附加目录"], name: "附加目录",
    tooltip: "多个目录用英文分号 ; 分隔，可以用「名称::路径」指定显示名。例如：我的图库::D:\\pics;E:\\ai\\out",
  },
  {
    id: "IIB.GridSize", key: "gridSize", type: "slider", defaultValue: 180,
    attrs: { min: 96, max: 512, step: 8 },
    category: ["无限图像浏览", "外观", "网格尺寸"], name: "网格单元尺寸（px）",
    tooltip: "图像列表中每个格子的目标宽度。",
  },
  {
    id: "IIB.ThumbSize", key: "thumbSize", type: "slider", defaultValue: 256,
    attrs: { min: 64, max: 512, step: 32 },
    category: ["无限图像浏览", "外观", "缩略图分辨率"], name: "缩略图分辨率（px）",
    tooltip: "缩略图长边像素。数值越大越清晰，也越占磁盘缓存。",
  },
  {
    id: "IIB.ShowVideos", key: "showVideos", type: "boolean", defaultValue: true,
    category: ["无限图像浏览", "外观", "显示视频"], name: "在列表中显示视频",
    tooltip: "关闭后列表只显示图片。",
  },
  {
    id: "IIB.PageSize", key: "pageSize", type: "slider", defaultValue: 120,
    attrs: { min: 24, max: 500, step: 4 },
    category: ["无限图像浏览", "行为", "每页数量"], name: "每次加载数量",
    tooltip: "滚动到底部时按这个数量继续加载。",
  },
  {
    id: "IIB.Sort", key: "sort", type: "combo", defaultValue: "修改时间 ↓",
    options: SORT_OPTIONS.map((item) => item.label),
    category: ["无限图像浏览", "行为", "默认排序"], name: "默认排序方式",
    tooltip: "打开窗口时使用的排序方式。",
  },
  {
    id: "IIB.RememberLastPath", key: "rememberLastPath", type: "boolean", defaultValue: true,
    category: ["无限图像浏览", "行为", "记住上次位置"], name: "记住上次浏览的目录",
    tooltip: "重新打开窗口时回到上次浏览的位置。",
  },
  {
    id: "IIB.EnableFileOps", key: "enableFileOps", type: "boolean", defaultValue: true,
    category: ["无限图像浏览", "行为", "允许文件操作"], name: "允许删除 / 重命名 / 移动",
    tooltip: "关闭后窗口只读，避免误操作。",
  },
  {
    id: "IIB.ScanDepth", key: "scanDepth", type: "slider", defaultValue: 4,
    attrs: { min: 1, max: 10, step: 1 },
    category: ["无限图像浏览", "性能", "搜索深度"], name: "搜索时的递归深度",
    tooltip: "按关键词搜索时最多向下遍历几层子目录。",
  },
  {
    id: "IIB.AutoIndex", key: "autoIndex", type: "boolean", defaultValue: false,
    category: ["无限图像浏览", "性能", "启动时自动索引"], name: "启动时自动建立索引",
    tooltip: "ComfyUI 启动后自动做一次增量扫描；大目录会占用一些磁盘 IO。",
  },
  {
    id: "IIB.AutoRefresh", key: "autoRefresh", type: "slider", defaultValue: 0,
    attrs: { min: 0, max: 300, step: 10 },
    category: ["无限图像浏览", "行为", "自动刷新间隔（秒，0 = 关闭）"], name: "自动刷新间隔",
    tooltip: "窗口打开期间每隔多少秒自动刷新当前目录，适合边生成边看。",
  },
  {
    id: "IIB.AutoHidePath", key: "autoHidePath", type: "boolean", defaultValue: true,
    category: ["无限图像浏览", "行为", "目录展开时隐藏路径栏"], name: "目录面板展开时隐藏路径栏",
    tooltip: "左侧目录树展开时自动隐藏地址栏（面包屑），把空间让给缩略图；关闭后地址栏始终显示。",
  },
  {
    id: "IIB.UseThumbnails", key: "useThumbnails", type: "boolean", defaultValue: true,
    category: ["无限图像浏览", "外观", "使用缩略图预览"], name: "使用缩略图预览",
    tooltip: "开启时网格使用服务端生成的缩略图（省内存、加载快）；关闭后直接显示原图。与「图像原比例显示」互斥，开启本项会自动关闭它。",
    onChange: (value) => { if (value) setSettingValueSafe("IIB.OriginalRatio", false); },
  },
  {
    id: "IIB.OriginalRatio", key: "originalRatio", type: "boolean", defaultValue: false,
    category: ["无限图像浏览", "外观", "图像原比例显示"], name: "图像原比例显示",
    tooltip: "开启后图片按原比例完整显示在单元格里（留黑边），关闭时裁剪填充整个单元格。与「使用缩略图预览」互斥，开启本项会自动关闭它。",
    onChange: (value) => { if (value) setSettingValueSafe("IIB.UseThumbnails", false); },
  },
  {
    id: "IIB.SavePrefix", key: "savePrefix", type: "text",
    defaultValue: "%year%-%month%-%day%/ComfyUI",
    category: ["无限图像浏览", "行为", "保存文件名前缀"], name: "保存图像节点的文件名前缀",
    tooltip: "载入工作流或修改本项时，会把所有 SaveImage 节点的 filename_prefix 设为该值；支持 ComfyUI 原生的 %year%/%month%/%day% 等占位符。",
    onChange: () => { applySavePrefix(); },
  },
  {
    id: "IIB.SearchMetadata", key: "searchMetadata", type: "boolean", defaultValue: false,
    category: ["无限图像浏览", "性能", "搜索包含元数据"], name: "搜索时匹配生成信息",
    tooltip: "开启后关键词也会匹配提示词 / 参数等元数据，速度会明显变慢。",
  },
];

const settingHandles = {};

function setSettingValueSafe(id, value) {
  try {
    app.ui?.settings?.setSettingValue?.(id, value);
  } catch (err) {
    console.warn("[IIB] 设置联动失败", id, err);
  }
}

/** 把当前设置里的保存文件名前缀写到所有带 filename_prefix 的节点（SaveImage 等）。 */
function applySavePrefix() {
  let prefix = "";
  try {
    prefix = String(app.ui?.settings?.getSettingValue?.("IIB.SavePrefix") ?? "").trim();
  } catch { prefix = ""; }
  if (!prefix) return 0;
  const nodes = app.graph?._nodes || [];
  let changed = 0;
  for (const node of nodes) {
    const widget = (node?.widgets || []).find((item) => item?.name === "filename_prefix");
    if (!widget || widget.value === prefix) continue;
    widget.value = prefix;
    try { widget.callback?.(prefix, app.canvas, node, [0, 0], null); } catch { /* ignore */ }
    try { node.setDirtyCanvas?.(true, true); } catch { /* ignore */ }
    changed += 1;
  }
  if (changed) {
    try { app.graph?.setDirtyCanvas?.(true, true); } catch { /* ignore */ }
  }
  return changed;
}

function registerSettings() {
  const settings = app.ui?.settings;
  if (!settings || typeof settings.addSetting !== "function") {
    console.warn("[IIB] 当前前端没有设置面板 API，跳过设置注册");
    return;
  }
  for (const def of SETTING_DEFS) {
    if (settingHandles[def.id]) continue;
    try {
      const payload = {
        id: def.id,
        name: def.name,
        type: def.type,
        defaultValue: def.defaultValue,
        category: def.category,
        tooltip: def.tooltip,
        onChange: (value) => {
          try { def.onChange?.(value); } catch (err) { console.warn("[IIB] 设置回调失败", def.id, err); }
          scheduleSyncSettings();
        },
      };
      if (def.attrs) payload.attrs = def.attrs;
      if (def.options) payload.options = def.options;
      settingHandles[def.id] = settings.addSetting(payload);
    } catch (err) {
      console.warn("[IIB] 注册设置项失败:", def.id, err);
    }
  }
}

function readSettingValue(def) {
  const handle = settingHandles[def.id];
  if (handle && handle.value !== undefined && handle.value !== null) return handle.value;
  try {
    const value = app.ui?.settings?.getSettingValue?.(def.id);
    if (value !== undefined && value !== null) return value;
  } catch { /* ignore */ }
  return def.defaultValue;
}

function collectSettings() {
  const out = {};
  for (const def of SETTING_DEFS) {
    let value = readSettingValue(def);
    if (def.key === "sort") {
      const matched = SORT_OPTIONS.find((item) => item.label === value);
      value = matched ? matched.value : String(value || "mtime_desc");
    }
    out[def.key] = value;
  }
  return out;
}

let syncTimer = null;
function scheduleSyncSettings() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncSettings().catch(() => {}); }, 220);
}

async function syncSettings() {
  const settings = collectSettings();
  try {
    const data = await postJSON("/settings", { settings });
    if (dialog && data?.roots) dialog.applyConfig(data);
  } catch (err) {
    console.warn("[IIB] 同步设置到后端失败", err);
  }
}

/* ------------------------------------------------------------------ 确认 / 输入弹窗 */

function modalShell(title, bodyBuilder, { confirmText = "确定", cancelText = "取消", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "iib-modal iib-scope" });
    const card = el("div", { class: "iib-modal-card" });
    const close = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(null); }
      if (event.key === "Enter" && event.target?.tagName === "INPUT") { event.preventDefault(); confirm(); }
    };
    const confirm = () => {
      const value = bodyBuilder.collect ? bodyBuilder.collect() : true;
      close(value);
    };
    card.append(el("div", { class: "iib-modal-title", text: title }));
    card.append(bodyBuilder.node);
    const actions = el("div", { class: "iib-modal-actions" },
      el("button", { class: "iib-btn", onclick: () => close(null) }, cancelText),
      el("button", {
        class: `iib-btn ${danger ? "danger" : "primary"}`,
        onclick: confirm,
      }, confirmText),
    );
    card.append(actions);
    overlay.append(card);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(null); });
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    bodyBuilder.focus?.();
  });
}

function iibConfirm(message, { title = "确认操作", danger = true, confirmText = "确定" } = {}) {
  const node = el("div", { class: "iib-modal-msg", text: message });
  return modalShell(title, { node }, { danger, confirmText }).then((value) => value === true);
}

function iibPrompt(title, { label = "", value = "", placeholder = "" } = {}) {
  const input = el("input", { class: "iib-input", value, placeholder });
  const node = el("div", {},
    label ? el("div", { class: "iib-modal-msg", text: label }) : null,
    input,
  );
  const builder = { node, collect: () => input.value.trim(), focus: () => { input.focus(); input.select(); } };
  return modalShell(title, builder, { confirmText: "确定", danger: false });
}

/* ------------------------------------------------------------------ 主窗口 */

class IIBDialog {
  constructor() {
    this.config = null;
    this.roots = [];
    this.rootId = null;
    this.rel = "";
    this.items = [];
    this.dirs = [];
    this.total = 0;
    this.page = 1;
    this.pageSize = 120;
    this.sort = "mtime_desc";
    this.kind = "all";
    this.query = "";
    this.selected = new Set();
    this.selectedItems = new Map();
    this.lastClicked = null;
    this.loading = false;
    this.requestToken = 0;
    this.history = [];
    this.historyIndex = -1;
    this.treeCache = new Map();
    this.activeNode = null;
    this.dragPaths = [];
    this.previewInfo = null;
    this.previewToken = 0;
    this.autoRefreshTimer = null;
    this.mode = "browse";
    this.tagFilter = [];
    this.walkMode = false;
    this.randomMode = false;
    this.onlyFavorites = false;
    this.useThumbnails = true;
    this.tabs = [];
    this.activeTabId = null;
    this.tabSeq = 0;
    this.compareImages = { a: null, b: null };
    this.indexStatus = null;
    this.indexTimer = null;
    this.built = false;
    this.build();
    this.bindGlobalKeys();
  }

  /* ------------------------------------------------------------ 构建 DOM */

  build() {
    if (this.built) return;
    this.built = true;

    this.treeBody = el("div", { class: "iib-tree-body iib-scroll" });
    this.treeEl = el("aside", { class: "iib-tree" },
      el("div", { class: "iib-tree-head" },
        icon("folder-multiple"),
        el("span", { text: "目录" }),
        el("span", { class: "iib-header-spacer" }),
        el("button", {
          class: "iib-btn icon ghost", title: "添加图库目录",
          onclick: () => this.addRootFolder(),
        }, icon("folder-plus-outline")),
      ),
      this.treeBody,
    );

    this.pathEl = el("div", { class: "iib-path" });
    this.searchInput = el("input", {
      class: "iib-input",
      type: "search",
      placeholder: "搜索文件名…",
      onkeydown: (event) => {
        event.stopPropagation();
        if (event.key === "Enter") this.reload({ reset: true });
        if (event.key === "Escape") { this.searchInput.value = ""; this.query = ""; this.reload({ reset: true }); }
      },
    });
    this.searchInput.addEventListener("input", debounce(() => {
      const value = this.searchInput.value.trim();
      if (value === this.query) return;
      this.query = value;
      this.reload({ reset: true });
    }, 320));

    this.sortSelect = el("select", {
      class: "iib-select",
      title: "排序方式",
      onchange: () => {
        this.sort = this.sortSelect.value;
        this.reload({ reset: true });
      },
    }, SORT_OPTIONS.map((item) => el("option", { value: item.value, text: item.label })));

    this.kindSelect = el("select", {
      class: "iib-select",
      title: "文件类型",
      onchange: () => {
        this.kind = this.kindSelect.value;
        this.reload({ reset: true });
      },
    }, KIND_OPTIONS.map((item) => el("option", { value: item.value, text: item.label })));

    this.backBtn = el("button", { class: "iib-btn icon", title: "后退", disabled: true, onclick: () => this.goBack() }, icon("arrow-left"));
    this.forwardBtn = el("button", { class: "iib-btn icon", title: "前进", disabled: true, onclick: () => this.goForward() }, icon("arrow-right"));
    this.upBtn = el("button", { class: "iib-btn icon", title: "上一级", onclick: () => this.goUp() }, icon("arrow-up"));

    this.sizeRange = el("input", {
      class: "iib-range", type: "range", min: "96", max: "512", step: "8", value: "180",
      title: "网格尺寸",
      oninput: () => {
        this.windowEl?.style.setProperty("--iib-cell", `${this.sizeRange.value}px`);
      },
    });

    this.walkBtn = el("button", {
      class: "iib-btn icon", title: "显示子文件夹内容（递归列出当前目录下所有文件）",
      onclick: () => this.toggleWalk(),
    }, icon("folder-multiple-outline"));

    this.randomBtn = el("button", {
      class: "iib-btn icon", title: "随机看看", onclick: () => this.randomBrowse(),
    }, icon("dice-multiple-outline"));

    this.treeBtn = el("button", {
      class: "iib-btn icon", title: "收起 / 展开目录面板", onclick: () => this.toggleTree(),
    }, icon("view-column-outline"));

    this.favBtn = el("button", {
      class: "iib-btn icon", title: "只看收藏", onclick: () => this.toggleFavorites(),
    }, icon("heart-outline"));

    this.previewBtn = el("button", {
      class: "iib-btn icon", title: "收起 / 展开预览面板", onclick: () => this.togglePreview(),
    }, icon("dock-right"));

    const toolbarLeft = el("div", { class: "iib-toolbar-left" },
      this.treeBtn,
      this.backBtn, this.forwardBtn, this.upBtn,
      this.pathEl,
      el("div", { class: "iib-search" }, icon("magnify"), this.searchInput),
    );
    const toolbarRight = el("div", { class: "iib-toolbar-right" },
      this.sortSelect,
      this.kindSelect,
      el("div", { class: "iib-divider" }),
      this.walkBtn,
      this.randomBtn,
      this.favBtn,
      this.sizeRange,
      this.previewBtn,
    );
    const toolbar = el("div", { class: "iib-toolbar" }, toolbarLeft, toolbarRight);
    this.filterBar = el("div", { class: "iib-filterbar iib-hidden" });

    this.gridEl = el("div", { class: "iib-grid" });
    this.emptyEl = el("div", { class: "iib-empty iib-hidden" });
    this.loadingEl = el("div", { class: "iib-loading iib-hidden" }, el("div", { class: "iib-spinner" }));
    this.gridWrap = el("div", { class: "iib-grid-wrap iib-scroll" }, this.gridEl, this.emptyEl, this.loadingEl);
    this.gridWrap.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.gridWrap.addEventListener("contextmenu", (event) => {
      if (event.target !== this.gridWrap && event.target !== this.gridEl) return;
      event.preventDefault();
      event.stopPropagation();
      this.showBlankMenu(event);
    });

    this.footerEl = el("div", { class: "iib-footer" });

    const main = el("div", { class: "iib-main" }, toolbar, this.filterBar, this.gridWrap, this.footerEl);

    this.previewStage = el("div", { class: "iib-preview-stage" });
    this.previewBody = el("div", { class: "iib-preview-body iib-scroll" });
    this.previewEl = el("aside", { class: "iib-preview" }, this.previewStage, this.previewBody);

    this.subtitleEl = el("div", { class: "iib-subtitle" });
    this.indexChip = el("button", {
      class: "iib-chip", title: "索引状态（点击进入索引面板）",
      onclick: () => this.setMode("index"),
    }, icon("database-check-outline"), el("span", { text: "索引" }));

    const header = el("div", { class: "iib-header" },
      el("div", { class: "iib-title" }, icon("image-multiple-outline"), el("span", { text: "无限图像浏览" })),
      this.subtitleEl,
      el("div", { class: "iib-header-spacer" }),
      this.indexChip,
      el("button", {
        class: "iib-btn icon ghost", title: "竖屏流（抖音式浏览）", onclick: () => this.setMode("feed"),
      }, icon("cellphone-screenshot")),
      el("button", {
        class: "iib-btn icon ghost", title: "清理缩略图缓存", onclick: () => this.clearThumbCache(),
      }, icon("broom")),
      el("button", {
        class: "iib-btn icon ghost", title: "刷新目录", onclick: () => this.refreshAll(),
      }, icon("refresh")),
      el("button", {
        class: "iib-btn icon ghost", title: "打开本插件设置", onclick: () => this.openSettingsAtPlugin(),
      }, icon("cog-outline")),
      el("button", {
        class: "iib-btn icon ghost", title: "关闭 (Esc)", onclick: () => this.close(),
      }, icon("close")),
    );

    this.treeResizer = el("div", { class: "iib-resizer iib-resizer-left", title: "拖动调整目录面板宽度（双击重置）" });
    this.previewResizer = el("div", { class: "iib-resizer iib-resizer-right", title: "拖动调整预览面板宽度（双击重置）" });

    this.browseEl = el("div", { class: "iib-browse" },
      this.treeEl, this.treeResizer, main, this.previewResizer, this.previewEl);
    this.panelHost = el("div", { class: "iib-panel-host iib-hidden" });
    this.contentEl = el("div", { class: "iib-content" }, this.browseEl, this.panelHost);
    this.modeRail = this.buildModeRail();
    this.tabBar = el("div", { class: "iib-tabbar" });

    this.windowEl = el("div", { class: "iib-window notranslate lite-search-item-type" }, header, this.tabBar,
      el("div", { class: "iib-body" }, this.modeRail, this.contentEl));
    this.windowEl.setAttribute("translate", "no");
    this.overlay = el("div", { class: "iib-overlay iib-scope", style: { display: "none" } }, this.windowEl);
    this.windowEl.addEventListener("keydown", (event) => event.stopPropagation());
    this.windowEl.addEventListener("keyup", (event) => event.stopPropagation());
    this.windowEl.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    this.windowEl.addEventListener("contextmenu", (event) => event.preventDefault());
    this.overlay.addEventListener("mousedown", (event) => {
      if (event.target === this.overlay) this.close();
    });
    try {
      if (localStorage.getItem("iib.ui.tree") === "1") {
        this.treeEl.classList.add("iib-collapsed");
        this.treeBtn?.classList.add("active");
        this.treeResizer.classList.add("iib-hidden");
      }
      if (localStorage.getItem("iib.ui.preview") === "1") {
        this.previewEl.classList.add("iib-collapsed");
        this.previewBtn?.classList.add("active");
        this.previewResizer.classList.add("iib-hidden");
      }
      const treeWidth = Number(localStorage.getItem("iib.ui.treeWidth") || 0);
      if (treeWidth >= 150) {
        this.treeEl.style.width = `${treeWidth}px`;
        this.treeEl.style.flex = "0 0 auto";
      }
      const previewWidth = Number(localStorage.getItem("iib.ui.previewWidth") || 0);
      if (previewWidth >= 200) {
        this.previewEl.style.width = `${previewWidth}px`;
        this.previewEl.style.flex = "0 0 auto";
      }
    } catch { /* ignore */ }
    this.makeResizable(this.treeResizer, this.treeEl, "left", "iib.ui.treeWidth", 150, 620);
    this.makeResizable(this.previewResizer, this.previewEl, "right", "iib.ui.previewWidth", 200, 820);
    this.updatePathVisibility();
    this.renderPreviewPlaceholder();
  }

  renderPreviewPlaceholder() {
    this.previewStage.replaceChildren(
      el("div", { class: "iib-empty", style: { color: "var(--iib-muted)", fontSize: "12px" } },
        icon("image-search-outline"), el("div", { text: "选中文件后在这里预览" })),
    );
    this.previewBody.replaceChildren();
  }

  /* ------------------------------------------------------------ 标签页 */

  activeTab() {
    return this.tabs.find((tab) => tab.id === this.activeTabId) || null;
  }

  createTab(rootId, rel = "") {
    const tab = { id: `tab-${++this.tabSeq}`, rootId, rel, history: [], historyIndex: -1 };
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    this.renderTabs();
    return tab;
  }

  tabTitle(tab) {
    const root = this.roots.find((item) => item.id === tab.rootId);
    const parts = (tab.rel || "").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : (root?.label || "浏览");
  }

  renderTabs() {
    if (!this.tabBar) return;
    const nodes = this.tabs.map((tab) => el("div", {
      class: `iib-tab ${tab.id === this.activeTabId ? "active" : ""}`,
      title: `${this.roots.find((root) => root.id === tab.rootId)?.label || ""}${tab.rel ? ` / ${tab.rel}` : ""}`,
      onclick: () => this.switchTab(tab.id),
    },
      icon("folder-outline"),
      el("span", { class: "iib-tab-title", text: this.tabTitle(tab) }),
      this.tabs.length > 1
        ? el("button", {
          class: "iib-tab-close", title: "关闭标签",
          onclick: (event) => { event.stopPropagation(); this.closeTab(tab.id); },
        }, "×")
        : null,
    ));
    nodes.push(el("button", { class: "iib-tab-add", title: "新建标签页", onclick: () => this.addTab() }, icon("plus")));
    this.tabBar.replaceChildren(...nodes);
  }

  saveActiveTabState() {
    const tab = this.activeTab();
    if (!tab) return;
    tab.rootId = this.rootId;
    tab.rel = this.rel;
    tab.history = this.history.slice();
    tab.historyIndex = this.historyIndex;
  }

  async switchTab(id) {
    if (id === this.activeTabId) return;
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) return;
    this.saveActiveTabState();
    this.activeTabId = id;
    this.rootId = tab.rootId;
    this.rel = tab.rel || "";
    this.history = tab.history?.length ? tab.history.slice() : [{ rootId: tab.rootId, rel: tab.rel || "" }];
    this.historyIndex = tab.historyIndex ?? this.history.length - 1;
    this.query = "";
    this.searchInput.value = "";
    this.tagFilter = [];
    this.onlyFavorites = false;
    this.randomMode = false;
    this.favBtn?.classList.remove("active");
    this.renderFilterBar();
    this.renderTabs();
    this.renderPath();
    this.highlightTree();
    this.updateHistoryButtons();
    await this.reload({ reset: true });
  }

  closeTab(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    if (!this.tabs.length) {
      this.createTab(this.roots[0]?.id || "", "");
      this.switchTab(this.activeTabId);
      return;
    }
    if (this.activeTabId === id) {
      const next = this.tabs[Math.max(0, index - 1)];
      this.activeTabId = null;
      this.switchTab(next.id);
    } else {
      this.renderTabs();
    }
  }

  async addTab() {
    this.saveActiveTabState();
    const tab = this.createTab(this.rootId || this.roots[0]?.id || "", "");
    this.activeTabId = null;
    await this.switchTab(tab.id);
  }

  /* ------------------------------------------------------------ 面板折叠 */

  toggleTree() {
    const collapsed = this.treeEl.classList.toggle("iib-collapsed");
    this.treeBtn?.classList.toggle("active", collapsed);
    this.treeResizer?.classList.toggle("iib-hidden", collapsed);
    this.updatePathVisibility();
    try { localStorage.setItem("iib.ui.tree", collapsed ? "1" : "0"); } catch { /* ignore */ }
  }

  makeResizable(handle, target, side, storageKey, min, max) {
    if (!handle || !target) return;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      let width = side === "left" ? startWidth + dx : startWidth - dx;
      width = Math.max(min, Math.min(max, width));
      target.style.width = `${Math.round(width)}px`;
      target.style.flex = "0 0 auto";
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("active");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem(storageKey, String(Math.round(target.getBoundingClientRect().width)));
      } catch { /* ignore */ }
    };

    handle.addEventListener("pointerdown", (event) => {
      if (target.classList.contains("iib-collapsed")) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = target.getBoundingClientRect().width;
      handle.classList.add("active");
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
    handle.addEventListener("dblclick", () => {
      target.style.width = "";
      target.style.flex = "";
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    });
  }

  updatePathVisibility() {
    if (!this.pathEl || !this.treeEl) return;
    const autoHide = this.config?.settings?.autoHidePath !== false;
    const treeOpen = !this.treeEl.classList.contains("iib-collapsed");
    this.pathEl.classList.toggle("iib-hidden", autoHide && treeOpen);
  }

  togglePreview() {
    const collapsed = this.previewEl.classList.toggle("iib-collapsed");
    this.previewBtn?.classList.toggle("active", collapsed);
    this.previewResizer?.classList.toggle("iib-hidden", collapsed);
    try { localStorage.setItem("iib.ui.preview", collapsed ? "1" : "0"); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------ 收藏 */

  async toggleFavorite(item, event) {
    event?.stopPropagation?.();
    if (!item?.abs) return;
    try {
      const data = await postJSON("/favorites/toggle", { path: item.abs });
      item.favorited = !!data.favorited;
      this.selectedItems.set(item.abs, item);
      for (const card of this.gridEl.querySelectorAll(".iib-card")) {
        if (card.dataset.abs === item.abs) card.classList.toggle("favorited", item.favorited);
      }
      if (this.previewInfo?.path === item.abs) this.showPreview(item);
      toast("success", item.favorited ? "已收藏" : "已取消收藏");
      if (this.onlyFavorites) await this.reload({ reset: true });
    } catch (err) {
      toast("error", "收藏失败", String(err?.message || err));
    }
  }

  async toggleFavorites() {
    this.onlyFavorites = !this.onlyFavorites;
    this.favBtn?.classList.toggle("active", this.onlyFavorites);
    this.renderFilterBar();
    await this.reload({ reset: true });
  }

  /* ------------------------------------------------------------ 添加图库目录 */

  async addRootFolder() {
    const input = await iibPrompt("添加图库目录", {
      label: "输入路径，可写 名称::路径，多个用分号分隔",
      placeholder: "我的图库::D:\\pics",
    });
    if (!input) return;
    const current = String(
      app.ui?.settings?.getSettingValue?.("IIB.ExtraDirs")
      ?? this.config?.settings?.extraDirs
      ?? "",
    );
    const next = current ? `${current};${input}` : input;
    try {
      app.ui?.settings?.setSettingValue?.("IIB.ExtraDirs", next);
      await syncSettings();
      await this.loadConfig();
      const rawPath = input.includes("::") ? input.split("::").pop().trim() : input.trim();
      const root = this.roots.find((item) => item.path.toLowerCase() === rawPath.toLowerCase());
      if (root) {
        await postJSON("/index/scan", { roots: [root.id] });
        toast("success", "目录已添加，正在索引", root.path);
      } else {
        toast("warning", "已加入设置，但目录不存在或不可访问", rawPath);
      }
    } catch (err) {
      toast("error", "添加目录失败", String(err?.message || err));
    }
  }

  /* ------------------------------------------------------------ 设置跳转 */

  async openSettingsAtPlugin() {
    this.close();
    document.querySelectorAll(".iib-modal.iib-scope, .iib-compare-drop").forEach((node) => node.remove());
    try {
      await app.extensionManager?.command?.execute?.("Comfy.ShowSettingsDialog");
    } catch (err) {
      console.warn("[IIB] 打开设置失败", err);
    }
    const clickGroup = (attempt = 0) => {
      const span = [...document.querySelectorAll("span")].find(
        (node) => node.textContent.trim() === "无限图像浏览" && node.closest("nav"),
      );
      if (span) {
        const row = span.closest('div[class*="cursor-pointer"]') || span.parentElement;
        row.scrollIntoView({ block: "center" });
        row.click();
        return;
      }
      if (attempt < 25) setTimeout(() => clickGroup(attempt + 1), 200);
    };
    setTimeout(() => clickGroup(), 300);
  }

  /* ------------------------------------------------------------ 拖动对比 */

  buildCompareDrop() {
    const slot = (key, label) => {
      const node = el("div", { class: "iib-compare-slot", dataset: { slot: key } },
        icon("image-plus"), el("span", { text: label }));
      node.addEventListener("dragover", (event) => {
        event.preventDefault();
        node.classList.add("over");
      });
      node.addEventListener("dragleave", () => node.classList.remove("over"));
      node.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        node.classList.remove("over");
        this.handleCompareDrop(key, event);
      });
      return node;
    };

    const panel = el("div", { class: "iib-compare-drop iib-hidden" },
      el("div", { class: "iib-compare-drop-head" },
        icon("compare-horizontal"),
        el("span", { text: "拖到这里对比" }),
        el("span", { class: "iib-header-spacer" }),
        el("button", {
          class: "iib-btn icon ghost", title: "关闭对比窗",
          onclick: () => {
            this.resetCompareSlots();
            this.compareDrop?.classList.add("iib-hidden");
          },
        }, icon("close")),
      ),
      el("div", { class: "iib-compare-slots" }, slot("a", "拖入 A"), slot("b", "拖入 B")),
      el("div", { class: "iib-panel-sub", text: "依次拖入两张图；放入第一张后窗口会保留，放满第二张自动打开对比" }),
    );
    document.body.append(panel);
    this.compareDrop = panel;
  }

  resetCompareSlots() {
    this.compareImages = { a: null, b: null };
    this.compareDrop?.querySelectorAll(".iib-compare-slot").forEach((slot) => {
      slot.classList.remove("over", "filled");
      slot.replaceChildren(icon("image-plus"), el("span", { text: slot.dataset.slot === "a" ? "拖入 A" : "拖入 B" }));
    });
  }

  beginCompareDrag() {
    if (!this.compareDrop) this.buildCompareDrop();
    this.compareDrop.classList.remove("iib-hidden");
  }

  endCompareDrag() {
    if (this.compareImages.a || this.compareImages.b) return;
    setTimeout(() => {
      if (!this.compareImages.a && !this.compareImages.b) this.compareDrop?.classList.add("iib-hidden");
    }, 260);
  }

  async handleCompareDrop(key, event) {
    const text = event.dataTransfer?.getData("text/plain") || "";
    const path = text.split("\n")[0].trim();
    if (!path) return;
    let item = this.items.find((entry) => entry.abs === path)
      || [...this.selectedItems.values()].find((entry) => entry.abs === path)
      || null;
    if (!item) {
      item = {
        abs: path,
        name: path.split(/[\\/]/).pop(),
        url: `/iib/file?path=${encodeURIComponent(path)}`,
        thumb: `/iib/thumb?path=${encodeURIComponent(path)}&size=220&v=0`,
        kind: /\.(mp4|webm|mov|mkv)$/i.test(path) ? "video" : "image",
      };
    }
    this.compareImages[key] = item;
    const slot = this.compareDrop?.querySelector(`.iib-compare-slot[data-slot="${key}"]`);
    if (slot) {
      slot.classList.add("filled");
      slot.replaceChildren(el("img", { src: item.thumb, alt: item.name }), el("span", { text: item.name }));
    }
    this.compareDrop?.classList.remove("iib-hidden");
    if (this.compareImages.a && this.compareImages.b) {
      const a = this.compareImages.a;
      const b = this.compareImages.b;
      this.resetCompareSlots();
      this.compareDrop?.classList.add("iib-hidden");
      const panels = await loadPanels();
      panels.openCompareOverlay(this, a, b);
    }
  }

  /* ------------------------------------------------------------ 模式切换 */

  buildModeRail() {
    const rail = el("nav", { class: "iib-modes" });
    for (const mode of MODES) {
      rail.append(el("button", {
        class: `iib-mode-btn ${mode.id === "browse" ? "active" : ""}`,
        dataset: { mode: mode.id },
        title: mode.label,
        onclick: () => this.setMode(mode.id),
      }, icon(mode.icon), el("span", { text: mode.label })));
    }
    return rail;
  }

  async setMode(mode, { skipReload = false } = {}) {
    const changed = this.mode !== mode;
    this.mode = mode;
    for (const button of this.modeRail.querySelectorAll(".iib-mode-btn")) {
      button.classList.toggle("active", button.dataset.mode === mode);
    }
    const browse = mode === "browse";
    this.browseEl.classList.toggle("iib-hidden", !browse);
    this.panelHost.classList.toggle("iib-hidden", browse);
    if (browse) {
      if (!skipReload && changed) await this.reload({ reset: true });
      return;
    }
    try {
      const panels = await loadPanels();
      this.panelHost.dispatchEvent(new CustomEvent("iib-dispose"));
      this.panelHost.replaceChildren();
      panels.renderPanel(this, mode, this.panelHost);
    } catch (err) {
      console.error("[IIB] 面板加载失败", err);
      this.panelHost.replaceChildren(el("div", { class: "iib-empty" }, icon("alert-circle-outline"), el("div", { text: `面板加载失败：${err.message || err}` })));
    }
  }

  /* ------------------------------------------------------------ 过滤 / 扁平 / 随机 */

  renderFilterBar() {
    const chips = [];
    if (this.onlyFavorites) {
      chips.push(el("div", { class: "iib-filter-chip" },
        icon("heart"),
        el("span", { text: "只看收藏" }),
        el("button", { class: "iib-chip-x", title: "取消收藏过滤", onclick: () => this.toggleFavorites() }, "×"),
      ));
    }
    if (this.tagFilter.length) {
      chips.push(el("div", { class: "iib-filter-chip" },
        icon("tag-outline"),
        el("span", { text: `标签：${this.tagFilter.join(" / ")}` }),
        el("button", { class: "iib-chip-x", title: "清除标签过滤", onclick: () => this.clearTagFilter() }, "×"),
      ));
    }
    if (this.walkMode) {
      chips.push(el("div", { class: "iib-filter-chip" },
        icon("folder-multiple-outline"),
        el("span", { text: "显示子文件夹内容" }),
        el("button", { class: "iib-chip-x", title: "只看当前目录", onclick: () => this.toggleWalk() }, "×"),
      ));
    }
    if (this.randomMode) {
      chips.push(el("div", { class: "iib-filter-chip" },
        icon("dice-multiple-outline"),
        el("span", { text: "随机结果" }),
        el("button", { class: "iib-chip-x", title: "返回目录", onclick: () => this.exitRandom() }, "×"),
      ));
    }
    if (this.filterBar) {
      this.filterBar.replaceChildren(...chips);
      this.filterBar.classList.toggle("iib-hidden", chips.length === 0);
    }
  }

  async openTagFilter(tag) {
    this.tagFilter = [tag];
    this.randomMode = false;
    this.renderFilterBar();
    if (this.mode !== "browse") {
      await this.setMode("browse", { skipReload: true });
    }
    await this.reload({ reset: true });
  }

  async clearTagFilter() {
    this.tagFilter = [];
    this.renderFilterBar();
    await this.reload({ reset: true });
  }

  async toggleWalk() {
    this.walkMode = !this.walkMode;
    this.walkBtn.classList.toggle("active", this.walkMode);
    this.renderFilterBar();
    await this.reload({ reset: true });
  }

  async randomBrowse() {
    try {
      const data = await jfetch(`/random?count=${Math.min(this.pageSize, 60)}`);
      this.randomMode = true;
      this.dirs = [];
      this.items = data.items || [];
      this.total = this.items.length;
      this.selected.clear();
      this.selectedItems.clear();
      this.gridEl.replaceChildren();
      this.renderedPaths = new Set();
      this.renderGrid({ reset: true });
      this.renderFooter();
      this.renderFilterBar();
      if (this.mode !== "browse") await this.setMode("browse", { skipReload: true });
    } catch (err) {
      toast("error", "随机失败", String(err?.message || err));
    }
  }

  async exitRandom() {
    this.randomMode = false;
    this.renderFilterBar();
    await this.reload({ reset: true });
  }

  /* ------------------------------------------------------------ 索引状态 */

  async refreshIndexChip() {
    try {
      const data = await jfetch("/index/status");
      this.indexStatus = data;
      const scanning = data.status === "scanning";
      const label = scanning ? `索引 ${data.scanned}` : `索引 ${data.indexed}`;
      this.indexChip.replaceChildren(
        icon(scanning ? "database-sync-outline" : "database-check-outline"),
        el("span", { text: label }),
      );
      this.indexChip.classList.toggle("scanning", scanning);
    } catch (err) {
      this.indexChip.replaceChildren(icon("database-alert-outline"), el("span", { text: "索引" }));
    }
  }

  startIndexPolling() {
    this.stopIndexPolling();
    this.refreshIndexChip();
    this.indexTimer = setInterval(() => this.refreshIndexChip(), 3000);
  }

  stopIndexPolling() {
    if (this.indexTimer) {
      clearInterval(this.indexTimer);
      this.indexTimer = null;
    }
  }

  startAutoRefresh() {
    this.stopAutoRefresh();
    const seconds = Number(this.config?.settings?.autoRefresh || 0);
    if (!seconds) return;
    this.autoRefreshTimer = setInterval(() => {
      if (!this.isOpen() || this.mode !== "browse" || this.loading) return;
      this.reload({ reset: false });
    }, Math.max(5, seconds) * 1000);
  }

  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  /* ------------------------------------------------------------ 批量操作 */

  async zipDownload(items) {
    const paths = (items || []).map((item) => item.abs || item.path).filter(Boolean);
    if (!paths.length) return;
    toast("info", `正在打包 ${paths.length} 个文件…`);
    try {
      const response = await api.fetchApi("/iib/zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || response.statusText);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `iib-${Date.now()}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 6000);
      toast("success", `已打包 ${paths.length} 个文件`);
    } catch (err) {
      toast("error", "打包失败", String(err?.message || err));
    }
  }

  async assignTagsDialog(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    const input = await iibPrompt("添加标签", {
      label: `给 ${list.length} 个文件添加标签，多个用逗号分隔`,
      placeholder: "收藏, 风景",
    });
    if (!input) return;
    const tags = input.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    if (!tags.length) return;
    try {
      await postJSON("/tags/assign", { paths: list, tags, action: "add" });
      toast("success", `已添加标签：${tags.join("、")}`);
      if (this.previewInfo?.path && list.includes(this.previewInfo.path)) {
        this.showPreview(this.selectedItems.get(this.previewInfo.path) || { abs: this.previewInfo.path, name: this.previewInfo.name, kind: this.previewInfo.kind, url: this.previewInfo.url, sizeText: this.previewInfo.sizeText, mtime: this.previewInfo.mtime });
      }
    } catch (err) {
      toast("error", "添加标签失败", String(err?.message || err));
    }
  }

  async findSimilar(path) {
    try {
      const data = await jfetch(`/similar?path=${encodeURIComponent(path)}&limit=40`);
      const items = data.items || [];
      const overlay = el("div", { class: "iib-modal iib-scope" });
      const card = el("div", { class: "iib-modal-card", style: { width: "min(860px, 92vw)" } });
      const grid = el("div", { class: "iib-grid", style: { maxHeight: "62vh", overflow: "auto", paddingRight: "6px" } },
        items.length ? items.map((item) => el("div", {
          class: "iib-card", title: `${item.name}\n差异 ${item.distance} bit`,
          onclick: () => { overlay.remove(); this.openLightbox(item, items); },
        },
          el("img", { src: item.thumb, loading: "lazy" }),
          el("div", { class: "caption", text: item.name }),
        )) : el("div", { class: "iib-empty", text: "没有找到相似图片（需要先建立索引）" }),
      );
      card.append(el("div", { class: "iib-modal-title", text: `相似图片（${items.length}）` }));
      card.append(grid);
      card.append(el("div", { class: "iib-modal-actions" },
        el("button", { class: "iib-btn", onclick: () => overlay.remove() }, "关闭"),
      ));
      overlay.append(card);
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) overlay.remove(); });
      document.body.append(overlay);
    } catch (err) {
      toast("error", "查找相似失败", String(err?.message || err));
    }
  }

  async showRawInfo(item) {
    try {
      const info = await jfetch(`/info?path=${encodeURIComponent(item.abs)}`);
      const overlay = el("div", { class: "iib-modal iib-scope" });
      const card = el("div", { class: "iib-modal-card", style: { width: "min(780px, 94vw)" } });
      const pre = el("pre", {
        class: "iib-meta-text",
        style: { maxHeight: "60vh", margin: 0 },
        text: JSON.stringify(info, null, 2),
      });
      card.append(el("div", { class: "iib-modal-title", text: `全部元数据 · ${item.name}` }));
      card.append(pre);
      card.append(el("div", { class: "iib-modal-actions" },
        el("button", {
          class: "iib-btn",
          onclick: () => { navigator.clipboard?.writeText(pre.textContent || ""); toast("success", "已复制"); },
        }, icon("content-copy"), "复制"),
        el("button", { class: "iib-btn primary", onclick: () => overlay.remove() }, "关闭"),
      ));
      overlay.append(card);
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) overlay.remove(); });
      document.body.append(overlay);
    } catch (err) {
      toast("error", "读取元数据失败", String(err?.message || err));
    }
  }

  async editPrompt(item) {    if (!item) return;
    let current = "";
    try {
      const info = await jfetch(`/info?path=${encodeURIComponent(item.abs)}`);
      current = info?.comfy?.["正向提示词"] || info?.parameters || "";
    } catch { /* ignore */ }
    const overlay = el("div", { class: "iib-modal iib-scope" });
    const card = el("div", { class: "iib-modal-card", style: { width: "min(720px, 92vw)" } });
    const textarea = el("textarea", {
      class: "iib-input", style: { width: "100%", height: "220px", padding: "8px", resize: "vertical", lineHeight: "1.5" },
    });
    textarea.value = current;
    const save = el("button", { class: "iib-btn primary" }, "写回 PNG");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await postJSON("/prompt", { path: item.abs, prompt: textarea.value });
        toast("success", "提示词已写回图片", item.name);
        overlay.remove();
        if (this.selectedItems.has(item.abs)) this.showPreview(item);
      } catch (err) {
        toast("error", "写回失败", String(err?.message || err));
      } finally {
        save.disabled = false;
      }
    });
    card.append(el("div", { class: "iib-modal-title", text: `编辑提示词 · ${item.name}` }));
    card.append(el("div", { class: "iib-modal-msg", text: "修改会直接写入图片的 PNG 文本块（prompt），原文件会被覆盖。" }));
    card.append(textarea);
    card.append(el("div", { class: "iib-modal-actions" },
      el("button", { class: "iib-btn", onclick: () => overlay.remove() }, "取消"),
      save,
    ));
    overlay.append(card);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.append(overlay);
    setTimeout(() => textarea.focus(), 0);
  }

  bindGlobalKeys() {
    this.keyHandler = (event) => {
      if (!this.isOpen()) return;
      const tag = event.target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (event.key === "Escape") {
        if (typing) return;
        const chatDialog = [...document.querySelectorAll(".p-dialog")].find((node) => node.offsetParent);
        if (chatDialog) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.menuEl) { this.closeMenu(); return; }
        this.close();
        return;
      }
      if (typing) return;
      if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const mode = MODES[Number(event.key) - 1];
        if (mode) {
          event.preventDefault();
          this.setMode(mode.id);
        }
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        this.setMode("browse");
        setTimeout(() => this.searchInput.focus(), 60);
        return;
      }
      if (event.key === "F5") {
        event.preventDefault();
        this.refreshAll();
        return;
      }
      if (event.key === "Delete" && this.selected.size) {
        event.preventDefault();
        this.deleteItems([...this.selectedItems.values()]);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && this.mode === "browse") {
        event.preventDefault();
        for (const item of this.dirs) { this.selected.add(item.abs); this.selectedItems.set(item.abs, item); }
        for (const item of this.items) { this.selected.add(item.abs); this.selectedItems.set(item.abs, item); }
        this.syncSelectionClasses();
        this.renderFooter();
      }
    };
    window.addEventListener("keydown", this.keyHandler, true);
  }

  /* ------------------------------------------------------------ 开关 */

  isOpen() {
    return this.overlay.style.display !== "none";
  }

  async open() {
    if (!this.overlay.isConnected) document.body.append(this.overlay);
    this.overlay.style.display = "flex";
    this.startIndexPolling();
    if (!this.config) {
      try {
        await this.loadConfig();
      } catch (err) {
        toast("error", "无法连接到无限图像浏览后端", String(err?.message || err));
        this.close();
        return;
      }
    }
    const remembered = this.readRemembered();
    if (!this.roots.length) {
      this.rootId = null;
      this.items = [];
      this.dirs = [];
      this.gridEl.replaceChildren();
      this.renderEmpty("没有可浏览的目录，请在 ComfyUI 设置里添加附加目录", "folder-alert-outline");
      this.renderFooter();
      return;
    }
    const hasRoot = (id) => this.roots.some((root) => root.id === id);
    if (this.tabs.length) {
      const tab = this.activeTab() || this.tabs[0];
      this.activeTabId = tab.id;
      if (tab.rootId && hasRoot(tab.rootId)) this.rootId = tab.rootId;
      this.rel = tab.rel || "";
      this.history = tab.history?.length ? tab.history.slice() : [{ rootId: this.rootId, rel: this.rel }];
      this.historyIndex = tab.historyIndex ?? Math.max(0, this.history.length - 1);
      this.renderTabs();
      this.renderPath();
      this.highlightTree();
      this.updateHistoryButtons();
      this.renderFilterBar();
      await this.reload({ reset: true });
      this.startAutoRefresh();
      return;
    }
    if (remembered && hasRoot(remembered.rootId)) {
      await this.navigate(remembered.rootId, remembered.rel || "", { push: false });
    } else if (!this.rootId || !hasRoot(this.rootId)) {
      await this.navigate(this.roots[0].id, "", { push: false });
    } else {
      await this.reload({ reset: true });
    }
    if (!this.tabs.length) {
      const tab = this.createTab(this.rootId, this.rel);
      tab.history = this.history.slice();
      tab.historyIndex = this.historyIndex;
      this.renderTabs();
    }
    this.startAutoRefresh();
  }

  close() {
    if (!this.isOpen()) return;
    this.closeMenu();
    this.closeLightbox();
    this.stopIndexPolling();
    this.stopAutoRefresh();
    this.compareDrop?.remove();
    this.compareDrop = null;
    document.querySelectorAll(".iib-modal.iib-scope").forEach((node) => node.remove());
    for (const video of this.previewStage.querySelectorAll("video")) {
      try { video.pause(); } catch { /* ignore */ }
    }
    this.overlay.style.display = "none";
    this.saveRemembered();
    this.selected.clear();
    this.selectedItems.clear();
    this.renderFooter();
  }

  readRemembered() {
    try {
      const raw = localStorage.getItem("IIB.lastPath");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.rootId ? parsed : null;
    } catch { return null; }
  }

  saveRemembered() {
    if (!this.config?.settings?.rememberLastPath) return;
    try {
      localStorage.setItem("IIB.lastPath", JSON.stringify({ rootId: this.rootId, rel: this.rel }));
    } catch { /* ignore */ }
  }

  openSettings() {
    try {
      app.extensionManager?.command?.execute?.("Comfy.ShowSettingsDialog");
    } catch (err) {
      console.warn("[IIB] 打开设置失败", err);
    }
  }

  /* ------------------------------------------------------------ 配置 */

  async loadConfig() {
    const data = await jfetch("/config");
    this.applyConfig(data);
  }

  applyConfig(data) {
    this.config = data;
    this.roots = data.roots || [];
    const settings = data.settings || {};
    this.pageSize = Number(settings.pageSize) || 120;
    this.sort = settings.sort || this.sort;
    this.useThumbnails = settings.useThumbnails !== false;
    this.originalRatio = settings.originalRatio === true;
    if (this.originalRatio && this.useThumbnails) {
      // 两个选项互斥：原比例优先
      this.useThumbnails = false;
      setSettingValueSafe("IIB.UseThumbnails", false);
    }
    this.sortSelect.value = this.sort;
    this.sizeRange.value = String(settings.gridSize || 180);
    this.windowEl.style.setProperty("--iib-cell", `${settings.gridSize || 180}px`);
    this.windowEl.classList.toggle("iib-fit-contain", this.originalRatio);
    this.buildTree().then(() => {
      if (this.isOpen() && this.rel) this.revealTreePath();
    });
    this.renderPath();
    this.renderFooter();
    this.updatePathVisibility();
    if (this.isOpen()) this.startAutoRefresh();
  }

  /* ------------------------------------------------------------ 导航 */

  async navigate(rootId, rel, { push = true } = {}) {
    this.rootId = rootId;
    this.rel = rel || "";
    this.query = "";
    this.searchInput.value = "";
    this.selected.clear();
    this.selectedItems.clear();
    if (this.tagFilter.length || this.randomMode) {
      this.tagFilter = [];
      this.randomMode = false;
      this.renderFilterBar();
    }
    if (push) {
      const current = this.history[this.historyIndex];
      if (!current || current.rootId !== rootId || current.rel !== this.rel) {
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push({ rootId, rel: this.rel });
        this.historyIndex = this.history.length - 1;
      }
    } else if (!this.history.length) {
      this.history = [{ rootId, rel: this.rel }];
      this.historyIndex = 0;
    }
    this.updateHistoryButtons();
    this.renderPath();
    this.highlightTree();
    const tab = this.activeTab();
    if (tab) {
      tab.rootId = rootId;
      tab.rel = this.rel;
      tab.history = this.history.slice();
      tab.historyIndex = this.historyIndex;
      this.renderTabs();
    }
    await this.reload({ reset: true });
  }

  goBack() {
    if (this.historyIndex <= 0) return;
    this.historyIndex -= 1;
    const target = this.history[this.historyIndex];
    this.updateHistoryButtons();
    this.navigate(target.rootId, target.rel, { push: false });
  }

  goForward() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex += 1;
    const target = this.history[this.historyIndex];
    this.updateHistoryButtons();
    this.navigate(target.rootId, target.rel, { push: false });
  }

  goUp() {
    if (!this.rel) return;
    const parts = this.rel.split("/").filter(Boolean);
    parts.pop();
    this.navigate(this.rootId, parts.join("/"));
  }

  updateHistoryButtons() {
    this.backBtn.disabled = this.historyIndex <= 0;
    this.forwardBtn.disabled = this.historyIndex >= this.history.length - 1;
    this.upBtn.disabled = !this.rel;
  }

  /* ------------------------------------------------------------ 数据加载 */

  async reload({ reset = true } = {}) {
    if (!this.rootId) return;
    if (reset) {
      this.page = 1;
      this.items = [];
      this.dirs = [];
      this.gridEl.replaceChildren();
      this.total = 0;
    }
    await this.loadPage();
  }

  async loadPage() {
    if (!this.rootId) return;
    this.loading = true;
    const token = ++this.requestToken;
    this.setLoading(true);
    try {
      let data;
      if (this.onlyFavorites) {
        const params = new URLSearchParams({ page: String(this.page), size: String(this.pageSize) });
        const result = await jfetch(`/favorites?${params.toString()}`);
        data = { path: this.currentAbs, rel: this.rel, dirs: [], items: result.items || [], total: result.total || 0 };
      } else if (this.walkMode && !this.tagFilter.length) {
        const params = new URLSearchParams({
          root: this.rootId,
          path: this.rel,
          page: String(this.page),
          size: String(this.pageSize),
          sort: this.sort,
          kind: this.kind,
          walk: "1",
        });
        if (this.query) params.set("q", this.query);
        data = await jfetch(`/list?${params.toString()}`);
      } else if (this.tagFilter.length) {
        const params = new URLSearchParams({
          page: String(this.page),
          size: String(this.pageSize),
          sort: this.sort,
          tagMode: "any",
        });
        if (this.walkMode) {
          const dirPath = this.currentDirAbs();
          if (dirPath) params.set("dir", dirPath);
        }
        if (this.query) params.set("q", this.query);
        if (this.kind !== "all") params.set("type", this.kind);
        params.set("tags", this.tagFilter.join(","));
        if (this.onlyFavorites) params.set("favorites", "1");
        const result = await jfetch(`/search?${params.toString()}`);
        data = {
          path: this.currentDirAbs(),
          rel: this.rel,
          dirs: [],
          items: result.items || [],
          total: result.total || 0,
        };
      } else {
        const params = new URLSearchParams({
          root: this.rootId,
          path: this.rel,
          page: String(this.page),
          size: String(this.pageSize),
          sort: this.sort,
          kind: this.kind,
        });
        if (this.query) params.set("q", this.query);
        data = await jfetch(`/list?${params.toString()}`);
      }
      if (token !== this.requestToken) return;
      this.total = data.total || 0;
      this.currentAbs = data.path || this.currentAbs || "";
      if (this.page === 1) {
        this.dirs = (this.query || this.walkMode || this.tagFilter.length) ? [] : (data.dirs || []);
      }
      const items = data.items || [];
      for (const item of items) this.items.push(item);
      this.renderGrid({ reset: this.page === 1 });
      this.renderFooter();
      this.updateHistoryButtons();
      if (!this.query) this.saveRemembered();
      if (this.page === 1 && !this.query) this.revealTreePath();
    } catch (err) {
      if (token === this.requestToken) {
        toast("error", "加载目录失败", String(err?.message || err));
        this.renderEmpty("无法加载这个目录", "alert-circle-outline");
      }
    } finally {
      if (token === this.requestToken) {
        this.loading = false;
        this.setLoading(false);
      }
    }
  }

  async loadMore() {
    if (this.loading) return;
    if (this.items.length >= this.total) return;
    this.page += 1;
    await this.loadPage();
  }

  onScroll() {
    if (this.loading) return;
    const wrap = this.gridWrap;
    if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 420) {
      this.loadMore();
    }
  }

  setLoading(visible) {
    this.loadingEl.classList.toggle("iib-hidden", !visible);
  }

  /* ------------------------------------------------------------ 渲染：路径 / 树 */

  currentRoot() {
    return this.roots.find((root) => root.id === this.rootId) || null;
  }

  renderPath() {
    this.pathEl.replaceChildren();
    const root = this.currentRoot();
    if (!root) {
      this.pathEl.append(el("span", { class: "iib-crumb", text: "（没有可用目录）" }));
      return;
    }
    this.pathEl.append(el("span", {
      class: "iib-crumb root", title: root.path, text: root.label,
      onclick: () => this.navigate(root.id, ""),
    }));
    const parts = (this.rel || "").split("/").filter(Boolean);
    let accumulated = "";
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const target = accumulated;
      this.pathEl.append(el("span", { class: "iib-crumb-sep", text: "/" }));
      this.pathEl.append(el("span", {
        class: "iib-crumb", title: part, text: part,
        onclick: () => this.navigate(root.id, target),
      }));
    }
    this.subtitleEl.textContent = parts.length ? `${root.label} / ${this.rel}` : root.label;
  }

  async buildTree() {
    this.treeBody.replaceChildren();
    this.treeCache.clear();
    for (const root of this.roots) {
      let dirs = [];
      try {
        const data = await jfetch(`/tree?root=${encodeURIComponent(root.id)}&path=`);
        dirs = data.dirs || [];
      } catch (err) {
        dirs = [];
      }
      const node = this.makeTreeNode(root.id, "", root.label, "folder-home-outline", true, dirs.length > 0, dirs);
      this.treeBody.append(node);
    }
    this.highlightTree();
  }

  makeTreeNode(rootId, rel, label, iconName, isRoot = false, hasChildren = true, preloadedDirs = null) {
    const row = el("div", {
      class: "iib-node",
      dataset: { root: rootId, rel },
      title: label,
      draggable: false,
    });
    const twisty = el("span", { class: "twisty", text: "▸" });
    if (!hasChildren) {
      twisty.classList.add("empty");
      twisty.style.visibility = "hidden";
    }
    row.append(twisty, icon(iconName || "folder-outline"));
    row.append(el("span", { class: "label", text: label }));

    const container = el("div", { class: "iib-tree-group" }, row);
    const children = el("div", { class: "iib-children iib-hidden" });
    container.append(children);

    let expanded = false;
    let pendingDirs = preloadedDirs;
    const expand = async (force) => {
      if (!hasChildren) return;
      const next = force === undefined ? !expanded : force;
      if (next === expanded) return;
      expanded = next;
      twisty.classList.toggle("open", expanded);
      children.classList.toggle("iib-hidden", !expanded);
      if (!expanded) return;
      if (children.dataset.loaded === "1") return;
      children.dataset.loaded = "1";
      try {
        let subdirs = pendingDirs;
        pendingDirs = null;
        if (!subdirs) {
          children.append(el("div", { class: "iib-node", style: { opacity: "0.6" } },
            el("span", { class: "twisty empty" }), el("span", { class: "label", text: "加载中…" })));
          const params = new URLSearchParams({ root: rootId, path: rel });
          const data = await jfetch(`/tree?${params.toString()}`);
          subdirs = data.dirs || [];
        }
        children.replaceChildren();
        if (!subdirs.length) {
          hasChildren = false;
          children.dataset.loaded = "0";
          twisty.classList.add("empty");
          twisty.style.visibility = "hidden";
          return;
        }
        for (const dir of subdirs) {
          children.append(this.makeTreeNode(rootId, dir.rel, dir.name, "folder-outline", false, dir.hasChildren !== false));
        }
      } catch (err) {
        children.replaceChildren(el("div", { class: "iib-node", style: { opacity: "0.6" } },
          el("span", { class: "label", text: `加载失败: ${err.message || err}` })));
      }
    };

    row.addEventListener("click", (event) => {
      event.stopPropagation();
      this.navigate(rootId, rel);
      if (!expanded) expand(true);
    });
    row.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      expand(true);
    });
    twisty.addEventListener("click", (event) => {
      event.stopPropagation();
      expand();
    });

    row.addEventListener("dragover", (event) => {
      if (!this.dragPaths.length) return;
      event.preventDefault();
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove("drop-target");
      const paths = this.dragPaths.length ? this.dragPaths : [];
      if (!paths.length) return;
      await this.movePaths(paths, rootId, rel);
    });

    row.__expand = expand;
    row.__container = container;
    row.__children = children;
    container.__row = row;
    return container;
  }

  async revealTreePath() {
    if (!this.rootId) return;
    const parts = (this.rel || "").split("/").filter(Boolean);
    const selectorFor = (rel) => `.iib-node[data-root="${CSS.escape(this.rootId)}"][data-rel="${CSS.escape(rel)}"]`;
    let parentRel = "";
    let row = this.treeBody.querySelector(selectorFor(""));
    if (!row) return;
    for (const part of parts) {
      const nextRel = parentRel ? `${parentRel}/${part}` : part;
      let child = this.treeBody.querySelector(selectorFor(nextRel));
      if (!child) {
        await row.__expand?.(true);
        await new Promise((resolve) => setTimeout(resolve, 80));
        child = this.treeBody.querySelector(selectorFor(nextRel));
      }
      if (!child) return;
      parentRel = nextRel;
      row = child;
    }
    this.highlightTree();
  }

  highlightTree() {
    for (const row of this.treeBody.querySelectorAll(".iib-node")) {
      const isActive = row.dataset.root === this.rootId && (row.dataset.rel || "") === (this.rel || "");
      row.classList.toggle("active", isActive);
      if (isActive) {
        let parent = row.parentElement;
        while (parent && parent !== this.treeBody) {
          if (parent.classList.contains("iib-children")) {
            parent.classList.remove("iib-hidden");
            const owner = parent.previousElementSibling;
            const twisty = owner?.querySelector?.(".twisty");
            twisty?.classList.add("open");
          }
          parent = parent.parentElement;
        }
      }
    }
  }

  /* ------------------------------------------------------------ 渲染：网格 */

  renderGrid({ reset = false } = {}) {
    if (reset) {
      this.gridEl.replaceChildren();
      this.renderedPaths = new Set();
    }
    if (!this.renderedPaths) this.renderedPaths = new Set();
    if (reset) {
      for (const dir of this.dirs) this.gridEl.append(this.makeDirCard(dir));
    }
    for (const item of this.items) {
      if (this.renderedPaths.has(item.abs)) continue;
      this.renderedPaths.add(item.abs);
      this.gridEl.append(this.makeCard(item));
    }
    const count = this.dirs.length + this.items.length;
    if (count === 0) {
      this.renderEmpty(this.query ? "没有匹配的文件" : "这个目录里还没有图片", "image-off-outline");
    } else {
      this.emptyEl.classList.add("iib-hidden");
      this.gridEl.classList.remove("iib-hidden");
    }
  }

  renderEmpty(text, iconName) {
    this.gridEl.classList.add("iib-hidden");
    this.emptyEl.classList.remove("iib-hidden");
    this.emptyEl.replaceChildren(icon(iconName || "folder-open-outline"), el("div", { text }));
    if (this.query) this.emptyEl.append(el("div", { style: { fontSize: "11px" }, text: `关键词：${this.query}` }));
  }

  makeDirCard(dir) {
    const card = el("div", {
      class: "iib-card dir",
      dataset: { abs: dir.abs },
      title: dir.name,
      ondblclick: (event) => { event.stopPropagation(); this.navigate(this.rootId, dir.rel); },
      onclick: (event) => { event.stopPropagation(); this.selectItem(dir, event); },
      oncontextmenu: (event) => this.showMenu(event, dir),
    },
      el("div", { class: "caption", text: dir.name }),
      el("span", { class: "iib-dir-badge", title: "文件夹" }, icon("folder")),
      el("div", { class: "check" }, icon("check")),
    );
    const cover = el("img", {
      src: `/iib/dircover?path=${encodeURIComponent(dir.abs)}&size=220&v=${Math.floor(dir.mtime || 0)}`,
      loading: "lazy",
      decoding: "async",
      alt: dir.name,
    });
    cover.addEventListener("error", () => {
      cover.remove();
      card.prepend(el("div", { class: "placeholder" }, icon("folder")));
    });
    card.prepend(cover);
    card.addEventListener("dragover", (event) => {
      if (!this.dragPaths.length) return;
      event.preventDefault();
      card.classList.add("selected");
    });
    card.addEventListener("dragleave", () => card.classList.remove("selected"));
    card.addEventListener("drop", async (event) => {
      event.preventDefault();
      card.classList.remove("selected");
      await this.movePaths(this.dragPaths, this.rootId, dir.rel);
    });
    return card;
  }

  makeCard(item) {
    const card = el("div", {
      class: `iib-card ${item.favorited ? "favorited" : ""}`.trim(),
      dataset: { abs: item.abs },
      title: `${item.name}\n${item.sizeText || ""} · ${item.mtimeText || ""}`,
      draggable: "true",
      onclick: (event) => { event.stopPropagation(); this.selectItem(item, event); },
      ondblclick: (event) => { event.stopPropagation(); this.openLightbox(item); },
      oncontextmenu: (event) => this.showMenu(event, item),
    });

    const imageSrc = this.useThumbnails
      ? item.thumb
      : (item.kind === "image" ? item.url : item.thumb);
    if (imageSrc) {
      const img = el("img", { src: imageSrc, loading: "lazy", decoding: "async", alt: item.name });
      img.addEventListener("error", () => {
        img.remove();
        card.prepend(el("div", { class: "placeholder" }, icon(item.kind === "video" ? "movie-open-outline" : "image-broken-variant")));
      });
      card.append(img);
    } else {
      card.append(el("div", { class: "placeholder" }, icon(item.kind === "video" ? "movie-open-outline" : "file-image-outline")));
    }

    if (item.kind === "video") {
      card.append(el("div", { class: "kind-badge" }, icon("play"), "视频"));
    }
    card.append(el("div", { class: "caption", text: item.name }));
    card.append(el("div", { class: "check" }, icon("check")));
    card.append(el("button", {
      class: "iib-fav",
      title: item.favorited ? "取消收藏" : "收藏",
      onclick: (event) => this.toggleFavorite(item, event),
    }, icon("heart")));

    card.addEventListener("dragstart", (event) => {
      if (!this.selected.has(item.abs)) this.selectItem(item, {});
      this.dragPaths = [...this.selected];
      event.dataTransfer.effectAllowed = "move";
      try { event.dataTransfer.setData("text/plain", this.dragPaths.join("\n")); } catch { /* ignore */ }
      this.beginCompareDrag();
    });
    card.addEventListener("dragend", () => {
      this.dragPaths = [];
      this.endCompareDrag();
      for (const node of this.gridEl.querySelectorAll(".selected")) node.classList.remove("selected");
      this.syncSelectionClasses();
    });
    return card;
  }

  /* ------------------------------------------------------------ 选择 */

  selectItem(item, event = {}) {
    const additive = event.ctrlKey || event.metaKey;
    const range = event.shiftKey;

    if (range && this.lastClicked) {
      const all = [...this.dirs, ...this.items];
      const start = all.findIndex((entry) => entry.abs === this.lastClicked);
      const end = all.findIndex((entry) => entry.abs === item.abs);
      if (start >= 0 && end >= 0) {
        for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
          this.selected.add(all[index].abs);
          this.selectedItems.set(all[index].abs, all[index]);
        }
        this.syncSelectionClasses();
        this.renderFooter();
        return;
      }
    }

    if (additive) {
      if (this.selected.has(item.abs)) {
        this.selected.delete(item.abs);
        this.selectedItems.delete(item.abs);
      } else {
        this.selected.add(item.abs);
        this.selectedItems.set(item.abs, item);
      }
    } else if (this.selected.size > 1 || !this.selected.has(item.abs)) {
      this.selected.clear();
      this.selectedItems.clear();
      this.selected.add(item.abs);
      this.selectedItems.set(item.abs, item);
    }
    this.lastClicked = item.abs;
    this.syncSelectionClasses();
    this.renderFooter();
    this.showPreview(item);
  }

  syncSelectionClasses() {
    for (const card of this.gridEl.querySelectorAll(".iib-card")) {
      card.classList.toggle("selected", this.selected.has(card.dataset.abs));
    }
  }

  /* ------------------------------------------------------------ 预览 */

  async showPreview(item) {
    if (!item || item.isDir) {
      this.previewInfo = null;
      this.previewStage.replaceChildren(el("div", { class: "iib-empty" }, icon("image-search-outline"), el("div", { text: "选中文件后在这里预览" })));
      this.previewBody.replaceChildren();
      return;
    }
    const token = ++this.previewToken;
    const isVideo = item.kind === "video";
    const stage = isVideo
      ? el("video", { src: item.url, controls: true, loop: true, muted: true, autoplay: true, playsinline: true })
      : el("img", { src: item.url, alt: item.name });
    this.previewStage.replaceChildren(stage);

    const body = el("div", {});
    body.append(el("div", { class: "iib-preview-name", text: item.name }));
    body.append(el("div", { class: "iib-preview-file", text: item.abs }));

    const actions = el("div", { class: "iib-actions" },
      el("button", { class: "iib-btn primary", onclick: () => this.loadToComfyUI(item) }, icon("send"), "载入到 LoadImage"),
      el("button", {
        class: `iib-btn ${item.favorited ? "active" : ""}`.trim(),
        onclick: () => this.toggleFavorite(item),
      }, icon(item.favorited ? "heart" : "heart-outline"), item.favorited ? "已收藏" : "收藏"),
      el("button", { class: "iib-btn", onclick: () => this.copyText(item.abs, "路径已复制") }, icon("content-copy"), "复制路径"),
      el("button", { class: "iib-btn", onclick: () => this.revealItem(item) }, icon("folder-open"), "在文件夹中显示"),
      el("button", { class: "iib-btn", onclick: () => this.downloadItem(item) }, icon("download"), "下载"),
      el("button", { class: "iib-btn", onclick: () => this.renameItem(item) }, icon("pencil"), "重命名"),
      el("button", { class: "iib-btn danger", onclick: () => this.deleteItems([item]) }, icon("trash-can-outline"), "删除"),
      el("button", { class: "iib-btn", onclick: () => this.showRawInfo(item) }, icon("code-json"), "全部元数据"),
    );
    body.append(actions);

    const tagBox = el("div", { class: "iib-preview-tags" });
    body.append(tagBox);
    jfetch(`/tags/of?path=${encodeURIComponent(item.abs)}`)
      .then((data) => {
        const tags = data.tags || [];
        tagBox.replaceChildren(
          el("span", { class: "iib-preview-tags-label", text: "标签" }),
          ...tags.map((tag) => el("span", {
            class: "iib-tag-chip",
            title: tag.source === "auto" ? "自动标签（来自提示词）" : "手动标签",
            onclick: () => this.openTagFilter(tag.name),
          }, tag.name)),
          el("button", {
            class: "iib-btn icon ghost", title: "编辑标签",
            onclick: () => this.assignTagsDialog([item.abs]),
          }, icon("tag-plus-outline")),
        );
      })
      .catch(() => tagBox.replaceChildren());

    body.append(el("div", { class: "iib-section-title", text: "文件信息" }));
    const kv = el("dl", { class: "iib-kv" });
    kv.append(el("dt", { text: "类型" }), el("dd", { text: isVideo ? "视频" : "图片" }));
    kv.append(el("dt", { text: "大小" }), el("dd", { text: item.sizeText || fmtSize(item.size) }));
    kv.append(el("dt", { text: "修改时间" }), el("dd", { text: item.mtimeText || fmtTime(item.mtime) }));
    body.append(kv);

    const metaBox = el("div", {});
    body.append(metaBox);
    this.previewBody.replaceChildren(body);
    this.previewInfo = null;

    try {
      const info = await jfetch(`/info?path=${encodeURIComponent(item.abs)}`);
      if (token !== this.previewToken) return;
      this.previewInfo = info;
      const dims = info.width && info.height ? `${info.width} × ${info.height}` : null;
      if (dims) kv.append(el("dt", { text: "尺寸" }), el("dd", { text: dims }));

      if (info.hasWorkflow || info.hasPrompt || info.hasParameters) {
        metaBox.append(el("div", { class: "iib-section-title", text: "工作流" }));
        const label = info.hasWorkflow
          ? "加载图片内的工作流"
          : (info.hasPrompt ? "由提示词还原工作流" : "由 WebUI 参数生成工作流");
        metaBox.append(el("button", {
          class: "iib-btn", style: { width: "100%", marginBottom: "8px" },
          onclick: () => this.loadWorkflow(item),
        }, icon("sitemap-outline"), label));
      }

      const fields = info.fields || [];
      if (fields.length) {
        metaBox.append(el("div", { class: "iib-section-title", text: "生成信息" }));
        for (const field of fields) {
          metaBox.append(el("div", { style: { fontSize: "11px", color: "var(--iib-muted)", margin: "6px 0 3px" } }, field.label));
          metaBox.append(el("div", { class: "iib-meta-text", text: field.value }));
        }
      }
    } catch (err) {
      console.warn("[IIB] 读取元数据失败", err);
    }
  }

  /* ------------------------------------------------------------ 灯箱 */

  openLightbox(item, list) {
    this.closeLightbox();
    this.lbItems = Array.isArray(list) && list.length ? list : this.items;
    const index = this.lbItems.findIndex((entry) => entry.abs === item.abs);
    this.lbIndex = index >= 0 ? index : 0;
    const infoPanel = el("div", { class: "iib-lb-info iib-scroll" });
    this.lbInfo = infoPanel;
    this.lbStage = el("div", { class: "iib-lb-stage" });
    this.lbTitle = el("div", { class: "iib-lb-title" });
    this.lbSub = el("div", { class: "iib-lb-sub" });

    const prev = el("button", { class: "iib-lb-nav prev", title: "上一张 (←)", onclick: () => this.lbStep(-1) }, "‹");
    const next = el("button", { class: "iib-lb-nav next", title: "下一张 (→)", onclick: () => this.lbStep(1) }, "›");
    this.lbStage.append(prev, next);

    const foot = el("div", { class: "iib-lb-foot" },
      el("button", { class: "iib-btn", onclick: () => this.loadToComfyUI(this.lbItems[this.lbIndex]) }, icon("send"), "载入到 LoadImage"),
      el("button", { class: "iib-btn", onclick: () => this.copyText(this.lbItems[this.lbIndex].abs, "路径已复制") }, icon("content-copy"), "复制路径"),
      el("button", { class: "iib-btn", onclick: () => this.downloadItem(this.lbItems[this.lbIndex]) }, icon("download"), "下载"),
      el("button", { class: "iib-btn", onclick: () => this.assignTagsDialog([this.lbItems[this.lbIndex].abs]) }, icon("tag-plus-outline"), "加标签"),
      el("div", { class: "iib-header-spacer" }),
      el("span", { text: "← → 切换 · Esc 关闭" }),
      el("button", { class: "iib-btn icon", title: "关闭", onclick: () => this.closeLightbox() }, icon("close")),
    );

    this.lbEl = el("div", { class: "iib-lightbox iib-scope" },
      el("div", { class: "iib-lb-head" }, this.lbTitle, el("div", { class: "iib-header-spacer" }), this.lbSub,
        el("button", { class: "iib-btn icon", title: "关闭", onclick: () => this.closeLightbox() }, icon("close"))),
      el("div", { class: "iib-lb-body" }, this.lbStage, infoPanel),
      foot,
    );
    this.lbEl.addEventListener("keydown", (event) => event.stopPropagation());
    this.lbEl.addEventListener("click", (event) => {
      if (event.target === this.lbEl || event.target === this.lbStage) this.closeLightbox();
    });
    document.body.append(this.lbEl);
    this.lbKeyHandler = (event) => {
      if (!this.lbEl) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.closeLightbox(); }
      if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); this.lbStep(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); this.lbStep(1); }
    };
    window.addEventListener("keydown", this.lbKeyHandler, true);
    this.lbRender();
  }

  lbStep(delta) {
    if (!this.lbItems?.length) return;
    this.lbIndex = (this.lbIndex + delta + this.lbItems.length) % this.lbItems.length;
    this.lbRender();
  }

  async lbRender() {
    if (!this.lbEl) return;
    const item = this.lbItems?.[this.lbIndex];
    if (!item) return;
    this.lbTitle.textContent = item.name;
    this.lbSub.textContent = `${this.lbIndex + 1} / ${this.lbItems.length}`;
    const media = item.kind === "video"
      ? el("video", { src: item.url, controls: true, autoplay: true, loop: true, playsinline: true })
      : el("img", { src: item.url, alt: item.name });
    const navButtons = [...this.lbStage.querySelectorAll(".iib-lb-nav")];
    this.lbStage.replaceChildren(...navButtons, media);
    try {
      const info = await jfetch(`/info?path=${encodeURIComponent(item.abs)}`);
      this.lbInfo.replaceChildren();
      const addRow = (label, value) => {
        this.lbInfo.append(el("div", { style: { fontSize: "11px", color: "#8b8b8b", marginTop: "8px" } }, label));
        this.lbInfo.append(el("div", { style: { fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, String(value)));
      };
      addRow("路径", item.abs);
      if (info.width) addRow("尺寸", `${info.width} × ${info.height}`);
      addRow("大小", info.sizeText || fmtSize(info.size));
      addRow("修改时间", info.mtimeText || fmtTime(info.mtime));
      for (const field of info.fields || []) addRow(field.label, field.value);
    } catch (err) {
      this.lbInfo.replaceChildren(el("div", { style: { fontSize: "12px", color: "#999" }, text: `元数据读取失败：${err.message || err}` }));
    }
  }

  closeLightbox() {
    if (this.lbEl) {
      this.lbEl.remove();
      this.lbEl = null;
    }
    if (this.lbKeyHandler) {
      window.removeEventListener("keydown", this.lbKeyHandler, true);
      this.lbKeyHandler = null;
    }
  }

  /* ------------------------------------------------------------ 右键菜单 */

  showMenu(event, item) {
    event.preventDefault();
    event.stopPropagation();
    if (this.menuEl) this.closeMenu();
    this.closeLightbox();
    if (!this.selected.has(item.abs)) {
      this.selected.clear();
      this.selectedItems.clear();
      this.selected.add(item.abs);
      this.selectedItems.set(item.abs, item);
      this.syncSelectionClasses();
      this.renderFooter();
    }
    const count = this.selected.size;
    const items = count > 1 ? [...this.selectedItems.values()] : [item];
    const menu = el("div", { class: "iib-menu iib-scope" });
    const add = (iconName, label, handler, { danger = false, disabled = false } = {}) => {
      const row = el("div", { class: `iib-menu-item ${danger ? "danger" : ""}`, style: disabled ? { opacity: "0.4", pointerEvents: "none" } : {} },
        icon(iconName), el("span", { text: label }));
      row.addEventListener("click", () => { this.closeMenu(); handler(); });
      menu.append(row);
    };

    if (item.isDir) {
      add("folder-open-outline", "打开文件夹", () => this.navigate(this.rootId, item.rel));
      add("playlist-plus", "在此新建文件夹", () => this.createFolder(item.abs));
      menu.append(el("div", { class: "iib-menu-sep" }));
      add("folder-open", "在资源管理器中打开", () => this.revealItem(item));
      add("pencil", "重命名", () => this.renameItem(item));
      add("trash-can-outline", "删除文件夹", () => this.deleteItems([item]), { danger: true });
    } else {
      add("eye-outline", "预览", () => this.openLightbox(item));
      add("send", "载入到 LoadImage", () => this.loadToComfyUI(item));
      add("content-copy", "复制路径", () => this.copyText(item.abs, "路径已复制"));
      add(item.favorited ? "heart-off-outline" : "heart-outline", item.favorited ? "取消收藏" : "收藏", () => this.toggleFavorite(item));
      add("tag-plus-outline", "添加标签…", () => this.assignTagsDialog([...this.selected].filter(Boolean)));
      add("image-search-outline", "查找相似图片", () => this.findSimilar(item.abs));
      add("text-box-edit-outline", "编辑提示词", () => this.editPrompt(item));
      add("sitemap-outline", "加载图片内的工作流", () => this.loadWorkflow(item));
      menu.append(el("div", { class: "iib-menu-sep" }));
      add("folder-open", "在文件夹中显示", () => this.revealItem(item));
      add("download", "下载", () => this.downloadItem(item));
      add("pencil", "重命名", () => this.renameItem(item));
      if (count > 1) {
        add("download-multiple", `打包下载 ${count} 个文件`, () => this.downloadMany(items));
      }
      menu.append(el("div", { class: "iib-menu-sep" }));
      add("trash-can-outline", count > 1 ? `删除 ${count} 个文件` : "删除", () => this.deleteItems(items), { danger: true });
    }

    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 230)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.childElementCount * 30 - 20)}px`;
    document.body.append(menu);
    this.menuEl = menu;
    setTimeout(() => {
      this.menuCloser = (evt) => {
        if (this.menuEl && !this.menuEl.contains(evt.target)) this.closeMenu();
      };
      window.addEventListener("mousedown", this.menuCloser, true);
    }, 0);
  }

  closeMenu() {
    if (this.menuCloser) {
      window.removeEventListener("mousedown", this.menuCloser, true);
      this.menuCloser = null;
    }
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
    }
  }

  showBlankMenu(event) {
    if (this.menuEl) this.closeMenu();
    const menu = el("div", { class: "iib-menu iib-scope" });
    const add = (iconName, label, handler) => {
      const row = el("div", { class: "iib-menu-item" }, icon(iconName), el("span", { text: label }));
      row.addEventListener("click", () => { this.closeMenu(); handler(); });
      menu.append(row);
    };
    add("refresh", "刷新", () => this.reload({ reset: true }));
    add("folder-plus-outline", "新建文件夹", () => this.createFolder(this.rootPath()));
    add("folder-open", "在资源管理器中打开当前目录", () => this.revealItem({ abs: this.rootPath() }));
    menu.append(el("div", { class: "iib-menu-sep" }));
    add("broom", "清理缩略图缓存", () => this.clearThumbCache());

    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 230)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 160)}px`;
    document.body.append(menu);
    this.menuEl = menu;
    setTimeout(() => {
      this.menuCloser = (evt) => {
        if (this.menuEl && !this.menuEl.contains(evt.target)) this.closeMenu();
      };
      window.addEventListener("mousedown", this.menuCloser, true);
    }, 0);
  }

  /* ------------------------------------------------------------ 页脚 */

  renderFooter() {
    const root = this.currentRoot();
    const total = this.total;
    const loaded = this.items.length + (this.query ? 0 : this.dirs.length);
    const parts = [
      el("span", { text: root ? `${root.label}${this.rel ? ` / ${this.rel}` : ""}` : "—" }),
      el("span", { text: "·" }),
      el("span", { text: this.query ? `搜索“${this.query}” · ${total} 个结果` : `${total} 个文件` }),
      el("span", { text: `· 已加载 ${loaded}` }),
      el("div", { class: "spacer" }),
      this.selected.size ? el("span", { text: `已选择 ${this.selected.size} 项` }) : null,
      this.selected.size
        ? el("button", { class: "iib-btn", onclick: () => { this.selected.clear(); this.selectedItems.clear(); this.syncSelectionClasses(); this.renderFooter(); } }, "取消选择")
        : null,
      this.selected.size > 1
        ? el("button", { class: "iib-btn danger", onclick: () => this.deleteItems([...this.selectedItems.values()]) }, icon("trash-can-outline"), "删除所选")
        : null,
      this.selected.size
        ? el("button", { class: "iib-btn", onclick: () => this.assignTagsDialog([...this.selected].filter(Boolean)) }, icon("tag-plus-outline"), "加标签")
        : null,
      this.selected.size
        ? el("button", { class: "iib-btn", onclick: () => this.zipDownload([...this.selectedItems.values()]) }, icon("zip-box-outline"), "打包下载")
        : null,
      this.config?.cache ? el("span", { text: `缩略图缓存 ${this.config.cache.count} 个 / ${fmtSize(this.config.cache.bytes)}` }) : null,
    ];
    this.footerEl.replaceChildren(...parts.filter(Boolean));
  }

  /* ------------------------------------------------------------ 文件操作 */

  async copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast("success", message || "已复制");
    } catch (err) {
      toast("error", "复制失败", String(err?.message || err));
    }
  }

  async revealItem(item) {
    try {
      await postJSON("/reveal", { path: item.abs });
    } catch (err) {
      toast("error", "无法打开资源管理器", String(err?.message || err));
    }
  }

  downloadItem(item) {
    const link = document.createElement("a");
    link.href = item.url + "&download=1";
    link.download = item.name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  async downloadMany(items) {
    for (const item of items) {
      this.downloadItem(item);
      await new Promise((resolve) => setTimeout(resolve, 260));
    }
    toast("info", `已开始下载 ${items.length} 个文件`);
  }

  async deleteItems(items) {
    if (!items.length) return;
    if (!this.config?.settings?.enableFileOps) {
      toast("warning", "设置中已禁用文件操作");
      return;
    }
    const names = items.slice(0, 6).map((item) => item.name).join("\n");
    const more = items.length > 6 ? `\n… 等 ${items.length} 个文件` : "";
    const confirmed = await iibConfirm(`确定要永久删除以下 ${items.length} 项吗？\n\n${names}${more}`, { title: "删除文件" });
    if (!confirmed) return;
    try {
      const data = await postJSON("/delete", { paths: items.map((item) => item.abs) });
      const failed = data.failed || [];
      if (failed.length) {
        toast("warning", `${failed.length} 项删除失败`, failed[0]?.error);
      } else {
        toast("success", `已删除 ${items.length} 项`);
      }
      for (const item of items) {
        this.selected.delete(item.abs);
        this.selectedItems.delete(item.abs);
      }
      if (this.previewInfo && items.some((item) => item.abs === this.previewInfo.path)) {
        this.previewStage.replaceChildren();
        this.previewBody.replaceChildren();
      }
      await this.reload({ reset: true });
      this.refreshTreeBranch();
    } catch (err) {
      toast("error", "删除失败", String(err?.message || err));
    }
  }

  async renameItem(item) {
    if (!this.config?.settings?.enableFileOps) {
      toast("warning", "设置中已禁用文件操作");
      return;
    }
    const name = await iibPrompt("重命名", { label: "新的名称（含扩展名）", value: item.name });
    if (!name || name === item.name) return;
    try {
      const data = await postJSON("/rename", { path: item.abs, name });
      toast("success", "已重命名", data.path);
      await this.reload({ reset: true });
      this.refreshTreeBranch();
    } catch (err) {
      toast("error", "重命名失败", String(err?.message || err));
    }
  }

  async createFolder(parent) {
    if (!this.config?.settings?.enableFileOps) {
      toast("warning", "设置中已禁用文件操作");
      return;
    }
    const name = await iibPrompt("新建文件夹", { label: "文件夹名称", placeholder: "新文件夹" });
    if (!name) return;
    try {
      await postJSON("/mkdir", { parent: parent || this.rootPath(), name });
      toast("success", "已新建文件夹", name);
      await this.reload({ reset: true });
      this.refreshTreeBranch();
    } catch (err) {
      toast("error", "新建文件夹失败", String(err?.message || err));
    }
  }

  currentDirAbs() {
    const root = this.roots.find((item) => item.id === this.rootId);
    if (!root) return this.currentAbs || "";
    const rel = (this.rel || "").replace(/\//g, "\\").replace(/^\\+/, "");
    return rel ? `${root.path}\\${rel}` : root.path;
  }

  rootPath() {
    return this.currentDirAbs();
  }

  async movePaths(paths, rootId, rel) {
    if (!paths.length) return;
    if (!this.config?.settings?.enableFileOps) {
      toast("warning", "设置中已禁用文件操作");
      return;
    }
    const root = this.roots.find((entry) => entry.id === rootId);
    if (!root) return;
    try {
      const data = await postJSON("/move", { paths, targetRoot: rootId, targetRel: rel || "" });
      if ((data.failed || []).length) {
        toast("warning", `${data.failed.length} 项移动失败`, data.failed[0]?.error);
      } else {
        toast("success", `已移动 ${paths.length} 项到 ${root.label}${rel ? ` / ${rel}` : ""}`);
      }
      this.dragPaths = [];
      await this.reload({ reset: true });
      this.refreshTreeBranch();
    } catch (err) {
      toast("error", "移动失败", String(err?.message || err));
    }
  }

  async refreshTreeBranch() {
    await this.buildTree();
    await this.revealTreePath();
  }

  async refreshAll() {
    await this.reload({ reset: true });
    await this.refreshTreeBranch();
  }

  async clearThumbCache() {
    const confirmed = await iibConfirm("清理后缩略图会在下次浏览时重新生成，确定继续吗？", { title: "清理缩略图缓存", danger: false });
    if (!confirmed) return;
    try {
      const data = await postJSON("/cache/clear", {});
      toast("success", `已清理 ${data.removed} 个缩略图缓存`);
      if (this.config) this.config.cache = data.cache;
      this.renderFooter();
    } catch (err) {
      toast("error", "清理失败", String(err?.message || err));
    }
  }

  /* ------------------------------------------------------------ 与 ComfyUI 联动 */

  async loadToComfyUI(item) {
    if (!item || item.isDir) return;
    try {
      const data = await postJSON("/send-to-input", { path: item.abs });
      const value = data.value || data.name;
      let node = app.canvas?.selectedItems?.find?.((entry) => entry?.type === "LoadImage");
      if (!node) node = app.graph._nodes.find((entry) => entry.type === "LoadImage");
      if (!node) {
        const created = LiteGraph.createNode("LoadImage");
        if (!created) throw new Error("当前环境里没有 LoadImage 节点");
        created.pos = [
          (app.canvas?.graph_mouse?.[0] ?? 200),
          (app.canvas?.graph_mouse?.[1] ?? 200),
        ];
        app.graph.add(created);
        node = created;
      }
      const widget = node.widgets?.find((entry) => entry.name === "image");
      if (widget) {
        widget.value = value;
        try { widget.callback?.(value, app.canvas, node, [0, 0], null); } catch { /* ignore */ }
      }
      try { node.onWidgetChanged?.("image", value, undefined, widget); } catch { /* ignore */ }
      node.setDirtyCanvas?.(true, true);
      app.graph.setDirtyCanvas?.(true, true);
      app.canvas?.selectNode?.(node, false);
      toast("success", "已载入到 LoadImage", `${value}`);
    } catch (err) {
      toast("error", "载入到 ComfyUI 失败", String(err?.message || err));
    }
  }

  async loadWorkflow(item) {
    if (!item?.abs) return;
    // 首选：把原图交给 ComfyUI 自己的 handleFile（与拖拽进画布完全一致，
    // 原生支持 workflow / prompt / WebUI parameters）
    try {
      const response = await api.fetchApi(`/iib/file?path=${encodeURIComponent(item.abs)}`);
      if (!response.ok) throw new Error(`读取原图失败（${response.status}）`);
      const blob = await response.blob();
      const file = new File([blob], item.name || "image.png", { type: blob.type || "image/png" });
      if (typeof app.handleFile !== "function") throw new Error("当前前端不支持 handleFile");
      await app.handleFile(file, "file_drop");
      applySavePrefix();
      toast("success", "已由 ComfyUI 原生解析并载入工作流", item.name);
      this.close();
      return;
    } catch (err) {
      console.warn("[IIB] 原生载入失败，回退到插件解析", err);
    }

    try {
      const data = await jfetch(`/workflow?path=${encodeURIComponent(item.abs)}`);
      if (data?.workflow) {
        await app.loadGraphData(data.workflow);
      } else if (data?.prompt) {
        if (typeof app.loadApiJson === "function") {
          await app.loadApiJson(data.prompt);
        } else {
          throw new Error("当前前端不支持从 API 提示词还原工作流");
        }
      } else {
        throw new Error("这张图片里没有嵌入工作流或提示词");
      }
      applySavePrefix();
      toast(
        "success",
        data?.workflow
          ? "工作流已加载"
          : (data?.a1111 ? "已由 WebUI 参数生成工作流" : "已由提示词还原工作流"),
        item.name,
      );
      this.close();
    } catch (err) {
      toast("error", "加载工作流失败", String(err?.message || err));
    }
  }
}

/* ------------------------------------------------------------------ 单例 */

let dialog = null;
let panelsPromise = null;

async function loadPanels() {
  if (!panelsPromise) panelsPromise = import("./iib-panels.js");
  return panelsPromise;
}

function ensureDialog() {
  if (!dialog) {
    injectCSS();
    dialog = new IIBDialog();
  }
  return dialog;
}

function openIIB() {
  return ensureDialog().open().catch((err) => {
    console.error("[IIB] 打开窗口失败", err);
    toast("error", "打开无限图像浏览失败", String(err?.message || err));
  });
}

/* ------------------------------------------------------------------ 接管「资产」按钮 */

function patchAssetsTab() {
  const manager = app.extensionManager;
  if (!manager) return false;

  let tabs = [];
  try {
    tabs = manager.getSidebarTabs?.() || manager.sidebarTabs?.sidebarTabs || [];
  } catch { tabs = []; }
  if (Array.isArray(tabs) === false) tabs = [];

  const tab = tabs.find?.((entry) => entry && entry.id === "assets");
  if (!tab) return false;

  if (!tab.__iibPatched) {
    tab.__iibPatched = true;
    tab.onToggle = () => {
      openIIB();
      return true; // 阻止原生资产侧栏展开
    };
    console.info("[IIB] 已接管左侧边栏「资产」按钮");
  }

  try {
    const commands = manager.command?.commands || [];
    const command = commands.find?.((entry) => entry?.id === "Workspace.ToggleSidebarTab.assets");
    if (command && !command.__iibPatched) {
      command.__iibPatched = true;
      command.function = async () => { await openIIB(); };
    }
  } catch (err) {
    console.warn("[IIB] 改写资产命令失败", err);
  }

  try {
    const store = manager.sidebarTab?.value ?? manager.sidebarTab;
    if (store && typeof store.toggleSidebarTab === "function" && !store.__iibPatched) {
      const original = store.toggleSidebarTab.bind(store);
      store.__iibPatched = true;
      store.toggleSidebarTab = (id) => {
        if (id === "assets") { openIIB(); return; }
        return original(id);
      };
    }
  } catch (err) {
    console.warn("[IIB] 接管资产侧栏失败", err);
  }

  return true;
}

function installAssetsOverride() {  if (patchAssetsTab()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (patchAssetsTab() || attempts > 40) clearInterval(timer);
  }, 500);
}

/** 让 ComfyUI 的翻译插件跳过我们的窗口（避免把 "ComfyUI" 之类文本误翻） */function protectFromTranslation() {
  const classes = ["notranslate", "lite-search-item-type"];
  const mark = (node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches?.(".iib-overlay, .iib-modal, .iib-lightbox, .iib-compare-drop, .iib-menu")) {
      node.classList.add(...classes);
      node.setAttribute("translate", "no");
    }
    node.querySelectorAll?.(".iib-overlay, .iib-modal, .iib-lightbox, .iib-compare-drop, .iib-menu").forEach((child) => {
      child.classList.add(...classes);
      child.setAttribute("translate", "no");
    });
  };
  try {
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) mark(node);
      }
    }).observe(document.body, { childList: true });
  } catch (err) {
    console.warn("[IIB] 安装翻译保护失败", err);
  }
}

/** 把设置里的「附加目录」文本项替换成列表管理（新增 / 移除） */
function installExtraDirsEditor() {
  const mount = () => {
    const input = document.getElementById("IIB.ExtraDirs");
    if (!input) return false;
    const holder = input.parentElement;
    if (!holder) return false;
    if (holder.dataset.iibList === "1" && holder.querySelector(".iib-extradirs")) return true;
    if (holder.dataset.iibList === "1") delete holder.dataset.iibList;
    holder.dataset.iibList = "1";
    input.style.display = "none";
    holder.querySelectorAll(".iib-extradirs").forEach((node) => node.remove());

    const readEntries = () => {
      let raw = "";
      try {
        raw = String(app.ui?.settings?.getSettingValue?.("IIB.ExtraDirs") ?? "");
      } catch { raw = ""; }
      return raw.split(";").map((item) => item.trim()).filter(Boolean);
    };
    const writeEntries = (items) => {
      const value = items.map((item) => item.trim()).filter(Boolean).join(";");
      try {
        app.ui?.settings?.setSettingValue?.("IIB.ExtraDirs", value);
      } catch (err) {
        console.warn("[IIB] 保存附加目录失败", err);
      }
      return value;
    };
    const list = el("div", { class: "iib-extradirs" });
    let entries = readEntries();

    const render = () => {
      const rows = entries.map((entry, index) => {
        const field = el("input", {
          class: "iib-input",
          value: entry,
          placeholder: "名称::D:\\图库 或 D:\\图库",
        });
        const apply = () => {
          if (field.dataset.removed === "1") return;
          entries[index] = field.value.trim();
          writeEntries(entries);
        };
        field.addEventListener("change", apply);
        field.addEventListener("blur", apply);
        field.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Enter") apply();
        });
        const remove = el("button", {
          class: "iib-btn icon danger",
          title: "从附加目录中移除（不会删除磁盘文件）",
          onclick: () => {
            field.dataset.removed = "1";
            entries.splice(index, 1);
            writeEntries(entries);
            render();
          },
        }, icon("delete-outline"));
        return el("div", { class: "iib-extradir-row" }, field, remove);
      });
      rows.push(el("button", {
        class: "iib-btn iib-extradir-add",
        onclick: () => {
          entries = readEntries();
          entries.push("");
          render();
          const inputs = list.querySelectorAll(".iib-extradir-row .iib-input");
          inputs[inputs.length - 1]?.focus();
        },
      }, icon("folder-plus-outline"), "新增附加目录"));
      list.replaceChildren(...rows);
    };

    render();
    holder.append(list);
    return true;
  };

  try {
    new MutationObserver(() => mount()).observe(document.body, { childList: true, subtree: true });
  } catch (err) {
    console.warn("[IIB] 监听设置面板失败", err);
  }
  setInterval(mount, 1200);
}

/* ------------------------------------------------------------------ 注册扩展 */

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    injectCSS();
    registerSettings();
    protectFromTranslation();
    installExtraDirsEditor();
    if (!Object.keys(settingHandles).length) {
      let tries = 0;
      const timer = setInterval(() => {
        registerSettings();
        tries += 1;
        if (Object.keys(settingHandles).length || tries > 20) clearInterval(timer);
      }, 500);
    }
    // 把当前设置推给后端（保证附加目录等在重启后依然生效）
    setTimeout(async () => {
      await syncSettings().catch(() => {});
      try {
        const autoIndex = app.ui?.settings?.getSettingValue?.("IIB.AutoIndex");
        if (autoIndex) await postJSON("/index/scan", {});
      } catch (err) {
        console.warn("[IIB] 自动索引启动失败", err);
      }
    }, 1500);
    installAssetsOverride();
  },

  async afterConfigureGraph() {
    applySavePrefix();
  },

  async afterLoadGraph() {
    applySavePrefix();
  },

  commands: [
    {
      id: "IIB.Open",
      label: "打开无限图像浏览",
      icon: "mdi mdi-image-multiple-outline",
      function: () => openIIB(),
    },
  ],
});

// 兜底：组件挂载后再尝试一次接管
if (document.readyState === "complete") {
  setTimeout(installAssetsOverride, 1200);
} else {
  window.addEventListener("load", () => setTimeout(installAssetsOverride, 1200), { once: true });
}
