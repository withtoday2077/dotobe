# 插件开发指南（PLUGIN_GUIDE）

> v2.2.0 起客户端采用「真实插件包」体系（替代旧 egui 版 crate 插件，`crates/` 已废弃）。
> 功能板块打包为 zip（manifest + JS 模块 + CSS），存放于服务端，用户在客户端
> 「插件市场」自行下载安装到本地数据目录后动态加载；卸载即删目录。
> 核心仅保留：控制面板 / 真题市场 / 我的题库 / 个人设置 + 插件市场。
> take 答题 / practice 刷题 / mock 仿真考为核心流程页，不插件化。

## 架构总览

```
desktop-client/plugins/<id>/        ← 插件源码（随仓库走）
├─ manifest.json                    ← 元信息（id/version/entry/css…）
├─ js/index.js                      ← 入口：default export { routes, footerButton?, shellKind? }
├─ js/<页面模块>.js                 ← 每页一模块，export async function render(container, param)
└─ css/<id>.css                     ← 专有样式（安装时注入 <link>，asset 协议）

desktop-client/plugins/build.php    ← 打包脚本：zip + sha256 → uploads/plugins/
服务端 backend/api/plugins.php      ← 目录（登录可见，按角色过滤）
服务端 backend/api/download_plugin.php ← 流式下载 + 计数（jail 于 uploads/plugins）
服务端 backend/api/admin/plugins.php    ← 后台「插件管理」上传/上架/版本管理
客户端 ui/js/plugin-state.js        ← 运行时状态枢纽（菜单合成/壳配置/路由归属）
客户端 ui/js/plugin-loader.js       ← 激活（asset 动态 import）/装卸
客户端 ui/js/pages/market.js        ← 插件市场页 + 首启引导
Rust lib.rs                          ← plugin_download/install/uninstall/list_installed 四命令
```

安装状态**只存本地**（数据目录 `plugins/<id>/` 目录存在即已安装），不上服务端。

## 5 分钟上手：新增一个插件

### 1. 建目录与 manifest

```
desktop-client/plugins/hello/manifest.json
{
  "format": "dotobe-plugin",
  "id": "hello",                 // 小写字母开头，3-63 位 [a-z0-9-]
  "name": "问候",
  "version": "1.0.0",
  "description": "市场卡片文案",
  "icon": "tree",                // 市场图标：客户端 CATALOG_ICONS 内置名，未知回退拼图
  "minClient": "2.2.0",
  "roles": null,                 // 或 ["teacher","admin"]：市场对学生隐藏
  "entry": "js/index.js",
  "css": ["css/hello.css"]
}
```

### 2. 入口模块（js/index.js）

```js
import { renderHello } from "./hello.js";

export default {
  routes: [
    { name: "hello", render: renderHello, shell: "study",
      menu: { title: "问候", icon: ICON_SVG_STRING, order: 60 } },
  ],
};
```

- `routes[].menu` 有值才出现在侧栏（order 排序；icon 必须是内联 SVG 字符串）。
- 独立壳插件（如公会）额外导出 `shellKind: { kind, brand, nav, icons, subRoutes, fallbackTitle }`
  与 `footerButton: { title, route }`（学习壳侧栏底部入口）。

### 3. 页面模块约定

```js
import { api, session } from "api";     // 裸名！经 index.html 的 importmap 解析到核心模块
import { el, toastOk } from "ui";
import { go } from "router";
import { isPluginActive } from "plugin-state";  // 门控其它插件交叉入口

export async function renderHello(container, param) { … }
```

**核心模块只能用裸名导入**（api/ui/router/shell/mobile/km-markdown/win/theme/plugin-state），
包位于数据目录，相对路径够不到核心；importmap 保证与壳内是同一模块实例。
包内互相引用用相对路径（`./xxx.js`）。新增可供插件引用的核心模块时，
必须同步登记 `ui/index.html` 的 importmap。

### 4. 打包上架

```bash
cd desktop-client/plugins
php build.php            # 全部；或 php build.php hello
```

产物落 `uploads/plugins/hello-1.0.0.zip`（含 sha256）→ 后台「高级功能 → 插件管理」
上传（表单 id/版本须与包内 manifest 一致，服务端会解包校验并计算 SHA-256 入库）→
设为当前版本。**改插件 → 重跑 build.php → 后台传新版本号，无需发新客户端。**

## 安全口径（三端一致，改动须同步）

- 插件 id：`^[a-z][a-z0-9-]{2,62}$`（Rust valid_plugin_id / 服务端 / build.php）。
- zip ≤ 20MB；解压白名单扩展 json/js/css/svg/png/jpg/woff2；单文件 ≤ 32MB；总量 ≤ 64MB。
- zip-slip：路径条目拒绝绝对路径与 `..`（Rust plugin_safe_join）。
- 下载后 SHA-256 校验（对齐目录 API 下发值）。
- manifest 三端校验：format/id/version/entry（Rust 安装时 + loader 激活时 + 服务端上传时）。

## 已知坑（2026-09-28 实测沉淀）

1. **asset URL 不能用 convertFileSrc 直连模块导入**：它把整段路径 encodeURIComponent
   （`/` → `%2F`），WebView 模块加载器拒绝含 %2F 的 URL（fetch/`<link>` 不受影响）。
   统一用 `plugin-loader.js` 的 `toAssetUrl()`（借 convertFileSrc 推导平台 origin，
   路径不编码拼接；Windows 为 `http://asset.localhost/...`，Android 为 https）。
2. **importmap 地址必须以 `./`、`/` 或 `../` 开头**（或绝对 URL），裸 `js/api.js`
   会被规范化为 null（报 "blocked by a null value"）。
3. 首启引导/装卸后要 `invalidateShell()` + `rerender()` 重建侧栏；
   卸载公会时若正处于公会页，先 `go("market")` 再卸载。
4. practice/mock 等核心页跳转插件路由的按钮须 `isPluginActive()` 门控。
5. debug（tauri dev）在本机 mingw 工具链下 cdylib 链接失败（历史环境问题），
   验证一律用 release：`cargo build --release` 后跑 target/release/dotobe-tauri.exe。
