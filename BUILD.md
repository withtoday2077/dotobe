# 途变客户端打包发布指南

客户端源码位于 `desktop-client/tauri`（Tauri v2，Windows + Android 双端共用一套 Rust lib 与 `ui/` 前端）。
本文档说明两个产物的打包流程：**Windows NSIS 安装包** 与 **Android APK**。

> 注意：`ui/` 目录是静态前端资源（`tauri.conf.json` 的 `frontendDist` 直接指向它），
> **没有前端编译步骤**——改了 js/css/html 后直接重新打包即可生效，无需 npm build。

---

## 一、环境要求

### 通用（两端都需要）
- Node.js + npm（依赖已装在 `desktop-client/tauri/node_modules`，Tauri CLI 通过 `npx tauri` 调用）
- Rust 工具链（Windows 侧用 MSVC；`cargo check` 可秒级验证 Rust 改动）

### Windows NSIS
- 无需 JAVA / Android SDK
- NSIS 与 WebView2 安装器缓存位于 `%LOCALAPPDATA%\tauri\`（首次构建已缓存，离线可用）

### Android APK
| 项目 | 要求 |
|---|---|
| JAVA_HOME | JDK 17（必须 17，JDK 8 不行），指向本机 JDK 17 安装目录 |
| ANDROID_HOME | Android SDK 目录（含 platform-tools/build-tools） |
| NDK_HOME | Android NDK 目录（如 `<ANDROID_HOME>/ndk/27.x`） |
| Rust targets | `aarch64-linux-android`、`armv7-linux-androideabi`（`rustup target add` 安装） |

构建前先在当前会话确认：

```bash
echo "$JAVA_HOME" && echo "$ANDROID_HOME" && echo "$NDK_HOME"
java -version   # 应显示 17.x
```

若为空，手动 export 后再构建（路径换成你的本机安装位置）：

```bash
export JAVA_HOME="<JDK17 目录>"
export ANDROID_HOME="<Android SDK 目录>"
export NDK_HOME="<Android NDK 目录>"
```

---

## 二、版本号（发布前必改）

新版本发布前，**两处版本号要同步修改**：

1. `desktop-client/tauri/src-tauri/tauri.conf.json` → `"version": "2.1.1"`
2. `desktop-client/tauri/src-tauri/Cargo.toml` → `version = "2.1.1"`

Android 的 `versionName`/`versionCode` 由 Tauri 在构建时自动从 `tauri.conf.json` 注入
（`gen/android/app/build.gradle.kts` 读 `tauri.properties`），无需手改 gradle。

---

## 三、Windows NSIS 安装包

### 指令

```bash
cd desktop-client/tauri
npx tauri build
```

只想要主程序 exe、不打安装包时：`npx tauri build --no-bundle`。

### 产物位置

| 产物 | 路径 |
|---|---|
| **NSIS 安装包（交付物）** | `desktop-client/tauri/src-tauri/target/release/bundle/nsis/途变客户端_<版本>_x64-setup.exe`（约 210MB，内嵌 WebView2 离线安装器） |
| 主程序（绿色版 exe） | `desktop-client/tauri/src-tauri/target/release/途变客户端-v<版本>.exe` |

历史产物示例：`途变客户端_2.1.0_x64-setup.exe`、`途变客户端_2.1.1_x64-setup.exe` 均在上述 nsis 目录。

### 补充：独立小体积安装包脚本（可选）

`desktop-client/build_installer.bat`（双击运行）→ 调 `build_installer.ps1` → 用 NSIS 脚本
`installer/dotobe_client.nsi` 把绿色版 exe 打成 `dist\途变客户端-v2.1-setup.exe`：

- 默认内嵌 WebView2 离线包（约 210MB）；`-NoWebView2` 参数可出 4.4MB 小包（装时检测缺失则引导联网下载）
- 按用户安装（无需管理员）到 `%LOCALAPPDATA%\Programs\Dotobe`，版本号自动读 `tauri.conf.json`
- 脚本内置产物体积校验与程序占用检测

> 坑：`.ps1` 与 `.nsi` 都必须保存为 **UTF-8 BOM**，否则中文乱码甚至语法崩。

---

## 四、Android APK

### 指令（两种变体）

```bash
cd desktop-client/tauri

