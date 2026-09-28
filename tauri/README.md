# Dotobe 桌面客户端 v2（Tauri 版）

以 **Tauri 2 + 系统 WebView2** 实现的 Dotobe 桌面客户端（Windows / Android）：
真正的 HTML/CSS 界面，完整落地《页面样式开发要求.md》（日系清新风）的
发丝边框、下划线输入、500ms 慢过渡、植物线描、纸纹底与 Ma 留白；
Rust 后端只做「会话 + API 代理 + 本地存储 + 插件装载」，业务数据全在服务器。

## 结构

```
tauri/
├─ package.json          # devDependencies: @tauri-apps/cli（构建编排）；scripts.tauri 供 Android 构建回调
├─ ui/                   # 前端：零构建原生 HTML/CSS/JS（ES Modules）
│  ├─ index.html         # 含 importmap：插件以裸名（api/ui/router/…）引用核心模块
│  ├─ css/  tokens.css（设计令牌）· app.css（基础+组件）· pages.css（页面布局）
│  │        · market.css（插件市场+引导）
│  └─ js/   main.js（装配：核心路由注册 + activateAll()）· api.js（invoke 封装+信封解析）
│          · router.js · ui.js · mobile.js（Android 平台判定 + 文件选择帮手）· win.js（自绘标题栏）
│          · plugin-state.js（插件运行时状态：菜单合成/壳配置/路由归属）
│          · plugin-loader.js（插件激活/装卸：asset 协议动态 import）
│          pages/ auth · shell · dashboard · exams · market（插件市场）· mybank
│                 · settings · take · practice · mock（核心流程页）
└─ src-tauri/            # Rust 后端
   ├─ tauri.conf.json    # 含 assetProtocol（scope 运行时限定为数据目录 plugins/）
   ├─ capabilities/default.json
   ├─ src/lib.rs         # 全部实现（桌面/Android 共用）：api_request / fetch_data_url /
   │                     # upload_file·upload_bytes / cookies（DPAPI）/ 草稿 / 试卷缓存 /
   │                     # 离线探测 / 数据目录 / 插件四命令（download·install·uninstall·list）
   └─ src/main.rs        # Windows GUI 入口（调 lib::run()）
```

功能插件源码在仓库根 `plugins/`（学习记录/知识树/本地题库/教学工具/冒险公会），
安装包不含插件本体——用户经「插件市场」从服务端下载安装。开发规范见
`../docs/PLUGIN_GUIDE.md`。

## 设计实现要点（日系清新）

- 令牌：`ui/css/tokens.css`（米白 `#fafaf8` 底、发丝 `#d4d4cf`、圆角 16/12/10px、
  语义色与浅着色 tint、`--dur: 500ms` 慢过渡）；深色皮肤 `[data-theme="dark"]` 一键切换。
- 输入框：仅底边线 + 浮动标签（`ui.js field()`），focus 时发丝线变品牌蓝。
- 每个大区块一枚植物线描 SVG（`ui.js botanical()`），不拥挤。
- 无 `font-weight ≥ 400`；层级靠字号与颜色（侘寂式克制）。
- `prefers-reduced-motion` 时全部动效关闭。

## 构建

### Windows（手动编译安装包）

前置：Node 18+（tauri CLI 经 node_modules）、Rust stable（windows-gnu 或 msvc 工具链均可）。
**不需要** JAVA_HOME / ANDROID_HOME（那是 Android 构建的变量）。

```bat
cd desktop-client\tauri
npx tauri build
```

产物两份：
- **NSIS 安装包**（交付用）：`src-tauri\target\release\bundle\nsis\途变客户端_<版本>_x64-setup.exe`
  （约 210MB；内嵌 WebView2 offlineInstaller，目标机器离线也能装）
- 裸 exe（调试用）：`src-tauri\target\release\dotobe-tauri.exe`

其他形态：

```bat
npx tauri build --no-bundle   # 只要 exe，不打安装包（更快）
cargo check                   # 纯快速查错（在 src-tauri 下），秒级
```

说明：首次构建 Tauri 会自动下载 NSIS 工具链（%LOCALAPPDATA%\tauri\NSIS）与 WebView2
离线安装器，二者缓存后后续构建约 30 秒完成；构建中途强杀会残留 Gradle/NSIS 锁进程，
重跑前可用 jps 查杀。

### Android 平板（APK）

环境：JDK 17 + Android SDK/NDK（`JAVA_HOME`/`ANDROID_HOME`/`NDK_HOME`，SDK 组件可经
腾讯镜像直链安装）；Rust targets `aarch64/armv7-linux-androideabi`。

```bat
cd tauri
npx tauri android build --apk --target aarch64
```

产物：`src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk`
（签名配置在 `gen/android/keystore.properties`，**该目录由 `android init` 生成、不入库**，
密钥模板见 `../BUILD.md`；maven/wrapper 走阿里云/腾讯镜像——重新 `android init` 后需要
重打镜像补丁）。

## 功能现状（v2.2.0，插件化）

- **核心四板块**：控制面板（统计卡/打卡日历/最近与推荐考试）、真题市场（筛选/收藏/
  购买/分享码）、我的题库、个人设置（资料/头像/改密/外观/存储/服务器地址），外加
  常驻「插件市场」与核心流程页（答题/刷题/仿真模拟考）。
- **功能插件**（从服务端下载安装，见根目录 `plugins/`）：学习记录（进行中/历史成绩/
  错题本/成绩回顾）、知识树（节点笔记/错题挂接/导出分享）、本地题库（离线刷题）、
  教学工具（题库管理/真题上传，仅教师可见）、冒险公会（任务悬赏/见闻手札/学习小队，
  独立公会壳）。

## 会话与安全

- Cookie 会话由 Rust 端 `reqwest` 统一持有（WebView 不直接访问后端，无跨域问题）；
- 「记住我」的 PHPSESSID / remember_token 经 **Windows DPAPI**（按当前用户）加密落盘
  `%APPDATA%\DotobeClientWeb\cookies.json`，启动时自动回注 cookie jar；
- 考试草稿与离线试卷缓存在同目录下 `exam_*.json` / `local_papers/`。
