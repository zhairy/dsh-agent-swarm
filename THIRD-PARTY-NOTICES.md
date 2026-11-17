# 第三方声明 / Third-party notices

本插件包含或改编了以下 MIT 许可的第三方内容。

## jev-mcp 0.2.1

`src/jev-questions.ts` 与 `src/jev-tools.ts` 中 7 个 Jev 工具（jev_ask / jev_check / jev_classify / jev_score / jev_match / jev_screen / jev_health）的题目、判定阈值与返回结构移植自 jev-mcp 0.2.1。

```
MIT License

Copyright (c) 2026 Blake Stone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## TypeSafe AI 技能

`skills/typesafe-ai/SKILL.md` 原样收录自 TypeSafe AI 的官方技能，许可证见 [skills/typesafe-ai/LICENSE](skills/typesafe-ai/LICENSE)（MIT，Copyright (c) 2026 TypeSafe AI）。

## Mermaid 12.2.0、DOMPurify 3.4.17、KaTeX 0.18.10 与 jsdom 26.1.0

Mermaid 用于官方语法检查和本地浏览器图形渲染，jsdom 用于隔离的 parser Worker DOM 适配。Node 侧解析器解析到 DOMPurify 3.4.17 与 KaTeX 0.18.10；Mermaid 的浏览器预打包资源内嵌 DOMPurify 3.4.12，前端使用 `strict`、关闭 HTML 标签并对输出 SVG 再做白名单复核。所有依赖均从 npm 安装并锁定，不从运行时 CDN 加载。Mermaid 为 MIT（Copyright (c) 2014–2022 Knut Sveidqvist）；DOMPurify 为 MPL-2.0 或 Apache-2.0；KaTeX 为 MIT；jsdom 的 MIT 许可位于依赖包的 `LICENSE.txt`（Copyright (c) 2010 Elijah Insua）。依赖通过 npm 原样安装并保留随包许可；本插件不将它们改名为自身代码。

## v3.4.0 兼容补丁与可选组件

Notebook、Subscriptions、RigorQuant和DSH桥接补丁含下列项目的MIT许可代码。独立兼容归档还包含OpenCode Go、本地OpenCode设置适配器及calculator，保留各组件LICENSE和原有第三方声明；它们不是Swarm的强制依赖，也不是第三方上游新版本。

- [dsh-notebook](https://github.com/beihzb/dsh-notebook)：Copyright (c) 2025-present beihzb。
- [dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions)：Copyright (c) 2026 V1ki。
- [dsh-rigorquant](https://github.com/linxichen/dsh-rigorquant)：Copyright (c) 2026 dsh-rigorquant contributors。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：Copyright (c) 2026 DeepSeek。
- [dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)：Copyright (c) 2026 DeepSeek；Copyright (c) 2026 dsh-opencode-go contributors。
- [dsh-tool-calculator](https://github.com/omdsh-dev/dsh-tool-calculator)：Copyright (c) 2026 whiteicey。

上述内容适用以下MIT许可，版权声明和许可随兼容包保留。确切来源版本/提交及文件摘要见发布资产的third-party-manifest.json。未分发用户的历史preset配置、运行配置或node_modules；外部SDK/普通npm依赖由用户按各自许可证安装，不能将本清单当作完整传递依赖SBOM。

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
