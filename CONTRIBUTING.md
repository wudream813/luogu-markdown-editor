# 参与贡献

欢迎提交 Issue 与 Pull Request。

## 本地开发

```bash
npm install                 # 仅用于取 KaTeX / Prism 资源与跑测试
node build-standalone.js    # 构建单文件产物 LuoguMarkdownEditor.html
node --test test/           # 运行测试
python3 app.py              # 本地起服务（仅本机可访问）
```

开发时请直接改 `src/` 下的源码，**不要**改 `LuoguMarkdownEditor.html`——
它是构建产物，且未纳入版本库（发布时由 CI 生成并上传到 Release）。

## 项目结构

| 路径 | 说明 |
|---|---|
| `index.html` | 开发用外壳，引用 `src/` 与 `assets/` |
| `src/luogu-parser.js` | Markdown + KaTeX 解析渲染 |
| `src/luogu-linter.js` | 洛谷规范检查与排版自动修复 |
| `src/editor.js` | 编辑器交互、滚动同步、导入导出 |
| `src/styles.css` | 全部样式（含打印/PDF 配色） |
| `build-standalone.js` | 把上述内容内联成单文件 |
| `test/` | Node 内置测试 |

## 提交要求

1. **带测试**。解析或排版行为的改动请在 `test/parser.test.js` 补用例。
2. **CI 必须通过**。CI 会校验测试、构建可重复、产物完全离线
   （不得引入任何 CDN 引用）、`index.html` 保持精简。
3. **注释写"为什么"**。代码本身已说明"做了什么"，注释请解释动机——
   尤其是绕过某个坑的地方，否则后人很容易"顺手改回去"。
4. 渲染行为以[洛谷官方 Markdown 说明](https://help.luogu.com.cn/rules/academic/handbook/markdown)
   为准；与 CommonMark 冲突时以洛谷为准，并在注释中说明。

## 安全相关

涉及安全的问题请勿公开提交，见 [SECURITY.md](SECURITY.md)。
