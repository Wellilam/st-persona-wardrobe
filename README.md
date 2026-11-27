# Persona Wardrobe (User 人设与世界书总管)

专为 **SillyTavern**、**Luker** 与 **TauriTavern (TRT)** 全端（桌面端 & Android / iOS / HarmonyOS 移动端）设计的 User 人设（Persona）分类管理、状态快照与关联世界书增强扩展。

原位接管酒馆顶栏原生人设抽屉（`#PersonaManagement`），并保留一键切换原生平铺列表与独立双栏总管窗口。

---

## 多宿主兼容矩阵

| 宿主前端 | 兼容特性 |
|---|---|
| **SillyTavern** (`v1.14+` ~ `v1.19+` / Termux) | 原位接管 `#PersonaManagement`、磁盘 `/api/avatars/get` 去重过滤、旧版头像直链自动降级（无需先打开原生列表）、防 `SETTINGS_UPDATED` 滚动回顶 |
| **Luker** (`funnycups/Luker`) | 识别并去重合并 `character.data.extensions.luker.dedicated_personas` 卡内专属人设、移动端 `html` transform 视口定位修复、阻止抽屉穿透收起 |
| **TauriTavern / TRT** (`Darkatse/TauriTavern`) | 等待 `__TAURITAVERN__.ready` 延迟激活、全量异步 `<dialog>` 输入/确认弹窗（规避原生 WebView 禁用 `prompt`/`confirm`）、接入 `__TAURITAVERN_HANDLE_BACK__` 安卓/鸿蒙侧滑返回手势、支持 `api.worldInfo.openEntry` 条目深链定位、适配 `download-bridge` 异步导出与软键盘视口压缩 |

---

## 核心功能

### 1. 原位接管人设栏目 & 进入新聊天衣柜选人设
- **原位接管开新聊天选人设弹窗**：进入新聊天（或角色绑定了多个人设弹出选人设框、点击角色连接按钮）时，自动用衣柜分组选择器替代酒馆原生简陋头像框——默认展示「★ 当前角色绑定」，同时支持随时切到「全部 / 收藏 / 自定义分组」跨组选人设、搜索、切换列表/宫格视图，以及一键直选某套**状态快照**；在「开始新聊天？」确认框内也支持提前预选新档 User（即使该角色未绑定多个人设）。
- **按角色自动成组 & 多卡防刷屏**：同一角色卡下绑定的多个 User 自动归为以该角色命名的折叠文件夹（当前聊天角色自动置顶）；通用人设绑定多张角色卡时自动聚合折叠，右栏支持超 6 个绑定角色折叠与一键清空。
- **多选批量管理**：开启「多选」即可一次性将多个人设批量归入分组、绑定角色卡、设置主世界书、收藏、导出分享包或安全批量删除（支持 `Shift` 连选与分节全选）。
- **排序、调序与三种视图切换**：支持按 `默认 / 最近使用 / 聊天时长 / 聊天档数 / 收藏优先 / 名称 A-Z` 排序，自定义分组支持 `置顶 / 上移 / 下移`，支持 **标准双行 / 紧凑单行 / 头像宫格** 三种视图切换，并自动记忆各分组与右栏模块的折叠状态。
- **通用图床与云端头像兼容**：自动穿透懒加载透明占位符（`1x1 GIF`）并识别第三方图床/美化扩展头像，内置 `⋯` 更多菜单支持直接上传、更换与同步云头像。

### 2. User 变体克隆、人设分享包 & 状态快照预设
- **状态快照**：一键把当前人设描述、主世界书（含各条目启用/常驻开关）、附加世界书与随身设定保存为命名快照（如「日常态」「战斗态」「IF线」），随时一键切回。
- **单人设 / 多选「人设分享包」导入导出**：支持将单个或多选的多个 User（含 Base64 头像原图、原生描述、随身设定、状态快照及可选关联世界书）打包导出为独立分享文件发给好友，一键导入完整还原。
- **完整克隆变体**：支持将当前 User 或任意快照一键克隆为全新独立 User 档案（含头像复制）。

### 3. 使用足迹统计（聊了几个角色卡 · 几个聊天档 · 聊了多久）
- 实时统计当前聊天互动，并支持 **「扫描历史档」** 一键回溯酒馆内所有历史聊天记录，展示每个 User 聊过的角色卡数、聊天档数、消息轮数、累计活跃时长及按角色展开明细。

### 4. 主世界书 + 多本附加世界书 + 随身设定卡
- **世界书一键跳转 & 条目定位**：支持直接跳转到酒馆世界书编辑器（在 TauriTavern 下支持 `api.worldInfo.openEntry` 直接定位具体条目），附带左下角 **「← 返回人设」** 悬浮胶囊。
- **弹窗内快改条目**：无需离开当前页面即可搜索、开关、切换常驻/关键词触发或增删改世界书条目。
- **突破单书限制**：每个 User 可额外关联多本世界书并配置独立随身设定片段，支持 **「生效预览」** 查看本轮实际注入内容。

---

## 安装方式

### 方式一：通过 Git 链接在线安装（推荐，支持 SillyTavern / Luker / TauriTavern）
1. 打开酒馆顶部 **扩展（Extensions）** → **安装扩展（Install Extension）**。
2. 粘贴仓库地址：`https://github.com/Wellilam/st-persona-wardrobe`
3. 安装后刷新页面（或在 TauriTavern 中重新进入）即可直接使用。

### 方式二：放入本地扩展目录
将 `st-persona-wardrobe` 文件夹放入对应宿主的扩展目录：
- **SillyTavern / Luker**：`data/<用户名>/extensions/st-persona-wardrobe/` 或 `public/scripts/extensions/third-party/st-persona-wardrobe/`
- **TauriTavern (TRT)**：在应用内通过「安装扩展」填入 Git URL，或放入 TauriTavern 数据目录的 `data/<user>/extensions/st-persona-wardrobe/`

---

## 权限与安全边界说明
- 纯前端 UI Extension，不包含 Server Plugin，不向任何外部服务器发送请求。
- 禁用扩展（`onDisable`）时自动卸载全部事件监听、安卓返回桥接与注入 DOM，零残留。