# 变体 A（推荐交付）：仅 arm64 单架构，约 14MB —— 平板/手机用这个
npx tauri android build --apk --target aarch64

# 变体 B：universal 全架构（arm64/armv7/x86/x86_64），约 47MB —— 少数旧设备才需要
npx tauri android build --apk
```

> 注意：**两种变体的产物都输出到同一路径**（目录名固定叫 universal），区别只在包内 ABI 内容。
> 变体 A 会覆盖变体 B 的产物，交付前以最后一次构建为准。

若报 `cc-rs: failed to find tool "clang.exe"`，先按第七节的办法 export NDK 编译器变量再构建。

### 产物位置

| 产物 | 路径 |
|---|---|
| **gradle 原始产物** | `desktop-client/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`（release 自签名；2.1.1 的 versionCode=2001001、versionName=2.1.1，见同目录 `output-metadata.json`） |
| **交付物（拷贝改名）** | 按惯例复制到 `desktop-client/tauri/途变客户端_<版本>_arm64.apk` |

拷贝改名命令（构建成功后执行）：

```bash
cp src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
   ./途变客户端_2.1.1_arm64.apk
```

### 签名

release 签名读取 `src-tauri/gen/android/keystore.properties`（该目录由 `tauri android init`
生成，**不入库**，密钥与密码切勿提交到仓库）。文件内容模板：

```properties
storeFile=<你的 .keystore/.jks 绝对路径>
storePassword=<密钥库密码>
keyAlias=<别名>
keyPassword=<密钥密码>
```

生成密钥库：`keytool -genkey -v -keystore my-release.keystore -alias <别名> -keyalg RSA -keysize 2048 -validity 10000`。

---

## 五、产物汇总

| 端 | 产物 | 位置 | 典型体积 |
|---|---|---|---|
| Windows | NSIS 安装包 | `tauri/src-tauri/target/release/bundle/nsis/途变客户端_<版本>_x64-setup.exe` | ~210MB |
| Windows | 绿色版主程序 | `tauri/src-tauri/target/release/途变客户端-v<版本>.exe` | — |
| Windows | 独立脚本小包（可选） | `desktop-client/dist/途变客户端-v2.1-setup.exe` | 210MB / 4.4MB |
| Android | APK（arm64 单架构，推荐） | 先在 `gen/android/.../apk/universal/release/`，后拷到 `tauri/途变客户端_<版本>_arm64.apk` | ~14MB |
| Android | APK（universal 全架构，可选） | 同上 | ~47MB |

---

## 六、发布上线

1. 打开后台管理 **`/backend/#releases`** 上传安装包（Windows 安装包 / APK 各一条记录）
2. 首页「下载客户端」按钮与 `frontend/download.php` 下载页自动读取最新版本
3. 下载走流式输出并计数，直链访问返回 403，无需手工同步文件

### 功能插件的上架与更新（v2.2.0 起，无需发新客户端）

```bash
cd desktop-client/plugins
php build.php            # 全部插件；或 php build.php knowledge 只打一个
```

产物（zip + sha256）落 `uploads/plugins/` → 后台 **`/backend/#plugins`**「插件管理」
上传（表单插件标识/版本须与包内 manifest.json 一致，服务端自动解包校验并算 SHA-256）
→ 勾选「设为当前版本」。客户端插件市场即见新版本，用户点更新即可。

- 首次部署需上传 5 个初始插件：study-records / knowledge / offline-bank /
  teaching-tools（roles=teacher,admin）/ guild；建表脚本为
  `database_updates/2026-09-28_client_plugins.sql`。
- 本地联调可用 `database_updates/seed_client_plugins_local.php` 直接登记打包产物。
- 插件开发规范见 `docs/PLUGIN_GUIDE.md`（裸名导入 / toAssetUrl / 安全白名单等硬约定）。

---

## 七、常见问题与避坑

### 构建卡住 / 报锁
- gradle daemon 被强杀后残留锁会让下次构建卡在 `Blocking waiting for file lock`：
  `jps` 查 Java 进程 PID 后 `taskkill /PID <pid> /F` 杀掉即可
