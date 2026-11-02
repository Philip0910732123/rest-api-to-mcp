# examples — 两分钟跑通

这个目录放的是**可直接运行**的最小样例，不用你自己的 API 也能验证生成器是否正常。

## 1. 生成 MCP server（Node + TypeScript）

```bash
node scripts/generate_mcp_server.js \
  --spec examples/petstore.json \
  --pkg petdemo-mcp \
  --out /tmp/petdemo-mcp \
  --install --self-check --audit
```

预期看到：

```
✅ 握手成功，服务器返回工具：find_pets_by_status, get_pet_by_id, delete_pet, add_pet
--- 审计汇总 ---
  ❌ FAIL: 0   ⚠️ WARN: 2   ✅ PASS: 12
```

`WARN` 两条是预期内的良性建议（`body` 用 `z.any()` 透传、未内置限流）。

## 2. 生成 WorkBuddy skill 包（Python 零依赖）

```bash
node scripts/generate_mcp_server.js \
  --spec examples/petstore.json \
  --pkg petskill \
  --out /tmp/petskill \
  --mode skill --install
```

然后直接打真实 API 验证：

```bash
python /tmp/petskill/scripts/query_api.py \
  --endpoint /pet/findByStatus \
  --params '{"status":"available"}'
```

预期 `"status": "ok"` 且 `"count"` 大于 0。

> Windows Git Bash 会把 `/pet/findByStatus` 改写成 `C:/Program Files/Git/pet/findByStatus`。
> 生成脚本已内置还原逻辑，两种写法都能用；实在不确定就省略前导斜杠写成 `pet/findByStatus`。

## 3. 只做质量审计

已经生成好的目录可以单独体检：

```bash
node scripts/generate_mcp_server.js --audit /tmp/petdemo-mcp
```

## 关于这个样例

`petstore.json` 是精简过的 OpenAPI 3.0 规范，刻意覆盖了四类最容易出问题的建模：

| 覆盖点 | 为什么重要 |
|---|---|
| `enum` 查询参数 | 验证 `z.enum([...])` 是否正确收敛取值 |
| `integer` + `minimum/maximum` | 验证 `z.coerce.number()`，而不是退化成 `z.string()` |
| path 参数 `{petId}` | 验证 URL 模板替换与 `encodeURIComponent` |
| `requestBody` JSON | 验证 `hasBody=true` 才带 body，GET 不会误带 |
| `DELETE` 操作 | 验证 `destructiveHint:true` / `readOnlyHint:false` 注解正确 |

目标 API 是 Swagger 官方的 petstore3，公开可访问、无需鉴权，适合做连通性验证。
