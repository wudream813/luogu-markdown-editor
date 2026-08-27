# 洛谷 Markdown & KaTeX 实时预览编辑器 (Windows 桌面轻量版)

一款专为洛谷算法竞赛选手、学术创作者、题解撰写者量身打造的**轻量级、所见即所得、支持 KaTeX 与全部洛谷扩展语法的实时双栏 Markdown 编辑器**。

---

## ✨ 核心特性

1. **100% 完整支持《洛谷 Markdown 格式手册》全部语法**：
   - **基础排版**：标准 CommonMark / GFM 语法、段落、行末双空格与反斜杠 `\` 紧凑换行、标题、粗体、斜体、粗斜体、删除线、反斜杠转义。
   - **洛谷代码块**：
     - 未指定语言时自动 fallback 为 C++（符合洛谷规则）。
     - 支持 `line-numbers` 显示代码行号。
     - 支持 `lines=start-end` 或 `lines=3,5-7` 指定高亮代码行。
     - 一键复制代码块内容，附带语言标签。
   - **表格合并【新特性】**：
     - 支持单元格内 `^` 向上合并（rowspan）。
     - 支持单元格内 `<` 向左合并（colspan）。
     - 支持 `^` 与 `<` 混合嵌套合并。
     - 支持 `::cute-table{tuack}` Tuack 竞赛风格美化表格。
   - **折叠框【新特性】**：
     - 支持 `:::info`、`:::success`、`:::warning`、`:::error` 四种语义折叠框。
     - 支持 `{open}` 参数设置默认展开状态。
     - **折叠框标题支持 LaTeX 数学公式**（例如 `::::success[$$\sum_{i=1}^n \gcd(i, j)$$]`）。
     - 支持多层深度嵌套（`:::`、`::::`、`:::::`、`::::::` 等）。
   - **引言【新特性】**：
     - 支持 `:::epigraph[落款作者]` 优雅引言块。
   - **居中与居右排版【新特性】**：
     - 支持 `:::align{center}` 与 `:::align{right}`。
   - **Bilibili 视频嵌入**：
     - 支持 `![](bilibili:BV号)`、`![](bilibili:av号)` 以及带时间/分P参数的嵌入播放器。

2. **高性能 KaTeX 数学公式排版**：
   - 支持行内公式 `$x$` 与行间公式 `$$\sum_{i=1}^n \frac{1}{i}$$`。
   - 内置 **LaTeX 数学公式面板与速查助手**，一键插入希腊字母、二元关系符、微积分巨运算符、分段函数 `cases`、矩阵 `pmatrix`/`bmatrix`、多行等号对齐 `aligned`、数集字体 `\mathbb{R}`、复杂度 `\mathcal{O}`、字号及字体颜色等。

3. **专为 Windows 打造的轻量丝滑体验**：
   - **双向精准同步滚动**：编辑区与预览区智能同步，长文排版不迷失。
   - **洛谷排版规范检查与一键修复**：内置排版规范 Linter 与盘古算法，一键在汉字与英文、数字、LaTeX 公式之间添加规范空格，检测公式包裹完整度与代码块语言。
   - **洛谷官方预设模板库**：内置洛谷全特性演示、符合审核规范的标准题解模板、题目题面模板、学术专栏模板。
   - **本地自动保存与历史回滚**：实时持久化至本地存储，支持撤销/重做（`Ctrl+Z`/`Ctrl+Y`），撤销后光标自动回到编辑位置；保存失败（如存储空间不足）会明确告警而非静默丢稿。
   - **多格式导出**：一键复制洛谷 Markdown 源码、导出独立单文件 HTML（离线可用）、打印/导出为 PDF。
   - **多套精致主题**：洛谷官方经典蓝白风、暗夜黑客主题、学术纯白极简风。
   - **移动端适配**：窄屏下双栏自动纵向堆叠，支持触屏操作。
   - **安全渲染**：预览区对 URL 协议做白名单校验并转义原始 HTML，粘贴他人题解不会被 XSS 攻击。
   - **线性渲染性能**：解析器为 O(n) 复杂度，360KB 长文档渲染约 150ms。

---

## Windows 运行使用指南

本项目提供三种运行方式，均完全开箱即用：

### 方式一：单文件免安装离线版（最轻量、推荐）
- 前往本仓库的 **[Releases](https://github.com/wudream813/luogu-markdown-editor/releases)** 页面，
  下载 **`LuoguMarkdownEditor.html`**，双击即可打开。
- 若想自行构建：克隆仓库后执行 `node build-standalone.js`，产物即为该文件。
- 会在您默认的浏览器（如 Microsoft Edge / Google Chrome）中以单文件纯离线方式打开，无任何依赖，体积仅 ~580KB，所有 KaTeX、代码高亮、排版引擎均已内嵌！

### 方式二：Windows 快捷启动脚本
- 双击运行 **`run.bat`** 或右键使用 PowerShell 运行 **`run.ps1`**。
- 脚本会自动检测 Python 环境并启动本地轻量服务并打开应用界面。

### 方式三：Python 桌面模式
- 在终端中运行：
  ```bash
  python app.py
  ```
- 即可启动本地服务并自动调起桌面窗口。

---

## ⌨️ 常用快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + S` | 保存 Markdown 文件到本地 |
| `Ctrl + B` | 加粗选中文本 (`**加粗**`) |
| `Ctrl + I` | 斜体选中文本 (`*斜体*`) |
| `Ctrl + K` | 插入超链接 |
| `Ctrl + Shift + K` | 插入行内数学公式 (`$x$`) |
| `Ctrl + Shift + M` | 插入行间独立数学公式 (`$$ ... $$`) |
| `Ctrl + Z` | 撤销 |
| `Ctrl + Y` 或 `Ctrl + Shift + Z` | 重做 |
| `Tab` / `Shift + Tab` | 增加 / 减少缩进 (4 空格) |

