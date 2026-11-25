# AGENTS.md — st-persona-wardrobe 岗位说明书

## 1. 项目定位
- **项目名称**：`st-persona-wardrobe`（Persona Wardrobe · User 人设与世界书总管）
- **载体形态**：SillyTavern 标准浏览器端扩展（UI Extension），可通过 Git 仓库 URL 或本地放入 `data/<user>/extensions/st-persona-wardrobe/` 安装。
- **用户背景**：有使用 AI 制作酒馆插件经验，偏好直接给结论、改动、关键机制与验收项，不堆砌基础教学。

## 2. 核心目标与边界
- **解决痛点**：
  1. 多 User（Persona）分类整理、标签筛选、搜索、收藏置顶与一键切换；
  2. 原生「User 绑定世界书」一键跳转到酒馆世界书编辑器 + 插件弹窗内直接查看/开关/编辑世界书条目；
  3. 支持单个 User 关联多本附加世界书（B）、随身设定卡片开关（A）以及顶部「当前生效总览与提示词预览」（C）。
- **硬红线**：
  - 优先使用 `SillyTavern.getContext()`，不硬编码脆弱的相对路径 `import`；
  - 绝不静默覆盖或删除用户原有的酒馆原生 Persona 描述或世界书条目；写世界书条目必须先读最新数据、仅修改目标条目后保存；
  - 所有事件监听、DOM 节点、全局拦截函数在 `onDisable` 中完整清理；
  - 离线静态校验与沙盒预览不能代替真实 SillyTavern 运行验收。
