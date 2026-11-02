# Changelog — rest-api-to-mcp

版本号遵循语义化版本（SemVer：`MAJOR.MINOR.PATCH`）。

**权威版本源 = GitHub tag（`vX.Y.Z`）**。发布到 WorkBuddy 技能中心时，
**填写与 GitHub tag 完全相同的版本号**，以保证两边一致、便于后续维护。

每次发版三步：
1. 在本文档加一条对应版本的变更记录；
2. `git tag vX.Y.Z` 并 `git push --tags`；
3. 在 WorkBuddy 技能中心后台以同一 `X.Y.Z` 发布 / 更新。

---

## [Unreleased]

- **补齐发布基建（对标 mcp-config-wizard）**：新增 `skill.manifest.json`、`CHANGELOG.md`、根目录 `README.md`、根目录 `.gitignore`、`scripts/publish.js`（GitHub 版，版本一致性校验 + 暂存打包 + changelog 提取，不依赖 skillhub CLI）；SKILL.md frontmatter 加 `version/slug/author/license`。
- **修复手动清单模式的类型忠实缺陷**：`--manual` 的 `queryParams`/`pathParams` 现在支持对象形式 `{name,type,enum,description,required}`，让整数/布尔/枚举参数生成正确的 `z.coerce.number()` / `z.coerce.boolean()` / `z.enum`，不再一律 `z.string()`。字符串简写仍向后兼容。

## [1.0.0] — 2026-11-02

- 首个公开发布版本。
- **双产出模式**：
  - `--mode mcp`（默认）：Node + TypeScript 的 stdio MCP server（依赖 `@modelcontextprotocol/sdk` + `zod`）。
  - `--mode skill`：WorkBuddy skill 包（Python 标准库零依赖，`SKILL.md` + `query_api.py` + `api_quickref.md`）。
- **两种输入**：OpenAPI 3.x（`--spec` / `--spec-url`，支持 JSON/YAML，YAML 用 pyyaml）或手动端点清单（`--manual`）。
- **工具设计已落实**：每个 REST 操作 → 一个 MCP 工具；`server.tool(name, desc, zodShape, annotations, handler)`；返回 `content` + `structuredContent.data`（解析后的 JSON 对象）；MCP Tool Annotations 按 HTTP 方法自动声明（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`）；密钥只走 `env`。
- **质量门禁 `--audit`**：按「合规 / 安全 / 可用」三栏做可执行的静态扫描 + 运行时握手检查，给出 ✅/⚠️/❌ 报告与 FAIL/WARN/PASS 计数。
- **自检 `--install --self-check`**：MCP 模式 = `npm install` + `tsc` 编译 + 握手；skill 模式 = `python query_api.py --help` 冒烟。
- **类型忠实映射**：依据 OpenAPI `schema.type` 生成 `z.coerce.number()` / `z.coerce.boolean()` / `z.array(z.string())` / `z.enum`。
- **功能评估方法论**（借鉴 cn-mcp-builder）：10 个只读评估问题模板 `references/evaluation_questions.xml.example`，可借其 `evaluation.py` harness 跑。
- 对应 GitHub tag：`v1.0.0`。
- 对应技能中心版本：`1.0.0`（发布时填写）。