- 强杀 tauri/cargo 构建同理，先杀残留进程再重试

### Android 专属
- **rust-std"假装已装"**：`rustup target list --installed` 显示已装、cargo 却报 `can't find crate for std`——是半途安装损坏（manifest 说有、文件没有）。强制重装：
  ```bash
  rustup component remove rust-std --target armv7-linux-androideabi
  rustup component add rust-std --target armv7-linux-androideabi
  ```
- **C 依赖编译找不到 clang**（`cc-rs: failed to find tool "clang.exe"`，rust 工具链更新后全量重编 C 依赖时触发）：给两个安卓目标显式指 NDK 编译器，**与构建命令同一条 shell 里 export**（Bash 环境变量不跨调用保留）：
  ```bash
  export NDKBIN="$NDK_HOME/toolchains/llvm/prebuilt/windows-x86_64/bin"
  export CC_armv7_linux_androideabi="$NDKBIN/armv7a-linux-androideabi24-clang.cmd"
  export CXX_armv7_linux_androideabi="$NDKBIN/armv7a-linux-androideabi24-clang++.cmd"
  export AR_armv7_linux_androideabi="$NDKBIN/llvm-ar.exe"
  export CC_aarch64_linux_android="$NDKBIN/aarch64-linux-android24-clang.cmd"
  export CXX_aarch64_linux_android="$NDKBIN/aarch64-linux-android24-clang++.cmd"
  export AR_aarch64_linux_android="$NDKBIN/llvm-ar.exe"
  ```
- **gradle 起不动 npm.bat / 卡锁**：陈旧 GradleDaemon 继承了过期 PATH 或残留锁。`jps` 找到 `GradleDaemon` 的 PID 后 `taskkill //F //PID <pid>` 杀掉，让下次构建起新 daemon
- `gen/android/gradle.properties` 里 `android.builder.sdkDownload=false` **不能删**（防止 AGP 挂起式自动下载卡死构建，曾假死 20 分钟）
- `package.json` 必须保留 `"tauri": "tauri"` script（gradle 回调 `npm run tauri …`，缺失则报 "Missing script"）
- **重新 `tauri android init` 会冲掉全部 gradle 补丁**，需重打：阿里云 maven 镜像（根/buildSrc settings.gradle.kts）、wrapper 腾讯镜像、compileSdk/targetSdk=36、签名 keystore.properties（模板见「四、Android APK → 签名」）、sdkDownload=false
- 本仓库不含 `gen/`（tauri android init 生成物，含签名配置不入库）：Android 构建前先 `npx tauri android init` 重新生成，再按上条重打补丁
- 缺 SDK 组件（platform/build-tools/NDK）时从腾讯镜像直链 zip 补：
  `https://mirrors.cloud.tencent.com/AndroidSDK/`（解压后注意嵌套目录要展平；licenses 手写 hash 接受许可）
- rustup 半途失败会留 manifest 冲突：删 `~/.rustup/.../lib/rustlib/manifest-rust-std-*` 后重装 target

### 通用
- 改了 Rust 代码先用 `cargo check`（src-tauri 下）秒级查错，再跑完整构建
- 换应用图标：`npx tauri icon <正方形png>`（PowerShell 遇中文路径乱码，先把图 cp 成 ASCII 名）；
  tauri-build 不会因图标变更触发重编译，改完图标 `touch src-tauri/src/main.rs`
- `tauri.conf.json` 里 `dragDropEnabled:false` 是编译期配置，改它必须重新构建安装包（非 ui 热更能覆盖）

---

## 八、本次（2.1.1）变更内容速览

- 我的题库试卷卡片：新增「开始/再考一次」入口，排版对齐 web 端（科目/难度标签、描述、元信息行）
- 真题上传：修复 Excel 导入报错（文件名变量作用域 + 解析器同步 web 09-24 新格式，兼容旧模板）
- 真题上传：新增「导入试卷包（.zip）」（对齐 web 编辑器的试卷包能力，图片走压缩上传）
- 修复弹窗/提示遮挡窗口最小化、关闭按钮的问题（顶栏层级提升）
