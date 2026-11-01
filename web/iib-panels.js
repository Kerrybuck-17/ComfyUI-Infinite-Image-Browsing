/**
 * 多模式面板：标签 / 搜索 / 统计 / 整理 / 对比 / 竖屏 / 索引
 * 由 iib.js 的 IIBDialog.setMode() 动态加载，全部使用 ComfyUI 原生样式变量。
 */
import {
  el, icon, jfetch, postJSON, toast, fmtSize, fmtTime,
  confirmDialog, promptDialog,
} from "./iib-ui.js";

/* ---------------------------------------------------------------- 公共小件 */

function shell(title, subtitle, actions, body) {
  return el("div", { class: "iib-panel" },
    el("div", { class: "iib-panel-head" },
      el("div", {},
        el("div", { class: "iib-panel-title", text: title }),
        subtitle ? el("div", { class: "iib-panel-sub", text: subtitle }) : null,
      ),
      el("div", { class: "iib-header-spacer" }),
      ...(actions || []),
    ),
    el("div", { class: "iib-panel-body iib-scroll" }, ...body),
  );
}

function field(label, control, extraClass = "") {
  return el("label", { class: `iib-field ${extraClass}`.trim() }, el("span", { text: label }), control);
}

function actionButton(label, iconName, onclick) {
  return el("button", { class: "iib-btn", onclick }, icon(iconName), label);
}

function statCard(label, value, hint) {
  return el("div", { class: "iib-stat-card" },
    el("div", { class: "iib-stat-label", text: label }),
    el("div", { class: "iib-stat-value", text: String(value) }),
    hint ? el("div", { class: "iib-stat-label", text: hint, style: { marginTop: "4px" } }) : null,
  );
}

function mediaCard(dialog, item, list) {
  const card = el("div", {
    class: "iib-card",
    title: `${item.name}\n${item.sizeText || fmtSize(item.size)} ${item.mtimeText ? `· ${item.mtimeText}` : ""}`,
    onclick: () => dialog.openLightbox(item, list),
    oncontextmenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      dialog.selected.clear();
      dialog.selectedItems.clear();
      dialog.selected.add(item.abs);
      dialog.selectedItems.set(item.abs, item);
      dialog.showMenu(event, item);
    },
  });
  if (item.thumb) {
    const img = el("img", { src: item.thumb, loading: "lazy", decoding: "async", alt: item.name });
    img.addEventListener("error", () => { img.remove(); card.prepend(el("div", { class: "placeholder" }, icon("image-broken-variant"))); });
    card.append(img);
  } else {
    card.append(el("div", { class: "placeholder" }, icon(item.kind === "video" ? "movie-open-outline" : "image-outline")));
  }
  card.append(el("div", { class: "caption", text: item.name }));
  return card;
}

async function fillRootSelect(select, dialog) {
  const roots = dialog.roots?.length ? dialog.roots : (await jfetch("/config")).roots || [];
  select.replaceChildren(...roots.map((root) => el("option", { value: root.id, text: `${root.label}（${root.path}）` })));
}

/* ---------------------------------------------------------------- 标签面板 */

function renderTags(dialog, host) {
  const state = { query: "", view: "cloud" };
  const cloud = el("div", { class: "iib-tagcloud" });
  const graph = el("div", { class: "iib-graph iib-hidden" });
  const countLabel = el("div", { class: "iib-panel-sub", style: { margin: "0 0 10px" } });
  const search = el("input", { class: "iib-input", placeholder: "筛选标签…", style: { width: "200px" } });
  search.addEventListener("input", () => {
    state.query = search.value.trim();
    loadCloud();
  });

  const viewBtn = el("button", { class: "iib-btn" }, icon("graph-outline"), "关系图");
  viewBtn.addEventListener("click", async () => {
    state.view = state.view === "cloud" ? "graph" : "cloud";
    viewBtn.classList.toggle("active", state.view === "graph");
    cloud.classList.toggle("iib-hidden", state.view === "graph");
    graph.classList.toggle("iib-hidden", state.view !== "graph");
    if (state.view === "graph") await loadGraph();
  });

  async function loadCloud() {
    try {
      const data = await jfetch(`/tags?q=${encodeURIComponent(state.query)}&limit=800`);
      const tags = data.tags || [];
      countLabel.textContent = `${tags.length} 个标签 · 单击按标签浏览，右键重命名 / 删除`;
      cloud.replaceChildren(...tags.map((tag) => el("div", {
        class: "iib-tag",
        title: `出现 ${tag.c} 次`,
        onclick: () => dialog.openTagFilter(tag.name),
        oncontextmenu: (event) => { event.preventDefault(); tagMenu(tag, event); },
      },
        el("span", { text: tag.name }),
        el("b", { text: String(tag.c) }),
      )));
      if (!tags.length) cloud.replaceChildren(el("div", { class: "iib-empty", text: "还没有标签，先去「索引」面板建立索引" }));
    } catch (err) {
      toast("error", "加载标签失败", String(err?.message || err));
    }
  }

  async function tagMenu(tag, event) {
    const menu = el("div", { class: "iib-menu iib-scope", style: { left: `${event.clientX}px`, top: `${event.clientY}px` } });
    const add = (label, iconName, handler, danger = false) => {
      const row = el("div", { class: `iib-menu-item ${danger ? "danger" : ""}` }, icon(iconName), el("span", { text: label }));
      row.addEventListener("click", () => { menu.remove(); handler(); });
      menu.append(row);
    };
    add("按此标签浏览", "image-filter", () => dialog.openTagFilter(tag.name));
    add("重命名标签", "pencil", async () => {
      const name = await promptDialog("重命名标签", { label: `原名称：${tag.name}`, value: tag.name });
      if (!name || name === tag.name) return;
      try {
        await postJSON("/tags/rename", { id: tag.id, name });
        toast("success", "标签已重命名");
        loadCloud();
      } catch (err) {
        toast("error", "重命名失败", String(err?.message || err));
      }
    });
    add("删除标签", "trash-can-outline", async () => {
      const ok = await confirmDialog(`删除标签「${tag.name}」？只会移除标签，不会删除图片。`, { title: "删除标签" });
      if (!ok) return;
      try {
        await postJSON("/tags/delete", { id: tag.id });
        toast("success", "标签已删除");
        loadCloud();
      } catch (err) {
        toast("error", "删除失败", String(err?.message || err));
      }
    }, true);
    document.body.append(menu);
    setTimeout(() => {
      const closer = (evt) => {
        if (!menu.contains(evt.target)) { menu.remove(); window.removeEventListener("mousedown", closer, true); }
      };
      window.addEventListener("mousedown", closer, true);
    }, 0);
  }

  async function loadGraph() {
    graph.replaceChildren(el("div", { class: "iib-empty", text: "正在计算标签关系…" }));
    try {
      const data = await jfetch("/tag/graph?limit=48&minEdge=2");
      graph.replaceChildren(buildGraphSvg(data, dialog));
    } catch (err) {
      graph.replaceChildren(el("div", { class: "iib-empty", text: `加载失败：${err.message || err}` }));
    }
  }

  const actions = [
    el("button", {
      class: "iib-btn primary",
      onclick: async () => {
        const name = await promptDialog("新建标签", { label: "标签名称", placeholder: "收藏" });
        if (!name) return;
        try {
          await postJSON("/tags/create", { name });
          toast("success", "标签已创建");
          loadCloud();
        } catch (err) {
          toast("error", "创建失败", String(err?.message || err));
        }
      },
    }, icon("tag-plus-outline"), "新建标签"),
    el("button", { class: "iib-btn", onclick: loadCloud }, icon("refresh"), "刷新"),
  ];

  host.replaceChildren(shell("标签", "自动标签来自提示词与模型，手动标签可自由添加", actions, [
    el("div", { class: "iib-actions-row" }, search, viewBtn),
    countLabel,
    cloud,
    graph,
  ]));
  loadCloud();
}