---

## 📂 项目文件结构

```
luogu-markdown-editor/
├── LuoguMarkdownEditor.html   # 100% 独立单文件便携离线版 (双击即开)
├── index.html                 # 主程序入口页面
├── app.py                     # Python 桌面启动器
├── run.bat                    # Windows 批处理快速启动脚本
├── run.ps1                    # Windows PowerShell 启动脚本
├── package.json               # 项目配置
├── build-standalone.js        # 单文件打包构建工具
├── src/
│   ├── luogu-parser.js        # 洛谷 Markdown + KaTeX 解析与渲染引擎
│   ├── luogu-linter.js        # 洛谷排版规范检测与空格自动修复
│   ├── luogu-math-cheatsheet.js # LaTeX 数学公式库与速查助手
│   ├── luogu-templates.js     # 洛谷官方题解/题面/文章预设模板
│   ├── editor.js              # 编辑器核心交互控制与双向同步滚动
│   └── styles.css             # 洛谷官方风格与深浅色主题样式
└── assets/                    # 本地内嵌 KaTeX 与 Prism.js 静态库
    ├── katex/
    └── prism/
```

## 开发

```bash
npm install                # 取 KaTeX / Prism 资源
node --test test/          # 解析器 / 排版单元测试
node build-standalone.js   # 构建单文件离线版
python3 app.py             # 启动本地服务（仅绑定 127.0.0.1）

# 浏览器端套件（需 npx playwright install chromium），针对构建产物运行
node test/browser/xss.test.js         # XSS 向量回归
node test/browser/fidelity.test.js    # 渲染保真度
node test/browser/robustness.test.js  # 畸形输入 / ReDoS
```

参与开发请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 项目结构

```
index.html                 开发用薄壳：纯 HTML 结构，通过 <link>/<script> 引用真实源码
src/                       样式与逻辑（styles.css, luogu-parser.js, editor.js …）
assets/                    第三方依赖本地副本（KaTeX, Prism 及字体）
build-standalone.js        构建脚本：内联全部资源，产出单文件版
LuoguMarkdownEditor.html   构建产物（不提交版本库，见 Releases）
```

数据流是**单向**的：

```
index.html + src/** + assets/**  ──build──▶  LuoguMarkdownEditor.html
```

日常开发**直接改 `src/`，然后刷新 `index.html` 即可**，无需每次构建。
只有发布时才需要跑 `node build-standalone.js`。

> 历史说明：早期 `index.html` 本身就是一份 928KB 的全内联文件，构建脚本读它、改它、
> 再写回去，既是输入又是输出。结果两份 HTML 悄悄脱节（`index.html` 一度仍在使用旧版
> 解析器），而且改一行 CSS 就会产生 928KB 的 diff。现在 `index.html` 只有 42KB。

### 安全说明

预览区通过 `innerHTML` 注入渲染结果，因此解析器承担净化职责：

- URL 仅允许 `http(s):` / `mailto:` / `ftp:` / `tel:` / 锚点 / 相对路径，其余（如
  `javascript:`、`data:`、`vbscript:`）一律替换为 `#`；比对前会剥离控制字符，
  防止 `java\tscript:` 之类的绕过。
- 原始 HTML 标签一律转义。这既堵住 XSS，也更贴近洛谷真实行为——洛谷本身不渲染
  任意 HTML。
- KaTeX 的 `trust` 按命令逐条判定，而非整体开启：`\href` / `\url` 复用上面同一套
  URL 白名单，`\includegraphics`、`\htmlClass` 等能拉取远程资源或注入属性的命令
  一律拒绝。（早先 `trust: true` 会让公式绕过 URL 检查，产出可点击的
  `javascript:` 链接。）
- Bilibili 播放器采用点击后加载，未点击时不会向 bilibili.com 发起任何请求。

上述性质由 `test/browser/xss.test.js` 中的 32 个攻击向量在真实浏览器里持续验证，
并纳入 CI。发现安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。

### 第三方组件

本项目内联打包了 KaTeX 与 Prism（均为 MIT），版权声明见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
