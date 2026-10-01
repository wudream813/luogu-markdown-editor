# 洛谷 Markdown & KaTeX 实时预览编辑器

一款专为洛谷算法竞赛选手、学术创作者、题解撰写者量身打造的**轻量级、所见即所得、支持 KaTeX 与全部洛谷扩展语法的实时双栏 Markdown 编辑器**。

同一套渲染引擎，三种用法：**网页在线版**、**单文件离线版**、**桌面应用版**
（Windows / macOS / Linux）。

**▶ [在线使用](https://wudream813.github.io/luogu-markdown-editor/)** ——
打开即用，无需安装；所有内容仅存于浏览器本地，不上传任何服务器。

**⬇ [下载](https://github.com/wudream813/luogu-markdown-editor/releases/latest)** ——
单文件 HTML、Windows 安装包 / 绿色版、macOS 通用二进制、Linux AppImage / deb，
同一个版本号下全部集中在一个 Release 里。

[![CI](https://github.com/wudream813/luogu-markdown-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/wudream813/luogu-markdown-editor/actions/workflows/ci.yml)
[![Desktop](https://github.com/wudream813/luogu-markdown-editor/actions/workflows/desktop.yml/badge.svg)](https://github.com/wudream813/luogu-markdown-editor/actions/workflows/desktop.yml)
[![Pages](https://github.com/wudream813/luogu-markdown-editor/actions/workflows/pages.yml/badge.svg)](https://github.com/wudream813/luogu-markdown-editor/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 📦 该用哪一种？

| 用法 | 适合 | 怎么拿 |
| :--- | :--- | :--- |
| **网页在线版** | 想立刻开写、不做任何安装 | [在线使用](https://wudream813.github.io/luogu-markdown-editor/) |
| **单文件离线版** | 断网环境、U 盘随身带、机房电脑 | Release 里的 `LuoguMarkdownEditor.html`，双击即用 |
| **桌面应用版** | 日常写题解：要文件关联、标签页与文件树、能写回磁盘 | Release 里的安装包（Windows `.exe` / 绿色版，macOS `.dmg`，Linux AppImage / `.deb`） |

三种用法是**同一份代码**：桌面版的前端产物就是 `LuoguMarkdownEditor.html` 本身
（构建时复制成 `desktop/dist/index.html`），网页版与单文件版出自同一次构建，
所以渲染结果、快捷键、导出行为完全一致——不存在"桌面版看起来不一样"这种事。

---

## ✨ 核心特性

1. **100% 完整支持《洛谷 Markdown 格式手册》全部语法**：
   - **基础排版**：标准 CommonMark / GFM 语法、段落、行末双空格与反斜杠 `\` 紧凑换行、标题（`#` 与 setext 下划线式）、粗体、斜体、粗斜体、删除线、反斜杠转义。
   - **GFM 链接与脚注**：裸链接自动识别（autolink literal）、引用式链接（`[文字][标签]` / `[标签]`）、脚注（`[^1]`，自动生成脚注区与回跳锚点）。
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
   - **空状态直接插入**：关闭所有标签后，点击工具栏插入或在插入面板确认，会自动新建未命名草稿并立即渲染预览；无需先打开文件。取消插入不会创建草稿。
   - **本地自动保存与历史回滚**：停止输入后按所选间隔持久化至本地存储（网页版可关闭），支持撤销/重做（`Ctrl+Z`/`Ctrl+Y`），撤销后光标自动回到编辑位置；保存失败（如存储空间不足）会明确告警而非静默丢稿。
   - **多格式导出**：一键复制洛谷 Markdown 源码、导出独立单文件 HTML（离线可用）、打印/导出为 PDF。
   - **多套精致主题**：洛谷官方经典蓝白风、暗夜黑客主题、学术纯白极简风。
   - **移动端适配**：窄屏下双栏自动纵向堆叠，支持触屏操作。
   - **设置子页面【新特性】**：点顶栏齿轮弹出设置页（`Esc` / 「完成」关闭），分 外观 / 语言 / 编辑器 三节 —— 主题（亮色 / 暗色）、界面语言（跟随系统 / 简体中文 / English）、显示排版问题，两端都有**自动保存间隔**（0.5 / 1 / 2.5 / 5 / 10 秒），网页版可开关浏览器自动保存（草稿及全部标签内容，不写回原文件），桌面版可开关自动保存到文件与保存时自动排版。网页版不再显示顶栏太阳入口，主题在设置里修改。所有选项都是下拉框或开关，改完即生效并记住。
   - **中英双语界面【新特性】**：首次打开跟随系统语言，手动切换后记住。界面外壳、排版检查提示、帮助手册与数学公式速查表都有英文；还没翻到的条目回退中文原文，绝不会露出 `key`。
   - **安全渲染**：预览区对 URL 协议做白名单校验并转义原始 HTML，粘贴他人题解不会被 XSS 攻击。
   - **线性渲染性能**：解析器为 O(n) 复杂度，360KB 长文档渲染约 150ms。

---

## 运行使用指南

四种运行方式，均完全开箱即用，且共用同一套渲染与编辑逻辑。

### 方式一：浏览器在线版（最省事）

直接打开 <https://wudream813.github.io/luogu-markdown-editor/>。

Github 访问慢的，可以使用镜像站：<https://mark.cheese-zzz.cloud/>。

若镜像站不可用，请使用镜像站2：<https://mark.cheese-zzz.top/>，详见 [issues](https://github.com/wudream813/luogu-markdown-editor/issues/2)。

镜像站由 @Transparent-fish 提供，内容同步自本站。镜像站仓库 Fork 链接：[Link](https://github.com/Transparent-fish/luogu-markdown-editor)。

这是同一份代码的在线部署，功能与离线版完全一致。文档保存在浏览器
localStorage 里，**不会上传到任何服务器**；换设备或清理浏览器数据前，
记得用「导出」功能保存文件。

### 方式二：单文件免安装离线版（最轻量）
- 前往本仓库的 **[Releases](https://github.com/wudream813/luogu-markdown-editor/releases)** 页面，
  下载 **`LuoguMarkdownEditor.html`**，双击即可打开。
- 若想自行构建：克隆仓库后执行 `node build-standalone.js`，产物即为该文件。
- 会在您默认的浏览器（如 Microsoft Edge / Google Chrome）中以单文件纯离线方式打开，无任何依赖，体积约 1.5MB（KaTeX 字体、代码高亮、长图导出引擎全部内嵌），断网也能用。

### 方式三：桌面应用版（Windows / macOS / Linux）

到 [Releases](https://github.com/wudream813/luogu-markdown-editor/releases/latest)
按系统取安装包：

| 系统 | 安装版 | 免安装版 |
| :--- | :--- | :--- |
| Windows 10/11 | `…-windows-x64-setup.exe` | `…-windows-x64-portable.zip` |
| macOS（Intel / Apple 芯片均可） | `…-macos-universal.dmg` | `…-macos-universal-portable.tar.gz` |
| Linux | `…-linux-x86_64.AppImage`（`chmod +x` 后直接运行）或 `…-linux-amd64.deb` | `…-linux-x86_64-portable.tar.gz` |

桌面版是在网页版之上加了一层很薄的原生外壳，多出来的能力是这几样：

- **资源管理器（VS Code 风格文件树）**：左侧边栏，展开箭头会转，图标按文件类型着色
  （内联 SVG，保持零外部依赖），带缩进引导线。单击打开（自动开新标签页）、`Ctrl+点击`加选、
  `Shift+点击`选一段、方向键上下走、`←/→`折叠展开、`Enter`打开、`F2`重命名、`Delete`删除、
  `Ctrl+A`全选；顶部有按文件名过滤框，底部是最近打开列表。
- **文件操作**：右键菜单可以新建文件/文件夹、重命名、删除、在系统文件管理器里显示、
  复制路径；也能把文件或文件夹**拖到另一个文件夹里移动**（拖动多选就是批量移动）。
  新建与重命名直接在树里就地输入，不弹对话框——命名发生在树里，就别让人离开上下文。
  删除会二次确认，被删文件若有未保存改动会单独提示；重命名或移动后，已打开的标签页、
  编辑器标题、最近列表会一起跟着改，不会留下指向旧路径的引用。
- **侧栏宽度可拖拽**：面板右边有 5px 的拖拽手柄，双击复位，宽度记在本地。
- **工作区标签页**：`Ctrl+S` 是**写回原文件**，而不是下载一份副本；标签页可以全部关掉，
  关完编辑区会显示引导页（此时编辑区置为只读——没有标签页时打了字无处可存）。
- **自动保存到文件**：停止输入约 2.5 秒后自动写回源文件，状态栏单独显示写盘时间
  （与"草稿缓存"分开显示，免得看到"已自动保存"就以为磁盘也更新了）。只写已有路径的文件，
  绝不会在背后弹出"另存为"。可在设置里关掉。
- **保存时自动排版**：按洛谷规范补中英文与公式之间的空格等，写盘前执行，编辑区同步更新
  且可撤销。可在设置里关掉。
- **关闭前可保存**：关掉有未保存改动的标签页时，弹的是**保存 / 不保存 / 取消**三选一
  （系统自带的确认框只有两个按钮，缺的正是最常用的那个"保存"）。
- **记住上次的样子**：主题、视图模式（双栏 / 纯编辑 / 纯预览 / Typora）、侧栏宽度、
  自动保存与自动排版开关，关掉应用再打开都还在。
- **拖进来的文件会被认账**：把 `.md` 拖进窗口，右侧出预览、左侧同时多出一个标签页，
  不会出现"一边有内容、一边说没打开"。桌面版走系统**原生拖放**，拖进来的文件**带绝对
  路径**——`Ctrl+S` 直接写回原文件，不再弹"另存为"（浏览器的 HTML5 拖放给不了路径，
  `.path` 是 Electron 才有的，这是两条路的根本差别）。一次拖多个 = 一次开多个标签页；
  拖一个文件夹会问一句要不要把它作为左侧的工作目录。
- **标签页快捷键**：`Ctrl+W` 或鼠标中键关闭当前标签页；关有改动的标签页仍是
  「保存 / 不保存 / 取消」三选一。焦点不在编辑区时 `Ctrl+B` 收起 / 展开侧栏。
- **侧栏可收起**：点资源管理器标题栏的收起按钮，左侧收成一条窄轨道，编辑区立刻变宽；
  展开回到原来的宽度，收起状态会被记住。
- **网页版也能多标签**：浏览器里没有可写回的目录，所以没有文件树，但标签页照常有——
  新建、切换、中键关闭都在，刷新之后标签页和内容也还在。网页版的 `Ctrl+S` 是下载一份
  副本（若浏览器支持文件句柄，则写回原文件）；`Ctrl+W` 归浏览器管，中键仍然可用。
- **打开非 Markdown 文件时会提醒**：`.txt` / `.cpp` 这类纯文本只在第一次打开该类型时提示
  一句"预览会按 Markdown 规则渲染，保存时原样写回"；而 `.png` / `.pdf` / `.exe` 这类
  **二进制文件会先问一句**再决定是否打开——按文本打开只会是乱码，一旦保存就会用乱码覆盖
  原文件，所以这一步值得停下来确认。
- **系统级文件关联**：安装后双击 `.md` / `.markdown` 文件直接用本编辑器打开。
- **便携模式**：免安装版解压出来自带一个 `portable.txt`；只要它和可执行文件在一起，
  草稿与最近打开记录就写进同目录的 `data/`，不碰系统用户目录。拷进 U 盘换台电脑继续写，
  文档还在。所以这个标记文件是打包时主动放进去的——绿色版要能「拎起来就走」，
  前提就是数据不落在用户目录里。
- **没有 Electron**：外壳是几百行 Rust，安装包 2MB 上下，启动和内存占用接近系统自带编辑器。

> 资源管理器只在桌面版出现：它需要真实的文件系统来做读写，网页版没有可以安全写回的目录，
> 所以网页版里这个面板不会显示，而不是给一个残废版本。权限上，编辑器只能操作你在
> 「打开文件夹」对话框里亲手选中的那个目录及其子目录，这是 Tauri 的文件系统作用域，
> 不是"整个磁盘都能碰"。

安装包**未做代码签名**（个人项目不买证书），首次运行系统会拦一下，属正常现象：
Windows 点「更多信息 → 仍要运行」，macOS 右键图标选「打开」。
不想看到这类提示，就用单文件版或网页版，功能完全一样。

若要从源码构建桌面版：

```bash
cd desktop && npm install   # 首次运行取 Tauri CLI
npm run dev                 # 开发模式启动（会自动把最新构建产物 stage 成前端）
npm run build               # 本机打出安装包
```

### 方式四：本地起服务（旧方式，仍可用）

- **Windows 快捷启动脚本**：双击 **`run.bat`**，或右键用 PowerShell 运行 **`run.ps1`**。
  脚本会自动检测 Python 环境、启动本地轻量服务并打开应用界面。
- **Python 桌面模式**：
  ```bash
  python app.py
  ```
  即可启动本地服务并自动调起桌面窗口。

---

### 列表自动续行

在列表项末尾按 **Enter**，下一行会自动补上同样的标记：

| 当前行 | 按 Enter 后 |
|---|---|
| `- 项目` | `- ` |
| `1. 项目` | `2. `（自动递增） |
| `- [x] 任务` | `- [ ] `（新任务默认未勾选） |

缩进层级会保留。在**空的**列表项上再按一次 Enter 即可退出列表。

### 关于 `++下划线++`

**本编辑器刻意不支持 `++文字++`**，请不要再把它实现为 `<ins>`。

洛谷现行渲染器是 Remark + Rehype，语法基线为 GFM（见[洛谷编辑器帮助手册](https://www.luogu.com.cn/article/70w8j2pj)）。GFM 及其 `remark-directive` 插件均未定义 `++` 语法，洛谷会把它原样输出为字面的 `++文字++`。若编辑器这边渲染成下划线，就会出现「本地好看、贴上去是加号」的假阳性预览。

内置 lint 规则 `unsupported-ins` 会在检测到该写法时给出警告，建议改用 `**加粗**` 或 `*斜体*`。

> 注：早期版本曾参考洛谷 2019 年的开源组件 [`luogu-dev/markdown-palettes`](https://github.com/luogu-dev/markdown-palettes)（基于 markdown-it@8）。该仓库已停更多年，与线上实际管线差异很大（它连 `$公式$`、`:::info` 都不渲染），**不应作为对齐基准**。

## ⌨️ 常用快捷键

macOS 上 `Ctrl` 对应 `⌘`。**洛谷** 一列标记该键与[洛谷官方编辑器](https://www.luogu.com.cn/article/70w8j2pj)一致。

| 快捷键 | 功能 | 洛谷 |
| :--- | :--- | :---: |
| `Ctrl + B` | 加粗选中文本 (`**加粗**`) | ✅ |
| `Ctrl + I` | 斜体选中文本 (`*斜体*`) | ✅ |
| `Ctrl + D` | 删除线 (`~~删除~~`) | ✅ |
| `Ctrl + M` | 插入行内数学公式 (`$x$`) | ✅ |
| `Ctrl + Shift + H` | 插入水平线 (`---`) | ✅ |
| `Ctrl + Shift + L` | 插入超链接 | ✅ |
| `Ctrl + Shift + I` | 插入图片 | ✅ |
| `Ctrl + Shift + Q` | 插入引用块 (`>`) | ✅ |
| `Ctrl + Shift + 1` | 插入代码块 | ✅ |
| `Ctrl + Shift + 2` | 插入表格 | ✅ |
| `Ctrl + Shift + 7` | 插入无序列表 | ✅ |
| `Ctrl + Shift + 8` | 插入有序列表 | ✅ |
| `Ctrl + Shift + 9` | 插入任务列表 | ✅ |
| `Ctrl + Shift + ↑` / `Ctrl + Shift + ↓` | 提升 / 降低标题等级（H1～H6，段落⇄标题） | ✅ |
| `Ctrl + S` | 保存 Markdown 文件到本地 | — |
| `Ctrl + K` | 插入超链接（本编辑器旧键，仍可用） | — |
| `Ctrl + Shift + K` | 插入行内数学公式（本编辑器旧键，仍可用） | — |
| `Ctrl + Shift + M` | 插入行间独立数学公式 (`$$ ... $$`) | — |
| `Ctrl + Z` | 撤销 | — |
| `Ctrl + Y` 或 `Ctrl + Shift + Z` | 重做 | — |
| `Tab` / `Shift + Tab` | 增加 / 减少缩进 (4 空格) | — |

---

## 📂 项目文件结构

```
luogu-markdown-editor/
├── LuoguMarkdownEditor.html   # 构建产物：100% 独立单文件离线版 (不提交，见 Releases)
├── index.html                 # 开发用薄壳：只写结构，引用 src/ 与 assets/
├── app.py                     # Python 启动器（仅绑定 127.0.0.1）
├── run.bat / run.ps1          # Windows 快速启动脚本
├── build-standalone.js        # 单文件打包构建工具
├── src/
│   ├── luogu-parser.js        # 洛谷 Markdown + KaTeX 解析与渲染引擎
│   ├── luogu-linter.js        # 洛谷排版规范检测与空格自动修复
│   ├── luogu-math-cheatsheet.js # LaTeX 数学公式库与速查助手
│   ├── luogu-templates.js     # 洛谷官方题解/题面/文章预设模板
│   ├── editor.js              # 编辑器核心交互控制与双向同步滚动
│   └── styles.css             # 洛谷官方风格与深浅色主题样式
├── desktop/                   # Tauri 桌面版外壳（Rust，只负责开窗与原生文件访问）
│   ├── package.json           # 只依赖 @tauri-apps/cli
│   └── src-tauri/             # Rust 侧：便携模式、窗口配置、安装包配置
├── scripts/
│   ├── stage-desktop-frontend.js # 把构建产物 stage 成桌面版前端
│   ├── bump-version.js        # 一次改齐三个文件的版本号
│   └── check-versions.js      # 校验版本号一致（CI 会跑）
├── test/                      # Node 内置测试（解析器 / 排版）
├── test-browser/              # Playwright 套件，针对构建产物在真实浏览器里跑
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
node test-browser/xss.test.js                  # XSS 向量回归
node test-browser/fidelity.test.js             # 渲染保真度
node test-browser/robustness.test.js           # 畸形输入 / ReDoS
node test-browser/workspace-explorer.test.js   # 文件树：图标 / 过滤 / 键鼠操作 / 增删改移

# 桌面版（需要 Rust 工具链）
cd desktop && npm install  # 取 Tauri CLI
npm run dev                # 开发模式启动
npm run build              # 本机出安装包
```

参与开发请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 发布新版本

版本号写在**三个文件**里：`package.json`、`desktop/src-tauri/tauri.conf.json`、
`desktop/src-tauri/Cargo.toml`。它不只是个标注——tag 决定 Release 资产名，CI 用它
给安装包命名，Tauri 还会把自己的那份烙进安装包信息里。所以 CI 会校验三者一致
（`node scripts/check-versions.js`），不一致直接红。

```bash
node scripts/bump-version.js 1.34.0   # 一次改齐三处，其余字节不动
git add -A && git commit -m "v1.34.0: 这一版做了什么"
git tag v1.34.0
git push origin main --tags
```

推 tag 之后并排跑两条流水线，产物汇总到**同一个 Release**：

| 工作流 | 触发 | 产物 |
| :--- | :--- | :--- |
| `ci.yml` | push / PR | 单元测试、浏览器端套件、构建可重复性、离线（无 CDN）校验、版本号一致性 |
| `release.yml` | tag `v*` | `LuoguMarkdownEditor.html`（上传前校验产物自包含） |
| `desktop.yml` | tag `v*` / 手动触发 | Windows 安装包 + 绿色版、macOS 通用 dmg + 便携版、Linux AppImage / deb / tar.gz |
| `pages.yml` | push main | 在线版站点 |

桌面版的三个平台并行构建（Windows、Linux 各约 3~4 分钟，macOS 要交叉编译通用
二进制，略慢），`fail-fast: false`，某个平台挂了不影响其他平台先把产物传上去；
两个发布工作流写的是同一个 tag 的不同资产，所以谁先跑完都不会互相覆盖。
只想验证桌面版能不能编译，可以在 Actions 页手动触发 `desktop.yml`——非 tag 触发时
它只上传 artifact，不会碰 Release。

### 项目结构

```
index.html                 开发用薄壳：纯 HTML 结构，通过 <link>/<script> 引用真实源码
src/                       样式与逻辑（styles.css, luogu-parser.js, editor.js …）
assets/                    第三方依赖本地副本（KaTeX, Prism 及字体）
build-standalone.js        构建脚本：内联全部资源，产出单文件版
LuoguMarkdownEditor.html   构建产物（不提交版本库，见 Releases）
desktop/                   Tauri 外壳：只提供窗口、文件关联与原生文件读写
```

数据流是**单向**的，桌面版接在最后一步，不额外分叉：

```
index.html + src/** + assets/**  ──build──▶  LuoguMarkdownEditor.html  ──stage──▶  desktop/dist/index.html  ──▶  安装包
                                                     │
                                                     └─────────────────────────────────────────▶  Release 资产
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

上述性质由 `test-browser/xss.test.js` 中的 32 个攻击向量在真实浏览器里持续验证，
并纳入 CI。发现安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。

桌面版沿用同一套渲染代码，区别只在外壳，因此额外守住两条：

- `desktop/src-tauri/capabilities/default.json` 只授予**必需**的原生权限（打开/保存
  对话框，以及对用户自己选定路径的读写）。Tauri 的默认行为是"要什么给什么"，
  所以这份清单是有意写窄的，不是从模板抄来的。
- 外壳只做一件事：开窗、传文件路径、便携模式换数据目录。它不解析 Markdown、不碰
  网络，也不把权限代理给页面里的脚本。

### 第三方组件

本项目内联打包了 KaTeX 与 Prism（均为 MIT），版权声明见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
