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

## INKWAVE v1

`templates/inkwave` is a curated snapshot of project `aoug8qt4zd8l`, source version 41,
based on the MIT-licensed [inkwave-game](https://github.com/caoxing9/inkwave-game).
The original license is retained at `public/game/LICENSE`. The game, guide, touch controls,
fonts, lightmaps, vendored engine and optional LAN download are included. Environment files,
credentials and original-site canonical URLs are excluded; new copies receive their own
workspace configuration through the existing sandbox lifecycle.

This template has no business tables. Each remix still gets its own schema, role and editable
source. Preferences and game progress live in browser storage. Multiplayer retains the source
project's external signaling requirements; an HTTP LAN relay is not deployed by this template.

Packaging preserves binary files as base64 with an explicit encoding and counts their decoded
storage size. It also copies the static game to the generated, ignored
`app/public/templates/inkwave/` directory for the gallery preview. The preview does not contact
the source project's workspace or need a demo database. Closing the preview unmounts the game.
Both the public landing page and signed-in home show the shared catalog. Rebuild the API before
building the app so the preview assets and source payload are generated.
The lobby uses the sandbox component library's Select through a small custom-element adapter
in `public/game/src/ui/select.js`. Packaging bundles that existing component into
`public/game/vendor/lovbase-ui.js`; copied projects retain this runtime library and the editable
adapter, including keyboard navigation, accessible labels and disabled options.

## 3D Product Studio v1

The `product-3d` template is an original bilingual furniture configurator inspired by the interaction
patterns of [Muuto](https://planner.muuto.com/in-situ) and
[VividWorks](https://www.vividworks.com/demos/sofa-configurator). No third-party models or brand assets
are copied. The chair, studio lights, wood grain and fabric textures are generated in code using
Three.js, React Three Fiber and Drei; no external model, texture, font or HDR service is required.

- Configure four upholstery colors and three frame finishes, quantity, and a live CNY quote.
- Save, reopen, update and delete named designs. Record inquiries and manage their status.
- Edit the built-in product and its finish names, colors, roughness, availability and prices.
- Public previews allow local configuration but expose no persistence controls. Copied projects
  use the existing workspace token/owner model. This is a workspace business template, not an
  anonymously writable storefront or a customer/merchant authorization system.
- Five visible IR tables store products, options, configurations, configuration items and inquiries.
  Prices are integer cents, quantities are integers from 1 to 1,000, and the server calculates the
  final quote. Inquiry snapshots are immutable through this API even after changing products or
  deleting designs. Disabled options remain visible in old designs but cannot be submitted again.
- `/api/data/:workspaceId/product-3d` supports authenticated reads and validated transactional
  commands, with project isolation, quota checks and atomic request-id deduplication. Retrying an
  identical write returns its previous result; reusing its ID for different input is rejected.
- A static chair illustration replaces WebGL on unsupported devices or context/render failure;
  configuration and business actions remain usable. The 3D bundle loads only when the viewer mounts.

The catalog, preview loader and trusted server registry select implementations by template ID and
version. Existing inventory v1 identities and endpoints stay compatible. Source packaging merges
per-template dependency overrides into the sandbox base and copies shared domain code locally.
Restoring a manifest installs its dependencies before marking a fresh sandbox ready; failed installs
can be retried. Template source updates affect new copies only.

Run the additional integration tests against disposable PostgreSQL:

```sh
node api/scripts/package-templates.mjs
TEMPLATE_TEST_DATABASE_URL=postgres://user:password@localhost:5432/testdb \
  bun test api/tests/product-3d.test.ts api/tests/templates.test.ts core/tests/product-3d.test.ts \
  sandbox/tests/template-dependencies.test.ts
```

Browser acceptance: open both gallery previews → switch finishes and language → create a named
copy → save a design → reload and reopen it → submit an inquiry → update its status → change the
product price → verify the old inquiry price is unchanged. Check a 390px viewport and a browser
without WebGL2. Run `bun run typecheck` and `bun run build` inside the copied application's sandbox
as well as the monorepo checks; a gallery-only build does not verify source packaging.

Not included: model uploads, arbitrary model mapping, payments, shopping carts, stock, AR or modular
assembly. Dataset reads use the same explicit 10,000-row-per-table boundary as the inventory template.
