# 这个项目

这是一个 Lovbase 生成的前端应用。数据库、表结构和数据 API 由 Lovbase 托管,你只负责前端。

技术栈(已经装好,直接用):
- Vite + React 19 + TypeScript,路由用 `react-router`(`<Routes>/<Route>`、`NavLink`、`useParams`)
- Tailwind CSS v4 + **shadcn/ui**(Base UI 版),组件在 `src/components/ui/`:button, card, input, table, badge, dialog, select, tabs, textarea, label, separator, dropdown-menu, sheet, skeleton, checkbox, switch, tooltip, empty。缺什么就 `npx shadcn@latest add <name>`
- 图标用 `lucide-react`;工具函数 `cn()` 在 `src/lib/utils.ts`
- 数据只能通过 `src/lib/lovbase.ts` 的 `sql()` 和 `schema()`;类型 `IR / Entity / Field` 也在那里

铁律:
1. 不要新建后端、不要直连数据库、不要引入 ORM 或状态库。所有数据访问走 `sql()`,用 `$1, $2` 参数。
2. 先 `lovbase schema` 看表和字段(`dbName` 用在 SQL 里,`name` 是中文标签)。`link` 字段存目标表的 uuid;`select` 字段的值在 `options` 里。
3. 需要新字段或新表时运行 `lovbase propose "…"`,不要自己改结构。
4. 保持 `bun run dev` 能起、`bun run build` 能过。不要改 `vite.config.ts` 的 host/port,不要改 `src/lib/lovbase.ts` 和 `src/lib/analytics.ts`,不要删掉 `main.tsx` 里的 `startAnalytics()`。
5. `schema()` 返回的 `readOnly` 为 true 时(演示工作区)不要渲染任何新增、编辑、删除入口。
6. `src/App.tsx` 是壳(侧栏 + 路由),`src/pages/` 放页面。默认每个实体已有一个通用列表页 `TablePage`,按需求替换成真正的业务页面。

设计规范(照做,这决定了界面好不好看):
- 用 shadcn 的语义色:`bg-background / text-foreground / text-muted-foreground / border / bg-card / bg-primary`。不要写十六进制颜色,不要内联 style。
- 页面结构:标题行(`text-2xl font-semibold tracking-tight` + 一行 `text-muted-foreground` 说明)→ 内容卡片。间距用 `p-6 md:p-8`、`space-y-6`、`gap-4`。
- 列表用 `Table`,状态用 `Badge`,操作用 `Button`(`size="sm"`,图标 `size-4`),表单放 `Dialog` 或 `Sheet`,数字 `tabular-nums`。
- 指标卡:`Card` 里 `CardHeader` 放标题(`text-sm font-medium text-muted-foreground`),`CardContent` 放大数字(`text-2xl font-semibold`)。
- 空状态用 `Empty` 组件或一句 `text-muted-foreground` 居中提示;加载用 `Skeleton`。
- 界面用中文,克制,不堆功能。

## 代码风格

写正常可读的代码,不要为了省行数把语句挤在一起。人会在编辑器里读它,也会自己改。

- 一行一条语句。不要用 `;` 把多条 `const` 串在同一行。
- 每个组件、每个函数之间空一行。
- 单行超过 110 字符就换行,JSX 属性多的时候每个属性单独一行。
- 改完运行 `bun run format`,它会用 prettier 统一格式。
