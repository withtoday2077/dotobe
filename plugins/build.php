<?php
/**
 * 插件打包脚本（desktop-client/plugins/build.php）
 *
 * 用法：php build.php [插件id ...]   （缺省打包全部）
 *
 * 逐插件校验 manifest.json → 打 zip（manifest + js/ + css/ + assets/）
 * → 计算 SHA-256 → 产出到站点 uploads/plugins/ 目录（供后台「插件管理」上架）。
 * 改完插件源码重跑本脚本，再上传新版本即可热更新，无需发新客户端。
 */

if (PHP_SAPI !== 'cli') {
    exit("仅限命令行运行\n");
}

$root = __DIR__;
$out_dir = dirname(dirname($root)) . '/uploads/plugins';  // online_exam_system/uploads/plugins
if (!is_dir($out_dir)) {
    mkdir($out_dir, 0755, true);
}

// 允许打包的文件扩展名（与服务端/客户端白名单一致）
$allowed_exts = ['json', 'js', 'css', 'svg', 'png', 'jpg', 'woff2'];

/**
 * 递归收集目录下白名单文件，返回 [zip内相对路径 => 绝对路径]
 */
function collect_files($dir, $base, $allowed_exts) {
    $files = [];
    foreach (scandir($dir) as $name) {
        if ($name === '.' || $name === '..') continue;
        $path = $dir . '/' . $name;
        if (is_dir($path)) {
            $files = array_merge($files, collect_files($path, $base, $allowed_exts));
        } else {
            $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
            if (!in_array($ext, $allowed_exts, true)) {
                fwrite(STDERR, "  跳过非白名单文件: " . substr($path, strlen($base) + 1) . "\n");
                continue;
            }
            $files[substr($path, strlen($base) + 1)] = $path;
        }
    }
    return $files;
}

$targets = array_slice($GLOBALS['argv'], 1);
$plugin_dirs = array_filter(scandir($root), function ($n) use ($root) {
    return $n[0] !== '.' && is_dir($root . '/' . $n);
});
if ($targets) {
    $plugin_dirs = array_values(array_intersect($plugin_dirs, $targets));
    $missing = array_diff($targets, $plugin_dirs);
    if ($missing) {
        fwrite(STDERR, "未找到插件目录: " . implode(', ', $missing) . "\n");
    }
}

if (!class_exists('ZipArchive')) {
    exit("错误: PHP 缺少 ZipArchive 扩展\n");
}

printf("插件打包 → %s\n\n", $out_dir);
$packaged = 0;

foreach ($plugin_dirs as $id) {
    $dir = $root . '/' . $id;
    $manifest_path = $dir . '/manifest.json';
    if (!is_file($manifest_path)) {
        fwrite(STDERR, "[跳过] $id: 缺少 manifest.json\n");
        continue;
    }
    $manifest = json_decode(file_get_contents($manifest_path), true);
    if (!is_array($manifest) || ($manifest['format'] ?? '') !== 'dotobe-plugin'
        || empty($manifest['id']) || empty($manifest['version']) || empty($manifest['entry'])) {
        fwrite(STDERR, "[跳过] $id: manifest.json 不合法（须含 format=dotobe-plugin / id / version / entry）\n");
        continue;
    }
    if ($manifest['id'] !== $id) {
        fwrite(STDERR, "[跳过] $id: 目录名与 manifest.id（{$manifest['id']}）不一致\n");
        continue;
    }
    if (!is_file($dir . '/' . $manifest['entry'])) {
        fwrite(STDERR, "[跳过] $id: 入口文件不存在 {$manifest['entry']}\n");
        continue;
    }
    // manifest 声明的 css 必须存在
    foreach (($manifest['css'] ?? []) as $css) {
        if (!is_file($dir . '/' . $css)) {
            fwrite(STDERR, "[跳过] $id: manifest 声明的样式缺失 $css\n");
            continue 2;
        }
    }

    $zip_name = $id . '-' . $manifest['version'] . '.zip';
    $zip_path = $out_dir . '/' . $zip_name;

    $zip = new ZipArchive();
    if ($zip->open($zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        fwrite(STDERR, "[失败] $id: 无法创建 $zip_path\n");
        continue;
    }
    // manifest.json 压缩包内固定位于根
    $zip->addFile($manifest_path, 'manifest.json');
    foreach (collect_files($dir, $dir, $allowed_exts) as $rel => $abs) {
        $zip->addFile($abs, $rel);
    }
    $zip->close();

    $sha256 = hash_file('sha256', $zip_path);
    $size = filesize($zip_path);
    printf("[%s] v%s  %s  %s bytes  sha256=%s\n", $id, $manifest['version'], $zip_name, number_format($size), $sha256);
    $packaged++;
}

printf("\n完成：%d 个插件包。请到后台「高级功能 → 插件管理」上传上架（表单 id/版本须与包内 manifest 一致）。\n", $packaged);
