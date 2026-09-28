//! Dotobe 在线考试系统桌面客户端（Tauri 版）—— Rust 后端。
//!
//! 职责（"服务全在服务器，本地只做客户端"）：
//! 1. HTTP 代理：前端经 [`api_request`]（带 Cookie 会话）访问 dotobe.cn 的 PHP API，
//!    避开 WebView 内 fetch 的跨域限制；
//! 2. 会话持久化：PHPSESSID / remember_token 经 Windows DPAPI 加密落盘；
//! 3. 本地数据：考试草稿、离线试卷缓存（%APPDATA%\DotobeClientWeb\）。
//!
//! 前端为 ui/ 下的零构建原生 HTML/CSS/JS（日系清新风）。

// release 构建按 Windows GUI 子系统链接（不弹终端窗口）；debug 保留控制台便于看日志
//（windows_subsystem 属性在 main.rs，lib 为双平台公共实现）

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL: &str = "https://www.dotobe.cn";

#[derive(Clone, Serialize)]
struct Config {
    base_url: String,
}

// ---------------------------------------------------------------------------
// 数据目录：三级优先级 = 便携(exe 旁 data\) > location.json 重定向 > 系统默认
// 重定向锚点固定写在默认目录，迁移后仍可被发现
// ---------------------------------------------------------------------------

fn default_data_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DotobeClientWeb")
}

fn location_marker_path() -> PathBuf {
    default_data_root().join("location.json")
}

/// 读取重定向标记（{"dir": "..."}，dir 为 null/缺失表示用默认）
fn read_location_marker() -> Option<String> {
    let text = std::fs::read_to_string(location_marker_path()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("dir").and_then(|d| d.as_str()).map(String::from)
}

/// 纯解析（便于单测）：便携目录 > 重定向 > 默认
fn resolve_data_dir(exe_dir: Option<&std::path::Path>, marker: Option<&str>) -> PathBuf {
    if let Some(dir) = exe_dir {
        let p = dir.join("data");
        if p.is_dir() {
            return p;
        }
    }
    if let Some(m) = marker {
        let p = PathBuf::from(m);
        if p.is_dir() {
            return p;
        }
    }
    default_data_root()
}

static DATA_DIR: std::sync::OnceLock<std::sync::RwLock<PathBuf>> = std::sync::OnceLock::new();

fn data_dir() -> PathBuf {
    let lock = DATA_DIR.get_or_init(|| {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));
        let marker = read_location_marker();
        let dir = resolve_data_dir(exe_dir.as_deref(), marker.as_deref());
        let _ = std::fs::create_dir_all(&dir);
        std::sync::RwLock::new(dir)
    });
    lock.read().unwrap().clone()
}

/// 当前是否处于便携模式（exe 旁 data 目录生效）
fn is_portable_mode() -> bool {
    match std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("data"))) {
        Some(p) => p.is_dir() && data_dir() == p,
        None => false,
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let to = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 搬移单个条目（跨盘时 rename 失败，回退为复制后删除）
fn move_entry(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if from.is_dir() {
        copy_dir_recursive(from, to)?;
        std::fs::remove_dir_all(from).map_err(|e| format!("删除源目录失败：{e}"))
    } else {
        std::fs::copy(from, to).map_err(|e| format!("复制失败：{e}"))?;
        std::fs::remove_file(from).map_err(|e| format!("删除源文件失败：{e}"))
    }
}

/// 迁移数据目录内容（location.json 是锚点不搬；目标非空则拒绝，防止覆盖）
fn migrate_data_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if src == dst {
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("无法创建目标目录：{e}"))?;
    if let Ok(entries) = std::fs::read_dir(dst) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name == "desktop.ini" || name == "Thumbs.db" || name == "System Volume Information" {
                continue;
            }
            return Err("目标目录不为空，为避免覆盖已有数据已中止".to_string());
        }
    }
    if !src.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        if entry.file_name() == "location.json" {
            continue;
        }
        move_entry(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

#[tauri::command(async)]
fn get_data_location() -> Value {
    let default = default_data_root();
    let current = data_dir();
    let portable = is_portable_mode();
    let first_run = !portable
        && !default.join("config.json").exists()
        && !default.join("cookies.json").exists()
        && !default.join("practice_stats.json").exists()
        && !default.join("local_papers").exists()
        && !location_marker_path().exists();
    serde_json::json!({
        "current": current.to_string_lossy(),
        "default": default.to_string_lossy(),
        "portable": portable,
        "custom": !portable && current != default,
        "firstRun": first_run,
    })
}

#[tauri::command(async)]
fn set_data_location(path: Option<String>) -> Result<Value, String> {
    if is_portable_mode() {
        return Err("便携模式下数据目录固定为 exe 旁的 data 文件夹；如需更改请先移除该文件夹".to_string());
    }
    let default = default_data_root();
    let _ = std::fs::create_dir_all(&default);
    let src = data_dir();
    let dst = match &path {
        None => default.clone(),
        Some(p) => {
            let p = PathBuf::from(p);
            if !p.exists() {
                return Err("目标路径不存在".to_string());
            }
            if p.is_file() {
                return Err("目标是一个文件，请选择文件夹".to_string());
            }
            if src.starts_with(&p) || p.starts_with(&src) {
                return Err("目标目录不能与当前数据目录相互嵌套".to_string());
            }
            if p.starts_with(r"C:\Windows") || p.parent().is_none() {
                return Err("目标位置不安全（系统目录/盘符根目录），请选择常规数据目录".to_string());
            }
            p
        }
    };

    migrate_data_dir(&src, &dst)?;

    // 锚点固定写在默认目录：dir=null 表示回默认（兼作首次初始化标记）
    let marker = serde_json::json!({ "dir": path });
    std::fs::write(location_marker_path(), marker.to_string())
        .map_err(|e| format!("写入位置标记失败：{e}"))?;

    if let Some(lock) = DATA_DIR.get() {
        *lock.write().unwrap() = dst.clone();
    }
    let _ = std::fs::create_dir_all(&dst);

    Ok(serde_json::json!({ "current": dst.to_string_lossy() }))
}

fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

fn load_config() -> Config {
    let base_url = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("base_url").and_then(|b| b.as_str()).map(String::from))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    Config { base_url }
}

