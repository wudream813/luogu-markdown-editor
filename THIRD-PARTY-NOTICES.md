# 第三方组件声明

本项目为离线单文件编辑器，将以下第三方组件**内联打包**进
`LuoguMarkdownEditor.html` 及 `assets/` 目录。它们各自的版权与许可条款如下，
其许可证全文随附于本仓库。

---

## KaTeX 0.18.4

- 用途：数学公式渲染（`$...$` / `$$...$$`）
- 主页：https://katex.org/
- 许可：MIT License
- 全文：[`assets/katex/LICENSE`](assets/katex/LICENSE)

Copyright (c) 2013-2020 Khan Academy and other contributors

内联内容包括 KaTeX 的 JS、CSS 与字体文件（`KaTeX_*.woff2` 等）。

---

## Prism 1.30.0

- 用途：代码块语法高亮
- 主页：https://prismjs.com/
- 许可：MIT License
- 全文：[`assets/prism/LICENSE`](assets/prism/LICENSE)

Copyright (c) 2012 Lea Verou

内联内容包括 Prism 核心、各语言定义与主题样式。

---

## 本项目

洛谷 Markdown 编辑器本身以 MIT License 发布，见 [`LICENSE`](LICENSE)。

由于构建产物 `LuoguMarkdownEditor.html` 同时包含上述组件的代码，
**再分发该文件时应一并保留本声明**，以满足 MIT 许可对版权声明的保留要求。