function buildGraphSvg(data, dialog) {
  const width = 900;
  const height = 520;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 70;
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const positions = new Map();
  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length) - Math.PI / 2;
    positions.set(node.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), ...node });
  });
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");

  const maxEdge = edges.reduce((max, edge) => Math.max(max, edge.weight), 1);
  for (const edge of edges) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;
    const line = document.createElementNS(svgNs, "line");
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
    line.setAttribute("stroke", "var(--iib-accent)");
    line.setAttribute("stroke-opacity", String(0.12 + 0.5 * (edge.weight / maxEdge)));
    line.setAttribute("stroke-width", String(0.6 + 2.4 * (edge.weight / maxEdge)));
    svg.append(line);
  }

  const maxWeight = nodes.reduce((max, node) => Math.max(max, node.weight), 1);
  for (const node of nodes) {
    const position = positions.get(node.id);
    const circle = document.createElementNS(svgNs, "circle");
    circle.setAttribute("cx", position.x);
    circle.setAttribute("cy", position.y);
    circle.setAttribute("r", String(5 + 11 * (node.weight / maxWeight)));
    circle.setAttribute("fill", "var(--iib-accent)");
    circle.setAttribute("fill-opacity", "0.85");
    circle.style.cursor = "pointer";
    circle.addEventListener("click", () => dialog.openTagFilter(node.name));
    const title = document.createElementNS(svgNs, "title");
    title.textContent = `${node.name}（权重 ${node.weight}）`;
    circle.append(title);
    svg.append(circle);

    const text = document.createElementNS(svgNs, "text");
    text.setAttribute("x", position.x);
    text.setAttribute("y", position.y - 14);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "11");
    text.setAttribute("fill", "var(--iib-text)");
    text.textContent = node.name.length > 12 ? `${node.name.slice(0, 12)}…` : node.name;
    svg.append(text);
  }
  return svg;
}

function buildTagSection(dialog) {
  const search = el("input", { class: "iib-input", placeholder: "筛选标签…", style: { width: "200px" } });
  const cloud = el("div", { class: "iib-tagcloud" });
  const graph = el("div", { class: "iib-graph iib-hidden" });
  const count = el("div", { class: "iib-panel-sub", style: { margin: "0 0 8px" } });
  let view = "cloud";

  const viewBtn = el("button", { class: "iib-btn" }, icon("graph-outline"), "关系图");
  viewBtn.addEventListener("click", async () => {
    view = view === "cloud" ? "graph" : "cloud";
    viewBtn.classList.toggle("active", view === "graph");
    cloud.classList.toggle("iib-hidden", view === "graph");
    graph.classList.toggle("iib-hidden", view !== "graph");
    if (view === "graph") {
      graph.replaceChildren(el("div", { class: "iib-empty", text: "正在计算标签关系…" }));
      try {
        graph.replaceChildren(buildGraphSvg(await jfetch("/tag/graph?limit=48&minEdge=2"), dialog));
      } catch (err) {
        graph.replaceChildren(el("div", { class: "iib-empty", text: `加载失败：${err.message || err}` }));
      }
    }
  });

  async function load() {
    try {
      const data = await jfetch(`/tags?q=${encodeURIComponent(search.value.trim())}&limit=800`);
      const tags = data.tags || [];
      count.textContent = `${tags.length} 个标签 · 单击按标签浏览，右键重命名 / 删除`;
      cloud.replaceChildren(...tags.map((tag) => el("div", {
        class: "iib-tag", title: `出现 ${tag.c} 次`,
        onclick: () => dialog.openTagFilter(tag.name),
        oncontextmenu: (event) => { event.preventDefault(); tagContextMenu(tag, event); },
      }, el("span", { text: tag.name }), el("b", { text: String(tag.c) }))));
      if (!tags.length) cloud.replaceChildren(el("div", { class: "iib-empty", text: "还没有标签，先去「索引」建立索引" }));
    } catch (err) {
      cloud.replaceChildren(el("div", { class: "iib-empty", text: `加载失败：${err.message || err}` }));
    }
  }

  function tagContextMenu(tag, event) {
    const menu = el("div", { class: "iib-menu iib-scope", style: { left: `${event.clientX}px`, top: `${event.clientY}px` } });
    const add = (label, iconName, handler, danger = false) => {
      const row = el("div", { class: `iib-menu-item ${danger ? "danger" : ""}` }, icon(iconName), el("span", { text: label }));
      row.addEventListener("click", () => { menu.remove(); handler(); });
      menu.append(row);
    };
    add("按此标签浏览", "image-filter", () => dialog.openTagFilter(tag.name));
    add("重命名标签", "pencil", async () => {
      const name = await promptDialog("重命名标签", { label: `原名称：${tag.name}`, value: tag.name });
      if (!name || name === tag.name) return;
      try { await postJSON("/tags/rename", { id: tag.id, name }); toast("success", "标签已重命名"); load(); }
      catch (err) { toast("error", "重命名失败", String(err?.message || err)); }
    });
    add("删除标签", "trash-can-outline", async () => {
      const ok = await confirmDialog(`删除标签「${tag.name}」？只会移除标签，不会删除图片。`, { title: "删除标签" });
      if (!ok) return;
      try { await postJSON("/tags/delete", { id: tag.id }); toast("success", "标签已删除"); load(); }
      catch (err) { toast("error", "删除失败", String(err?.message || err)); }
    }, true);
    document.body.append(menu);
    setTimeout(() => {
      const closer = (evt) => { if (!menu.contains(evt.target)) { menu.remove(); window.removeEventListener("mousedown", closer, true); } };
      window.addEventListener("mousedown", closer, true);
    }, 0);
  }

  search.addEventListener("input", load);
  const box = el("div", { style: { marginTop: "18px" } },
    el("div", { class: "iib-section-title", text: "标签" }),
    el("div", { class: "iib-actions-row" }, search, viewBtn),
    count,
    cloud,
    graph,
  );
  load();
  return box;
}