// ---------------------------------------------------------------------------
// 外观插件：用户导入的主题包（dotobe-theme JSON v1，含可选 css 附加样式表字段）
// 存于 data_dir/themes/
// 深层令牌校验在前端 theme.js（白名单/值安全），此处做基础形状与文件安全校验
// ---------------------------------------------------------------------------

fn themes_dir() -> PathBuf {
    let dir = data_dir().join("themes");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 主题 id 白名单（兼作文件名，防路径穿越）
fn valid_theme_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 附加样式表（css 字段）校验：≤3MB（容纳内嵌 CJK 子集字体/插画）；禁 @import 与脚本向量；
/// url( 仅允许 data: 内嵌资源。与前端 theme.js 的 safeCss 规则对齐（双保险），此处用字节长度。
fn valid_theme_css(css: &str) -> bool {
    if css.trim().is_empty() || css.len() > 3 * 1024 * 1024 {
        return false;
    }
    let low = css.to_lowercase();
    if low.contains("@import")
        || low.contains("javascript:")
        || low.contains("expression(")
        || low.contains("behavior:")
        || low.contains("<script")
    {
        return false;
    }
    // url( 只允许 data:；逐个检查 url( 后是否直接跟可选引号 + data:
    let bytes = low.as_bytes();
    let mut i = 0;
    while let Some(pos) = low[i..].find("url(") {
        let mut j = i + pos + 4;
        while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t' || bytes[j] == b'\n' || bytes[j] == b'\r' || bytes[j] == b'"' || bytes[j] == b'\'') {
            j += 1;
        }
        if !low[j..].starts_with("data:") {
            return false;
        }
        i = j;
    }
    true
}

/// 基础形状校验：format/id/name/mode/tokens/css；返回规范化后的主题对象
fn theme_basic_validate(v: &Value) -> Result<Value, String> {
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    if !valid_theme_id(id) {
        return Err("id 需为 2-40 位小写字母/数字/连字符".to_string());
    }
    if v.get("format").and_then(|x| x.as_str()) != Some("dotobe-theme") {
        return Err("缺少 format: \"dotobe-theme\" 标识".to_string());
    }
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
    if name.trim().is_empty() || name.chars().count() > 24 {
        return Err("name 需为 1-24 个字符".to_string());
    }
    match v.get("mode").and_then(|x| x.as_str()) {
        Some("light") | Some("dark") => {}
        _ => return Err("mode 需为 \"light\" 或 \"dark\"".to_string()),
    }
    let tokens = v.get("tokens").and_then(|x| x.as_object()).ok_or("tokens 需为非空对象")?;
    if tokens.is_empty() {
        return Err("tokens 需为非空对象".to_string());
    }
    for (k, val) in tokens {
        if !k.starts_with("--") {
            return Err(format!("不支持的令牌键：{k}"));
        }
        let s = val.as_str().ok_or_else(|| format!("令牌 {k} 的值需为字符串"))?;
        if s.contains('{') || s.contains('}') {
            return Err(format!("令牌 {k} 的值不能包含花括号"));
        }
    }
    if let Some(css) = v.get("css") {
        let css = css.as_str().ok_or("css 需为字符串")?;
        if !valid_theme_css(css) {
            return Err("css 字段不合法（≤3MB，禁止 @import 与脚本向量，url( 仅允许 data:）".to_string());
        }
    }
    // 可选装饰声明：白名单与前端 DECOR 对齐，最多 8 项
    if let Some(decor) = v.get("decor") {
        let arr = decor.as_array().ok_or("decor 需为数组")?;
        if arr.len() > 8 {
            return Err("decor 最多 8 项".to_string());
        }
        for d in arr {
            let s = d.as_str().ok_or("decor 项需为字符串")?;
            if s != "petals" {
                return Err(format!("不支持的装饰：{s}（可选：petals）"));
            }
        }
    }
    Ok(v.clone())
}

#[tauri::command(async)]
fn import_theme(path: String) -> Result<Value, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.len() > 4 * 1024 * 1024 {
        return Err("主题包过大（超过 4MB）".to_string());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "JSON 解析失败".to_string())?;
    let theme = theme_basic_validate(&v)?;
    let id = theme.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let dest = themes_dir().join(format!("{id}.json"));
    if dest.exists() {
        return Err(format!("已存在同名主题「{id}」，请先删除后再导入"));
    }
    std::fs::write(&dest, serde_json::to_string_pretty(&theme).unwrap_or_default())
        .map_err(|e| format!("写入主题失败：{e}"))?;
    Ok(theme)
}

