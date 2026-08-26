# 洛谷 Markdown & KaTeX 实时预览编辑器 (Windows 桌面轻量版)

一款专为洛谷算法竞赛选手、学术创作者、题解撰写者量身打造的**轻量级、所见即所得、支持 KaTeX 与全部洛谷扩展语法的实时双栏 Markdown 编辑器**。

---

## ✨ 核心特性

1. **100% 完整支持《洛谷 Markdown 格式手册》全部语法**：
   - 📌 **基础排版**：标准 CommonMark / GFM 语法、段落、行末双空格与反斜杠 `\` 紧凑换行、标题、粗体、斜体、粗斜体、删除线、反斜杠转义。
   - 💻 **洛谷代码块**：
     - 未指定语言时自动 fallback 为 C++（符合洛谷规则）。
     - 支持 `line-numbers` 显示代码行号。
     - 支持 `lines=start-end` 或 `lines=3,5-7` 指定高亮代码行。
     - 一键复制代码块内容，附带语言标签。
   - 📊 **表格合并【新特性】**：
     - 支持单元格内 `^` 向上合并（rowspan）。
     - 支持单元格内 `<` 向左合并（colspan）。
     - 支持 `^` 与 `<` 混合嵌套合并。
     - 支持 `::cute-table{tuack}` Tuack 竞赛风格美化表格。
   - 📦 **折叠框【新特性】**：
     - 支持 `:::info`、`:::success`、`:::warning`、`:::error` 四种语义折叠框。
     - 支持 `{open}` 参数设置默认展开状态。
     - **折叠框标题支持 LaTeX 数学公式**（例如 `::::success[$$\sum_{i=1}^n \gcd(i, j)$$]`）。
     - 支持多层深度嵌套（`:::`、`::::`、`:::::`、`::::::` 等）。
   - 📜 **引言【新特性】**：
     - 支持 `:::epigraph[落款作者]` 优雅引言块。
   - ↔️ **居中与居右排版【新特性】**：
     - 支持 `:::align{center}` 与 `:::align{right}`。
   - 📺 **Bilibili 视频嵌入**：
     - 支持 `![](bilibili:BV号)`、`![](bilibili:av号)` 以及带时间/分P参数的嵌入播放器。

2. **高性能 KaTeX 数学公式排版**：
   - 支持行内公式 `$x$` 与行间公式 `$$\sum_{i=1}^n \frac{1}{i}$$`。
   - 内置 **LaTeX 数学公式面板与速查助手**，一键插入希腊字母、二元关系符、微积分巨运算符、分段函数 `cases`、矩阵 `pmatrix`/`bmatrix`、多行等号对齐 `aligned`、数集字体 `\mathbb{R}`、复杂度 `\mathcal{O}`、字号及字体颜色等。

3. **专为 Windows 打造的轻量丝滑体验**：
   - 🌓 **双向精准同步滚动**：编辑区与预览区智能同步，长文排版不迷失。
   - ⚡ **洛谷排版规范检查与一键修复**：内置排版规范 Linter 与盘古算法，一键在汉字与英文、数字、LaTeX 公式之间添加规范空格，检测公式包裹完整度与代码块语言。
   - 📑 **洛谷官方预设模板库**：内置洛谷全特性演示、符合审核规范的标准题解模板、题目题面模板、学术专栏模板。
   - 💾 **本地自动保存与历史回滚**：实时持久化至本地存储，支持撤销/重做（`Ctrl+Z`/`Ctrl+Y`），防丢稿机制。
   - 📤 **多格式导出**：一键复制洛谷 Markdown 源码、导出独立单文件 HTML（离线可用）、打印/导出为 PDF。
   - 🎨 **多套精致主题**：洛谷官方经典蓝白风、暗夜黑客主题、学术纯白极简风。

---

## 🚀 Windows 运行使用指南

本项目提供三种运行方式，均完全开箱即用：

### 方式一：单文件免安装离线版（最轻量、推荐）
- 直接双击目录下的 **`LuoguMarkdownEditor.html`** 文件。
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

---

## 📜 洛谷扩展语法快速参考

### 1. 表格合并与 Tuack 表格
\`\`\`markdown
::cute-table{tuack}

| 标题 1 | 标题 2 | 标题 3 |
| :---: | :---: | :---: |
| 数据 A | 数据 B | 数据 C |
| ^ | 数据 D | < |
\`\`\`

### 2. 折叠框（标题支持公式）
\`\`\`markdown
::::success[$\\mathcal{O}(n \\log n)$ 算法证明]{open}
这里是默认展开的折叠框内容。
::::
\`\`\`

### 3. 代码块行号与高亮
\`\`\`cpp line-numbers lines=3-5
#include <iostream>
using namespace std;
int main() {
    cout << "Hello Luogu!" << endl;
    return 0;
}
\`\`\`

### 4. 居中与引言
\`\`\`markdown
:::epigraph[—— 作者]
引言正文
:::

:::align{center}
居中内容
:::
\`\`\`