/* ---------------------------------------------------------------- 搜索面板 */

function renderSearch(dialog, host) {
  const state = { page: 1, pageSize: 60, total: 0, items: [], loading: false };
  const keyword = el("input", { class: "iib-input", placeholder: "文件名 / 提示词 / 模型" });
  const model = el("input", { class: "iib-input", placeholder: "模型名包含…" });
  const tags = el("input", { class: "iib-input", placeholder: "标签，多个用逗号分隔" });
  const tagMode = el("select", { class: "iib-select" },
    el("option", { value: "any", text: "任一标签" }),
    el("option", { value: "all", text: "同时包含" }),
  );
  const type = el("select", { class: "iib-select" },
    el("option", { value: "", text: "全部类型" }),
    el("option", { value: "image", text: "图片" }),
    el("option", { value: "video", text: "视频" }),
  );
  const from = el("input", { class: "iib-input", type: "date" });
  const to = el("input", { class: "iib-input", type: "date" });
  const minSize = el("input", { class: "iib-input", type: "number", min: "0", placeholder: "MB" });
  const maxSize = el("input", { class: "iib-input", type: "number", min: "0", placeholder: "MB" });
  const sort = el("select", { class: "iib-select" },
    el("option", { value: "mtime_desc", text: "修改时间 ↓" }),
    el("option", { value: "mtime_asc", text: "修改时间 ↑" }),
    el("option", { value: "name_asc", text: "名称 A→Z" }),
    el("option", { value: "size_desc", text: "大小 ↓" }),
    el("option", { value: "random", text: "随机" }),
  );
  const status = el("div", { class: "iib-panel-sub", style: { margin: "0 0 8px" }, text: "输入条件后搜索" });
  const grid = el("div", { class: "iib-grid" });
  const datalist = el("datalist", { id: "iib-tag-suggest" });
  tags.setAttribute("list", "iib-tag-suggest");
  jfetch("/tags?limit=120")
    .then((data) => datalist.replaceChildren(...(data.tags || []).map((tag) => el("option", { value: tag.name }))))
    .catch(() => {});
  const more = actionButton("加载更多", "chevron-down", () => { state.page += 1; run(false); });
  more.classList.add("iib-hidden");

  function buildQuery() {
    const params = new URLSearchParams({ page: String(state.page), size: String(state.pageSize), sort: sort.value });
    if (keyword.value.trim()) params.set("q", keyword.value.trim());
    if (model.value.trim()) params.set("model", model.value.trim());
    if (tags.value.trim()) params.set("tags", tags.value.trim());
    if (tags.value.trim()) params.set("tagMode", tagMode.value);
    if (type.value) params.set("type", type.value);
    if (from.value) params.set("from", String(new Date(`${from.value}T00:00:00`).getTime() / 1000));
    if (to.value) params.set("to", String(new Date(`${to.value}T23:59:59`).getTime() / 1000));
    if (minSize.value) params.set("minSize", String(Number(minSize.value) * 1024 * 1024));
    if (maxSize.value) params.set("maxSize", String(Number(maxSize.value) * 1024 * 1024));
    return params;
  }

  async function run(reset = true) {
    if (state.loading) return;
    state.loading = true;
    if (reset) { state.page = 1; state.items = []; grid.replaceChildren(); }
    try {
      const data = await jfetch(`/search?${buildQuery().toString()}`);
      state.total = data.total || 0;
      state.items = reset ? data.items : state.items.concat(data.items);
      grid.replaceChildren(...state.items.map((item) => mediaCard(dialog, item, state.items)));
      status.textContent = `共 ${state.total} 个结果，已显示 ${state.items.length}`;
      more.classList.toggle("iib-hidden", state.items.length >= state.total);
      if (!state.items.length) {
        grid.replaceChildren(el("div", { class: "iib-empty" }, icon("file-search-outline"), el("div", { text: "没有匹配的文件（搜索依赖索引，请先在索引面板建立索引）" })));
      }
    } catch (err) {
      toast("error", "搜索失败", String(err?.message || err));
    } finally {
      state.loading = false;
    }
  }

  const actions = [
    el("button", { class: "iib-btn primary", onclick: () => run(true) }, icon("magnify"), "搜索"),
    el("button", { class: "iib-btn", onclick: () => {
      keyword.value = ""; model.value = ""; tags.value = ""; type.value = ""; from.value = ""; to.value = "";
      minSize.value = ""; maxSize.value = ""; sort.value = "mtime_desc";
      run(true);
    } }, icon("broom"), "清空"),
    el("button", { class: "iib-btn", onclick: () => dialog.zipDownload(state.items) }, icon("zip-box-outline"), "打包全部结果"),
  ];

  host.replaceChildren(shell("高级搜索", "基于索引检索：文件名、提示词、模型、标签、时间与大小", actions, [
    el("div", { class: "iib-form" },
      field("关键词", keyword), field("模型", model), field("标签", tags), field("标签匹配", tagMode),
      field("类型", type), field("排序", sort),
      field("开始日期", from), field("结束日期", to),
      field("最小大小 (MB)", minSize), field("最大大小 (MB)", maxSize),
      datalist,
    ),
    el("div", { class: "iib-actions-row" }, status),
    grid,
    el("div", { class: "iib-actions-row", style: { justifyContent: "center", marginTop: "12px" } }, more),
  ]));
  run(true);
}

/* ---------------------------------------------------------------- 统计面板 */