#[tauri::command(async)]
fn list_themes() -> Vec<Value> {
    let dir = themes_dir();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if theme_basic_validate(&v).is_ok() {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

#[tauri::command(async)]
fn delete_theme(id: String) -> Result<(), String> {
    if !valid_theme_id(&id) {
        return Err("非法的主题 id".to_string());
    }
    let p = themes_dir().join(format!("{id}.json"));
    if !p.exists() {
        return Err("主题不存在".to_string());
    }
    std::fs::remove_file(p).map_err(|e| format!("删除失败：{e}"))
}

// ---------------------------------------------------------------------------
// 功能插件：市场下载 → SHA-256 校验 → 解压安装（data_dir/plugins/<id>/）
// → 卸载 / 已装清单。前端经 asset 协议动态 import 包内入口模块。
// 安全：插件 id 白名单（防路径穿越）、zip-slip 清洗、扩展名白名单、
// 解压体积上限（防 zip 炸弹）、staging 目录原子换名。
// ---------------------------------------------------------------------------

fn plugins_dir() -> PathBuf {
    data_dir().join("plugins")
}

/// 插件 id 合法性（与服务端 admin/plugins.php 一致：小写字母开头，3-63 位）
fn valid_plugin_id(id: &str) -> bool {
    (3..=63).contains(&id.len())
        && id.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false)
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 插件包压缩体积上限（与服务端一致）
const PLUGIN_ZIP_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// 单文件解压上限 / 全包解压总上限（防 zip 炸弹）
const PLUGIN_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;
const PLUGIN_TOTAL_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// 允许解压出的文件扩展名
const PLUGIN_EXTS: &[&str] = &["json", "js", "css", "svg", "png", "jpg", "woff2"];

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// manifest.json 形状校验（与打包脚本/服务端口径一致）
fn plugin_manifest_validate(v: &Value) -> Result<(), String> {
    if v.get("format").and_then(|x| x.as_str()) != Some("dotobe-plugin") {
        return Err("缺少 format: \"dotobe-plugin\" 标识".to_string());
    }
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    if !valid_plugin_id(id) {
        return Err("manifest.id 需为小写字母开头的 3-63 位标识".to_string());
    }
    let version = v.get("version").and_then(|x| x.as_str()).unwrap_or("");
    if version.is_empty() || version.len() > 50 {
        return Err("manifest.version 不合法".to_string());
    }
    let entry = v.get("entry").and_then(|x| x.as_str()).unwrap_or("");
    if entry.is_empty() || entry.contains("..") {
        return Err("manifest.entry 不合法".to_string());
    }
    Ok(())
}

/// zip 条目路径清洗：拒绝绝对路径 / 父目录跳转 / 盘符 / 空字节，返回 base 下的安全路径
fn plugin_safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err(format!("路径包含非法字符：{rel}"));
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(format!("拒绝绝对路径条目：{rel}"));
    }
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            _ => return Err(format!("拒绝越界路径条目：{rel}")),
        }
    }
    Ok(base.join(p))
}

/// 下载插件包到临时文件并校验哈希。path 为相对 base_url 的下载地址（携带登录会话）。
#[tauri::command(async)]
fn plugin_download(state: State<'_, HttpState>, path: String, sha256: Option<String>) -> Result<Value, String> {
    let base = state.base_url.lock().unwrap().clone();
    let url = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
    let resp = state
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败（HTTP {}）", resp.status().as_u16()));
    }

    let tmp_dir = plugins_dir().join(".tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let tmp_path = tmp_dir.join(format!("pkg_{}_{}.zip", std::process::id(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));

    let bytes = resp.bytes().map_err(|e| format!("读取响应失败：{e}"))?;
    if bytes.len() as u64 > PLUGIN_ZIP_MAX_BYTES {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("插件包超过 {} MB 上限", PLUGIN_ZIP_MAX_BYTES / 1024 / 1024));
    }
    let actual = sha256_hex(&bytes);
    if let Some(expect) = sha256.as_deref().filter(|s| !s.is_empty()) {
        if !expect.eq_ignore_ascii_case(&actual) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err("插件包校验失败（SHA-256 不匹配），请重试".to_string());
        }
    }
    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;

    Ok(serde_json::json!({
        "path": tmp_path.to_string_lossy(),
        "size": bytes.len(),
        "sha256": actual,
    }))
}

/// 解压安装：manifest 校验 → 白名单解压到 staging → 原子换名到 plugins/<id>/
#[tauri::command(async)]
fn plugin_install(tmp_path: String) -> Result<Value, String> {
    let result = plugin_install_inner(&tmp_path);
    // 无论成败都清掉临时包
    let _ = std::fs::remove_file(&tmp_path);
    result
}

fn plugin_install_inner(tmp_path: &str) -> Result<Value, String> {
    let file = std::fs::File::open(tmp_path).map_err(|e| format!("打开插件包失败：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "插件包不是有效的 zip 文件".to_string())?;

    // manifest.json 必须位于压缩包根
    let manifest_str = {
        let mut entry = zip.by_name("manifest.json").map_err(|_| "插件包缺少 manifest.json".to_string())?;
        if entry.size() > 1024 * 1024 {
            return Err("manifest.json 过大".to_string());
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| format!("读取 manifest 失败：{e}"))?;
        String::from_utf8(buf).map_err(|_| "manifest.json 不是 UTF-8 文本".to_string())?
    };
    let manifest: Value = serde_json::from_str(&manifest_str).map_err(|_| "manifest.json 解析失败".to_string())?;
    plugin_manifest_validate(&manifest)?;
    let id = manifest.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let entry_path = manifest.get("entry").and_then(|x| x.as_str()).unwrap_or("").replace('\\', "/");

    let root = plugins_dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("创建插件目录失败：{e}"))?;
    let staging = root.join(format!(".stage-{id}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);

    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("读取压缩条目失败：{e}"))?;
        let name = entry.name().to_string();
        if name.is_empty() {
            continue;
        }
        let dest = plugin_safe_join(&staging, &name)?;
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        let ext = Path::new(&name).extension().and_then(|x| x.to_str()).map(|x| x.to_lowercase()).unwrap_or_default();
        if !PLUGIN_EXTS.contains(&ext.as_str()) {
            return Err(format!("插件包含不支持的文件类型：{name}"));
        }
        if entry.size() > PLUGIN_FILE_MAX_BYTES {
            return Err(format!("单文件超过解压上限：{name}"));
        }
        total += entry.size();
        if total > PLUGIN_TOTAL_MAX_BYTES {
            return Err("插件包解压总量超过上限".to_string());
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut out = std::fs::File::create(&dest).map_err(|e| format!("写入文件失败：{e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压失败：{e}"))?;
    }

    // 入口必须存在
    let entry_file = staging.join(&entry_path);
    if !entry_file.is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("入口文件不存在：{entry_path}"));
    }

    // 原子替换：旧目录先挪走，staging 换名到位，再清旧
    let final_dir = root.join(&id);
    let old = root.join(format!(".old-{id}-{}", std::process::id()));
    let replaced = final_dir.exists();
    if replaced {
        std::fs::rename(&final_dir, &old).map_err(|e| format!("替换旧版本失败：{e}"))?;
    }
    if let Err(e) = std::fs::rename(&staging, &final_dir) {
        let _ = std::fs::remove_dir_all(&staging);
        if replaced {
            let _ = std::fs::rename(&old, &final_dir);
        }
        return Err(format!("安装失败：{e}"));
    }
    if replaced {
        let _ = std::fs::remove_dir_all(&old);
    }

    Ok(manifest)
}

