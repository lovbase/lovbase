# Application templates / 应用模板

`/templates` and the signed-in home page expose the bilingual catalog. A card opens a large,
read-only preview. **Use template** opens a named Remix dialog (returning here after login if
necessary). Confirmation creates an independent PostgreSQL schema and editable source snapshot,
then opens the existing project editor. Creating a copy does not require an LLM call.

用户点击模板卡片后可浏览只读应用；点击「使用模板」、填写项目名称并确认后，进入现有编辑器。
每个副本有独立数据、数据库角色和源码，不会改动演示数据或其他用户的副本。

## Inventory v1

Original React/CSS implementation with Chinese/English labels and fictional sample data:

- Dashboard, searchable/filterable/paginated products, supplier directory and location hierarchy.
- Received, shipped, adjusted and transferred stock with an immutable movement history in the UI.
- Draft purchase orders, submit/cancel and partial/full receipts; receipt, balance and ledger changes
  commit together. Negative stock, overreceipt and duplicate submissions are rejected.
- Date/category/supplier/location analytics and replenishment based on recent shipments, lead time,
  reorder settings and outstanding deliveries. These suggestions are deterministic, not AI output.
- Product CSV validation/preview/import (1–500 rows, 2 MB), plus product, supplier, movement and
  analytics exports. Exports neutralize spreadsheet formulas. Product import creates new SKUs;
  it does not overwrite existing SKUs or set opening stock. Use a receipt/adjustment for stock.

首版覆盖库存总览、商品、供应商、层级库位、出入库/调拨/盘点、采购及分批收货、分析、规则补货
和 CSV 导入导出。没有团队审批、扫码、外部通知或真实 AI 分析。

## Implementation

| Path | Purpose |
| --- | --- |
| `core/src/templates.ts` | Versioned metadata, bilingual names and cover image |
| `core/src/inventory.ts` | Shared data contract, calculations and CSV utilities |
| `templates/inventory/src/` | Original app source, used both for preview and copied projects |
| `api/src/modules/templates/` | Trusted model, seed data, transactional Remix and inventory commands |
| `api/scripts/package-templates.mjs` | Packages the sandbox base plus inventory source into the API build |
| `app/src/components/TemplatesGallery.tsx` | Gallery, preview, login return and Remix dialog |

The packaged JSON is generated and ignored by Git. `bun run build`, `bun run dev` and `bun run test`
generate it automatically; API development also watches template changes. Direct test commands
need `node api/scripts/package-templates.mjs` first. Production bundles contain the source payload;
runtime does not depend on this checkout. Copies use the existing sandbox environment variables
and `/api/data/:workspaceId/inventory`, authenticated by the workspace token or owner session.

Remix holds the same user lock as blank-project creation, checks the account's project limit and
uses a request UUID for safe retries. Project, schema, role, seed rows, source and provenance commit
in one PostgreSQL transaction. The public preview has no API token and its database role grants
SELECT only. An inventory write locks its project and records its request UUID atomically with the
stock changes; repeating an identical request returns its previous result.

## Development and verification

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run test

# Use a disposable PostgreSQL database with permission to create schemas and roles.
# Never point the integration suite at a production database.
TEMPLATE_TEST_DATABASE_URL=postgres://user:password@localhost:5432/testdb \
  bun test api/tests/templates.test.ts core/tests/inventory.test.ts sandbox/tests/write-file.test.ts
```

The PostgreSQL suite exercises quota races, rollback of schemas/roles/source, isolation, read-only
demo access, ledger consistency, overselling, replay, transfers, receipts and import rollback.
The ordinary suite skips PostgreSQL integration tests unless the dedicated variable is set.

For a browser check: preview in both languages → Use template → login return → change the project
name → create → editor preview → log a receipt → reload → confirm the new quantity. Test a partial
purchase receipt and mobile layout as well. Generated copies can run `bun run typecheck` and
`bun run build` inside their sandbox.

## Versioning and boundaries

Each copy records its template version and receives its own source snapshot. Updating template
source affects new copies; it never updates an existing user's app. A future database shape change
needs a new template version and a new demo identity, plus an explicit compatibility strategy for
the existing inventory API. Do not silently reseed user schemas.

Reads currently load at most 10,000 rows per table and fail explicitly above that boundary, so charts
and stock totals never silently omit rows. Larger applications should add server-side pagination
and aggregation. A copy remains a Lovbase application: its inventory client depends on the platform
API; it is not a standalone backend export. Database owners can still customize schema and data in
the editor, so changes to inventory tables must also update their API contract.

To add another template, supply catalog metadata, original UI source, a versioned schema/seeder,
source packaging and authenticated creation/operation handlers, then add isolation and lifecycle
tests. The inventory-specific endpoint is intentionally not a generic arbitrary SQL API.