function renderStats(dialog, host) {
  const body = el("div", {});
  const actions = [
    actionButton("刷新", "refresh", () => load()),
    actionButton("查找重复图", "content-duplicate", () => showDuplicates()),
  ];

  async function load() {
    body.replaceChildren(el("div", { class: "iib-empty", text: "正在统计…" }));
    try {
      const data = await jfetch("/stats?days=120");
      const days = (data.byDay || []).slice(-45);
      const maxDay = days.reduce((max, day) => Math.max(max, day.c), 1);
      const totalModels = (data.topModels || []).reduce((sum, item) => sum + item.c, 0) || 1;

      body.replaceChildren(
        el("div", { class: "iib-stat-cards" },
          statCard("已索引文件", data.total),
          statCard("占用空间", fmtSize(data.bytes)),
          statCard("模型数量", (data.topModels || []).length),
          statCard("标签数量", (data.topTags || []).length),
        ),
        el("div", { class: "iib-section-title", text: "按天产量（最近 45 天）" }),
        el("div", { class: "iib-bars" }, days.map((day) => el("div", {
          class: "iib-bar",
          style: { height: `${Math.max(2, (day.c / maxDay) * 100)}%` },
          title: `${day.d}：${day.c} 个`,
        }))),
        el("div", { class: "iib-panel-sub", text: days.length ? `${days[0].d} → ${days[days.length - 1].d}` : "暂无数据" }),

        el("div", { class: "iib-section-title", text: "模型分布" }),
        ...(data.topModels || []).map((item) => el("div", { class: "iib-hbar" },
          el("span", { class: "name", title: item.model, text: item.model || "未知" }),
          el("span", { class: "track" }, el("span", { class: "fill", style: { width: `${(item.c / totalModels) * 100}%` } })),
          el("span", { class: "count", text: String(item.c) }),
        )),

        el("div", { class: "iib-section-title", text: "高频标签（点击筛选）" }),
        el("div", { class: "iib-tagcloud" }, (data.topTags || []).map((tag) => el("div", {
          class: "iib-tag", onclick: () => dialog.openTagFilter(tag.name),
        }, el("span", { text: tag.name }), el("b", { text: String(tag.c) })))),
      );
      if (!days.length) body.prepend(el("div", { class: "iib-panel-sub", text: "提示：先到「索引」面板建立索引，统计才有数据。" }));
    } catch (err) {
      body.replaceChildren(el("div", { class: "iib-empty", text: `统计失败：${err.message || err}` }));
    }
  }

  async function showDuplicates() {
    body.prepend(el("div", { class: "iib-panel-sub", text: "正在查找重复图片…" }));
    try {
      const data = await jfetch("/duplicates?distance=6");
      const groups = data.groups || [];
      const toItem = (entry) => ({
        ...entry,
        abs: entry.path,
        kind: "image",
        sizeText: fmtSize(entry.size),
        mtimeText: fmtTime(entry.mtime),
        thumb: `/iib/thumb?path=${encodeURIComponent(entry.path)}&size=220&v=0`,
        url: `/iib/file?path=${encodeURIComponent(entry.path)}`,
      });
      const box = el("div", {});
      box.append(el("div", { class: "iib-section-title", text: `重复图片 ${groups.length} 组` }));
      for (const group of groups.slice(0, 40)) {
        const row = el("div", { style: { border: "1px solid var(--iib-border)", borderRadius: "10px", padding: "8px", marginBottom: "8px" } },
          el("div", { class: "iib-panel-sub", text: `${group.length} 张相似（差异 ≤6 bit）` }),
          el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            ...group.map((item) => el("div", {
              class: "iib-card", style: { width: "110px", aspectRatio: "1" },
              title: `${item.name}\n${fmtSize(item.size)}`,
              onclick: () => dialog.openLightbox(toItem(item), group.map(toItem)),
              oncontextmenu: async (event) => {
                event.preventDefault();
                const ok = await confirmDialog(`删除 ${item.name}？`, { title: "删除重复图" });
                if (!ok) return;
                try {
                  await postJSON("/delete", { paths: [item.path] });
                  toast("success", "已删除");
                  load();
                } catch (err) { toast("error", "删除失败", String(err?.message || err)); }
              },
            }, el("img", { src: `/iib/thumb?path=${encodeURIComponent(item.path)}&size=220&v=0`, loading: "lazy" }))),
          ),
        );
        box.append(row);
      }
      if (!groups.length) box.append(el("div", { class: "iib-empty", text: "没有发现重复图片" }));
      body.replaceChildren(box);
      body.prepend(el("div", { class: "iib-actions-row" }, actionButton("返回统计", "arrow-left", () => load())));
    } catch (err) {
      body.replaceChildren(el("div", { class: "iib-empty", text: `查找失败：${err.message || err}` }));
    }
  }

  const tagHost = el("div", {});
  host.replaceChildren(shell("统计", "索引数据的产量、模型分布、标签与重复图检测", actions, [body, tagHost]));
  tagHost.append(buildTagSection(dialog));
  load();
}

/* ---------------------------------------------------------------- 整理面板 */