/// 卸载：删除插件目录（本地缓存/服务端数据不受影响）
#[tauri::command(async)]
fn plugin_uninstall(id: String) -> Result<(), String> {
    if !valid_plugin_id(&id) {
        return Err("非法的插件 id".to_string());
    }
    let dir = plugins_dir().join(&id);
    if !dir.is_dir() {
        return Err("插件未安装".to_string());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("卸载失败：{e}"))
}

/// 已安装清单：扫描 plugins/*/manifest.json（目录存在即已安装）
#[tauri::command(async)]
fn plugin_list_installed() -> Vec<Value> {
    let root = plugins_dir();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !valid_plugin_id(&name) {
                continue;
            }
            let mp = dir.join("manifest.json");
            if let Ok(text) = std::fs::read_to_string(&mp) {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if plugin_manifest_validate(&v).is_ok() {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// HTTP 客户端（阻塞式 + Cookie 会话）
// ---------------------------------------------------------------------------

struct HttpState {
    client: reqwest::blocking::Client,
    jar: std::sync::Arc<reqwest::cookie::Jar>,
    base_url: Mutex<String>,
    /// 离线标志：最近一次请求是否为连接类失败
    offline: Mutex<bool>,
    /// 关键登录 cookie（PHPSESSID / remember_token），随响应自动持久化
    saved: Mutex<std::collections::HashMap<String, String>>,
}

#[derive(Deserialize)]
struct ApiRequest {
    method: Option<String>,
    path: String,
    #[serde(default)]
    params: std::collections::HashMap<String, String>,
    #[serde(default)]
    body: Option<Value>,
    /// true 时 body 以 application/json 发送（读 php://input 的接口，如交卷）；
    /// "form" 时走 multipart/form-data（读 $_FILES + $_POST 的接口，如手札发布）；
    /// 缺省 false 时 POST body 走 application/x-www-form-urlencoded（读 $_POST 的接口）
    #[serde(default)]
    json: bool,
    #[serde(default)]
    form: bool,
}

#[derive(Serialize)]
struct ApiResult {
    ok: bool,
    status: u16,
    /// 请求成功时为响应 JSON 文本；网络失败时为错误说明
    text: String,
    offline: bool,
}

impl HttpState {
    fn new() -> Self {
        let jar = std::sync::Arc::new(reqwest::cookie::Jar::default());
        let client = reqwest::blocking::Client::builder()
            .cookie_provider(jar.clone())
            .user_agent("DotobeClient/2.0")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("http client");
        let state = Self {
            client,
            jar,
            base_url: Mutex::new(load_config().base_url),
            offline: Mutex::new(false),
            saved: Mutex::new(std::collections::HashMap::new()),
        };
        state.restore_session();
        state
    }

    /// 启动时把 DPAPI 落盘的会话回注到 cookie jar（实现"记住我"跨进程重启）。
    fn restore_session(&self) {
        let Some(v) = load_cookies_value() else { return };
        let Some(map) = v.as_object() else { return };
        let base = self.base_url.lock().unwrap().clone();
        let Ok(url) = url::Url::parse(&base) else { return };
        for (k, val) in map {
            let Some(s) = val.as_str() else { continue };
            let raw = format!("{}={}; Path=/", k, s);
            self.jar.add_cookie_str(&raw, &url);
            self.saved.lock().unwrap().insert(k.clone(), s.to_string());
        }
    }

    fn request(&self, req: ApiRequest) -> ApiResult {
        let base = self.base_url.lock().unwrap().clone();
        let method = req.method.unwrap_or_else(|| "GET".to_string()).to_uppercase();
        let mut url = format!("{}/{}", base.trim_end_matches('/'), req.path.trim_start_matches('/'));
        if !req.params.is_empty() {
            let qs: Vec<String> = req
                .params
                .iter()
                .map(|(k, v)| format!("{}={}", k, urlencode(v)))
                .collect();
            url.push('?');
            url.push_str(&qs.join("&"));
        }
        let built = match method.as_str() {
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "DELETE" => self.client.delete(&url),
            _ => self.client.get(&url),
        };
        let built = match (&req.body, req.json, req.form) {
            (Some(Value::Object(map)), false, true) if method == "POST" => {
                // multipart：FormData（文本字段；文件走独立上传接口）
                use reqwest::blocking::multipart::Form;
                let mut form = Form::new();
                for (k, v) in map {
                    match v {
                        Value::String(sv) => form = form.text(k.clone(), sv.clone()),
                        other => form = form.text(k.clone(), other.to_string()),
                    }
                }
                built.multipart(form)
            }
            (Some(Value::Object(map)), false, false) if method == "POST" => {
                // 表单提交（PHP 后端按 $_POST 读取）
                let pairs: Vec<(String, String)> = map
                    .iter()
                    .map(|(k, v)| match v {
                        Value::String(s) => (k.clone(), s.clone()),
                        other => (k.clone(), other.to_string()),
                    })
                    .collect();
                built.form(&pairs)
            }
            (Some(v), true, _) => built.json(v),
            (Some(v), false, _) => built.json(v),
            _ => built,
        };
        match built.send() {
            Ok(resp) => {
                *self.offline.lock().unwrap() = false;
                self.capture_set_cookies(&resp);
                ApiResult {
                    ok: resp.status().is_success(),
                    status: resp.status().as_u16(),
                    text: resp.text().unwrap_or_default(),
                    offline: false,
                }
            }
            Err(e) => {
                let offline = e.is_connect() || e.is_timeout();
                *self.offline.lock().unwrap() = offline;
                ApiResult {
                    ok: false,
                    status: 0,
                    text: if offline {
                        "网络连接失败，请检查网络后重试".to_string()
                    } else {
                        format!("请求失败：{}", e)
                    },
                    offline,
                }
            }
        }
    }
}

impl HttpState {
    /// 从响应 Set-Cookie 中捕获关键登录 cookie（PHPSESSID / remember_token）并 DPAPI 落盘
    fn capture_set_cookies(&self, resp: &reqwest::blocking::Response) {
        use reqwest::header::SET_COOKIE;
        let mut updated = false;
        {
            let mut saved = self.saved.lock().unwrap();
            for v in resp.headers().get_all(SET_COOKIE) {
                let Ok(cv) = v.to_str() else { continue };
                let pair = cv.split(';').next().unwrap_or("");
                for name in ["PHPSESSID=", "remember_token="] {
                    if pair.starts_with(name) {
                        saved.insert(name.trim_end_matches('=').to_string(), pair[name.len()..].to_string());
                        updated = true;
                    }
                }
            }
        }
        if !updated { return; }
        let map = self.saved.lock().unwrap().clone();
        let value = serde_json::json!({ "v": 1, "data": map });
        #[cfg(windows)]
        let content = dpapi_protect(value.to_string().as_bytes())
            .map(|c| serde_json::json!({ "alg": "dpapi", "data": encode_b64(&c) }));
        #[cfg(not(windows))]
        let content: Result<Value, String> = Ok(value);
        if let Ok(text) = content {
            let _ = std::fs::write(data_dir().join("cookies.json"), text.to_string());
        }
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 会话持久化（DPAPI）
// ---------------------------------------------------------------------------

/// 从 webview 前端收到 cookie（document.cookie 不可用时由后端响应头提取，见 save_cookies_from_headers）。
#[tauri::command(async)]
fn save_cookies(state: State<'_, HttpState>, cookies: std::collections::HashMap<String, String>) {
    let value = serde_json::json!({ "v": 1, "data": cookies });
    #[cfg(windows)]
    let content = dpapi_protect(value.to_string().as_bytes())
        .map(|cipher| serde_json::json!({ "alg": "dpapi", "data": encode_b64(&cipher) }));
    #[cfg(not(windows))]
    let content: Result<Value, String> = Ok(value);
    if let Ok(text) = content {
        let _ = std::fs::write(data_dir().join("cookies.json"), text.to_string());
    }
    let _ = state; // 会话经由 client cookie jar 生效
}

#[tauri::command(async)]
fn load_cookies() -> Option<Value> {
    load_cookies_value()
}

/// 读取 DPAPI 加密的 cookies.json → {PHPSESSID: "...", remember_token: "..."}
fn load_cookies_value() -> Option<Value> {
    let text = std::fs::read_to_string(data_dir().join("cookies.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    match v.get("alg").and_then(|a| a.as_str()) {
        Some("dpapi") => {
            #[cfg(windows)]
            {
                let data = v.get("data").and_then(|d| d.as_str())?;
                let cipher = decode_b64(data)?;
                let plain = dpapi_unprotect(&cipher).ok()?;
                let inner: Value = serde_json::from_str(&String::from_utf8(plain).ok()?).ok()?;
                inner.get("data").cloned()
            }
            #[cfg(not(windows))]
            None
        }
        // 旧明文格式
        _ => v.get("data").cloned(),
    }
}

#[tauri::command(async)]
fn clear_cookies() {
    let _ = std::fs::remove_file(data_dir().join("cookies.json"));
}

// ---------------------------------------------------------------------------
// 配置命令
// ---------------------------------------------------------------------------

#[tauri::command(async)]
fn get_config() -> Config {
    load_config()
}

#[tauri::command(async)]
fn set_base_url(state: State<'_, HttpState>, base_url: String) {
    let url = if base_url.is_empty() {
        DEFAULT_BASE_URL.to_string()
    } else {
        base_url
    };
    *state.base_url.lock().unwrap() = url.clone();
    let _ = std::fs::write(
        config_path(),
        serde_json::json!({ "base_url": url }).to_string(),
    );
}

// ---------------------------------------------------------------------------
// 考试草稿 / 离线试卷缓存
// ---------------------------------------------------------------------------

#[tauri::command(async)]
fn save_draft(exam_id: i64, draft: Value) {
    let _ = serde_json::to_string(&draft).map(|s| {
        std::fs::File::create(data_dir().join(format!("exam_{}_draft.json", exam_id)))
            .and_then(|mut f| f.write_all(s.as_bytes()))
    });
}

#[tauri::command(async)]
fn load_draft(exam_id: i64) -> Option<Value> {
    let path = data_dir().join(format!("exam_{}_draft.json", exam_id));
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

#[tauri::command(async)]
fn clear_draft(exam_id: i64) {
    let _ = std::fs::remove_file(data_dir().join(format!("exam_{}_draft.json", exam_id)));
}

fn papers_dir() -> PathBuf {
    let dir = data_dir().join("local_papers");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[tauri::command(async)]
fn cache_paper(exam_id: i64, paper: Value) {
    let _ = serde_json::to_string_pretty(&paper).map(|s| {
        std::fs::File::create(papers_dir().join(format!("{}.json", exam_id)))
            .and_then(|mut f| f.write_all(s.as_bytes()))
    });
}

#[tauri::command(async)]
fn get_cached_paper(exam_id: i64) -> Option<Value> {
    let path = papers_dir().join(format!("{}.json", exam_id));
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

#[tauri::command(async)]
fn delete_cached_paper(exam_id: i64) {
    let _ = std::fs::remove_file(papers_dir().join(format!("{}.json", exam_id)));
}

#[tauri::command(async)]
fn list_cached_papers() -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(papers_dir()) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let stem = path.file_stem().and_then(|x| x.to_str()).unwrap_or("");
            let id: i64 = stem.parse().unwrap_or(0);
            if let Ok(s) = std::fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<Value>(&s) {
                    let meta = v.get("exam").unwrap_or(&v);
                    let title = meta
                        .get("title")
                        .and_then(|t| t.as_str())
                        .unwrap_or("未命名试卷")
                        .to_string();
                    let count = v
                        .get("questions")
                        .and_then(|q| q.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    let cached_at = meta
                        .get("cached_at")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    out.push(serde_json::json!({
                        "exam_id": id, "title": title, "question_count": count, "cached_at": cached_at
                    }));
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 刷题进度 / 刷题统计（本地保存）
// ---------------------------------------------------------------------------

fn practice_progress_path(exam_id: i64) -> PathBuf {
    data_dir().join(format!("practice_{}.json", exam_id))
}

#[tauri::command(async)]
fn save_practice(exam_id: i64, progress: Value) {
    let _ = serde_json::to_string(&progress).map(|s| {
        std::fs::File::create(practice_progress_path(exam_id))
            .and_then(|mut f| f.write_all(s.as_bytes()))
    });
}

#[tauri::command(async)]
fn load_practice(exam_id: i64) -> Option<Value> {
    std::fs::read_to_string(practice_progress_path(exam_id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

#[tauri::command(async)]
fn clear_practice(exam_id: i64) {
    let _ = std::fs::remove_file(practice_progress_path(exam_id));
}

/// 刷题总记录：一次会话完成（或中途退出）时累加 {question_count, correct_count, duration}
#[tauri::command(async)]
fn record_practice(stats: Value) {
    let path = data_dir().join("practice_stats.json");
    let mut records: Vec<Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    records.push(stats);
    if records.len() > 500 {
        records.drain(0..records.len() - 500);
    }
    let _ = serde_json::to_string(&records).map(|s| {
        std::fs::write(&path, s)
    });
}

#[tauri::command(async)]
fn load_practice_stats() -> Vec<Value> {
    std::fs::read_to_string(data_dir().join("practice_stats.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 本地通用键值缓存（知识点树等页面数据，离线优先加载 + 检测更新）
// ---------------------------------------------------------------------------

fn cache_path(key: &str) -> PathBuf {
    data_dir().join(format!("cache_{}.json", key))
}

#[tauri::command(async)]
fn save_local_cache(key: String, value: Value) {
    let _ = serde_json::to_string(&value).map(|s| {
        std::fs::File::create(cache_path(&key))
            .and_then(|mut f| f.write_all(s.as_bytes()))
    });
}

#[tauri::command(async)]
fn load_local_cache(key: String) -> Option<Value> {
    std::fs::read_to_string(cache_path(&key))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

// ---------------------------------------------------------------------------
// 验证码 / 头像等二进制拉取 → data URL
// ---------------------------------------------------------------------------

#[tauri::command(async)]
fn fetch_data_url(state: State<'_, HttpState>, path: String, params: std::collections::HashMap<String, String>) -> ApiResult {
    let base = state.base_url.lock().unwrap().clone();
    let mut url = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
    if !params.is_empty() {
        let qs: Vec<String> = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, urlencode(v)))
            .collect();
        url.push('?');
        url.push_str(&qs.join("&"));
    }
    match state.client.get(&url).send() {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let headers = resp.headers().clone();
            match resp.bytes() {
                Ok(bytes) => {
                    let mime = headers
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|m| m.to_str().ok())
                        .unwrap_or("image/png")
                        .to_string();
                    let b64 = encode_b64(&bytes);
                    ApiResult {
                        ok: true,
                        status,
                        text: format!("data:{};base64,{}", mime, b64),
                        offline: false,
                    }
                }
                Err(e) => ApiResult { ok: false, status, text: e.to_string(), offline: false },
            }
        }
        Err(e) => ApiResult { ok: false, status: 0, text: e.to_string(), offline: true },
    }
}

/// 读取本地二进制文件为 base64（题图上传用）。
#[tauri::command(async)]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{}", e))?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("文件过大（超过 12MB）".to_string());
    }
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 弹出「另存为」对话框，把 base64 内容写入用户选择的路径（Excel 模板下载用）。
#[tauri::command]
fn export_file(
    app: tauri::AppHandle,
    default_name: String,
    base64_data: String,
    filter_name: Option<String>,
    filter_exts: Option<Vec<String>>,
) {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .unwrap_or_default();
    let exts = filter_exts.unwrap_or_else(|| vec!["xlsx".to_string()]);
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(
            filter_name.as_deref().unwrap_or("Excel 工作簿"),
            &exts.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        )
        .save_file(move |path| {
            if let Some(p) = path {
                if let Ok(full) = p.into_path() {
                    let _ = std::fs::write(&full, &data);
                }
            }
        });
}

/// multipart 文件上传（头像等）。
/// 读取本地文本文件（真题 JSON 导入用）。
#[tauri::command(async)]
fn read_file_text(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{}", e))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("文件过大（超过 8MB）".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())
}

#[tauri::command(async)]
fn upload_file(state: State<'_, HttpState>, path: String, file_field: String, file_path: String, extra: std::collections::HashMap<String, String>) -> ApiResult {
    use reqwest::blocking::multipart::{Form, Part};
    let base = state.base_url.lock().unwrap().clone();
    let url = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
    match std::fs::read(&file_path) {
        Ok(bytes) => {
            let file_name = std::path::Path::new(&file_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("upload.bin")
                .to_string();
            let mut form = Form::new();
            for (k, v) in &extra {
                form = form.text(k.clone(), v.clone());
            }
            form = form.part(file_field, Part::bytes(bytes).file_name(file_name));
            match state.client.post(&url).multipart(form).send() {
                Ok(resp) => ApiResult {
                    ok: resp.status().is_success(),
                    status: resp.status().as_u16(),
                    text: resp.text().unwrap_or_default(),
                    offline: false,
                },
                Err(e) => ApiResult { ok: false, status: 0, text: e.to_string(), offline: true },
            }
        }
        Err(e) => ApiResult { ok: false, status: 0, text: format!("读取文件失败：{}", e), offline: false },
    }
}

/// multipart 上传内存字节（客户端已压缩为 WebP 的错题图片等），data_base64 为文件内容。
#[tauri::command(async)]
fn upload_bytes(
    state: State<'_, HttpState>,
    path: String,
    file_field: String,
    file_name: String,
    data_base64: String,
    mime: Option<String>,
    extra: std::collections::HashMap<String, String>,
) -> ApiResult {
    use base64::Engine;
    use reqwest::blocking::multipart::{Form, Part};
    let base = state.base_url.lock().unwrap().clone();
    let url = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&data_base64) {
        Ok(b) => b,
        Err(e) => return ApiResult { ok: false, status: 0, text: format!("base64 解码失败：{}", e), offline: false },
    };
    // mime_str 失败时回退为不带 Content-Type 的 part（服务端按文件内容嗅探，此头非必需）
    let part = match mime.as_deref().filter(|m| !m.is_empty()) {
        Some(m) => match Part::bytes(bytes.clone()).file_name(file_name.clone()).mime_str(m) {
            Ok(p) => p,
            Err(_) => Part::bytes(bytes).file_name(file_name),
        },
        None => Part::bytes(bytes).file_name(file_name),
    };
    let mut form = Form::new();
    for (k, v) in &extra {
        form = form.text(k.clone(), v.clone());
    }
    form = form.part(file_field, part);
    match state.client.post(&url).multipart(form).send() {
        Ok(resp) => ApiResult {
            ok: resp.status().is_success(),
            status: resp.status().as_u16(),
            text: resp.text().unwrap_or_default(),
            offline: false,
        },
        Err(e) => ApiResult { ok: false, status: 0, text: e.to_string(), offline: true },
    }
}

// ---------------------------------------------------------------------------
// API 透传命令
// ---------------------------------------------------------------------------

#[tauri::command(async)]
fn api_request(state: State<'_, HttpState>, req: ApiRequest) -> ApiResult {
    state.request(req)
}

#[tauri::command(async)]
fn is_offline(state: State<'_, HttpState>) -> bool {
    *state.offline.lock().unwrap()
}

/// 探测联网（恢复在线后由前端触发冲刷）。
#[tauri::command(async)]
fn probe_online(state: State<'_, HttpState>) -> bool {
    let base = state.base_url.lock().unwrap().clone();
    let url = format!("{}/backend/api/captcha.php", base.trim_end_matches('/'));
    state.client.head(&url).send().is_ok()
}

// ---------------------------------------------------------------------------
// DPAPI
// ---------------------------------------------------------------------------

fn encode_b64(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn decode_b64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        let ok = CryptProtectData(&input, null(), null(), null(), null(), 0, &mut out);
        if ok == 0 {
            return Err("DPAPI 加密失败".to_string());
        }
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize);
        let v = slice.to_vec();
        LocalFree(out.pbData as *mut _);
        Ok(v)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        let ok = CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut out);
        if ok == 0 {
            return Err("DPAPI 解密失败".to_string());
        }
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize);
        let v = slice.to_vec();
        LocalFree(out.pbData as *mut _);
        Ok(v)
    }
}

// ---------------------------------------------------------------------------
// 入口：桌面由 src/main.rs 调用；Android/iOS 经 mobile_entry_point 进入
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // 移动端：dirs crate 读不到主目录（Android 无 $HOME 且 POSIX 回退被禁用），
            // 数据目录必须用应用私有目录，否则 cookies/草稿/缓存全部静默写入失败。
            // 桌面端此分支不参与编译，逻辑保持不变。
            #[cfg(mobile)]
            {
                use tauri::Manager;
                if let Ok(dir) = _app.path().app_data_dir() {
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = DATA_DIR.set(std::sync::RwLock::new(dir));
                }
            }

            // —— 功能插件：asset 协议只放行数据目录下的 plugins/（运行时扩展 scope，
            //    兼容便携/重定向目录）。前端 convertFileSrc + 动态 import 加载包内模块。 ——
            {
                use tauri::Manager;
                let dir = plugins_dir();
                let _ = std::fs::create_dir_all(&dir);
                let _ = _app.asset_protocol_scope().allow_directory(dir, true);
            }

            // —— 启动屏衔接：splashscreen 窗口在 conf 中先建先显，main 初始隐藏。
            // 前端完成会话探测并渲染目标页后 emit "app-ready"，此处显示主窗（此时页内
            // 启动层已与启动屏同画面，切换无感）并撤掉启动屏；8 秒兜底强制显示，
            // 防止前端异常导致永远卡在启动屏。桌面/移动同逻辑。 ——
            fn reveal_main(
                ready: &std::sync::atomic::AtomicBool,
                handle: &tauri::AppHandle,
            ) {
                use tauri::Manager;
                if ready.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return; // 已显示过（幂等）
                }
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                if let Some(splash) = handle.get_webview_window("splashscreen") {
                    let _ = splash.destroy();
                }
            }
            use tauri::Listener;
            let ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let handle = _app.handle().clone();
            {
                let (ready, handle) = (ready.clone(), handle.clone());
                _app.listen("app-ready", move |_| {
                    reveal_main(&ready, &handle);
                });
            }
            {
                let (ready, handle) = (ready.clone(), handle.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    reveal_main(&ready, &handle);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口关闭时一并撤掉启动屏，避免残窗阻止进程按“全部窗口关闭即退出”收尾
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    use tauri::Manager;
                    if let Some(splash) = window.app_handle().get_webview_window("splashscreen") {
                        let _ = splash.destroy();
                    }
                }
            }
        })
        .manage(HttpState::new())
        .invoke_handler(tauri::generate_handler![
            api_request,
            fetch_data_url,
            upload_file,
            upload_bytes,
            read_file_text,
            read_file_base64,
            export_file,
            save_cookies,
            load_cookies,
            clear_cookies,
            get_config,
            set_base_url,
            save_draft,
            load_draft,
            clear_draft,
            cache_paper,
            get_cached_paper,
            delete_cached_paper,
            list_cached_papers,
            save_practice,
            load_practice,
            clear_practice,
            record_practice,
            load_practice_stats,
            save_local_cache,
            load_local_cache,
            get_data_location,
            set_data_location,
            import_theme,
            list_themes,
            delete_theme,
            plugin_download,
            plugin_install,
            plugin_uninstall,
            plugin_list_installed,
            is_offline,
            probe_online
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dotobe_km_test_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn resolve_priority_portable_wins() {
        let base = tmp("prio");
        let exe_dir = base.join("exe");
        let portable = exe_dir.join("data");
        let custom = base.join("custom");
        for d in [&exe_dir, &portable, &custom] {
            std::fs::create_dir_all(d).unwrap();
        }
        // 便携 > 重定向
        assert_eq!(resolve_data_dir(Some(exe_dir.as_path()), Some(custom.to_str().unwrap())), portable);
        // 无便携 → 重定向
        assert_eq!(resolve_data_dir(Some(exe_dir.parent().unwrap()), Some(custom.to_str().unwrap())), custom);
        // 重定向目录不存在 → 默认
        let ghost = base.join("ghost");
        let fallback = resolve_data_dir(None, Some(ghost.to_str().unwrap()));
        assert_eq!(fallback, default_data_root());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migrate_moves_all_and_skips_marker() {
        let base = tmp("mig");
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(src.join("local_papers")).unwrap();
        std::fs::write(src.join("config.json"), "{}").unwrap();
        std::fs::write(src.join("location.json"), r#"{"dir":"x"}"#).unwrap();
        std::fs::write(src.join("local_papers").join("p.json"), "1").unwrap();

        migrate_data_dir(&src, &dst).unwrap();
        assert!(dst.join("config.json").is_file());
        assert!(dst.join("local_papers").join("p.json").is_file());
        // 锚点不搬
        assert!(src.join("location.json").is_file());
        assert!(!dst.join("location.json").exists());
        assert!(!src.join("config.json").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migrate_rejects_non_empty_target() {
        let base = tmp("rej");
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("a.json"), "1").unwrap();
        std::fs::write(dst.join("existing.json"), "x").unwrap();

        let r = migrate_data_dir(&src, &dst);
        assert!(r.is_err());
        // 源未被破坏
        assert!(src.join("a.json").is_file());
        assert!(dst.join("existing.json").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migrate_same_dir_noop() {
        let base = tmp("noop");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("a.json"), "1").unwrap();
        migrate_data_dir(Path::new(&base), Path::new(&base)).unwrap();
        assert!(base.join("a.json").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod theme_tests {
    use super::*;

    fn ok_theme() -> Value {
        serde_json::json!({
            "format": "dotobe-theme", "version": 1,
            "id": "ocean-mist", "name": "海洋雾蓝", "mode": "light",
            "tokens": { "--sky": "#4a90d9", "--rice": "#f2f6fa" }
        })
    }

    #[test]
    fn validate_ok() {
        assert!(theme_basic_validate(&ok_theme()).is_ok());
    }

    #[test]
    fn reject_bad_id_and_format() {
        let mut t = ok_theme();
        t["id"] = Value::String("../evil".into());
        assert!(theme_basic_validate(&t).is_err());
        let mut t2 = ok_theme();
        t2["format"] = Value::String("other".into());
        assert!(theme_basic_validate(&t2).is_err());
    }

    #[test]
    fn reject_bad_mode_and_empty_tokens() {
        let mut t = ok_theme();
        t["mode"] = Value::String("blue".into());
        assert!(theme_basic_validate(&t).is_err());
        let mut t2 = ok_theme();
        t2["tokens"] = serde_json::json!({});
        assert!(theme_basic_validate(&t2).is_err());
    }

    #[test]
    fn reject_non_string_token_value() {
        let mut t = ok_theme();
        t["tokens"] = serde_json::json!({ "--sky": 123 });
        assert!(theme_basic_validate(&t).is_err());
    }

    #[test]
    fn valid_theme_id_rules() {
        assert!(valid_theme_id("abc-123"));
        assert!(!valid_theme_id(""));
        assert!(!valid_theme_id("../x"));
        assert!(!valid_theme_id("ABC"));
    }
}
