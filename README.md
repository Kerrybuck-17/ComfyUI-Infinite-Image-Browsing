# ComfyUI Infinite Image Browsing

> **本项目由 [DeepSeek](https://www.deepseek.com/) 从 [sd-webui-infinite-image-browsing (IIB)](https://github.com/zanllp/infinite-image-browsing) 移植到 ComfyUI**，是非官方移植版本。
> 全部界面已按 ComfyUI 原生 UI 体系重写，设置项接入 ComfyUI 设置面板。

原项目 **IIB** 是面向 AI 绘画的高性能无限图像浏览器：为 SD WebUI、ComfyUI、Fooocus、NovelAI、StableSwarmUI、InvokeAI 等生成工具的产出提供毫秒级缩略图浏览、标签检索、收藏、整理、对比、批量下载与索引能力。

本移植版把 IIB 的核心体验带进 ComfyUI：**接管左侧边栏的「资产」按钮**，点击后打开一个与「模板」按钮同款的大窗口，用 ComfyUI 原生组件重建浏览、标签、搜索、统计、整理、对比、竖屏流、收藏、索引等能力，并把所有选项放进 `设置 → 无限图像浏览`。

---

## 特性

### 与 ComfyUI 的整合

- **接管「资产」按钮**：点击打开窗口，不再展开原生资产侧栏；命令、快捷键、侧栏 store 三处同时接管。
- **浏览器式多标签栏**：每个标签独立保存目录、前进/后退历史，`+` 新建、`×` 关闭。
- **全部使用 ComfyUI 原生 UI**：CSS 变量主题、material 图标、原生设置面板；明暗主题自动跟随。
- **原生设置项**：18 个选项全部在 `设置 → 无限图像浏览`，附加目录为列表管理（新增/移除，不删除文件）。
- **左右面板可拖拽调整宽度**，双击分隔条恢复默认，宽度记忆。
- **原生 toast** 会显示在窗口之上；窗口标记 `notranslate`，避免翻译插件改写目录名。

### 浏览

- 多根目录：`output`、`input`、`temp`、任意自定义目录；目录树懒加载、自动展开当前路径、无子目录时隐藏展开箭头。
- 缩略图网格（服务端 WebP 缓存、懒加载、无限滚动）；**缩略图预览 / 图像原比例显示**（二选一互斥）。
- 排序作用于文件夹与图片；**类型筛选会递归隐藏不含对应媒体的文件夹**。
- 子文件夹显示 **2×2 封面拼图** 与文件夹角标；选中显示勾选。
- 预览面板：尺寸、大小、时间、标签、模型 / LoRA / 采样器 / 步数 / CFG / 种子 / 正负提示词；全部元数据查看。
- 全屏灯箱：← → 切换、加标签、载入、下载。
- **显示子文件夹内容**（递归列出）、随机、自动刷新。

### 检索与整理

- **标签**：自动标签（提示词 + 模型 + LoRA）与手动标签，按次数排序、重命名、删除、标签共现关系图。
- **搜索**：文件名 / 提示词 / 模型 / 标签（任一或同时）/ 类型 / 日期 / 大小 / 排序，分页。
- **统计**：文件数、占用空间、按天产量柱状图、模型分布、高频标签、重复图检测与清理。
- **整理**：搜索分组 → 全选 / 取消全部勾选 → 预览所选分组全部图片 → 按规则移动/复制（同名覆盖可选）。
- **收藏**：卡片心形、预览收藏、右键菜单、只看收藏。
- 批量打包下载（服务端 zip）、导出 JSON/CSV、备份索引库、清理缩略图缓存。

### 与画布联动

- **载入到 LoadImage**：复制到 `input/iib/` 并写入或新建节点。
- **加载工作流**：直接调用 ComfyUI 原生 `handleFile`（与拖拽进画布一致），原生解析 `workflow` / `prompt` / WebUI `parameters`（含 LoRA、CLIP skip、尺寸、种子）。
- **编辑提示词**：修改 PNG 文本块后写回原图。
- **保存文件名前缀**：载入工作流后把 `SaveImage.filename_prefix` 设为配置值（默认 `%year%-%month%-%day%/ComfyUI`）。

### 竖屏流

TikTok 式整屏滚动，右上角按钮进入，支持刷新与随机；索引为空时回退到当前目录。

### 图片对比（拖动触发）

拖动任意图片时，窗口正下方居中弹出不透明的「拖到这里对比」窗：放入第一张后窗口保留并显示在 A 槽，放满第二张自动打开对比视图（叠放滑块 + 提示词词级差异），或点 × 关闭。

---

## 安装

### 通过 ComfyUI Manager

在 Manager 中搜索 **Infinite Image Browsing** 安装，或打开 [Comfy Registry 页面](https://registry.comfy.org/nodes/comfyui-infinite-image-browsing)。

### 手动安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Kerrybuck-17/ComfyUI-Infinite-Image-Browsing.git
```

重启 ComfyUI，日志出现：

```
[IIB] Infinite Image Browsing (ComfyUI port) 已加载，版本 1.0.0
```

点击左侧「资产」；升级后 `Ctrl + F5` 刷新一次浏览器缓存。

首次使用建议先到「索引」面板点一次「增量扫描」，标签 / 搜索 / 统计 / 整理才有数据。

---

## 设置项（18 项）

路径：`设置 → 无限图像浏览`

| 分组 | 设置项 |
| --- | --- |
| 目录 | 显示输入目录、显示临时目录、附加目录（列表管理） |
| 外观 | 网格单元尺寸、缩略图分辨率、显示视频、使用缩略图预览、图像原比例显示 |
| 行为 | 每次加载数量、默认排序、记住上次位置、允许文件操作、自动刷新间隔、目录展开时隐藏路径栏、保存文件名前缀 |
| 性能 | 搜索递归深度、搜索匹配生成信息、启动时自动建立索引 |

> 「使用缩略图预览」与「图像原比例显示」互斥，开启一个会自动关闭另一个。

---

## 快捷键

| 键 | 作用 |
| --- | --- |
| `1`–`4` | 浏览 / 搜索 / 统计 / 整理 |
| `/` | 回浏览并聚焦搜索框 |
| `F5` | 刷新目录（含目录树） |
| `Delete` | 删除选中 |
| `Ctrl/⌘ + A` | 全选 |
| `Ctrl/⌘ + 点击`、`Shift + 点击` | 多选 / 连选 |
| `←` `→` | 灯箱切换 |
| `↑` `↓` | 竖屏流滚动 |
| `Esc` | 关闭菜单 / 灯箱 / 窗口 |

---

## 数据位置

- 索引库：`<user 目录>/iib/index.db`（SQLite WAL）
- 缩略图缓存：`<user 目录>/iib/thumbs`
- 设置：ComfyUI 自身设置存储 + `<user 目录>/iib/settings.json`
- 附加目录列表只影响插件显示，不会删除磁盘文件

---

## 已知差异

- **语义搜索 / AI 聚类 / 智能命名**：原版依赖 OpenAI 兼容接口与向量库，本移植使用确定性规则分组，不联网。
- **多语言界面**：当前为中文。
- **访问密钥 / 只读 Web 开关**：面向本机 ComfyUI 使用。
- **快捷键自定义**：使用内置快捷键。

---

## 开发

```
ComfyUI-Infinite-Image-Browsing/
├── __init__.py          # WEB_DIRECTORY + 路由注册
├── iib/
│   ├── api.py           # 浏览 / 缩略图 / 文件操作 / workflow
│   ├── api_extra.py     # 索引 / 标签 / 收藏 / 搜索 / 统计 / 整理 / 打包 / 备份
│   ├── config.py        # 设置持久化、根目录与越界校验
│   ├── db.py            # SQLite（files / tags / favorites / scan_log）
│   ├── indexer.py       # 后台扫描、自动标签、感知哈希
│   ├── meta.py          # PNG / EXIF / ComfyUI prompt / A1111 解析
│   ├── routes.py        # 共享路由表
│   └── thumb.py         # 缩略图与目录封面缓存
├── web/
│   ├── iib.js           # 主窗口、标签页、灯箱、拖拽对比
│   ├── iib-panels.js    # 搜索 / 统计 / 整理 / 竖屏 / 索引
│   ├── iib-ui.js        # 共享 UI 工具
│   └── iib.css          # 基于 ComfyUI CSS 变量
├── pyproject.toml
├── LICENSE
└── README.md
```

---

## 致谢

- 原始项目：[zanllp/sd-webui-infinite-image-browsing](https://github.com/zanllp/infinite-image-browsing)（MIT）
- 移植与 ComfyUI 适配：DeepSeek

## 许可证

MIT，见 [LICENSE](./LICENSE)。原项目版权归 zanllp 所有。