function renderOrganize(dialog, host) {
  const state = { groups: [], rows: [] };
  const by = el("select", { class: "iib-select" },
    el("option", { value: "model", text: "按模型" }),
    el("option", { value: "date", text: "按日期（天）" }),
    el("option", { value: "month", text: "按月份" }),
    el("option", { value: "tag", text: "按标签" }),
    el("option", { value: "type", text: "按类型" }),
    el("option", { value: "folder", text: "按原文件夹" }),
  );
  const scope = el("select", { class: "iib-select" },
    el("option", { value: "all", text: "全部索引文件" }),
    el("option", { value: "dir", text: "当前浏览目录" }),
  );
  const targetRoot = el("select", { class: "iib-select" });
  const targetRel = el("input", { class: "iib-input", value: "整理", placeholder: "目标子目录" });
  const copyMode = el("input", { type: "checkbox" });
  const forceMode = el("input", { type: "checkbox" });
  const status = el("div", { class: "iib-panel-sub", style: { margin: "0 0 8px" }, text: "设置规则后点「搜索」得到分组，勾选后再点「预览分组」" });
  const result = el("div", {});
  const groupsBox = el("div", {});
  const previewBox = el("div", { class: "iib-organize-preview" });

  const toItem = (file) => {
    const path = file.path || "";
    const isVideo = /\.(mp4|webm|mov|mkv|avi|m4v|wmv|flv)$/i.test(path);
    const mtime = Number(file.mtime || 0);
    return {
      abs: path,
      name: file.name || path.split(/[\\/]/).pop(),
      size: Number(file.size || 0),
      sizeText: fmtSize(Number(file.size || 0)),
      mtime,
      mtimeText: fmtTime(mtime),
      kind: isVideo ? "video" : "image",
      thumb: `/iib/thumb?path=${encodeURIComponent(path)}&size=220&v=${Math.floor(mtime)}`,
      url: `/iib/file?path=${encodeURIComponent(path)}`,
      favorited: false,
    };
  };

  function renderGroups(total) {
    const groups = state.groups;
    status.textContent = `共 ${total} 个文件，分为 ${groups.length} 组`;
    if (!groups.length) {
      groupsBox.replaceChildren(el("div", { class: "iib-empty", text: "没有可整理的文件（先在索引面板建立索引）" }));
      return;
    }
    const tbody = el("tbody", {});
    const rows = [];
    for (const group of groups) {
      const checkbox = el("input", { type: "checkbox" });
      checkbox.checked = true;
      const row = el("tr", {},
        el("td", {}, checkbox),
        el("td", { text: group.name }),
        el("td", { text: String(group.count) }),
        el("td", { class: "iib-panel-sub", text: (group.files || []).slice(0, 3).map((file) => file.name).join("、") }),
      );
      row.__checkbox = checkbox;
      row.__group = group;
      rows.push(row);
      tbody.append(row);
    }
    state.rows = rows;
    const table = el("table", { class: "iib-table" },
      el("thead", {}, el("tr", {},
        el("th", { text: "应用" }), el("th", { text: "分组" }), el("th", { text: "数量" }), el("th", { text: "示例" }),
      )),
      tbody,
    );
    groupsBox.replaceChildren(
      el("div", { class: "iib-actions-row", style: { marginTop: "6px" } },
        el("button", {
          class: "iib-btn",
          onclick: () => { state.rows.forEach((row) => { row.__checkbox.checked = true; }); },
        }, icon("checkbox-multiple-marked-outline"), "全选"),
        el("button", {
          class: "iib-btn",
          onclick: () => { state.rows.forEach((row) => { row.__checkbox.checked = false; }); },
        }, icon("checkbox-multiple-blank-outline"), "取消全部勾选"),
      ),
      table,
    );
  }

  async function search() {
    status.textContent = "正在搜索…";
    groupsBox.replaceChildren();
    previewBox.replaceChildren();
    result.replaceChildren();
    state.groups = [];
    state.rows = [];
    try {
      const payload = { by: by.value };
      if (scope.value === "dir" && dialog.currentAbs) payload.dir = dialog.currentAbs;
      const data = await jfetch("/organize/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      state.groups = data.groups || [];
      renderGroups(data.total || 0);
    } catch (err) {
      status.textContent = `搜索失败：${err.message || err}`;
    }
  }

  function selectedGroups() {
    return state.rows.filter((row) => row.__checkbox.checked).map((row) => row.__group);
  }

  function previewSelected() {
    if (!state.rows.length) {
      toast("warning", "请先点击「搜索」得到分组");
      return;
    }
    const groups = selectedGroups();
    if (!groups.length) {
      toast("warning", "请至少勾选一个分组");
      return;
    }
    const items = [];
    for (const group of groups) {
      for (const file of group.files || []) items.push(toItem(file));
    }
    previewBox.replaceChildren(
      el("div", { class: "iib-section-title", text: `已选 ${groups.length} 组，共 ${items.length} 张` }),
      el("div", { class: "iib-grid" }, items.map((item) => mediaCard(dialog, item, items))),
    );
    if (!items.length) {
      previewBox.replaceChildren(el("div", { class: "iib-empty", text: "所选分组没有文件" }));
    }
    previewBox.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  async function apply() {
    const groups = selectedGroups().map((group) => ({ name: group.name, files: group.files || [] }));
    if (!groups.length) { toast("warning", "请先搜索并选择分组"); return; }
    const total = groups.reduce((sum, group) => sum + group.files.length, 0);
    const ok = await confirmDialog(
      `把 ${total} 个文件${copyMode.checked ? "复制" : "移动"}到 ${targetRoot.selectedOptions[0]?.textContent || ""} / ${targetRel.value}？`,
      { title: "执行整理", danger: false, confirmText: "开始" },
    );
    if (!ok) return;
    status.textContent = "正在整理…";
    try {
      const data = await postJSON("/organize/apply", {
        groups,
        targetRoot: targetRoot.value,
        targetRel: targetRel.value,
        copy: copyMode.checked,
        force: forceMode.checked,
      });
      status.textContent = `完成：${data.moved} 个文件，失败 ${data.failed?.length || 0} 个`;
      result.replaceChildren(el("div", { class: "iib-actions-row" },
        actionButton("重新搜索", "refresh", search),
        actionButton("去浏览目录", "folder-open", () => dialog.setMode("browse")),
      ));
      toast("success", `整理完成，共处理 ${data.moved} 个文件`);
      dialog.refreshTreeBranch?.();
    } catch (err) {
      status.textContent = `整理失败：${err.message || err}`;
    }
  }

  fillRootSelect(targetRoot, dialog).catch(() => {});

  host.replaceChildren(shell("智能整理", "按模型 / 日期 / 标签等规则把文件归入子目录：搜索 → 勾选分组 → 预览 → 执行", [
    actionButton("搜索", "magnify", search),
    actionButton("预览分组", "eye-outline", previewSelected),
    el("button", { class: "iib-btn primary", onclick: apply }, icon("folder-move-outline"), "执行整理"),
  ], [
    el("div", { class: "iib-form" },
      field("分组依据", by),
      field("范围", scope),
      field("目标根目录", targetRoot),
      field("目标子目录", targetRel),
      el("label", { class: "iib-check" }, copyMode, el("span", { text: "复制模式（不移动原文件）" })),
      el("label", { class: "iib-check" }, forceMode, el("span", { text: "同名覆盖" })),
    ),
    el("div", { class: "iib-actions-row" }, status),
    groupsBox,
    previewBox,
    result,
  ]));
}

/* ---------------------------------------------------------------- 对比面板 */

function renderCompare(dialog, host) {
  const state = { a: null, b: null, split: 50 };
  const imgA = el("img", { class: "a" });
  const imgB = el("img", { class: "b" });
  const divider = el("div", { class: "iib-compare-divider" });
  const empty = el("div", { class: "iib-compare-empty", text: "选择两张图片进行对比" });
  const stage = el("div", { class: "iib-compare", style: { "--split": "50%" } }, imgA, imgB, divider, empty);
  const diff = el("div", { class: "iib-diff" });
  const labelA = el("span", { class: "iib-panel-sub", text: "未选择" });
  const labelB = el("span", { class: "iib-panel-sub", text: "未选择" });

  function setSplit(percent) {
    state.split = Math.max(0, Math.min(100, percent));
    stage.style.setProperty("--split", `${state.split}%`);
  }

  let dragging = false;
  stage.addEventListener("pointerdown", (event) => {
    dragging = true;
    stage.setPointerCapture?.(event.pointerId);
    const rect = stage.getBoundingClientRect();
    setSplit(((event.clientX - rect.left) / rect.width) * 100);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    setSplit(((event.clientX - rect.left) / rect.width) * 100);
  });
  stage.addEventListener("pointerup", () => { dragging = false; });
  stage.addEventListener("pointerleave", () => { dragging = false; });

  async function refresh() {
    empty.classList.toggle("iib-hidden", !!(state.a && state.b));
    imgA.src = state.a?.url || "";
    imgB.src = state.b?.url || "";
    imgA.style.display = state.a ? "block" : "none";
    imgB.style.display = state.b ? "block" : "none";
    labelA.textContent = state.a ? state.a.name : "未选择";
    labelB.textContent = state.b ? state.b.name : "未选择";
    diff.replaceChildren();
    if (!state.a || !state.b) return;
    try {
      const [infoA, infoB] = await Promise.all([
        jfetch(`/info?path=${encodeURIComponent(state.a.abs)}`),
        jfetch(`/info?path=${encodeURIComponent(state.b.abs)}`),
      ]);
      const promptA = infoA?.comfy?.["正向提示词"] || "";
      const promptB = infoB?.comfy?.["正向提示词"] || "";
      diff.append(diffColumn("A · " + state.a.name, promptA, promptB, "only-a"));
      diff.append(diffColumn("B · " + state.b.name, promptB, promptA, "only-b"));
    } catch (err) {
      diff.append(el("div", { class: "iib-panel-sub", text: `提示词读取失败：${err.message || err}` }));
    }
  }

  async function pick(slot) {
    const item = await pickImage(dialog);
    if (!item) return;
    state[slot] = item;
    refresh();
  }

  host.replaceChildren(shell("图片对比", "拖动中间分隔线查看差异，下方对比提示词", [
    actionButton("选择 A", "image-plus", () => pick("a")),
    actionButton("选择 B", "image-plus", () => pick("b")),
    actionButton("交换", "swap-horizontal", () => { const tmp = state.a; state.a = state.b; state.b = tmp; refresh(); }),
  ], [
    el("div", { class: "iib-compare-wrap" }, stage, el("div", { class: "iib-actions-row" }, labelA, el("div", { class: "iib-header-spacer" }), labelB)),
    el("div", { class: "iib-section-title", text: "提示词差异" }),
    diff,
  ]));
  refresh();
}

function diffColumn(title, own, other, onlyClass) {
  const ownParts = splitPrompt(own);
  const otherParts = new Set(splitPrompt(other));
  const content = el("pre", {});
  if (!ownParts.length) {
    content.append(el("span", { class: "same", text: "（无提示词）" }));
  }
  ownParts.forEach((part, index) => {
    if (index) content.append(document.createTextNode("，"));
    content.append(el("span", { class: otherParts.has(part) ? "same" : onlyClass, text: part }));
  });
  return el("div", {}, el("div", { class: "iib-section-title", text: title }), content);
}

function splitPrompt(text) {
  return String(text || "")
    .split(/[,，\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

async function pickImage(dialog) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "iib-modal iib-scope" });
    const card = el("div", { class: "iib-modal-card", style: { width: "min(980px, 94vw)" } });
    const input = el("input", { class: "iib-input", placeholder: "搜索文件名 / 提示词，留空显示最新图片" });
    const grid = el("div", { class: "iib-grid", style: { maxHeight: "62vh", overflow: "auto", padding: "6px" } });
    const close = (value) => { overlay.remove(); resolve(value); };

    async function search() {
      grid.replaceChildren(el("div", { class: "iib-empty", text: "加载中…" }));
      try {
        const q = input.value.trim();
        const params = new URLSearchParams({ size: "60", sort: "mtime_desc" });
        if (q) params.set("q", q);
        const data = await jfetch(`/search?${params.toString()}`);
        const items = data.items || [];
        grid.replaceChildren(...items.map((item, index) => el("div", {
          class: "iib-card",
          title: item.name,
          dataset: { index: String(index) },
        },
          el("img", { src: item.thumb, loading: "lazy", alt: item.name }),
          el("div", { class: "caption", text: item.name }),
        )));
        if (!items.length) grid.replaceChildren(el("div", { class: "iib-empty", text: "没有结果" }));
        grid.__items = items;
      } catch (err) {
        grid.replaceChildren(el("div", { class: "iib-empty", text: `失败：${err.message || err}` }));
      }
    }

    grid.addEventListener("click", (event) => {
      const cardEl = event.target.closest(".iib-card");
      if (!cardEl) return;
      const index = Number(cardEl.dataset.index);
      const items = grid.__items || [];
      if (items[index]) close(items[index]);
    });

    input.addEventListener("input", () => { clearTimeout(input.__timer); input.__timer = setTimeout(search, 320); });
    input.addEventListener("keydown", (event) => { event.stopPropagation(); if (event.key === "Enter") search(); });
    card.append(el("div", { class: "iib-modal-title", text: "选择图片" }));
    card.append(input, grid);
    card.append(el("div", { class: "iib-modal-actions" }, el("button", { class: "iib-btn", onclick: () => close(null) }, "取消")));
    overlay.append(card);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(null); });
    document.body.append(overlay);
    setTimeout(() => input.focus(), 0);
    search();
  });
}

