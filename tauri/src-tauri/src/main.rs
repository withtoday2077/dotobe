//! Dotobe 在线考试系统客户端（Tauri 版）—— Windows 桌面入口。
//!
//! 全部实现位于 lib.rs（桌面/Android 共用）；本文件只做 Windows GUI 子系统
//! 声明并调用 [`dotobe_tauri_lib::run`]。

// release 构建按 Windows GUI 子系统链接（不弹终端窗口）；debug 保留控制台便于看日志
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dotobe_tauri_lib::run()
}
