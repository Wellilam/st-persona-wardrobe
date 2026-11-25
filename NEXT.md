# NEXT.md — 进度与交接账本

## 当前状态
- **已完成阶段**：第一版完整实现、静态门校验与本地 Git 仓库初始化（v1.0.0，分支 `main`）
- **项目路径**：`C:\Users\ww\.gemini\antigravity\scratch\st-persona-wardrobe`
- **本机 Git 路径**：`C:\Users\ww\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe`

## 已交付产物
1. `manifest.json`：声明 UI Extension 元数据、`PersonaWardrobe_interceptGeneration` 生成拦截器及 `activate/disable/clean` 钩子。
2. `index.js`：
   - 自动读取酒馆原生 `powerUserSettings.personas` / `persona_descriptions` 与 DOM 兜底；
   - 原生 User 面板内嵌「↗ 跳转打开此世界书」「📖 弹窗管理条目」「🗂️ User 衣柜总管」工具条；
   - 一键跳转到酒馆 `#world_editor_select` 并附带右下角「← 返回 User 人设衣柜」悬浮胶囊；
   - 弹窗内直接通过 `/api/worldinfo/get` 与 `/api/worldinfo/edit` 搜索、开关、切换常驻/关键词、编辑与新增世界书条目；
   - 多 User 分类标签、收藏置顶、搜索过滤、一键切换；
   - 附加关联多本世界书（B）、模块化随身设定卡片（A）、顶部当前生效总览与提示词预览（C）。
3. `settings.html` / `style.css` / `i18n/zh-cn.json` / `capability-contract.json`。
4. `preview-sandbox.html`：离线可交互视觉预览沙盒（模拟酒馆环境，可直接双击在浏览器中体验完整交互）。

## 待真机验证项（Live Gates）
1. 在真实 SillyTavern 实例中安装并启用扩展，验证顶部栏、魔棒菜单与原生 Persona 面板下的三个快捷按钮正常渲染；
2. 点击「↗ 跳转世界书面板」，确认酒馆顶部 World Info 抽屉自动展开且 `#world_editor_select` 正确切换到目标世界书；
3. 点击「📖 弹窗管理条目」，确认能读取真实世界书条目并保存开关/正文修改；
4. 开启随身设定卡片与附加世界书后发送消息，在酒馆后台或 Prompt 预览中确认扩展设定正确注入且切换 User 后无残留。