/* ---------------------------------------------------------------- 竖屏流 */

function renderFeed(dialog, host) {
  const feed = el("div", { class: "iib-feed iib-scroll" });
  const status = el("div", { class: "iib-panel-sub" });

  async function load(shuffle = false) {
    feed.replaceChildren(el("div", { class: "iib-empty", text: "加载中…" }));
    try {
      const params = new URLSearchParams({ size: "60", sort: shuffle ? "random" : "mtime_desc" });
      if (dialog.tagFilter.length) params.set("tags", dialog.tagFilter.join(","));
      const data = await jfetch(`/search?${params.toString()}`);
      let items = data.items || [];
      if (!items.length && dialog.rootId) {
        const listParams = new URLSearchParams({
          root: dialog.rootId, path: dialog.rootId ? (dialog.rel || "") : "",
          size: "60", sort: shuffle ? "mtime_desc" : "mtime_desc", kind: "all",
        });
        const listed = await jfetch(`/list?${listParams.toString()}`);
        items = (listed.items || []).slice(0, 60);
      }
      status.textContent = `${items.length} 个作品 · 上下滚动 / ↑↓ 切换`;
      feed.replaceChildren(...items.map((item) => feedItem(dialog, item, items)));
      if (!items.length) feed.replaceChildren(el("div", { class: "iib-empty", text: "没有可展示的作品（先去索引面板建立索引）" }));
    } catch (err) {
      feed.replaceChildren(el("div", { class: "iib-empty", text: `加载失败：${err.message || err}` }));
    }
  }

  feed.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const height = feed.clientHeight;
    feed.scrollBy({ top: event.key === "ArrowDown" ? height : -height, behavior: "smooth" });
  });
  feed.tabIndex = 0;

  host.replaceChildren(el("div", { class: "iib-panel" },
    el("div", { class: "iib-panel-head" },
      el("div", {}, el("div", { class: "iib-panel-title", text: "竖屏流" }), status),
      el("div", { class: "iib-header-spacer" }),
      actionButton("返回浏览", "arrow-left", () => dialog.setMode("browse")),
      actionButton("刷新", "refresh", () => load(false)),
      actionButton("随机", "shuffle-variant", () => load(true)),
    ),
    feed,
  ));
  load(false);
}

