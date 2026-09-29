# 途变 · 在线考试系统桌面客户端（Dotobe Exam Client）

基于 **Tauri 2** 的跨平台桌面客户端（Windows / Android），对接在线考试系统 PHP 后端
（默认 `https://www.dotobe.cn`，可在设置中更换）。//因为作者自己的服务器是这个，所以没改，需要的可以自己搭建服务器切换到自己服务器即可。

**瘦客户端架构**：本地窗口 + 会话加密落盘 + 离线缓存，业务数据全在服务端；
前端为 `tauri/ui/` 下的零构建原生 HTML/CSS/JS（日系清新风），Rust 侧只做
API 代理、会话持久化（DPAPI 加密）、本地存储与插件装载。

## 特性

- **插件化架构（v2.2.0）**：核心保留 控制面板 / 真题市场 / 我的题库 / 个人设置 +
  插件市场；知识树、学习记录、本地题库、教学工具、冒险公会等以**真实插件包**（zip）
  从服务端下载安装，装后才显示、卸载即移除，插件热更新无需发新客户端。
  见 [`docs/PLUGIN_GUIDE.md`](docs/PLUGIN_GUIDE.md)
- **完整考试流程**：六种题型 + 材料分析子题、服务端倒计时自动交卷、答题卡、
  标记待复查、本地草稿自动保存（断点续答）、切屏防作弊计数、快捷键
- **全屏刷题 / 仿真模拟考**：逐题即时判分、刷题记录与错题重刷、A3 纸质小册仿真模式
- **离线能力**：试卷缓存到本地，「本地题库」插件无网刷题（即时判分），联网自动同步
- **真题市场**：试卷上架/购买/分享码导入；**冒险公会**：任务悬赏 + 手札社区 + 学习小队   //本购买体系仅作为保护所用，限制二次导出，防止白嫖后二次售卖
- **外观体系**：默认皮肤 + 深色模式 + 主题包导入（`themes/` 附样例），
  参照 [`页面样式开发要求.md`](页面样式开发要求.md) 
- **公式渲染**：KaTeX（含 mhchem）全链路支持

## 目录结构

```
dotobe-client/
├─ tauri/                     # ★ 主程序（Tauri 2）
│  ├─ ui/                     #    前端：零构建原生 HTML/CSS/JS（ES Modules）
│  │  ├─ index.html           #    含 importmap（插件以裸名引用核心模块）
│  │  ├─ css/                 #    tokens（设计令牌）/ app / pages / market …
│  │  └─ js/
│  │     ├─ main.js           #    装配：核心路由注册 + activateAll()
│  │     ├─ router.js / api.js / ui.js / shell …
│  │     ├─ plugin-state.js   #    插件运行时状态（菜单合成/壳配置）
│  │     ├─ plugin-loader.js  #    插件激活/装卸（asset 协议动态 import）
│  │     └─ pages/            #    核心页面（auth/dashboard/exams/market/mock/mybank/practice/settings/shell/take）
│  └─ src-tauri/              #    Rust 后端：API 代理/会话/本地存储/插件四命令
├─ plugins/                   # ★ 功能插件源码（每插件 manifest + js 入口 + css）
│  ├─ study-records/ knowledge/ offline-bank/ teaching-tools/ guild/
│  └─ build.php               #    打包脚本：zip + sha256 → 服务端 uploads/plugins/
├─ docs/PLUGIN_GUIDE.md       # ★ 插件开发指南（含安全口径与已知坑）
├─ BUILD.md                   # ★ 构建发布指南（NSIS / APK / 插件上架）
├─ installer/                 # 可选 NSIS 小体积安装包脚本
├─ build_client.bat/.ps1      # Windows 一键编译脚本
├─ themes/kawaii-cafe.dtheme  # 主题包样例
└─ 页面样式开发要求.md          # UI 视觉规范（Japanese Fresh 日系清新）
```

## 构建

前置：Node.js（Tauri CLI）、Rust stable、Windows 需 WebView2（Win10/11 自带）、
Android 需 JDK 17 + SDK + NDK。详见 [`BUILD.md`](BUILD.md)。

```bash
# Windows NSIS 安装包（~210MB，含 WebView2 离线安装器）
cd tauri && npx tauri build

# Android APK（arm64）
npx tauri android build --apk --target aarch64
```

> 注：本仓库不含 `tauri/src-tauri/gen/`（Android 工程生成物，含签名配置不入库）。
> Android 构建前先 `npx tauri android init` 生成并按 `BUILD.md` 重打镜像/签名补丁。

## 插件打包与上架

```bash
cd plugins && php build.php      # 产出 zip + sha256 到服务端 uploads/plugins/
```

服务端提供目录 API / 流式下载 / 后台管理（上传时自动校验包内 manifest 与 SHA-256）。
插件规范、安全口径（zip-slip 清洗/扩展名白名单/SHA-256 校验）与已知坑见
[`docs/PLUGIN_GUIDE.md`](docs/PLUGIN_GUIDE.md)。

## 使用

1. 启动后登录（支持「记住我」30 天免登录；会话经 DPAPI 加密落盘）
2. 首次进入弹出插件引导，按需安装功能模块；之后在「插件市场」随时装卸
3. 数据目录：`%APPDATA%\DotobeClientWeb\`（便携模式为 exe 旁 `data\`），
   可在「个人设置 → 存储」迁移；服务器地址在「个人设置 → 服务器」修改

## License

仅供学习交流使用。

<img width="1919" height="1230" alt="image" src="https://github.com/user-attachments/assets/d92f6009-fd51-42a3-8cf4-ef5901a2a789" />
<img width="1919" height="1230" alt="image" src="https://github.com/user-attachments/assets/079d640c-2d90-49f3-ac1e-bf8d6d578742" />
<img width="1919" height="1230" alt="image" src="https://github.com/user-attachments/assets/896a13d3-322c-41e1-8d22-e0cde623c63b" />


