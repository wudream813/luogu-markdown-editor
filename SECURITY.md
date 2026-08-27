# 安全策略

## 报告漏洞

请**不要**通过公开 Issue 报告安全漏洞。

请使用 GitHub 的
[私密漏洞报告](https://github.com/wudream813/luogu-markdown-editor/security/advisories/new)
功能提交。我会尽力在 7 天内回复。

报告时请尽量附上：可复现的 Markdown 输入、浏览器与版本、实际与预期行为。

## 威胁模型

本编辑器**在本地渲染不受信任的 Markdown**——用户经常粘贴从题解区、
QQ 群或他人博客复制来的内容。因此下列输入一律视为不可信：

- Markdown 正文（含 HTML 片段、链接、图片地址）
- LaTeX 公式（交由 KaTeX 渲染）
- 代码块内容与语言标识

安全目标：**渲染任何输入都不得导致脚本执行**。

### 现有防护

| 防护 | 实现 |
|---|---|
| 原始 HTML 不解析 | `neutralizeRawHtml()` 转义 `<`，与洛谷行为一致 |
| URL 协议白名单 | `sanitizeUrl()` 仅放行 `http(s)/mailto/ftp/tel` 与相对地址；测试前先剥离控制字符与空白 |
| KaTeX 命令白名单 | `trust` 回调逐命令判定：`\href`/`\url` 复用 `sanitizeUrl()`，`\includegraphics`、`\htmlClass` 等一律拒绝 |
| 属性注入 | 所有插值经 `escapeHtml()` |
| 视频嵌入 | bilibili iframe 带 `sandbox`，且仅接受合法 BV 号 |
| 本地服务器 | `app.py` 仅绑定 `127.0.0.1`，不对局域网开放 |

### 不在范围内

- 用户**自己**编写的内容造成的自我影响
- 导出的独立 HTML 在他人处打开——该文件同样只包含经过上述净化的内容，
  但请自行确认来源可信
- 依赖（KaTeX / Prism）自身的漏洞，请向上游报告

## 支持版本

仅最新 Release 接受安全修复。