function feedItem(dialog, item, list) {
  const media = item.kind === "video"
    ? el("video", { src: item.url, controls: true, loop: true, muted: true, autoplay: true, playsinline: true })
    : el("img", { src: item.url, loading: "lazy", alt: item.name });
  return el("div", { class: "iib-feed-item" },
    media,
    el("div", { class: "iib-feed-overlay" },
      el("div", {},
        el("div", { class: "iib-feed-name", text: item.name }),
        el("div", { class: "iib-feed-meta", text: `${item.sizeText || fmtSize(item.size)} · ${item.mtimeText || fmtTime(item.mtime)}${item.model ? ` · ${item.model}` : ""}` }),
      ),
      el("div", { class: "iib-feed-buttons" },
        el("button", { class: "iib-btn", onclick: () => dialog.openLightbox(item, list) }, icon("arrow-expand"), "全屏"),
        el("button", { class: "iib-btn", onclick: () => dialog.loadToComfyUI(item) }, icon("send"), "载入"),
        el("button", { class: "iib-btn", onclick: () => dialog.assignTagsDialog([item.abs]) }, icon("tag-plus-outline"), "标签"),
      ),
    ),
  );
}

/* ---------------------------------------------------------------- 索引面板 */

function renderIndex(dialog, host) {
  const status = el("div", {});
  const progress = el("div", { class: "iib-progress" }, el("div", {}));
  const logs = el("div", {});
  let timer = null;

  async function load() {
    try {
      const data = await jfetch("/index/status");
      dialog.indexStatus = data;
      const scanning = data.status === "scanning" || data.status === "canceling";
      status.replaceChildren(
        el("div", { class: "iib-stat-cards" },
          statCard("已索引文件", data.indexed ?? 0),
          statCard("索引库大小", fmtSize(data.dbBytes || 0)),
          statCard("本次已扫描", data.scanned ?? 0),
          statCard("状态", scanning ? "扫描中" : "空闲"),
        ),
        el("div", { class: "iib-panel-sub", text: data.message || (data.last ? `上次扫描：新增 ${data.last.added}，更新 ${data.last.updated}，移除 ${data.last.removed}` : "还没有扫描记录") }),
        progress,
        el("div", { class: "iib-panel-sub", text: scanning && data.current ? `正在扫描：${data.current}` : "" }),
        el("div", { class: "iib-actions-row" },
          el("button", { class: "iib-btn primary", onclick: () => startScan(false), disabled: scanning }, icon("database-sync-outline"), "增量扫描"),
          el("button", { class: "iib-btn", onclick: () => startScan(true), disabled: scanning }, icon("database-refresh-outline"), "强制重建"),
          el("button", { class: "iib-btn", onclick: () => stopScan(), disabled: !scanning }, icon("stop-circle-outline"), "停止"),
          el("button", { class: "iib-btn danger", onclick: () => clearIndex(), disabled: scanning }, icon("database-remove-outline"), "清空索引"),
        ),
      );
      progress.firstElementChild.style.width = scanning ? `${Math.min(96, 8 + (data.scanned || 0) / 40)}%` : "0%";
      if (scanning) {
        const chip = dialog.indexChip;
        chip?.classList.add("scanning");
      }
      await loadLogs();
    } catch (err) {
      status.replaceChildren(el("div", { class: "iib-empty", text: `读取状态失败：${err.message || err}` }));
    }
  }

  async function loadLogs() {
    try {
      const data = await jfetch("/index/log");
      const rows = (data.logs || []).slice(0, 12);
      const table = el("table", { class: "iib-table" },
        el("thead", {}, el("tr", {},
          el("th", { text: "时间" }), el("th", { text: "新增" }), el("th", { text: "更新" }), el("th", { text: "移除" }), el("th", { text: "错误" }), el("th", { text: "耗时" }),
        )),
        el("tbody", {}, rows.map((row) => el("tr", {},
          el("td", { text: fmtTime(row.finished || row.started) }),
          el("td", { text: String(row.added) }),
          el("td", { text: String(row.updated) }),
          el("td", { text: String(row.removed) }),
          el("td", { text: String(row.errors) }),
          el("td", { text: `${Math.round(((row.finished || 0) - (row.started || 0)) * 10) / 10}s` }),
        ))),
      );
      logs.replaceChildren(el("div", { class: "iib-section-title", text: "扫描记录" }), rows.length ? table : el("div", { class: "iib-panel-sub", text: "暂无记录" }));
    } catch { /* ignore */ }
  }

  async function startScan(force) {
    try {
      await postJSON("/index/scan", { force });
      toast("info", force ? "开始强制重建索引…" : "开始增量扫描…");
      load();
    } catch (err) {
      toast("error", "启动失败", String(err?.message || err));
    }
  }

  async function stopScan() {
    try {
      await postJSON("/index/stop", {});
      toast("info", "已请求停止");
      load();
    } catch (err) { toast("error", "停止失败", String(err?.message || err)); }
  }

  async function clearIndex() {
    const ok = await confirmDialog("清空索引会删除标签与搜索数据（不会删除图片），确定吗？", { title: "清空索引" });
    if (!ok) return;
    try {
      await postJSON("/index/clear", {});
      toast("success", "索引已清空");
      load();
    } catch (err) { toast("error", "清空失败", String(err?.message || err)); }
  }

  const tools = el("div", { class: "iib-actions-row" },
    el("a", { class: "iib-btn", href: "/iib/export?format=json", download: "" }, icon("file-export-outline"), "导出 JSON"),
    el("a", { class: "iib-btn", href: "/iib/export?format=csv", download: "" }, icon("file-delimited-outline"), "导出 CSV"),
    el("button", {
      class: "iib-btn",
      onclick: async () => {
        try {
          const response = await fetch("/iib/backup/export", { method: "POST" });
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const link = el("a", { href: url, download: `iib-backup-${Date.now()}.db` });
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 6000);
          toast("success", "备份已下载");
        } catch (err) { toast("error", "备份失败", String(err?.message || err)); }
      },
    }, icon("database-export-outline"), "备份数据库"),
    el("button", {
      class: "iib-btn",
      onclick: async () => {
        try {
          const data = await postJSON("/cache/clear", {});
          toast("success", `已清理 ${data.removed} 个缩略图缓存`);
        } catch (err) { toast("error", "清理失败", String(err?.message || err)); }
      },
    }, icon("broom"), "清理缩略图缓存"),
  );

  host.replaceChildren(shell("索引", "索引是标签、搜索、统计与整理的数据来源；可随时停止，不阻塞生成", [
    actionButton("返回浏览", "arrow-left", () => dialog.setMode("browse")),
    actionButton("刷新", "refresh", () => load()),
  ], [status, tools, logs]));
  load();
  timer = setInterval(() => {
    if (!host.isConnected) { clearInterval(timer); return; }
    load();
  }, 2500);
  host.addEventListener("iib-dispose", () => clearInterval(timer), { once: true });
}

