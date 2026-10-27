# UI component conventions

- 优先复用项目已有组件库。平台组件位于 `app/src/components/ui/`，生成应用的组件位于 `src/components/ui/`，均使用 shadcn/ui（Base UI）。新增界面前先检查已有组件；缺少组件时优先补充组件库组件。
- 下拉选择使用组件库的 `Select` 或 `Combobox`，操作菜单使用 `DropdownMenu`。不要使用浏览器原生 `<select>`，也不要自行用普通元素模拟这些交互。
- 此约定适用于平台、模板以及生成的应用。保留键盘操作、可访问名称、必填校验、禁用状态与主题样式。
- 修改应用生成指引时，同步维护 `sandbox/template/AGENTS.md` 和 `api/src/modules/agent/skills/build-ui.md` 中的组件库约定。