export function openCompareOverlay(dialog, a, b) {
  const overlay = el("div", { class: "iib-modal iib-scope", style: { background: "rgba(0,0,0,.78)" } });
  const card = el("div", {
    class: "iib-modal-card",
    style: { width: "min(1500px,96vw)", height: "92vh", display: "flex", flexDirection: "column", gap: "10px", padding: "12px" },
  });

  const imgA = el("img", { class: "a", src: a.url, alt: a.name });
  const imgB = el("img", { class: "b", src: b.url, alt: b.name });
  const divider = el("div", { class: "iib-compare-divider" });
  const stage = el("div", { class: "iib-compare", style: { flex: "1 1 auto", height: "auto" } }, imgA, imgB, divider);

  let dragging = false;
  const setSplit = (percent) => stage.style.setProperty("--split", `${Math.max(0, Math.min(100, percent))}%`);
  stage.addEventListener("pointerdown", (event) => {
    dragging = true;
    stage.setPointerCapture?.(event.pointerId);
    const rect = stage.getBoundingClientRect();
    setSplit(((event.clientX - rect.left) / rect.width) * 100);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    setSplit(((event.clientX - rect.left) / rect.width) * 100);
  });
  stage.addEventListener("pointerup", () => { dragging = false; });
  stage.addEventListener("pointerleave", () => { dragging = false; });

  const diff = el("div", { class: "iib-diff", style: { maxHeight: "26vh", overflow: "auto" } });
  const head = el("div", { class: "iib-panel-head", style: { border: "none", padding: "0 2px" } },
    el("div", { class: "iib-title", style: { fontSize: "13px" } }, icon("compare-horizontal"), el("span", { text: "图片对比" })),
    el("div", { class: "iib-subtitle", text: `${a.name}  ↔  ${b.name}` }),
    el("div", { class: "iib-header-spacer" }),
    el("button", { class: "iib-btn icon ghost", title: "关闭", onclick: () => overlay.remove() }, icon("close")),
  );
  card.append(head, stage, diff);
  overlay.append(card);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) overlay.remove(); });
  document.body.append(overlay);

  (async () => {
    try {
      const [infoA, infoB] = await Promise.all([
        jfetch(`/info?path=${encodeURIComponent(a.abs)}`),
        jfetch(`/info?path=${encodeURIComponent(b.abs)}`),
      ]);
      const promptA = infoA?.comfy?.["正向提示词"] || "";
      const promptB = infoB?.comfy?.["正向提示词"] || "";
      if (!promptA && !promptB) {
        diff.replaceChildren(el("div", { class: "iib-panel-sub", text: "两张图都没有可读的提示词" }));
        return;
      }
      diff.append(diffColumn(`A · ${a.name}`, promptA, promptB, "only-a"));
      diff.append(diffColumn(`B · ${b.name}`, promptB, promptA, "only-b"));
    } catch (err) {
      diff.replaceChildren(el("div", { class: "iib-panel-sub", text: `提示词读取失败：${err.message || err}` }));
    }
  })();
}

/* ---------------------------------------------------------------- 双栏浏览 */

function renderSplit(dialog, host) {
  const panes = [];

  function makePane(index) {
    const state = {
      rootId: dialog.roots[index % Math.max(1, dialog.roots.length)]?.id || "",
      rel: "",
    };
    const pathLabel = el("div", { class: "iib-panel-sub", text: "" });
    const rootSelect = el("select", { class: "iib-select" },
      ...(dialog.roots || []).map((root) => el("option", { value: root.id, text: root.label })),
    );
    rootSelect.value = state.rootId;
    rootSelect.addEventListener("change", () => {
      state.rootId = rootSelect.value;
      state.rel = "";
      load();
    });

    const upBtn = el("button", {
      class: "iib-btn icon", title: "上一级",
      onclick: () => {
        if (!state.rel) return;
        const parts = state.rel.split("/").filter(Boolean);
        parts.pop();
        state.rel = parts.join("/");
        load();
      },
    }, icon("arrow-up"));

    const grid = el("div", { class: "iib-grid", style: { padding: "10px", alignContent: "start" } });
    const body = el("div", { class: "iib-split-pane" },
      el("div", { class: "iib-toolbar", style: { padding: "8px" } }, rootSelect, upBtn, pathLabel),
      el("div", { class: "iib-grid-wrap iib-scroll" }, grid),
    );

    async function load() {
      grid.replaceChildren(el("div", { class: "iib-empty", text: "加载中…" }));
      try {
        const params = new URLSearchParams({
          root: state.rootId, path: state.rel, size: "120", sort: "mtime_desc", kind: "all",
        });
        const data = await jfetch(`/list?${params.toString()}`);
        pathLabel.textContent = `${data.root?.label || ""}${state.rel ? ` / ${state.rel}` : ""}`;
        const dirCards = (data.dirs || []).map((dir) => el("div", {
          class: "iib-card dir", title: dir.name,
          onclick: () => { state.rel = dir.rel; load(); },
        },
          el("div", { class: "placeholder" }, icon("folder")),
          el("div", { class: "caption", text: dir.name }),
        ));
        const fileCards = (data.items || []).map((item) => mediaCard(dialog, item, data.items));
        grid.replaceChildren(...dirCards, ...fileCards);
        if (!dirCards.length && !fileCards.length) {
          grid.replaceChildren(el("div", { class: "iib-empty", text: "空目录" }));
        }
      } catch (err) {
        grid.replaceChildren(el("div", { class: "iib-empty", text: `加载失败：${err.message || err}` }));
      }
    }

    load();
    panes.push({ load, state });
    return body;
  }

  host.replaceChildren(shell("双栏浏览", "左右两个独立目录，适合把两个文件夹放在一起对照", [], [
    el("div", { class: "iib-split" }, makePane(0), makePane(1)),
  ]));
}

/* ---------------------------------------------------------------- 入口 */

export function renderPanel(dialog, mode, host) {
  host.replaceChildren();
  switch (mode) {
    case "search": renderSearch(dialog, host); break;
    case "stats": renderStats(dialog, host); break;
    case "organize": renderOrganize(dialog, host); break;
    case "feed": renderFeed(dialog, host); break;
    case "index": renderIndex(dialog, host); break;
    default: host.replaceChildren(el("div", { class: "iib-empty", text: "未知面板" }));
  }
}
