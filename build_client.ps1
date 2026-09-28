# ============================================================
#  Dotobe 桌面客户端（Tauri 2 版）一键编译脚本  v2.1
#  · 自动检测 Node / Rust(msvc) / VS Build Tools 并进入编译环境
#  · 强制使用 msvc 工具链（tauri 在 Windows 上必须 MSVC）
#  · 产物：src-tauri\target\release\dotobe-tauri.exe
#  · 打包绿色版：dist\途变客户端-v2.1-win64.zip
#  · 用法：双击 build_client.bat（本文件由它调用）
# ============================================================

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$TauriDir  = Join-Path $Root 'tauri'
$BuildDir  = Join-Path $TauriDir 'src-tauri\target\release'
$DistDir   = Join-Path $Root 'dist'
$Toolchain = 'stable-x86_64-pc-windows-msvc'
$ExeName   = 'dotobe-tauri.exe'
$ProductExe= '途变客户端-v2.1.exe'
$ZipName   = '途变客户端-v2.1-win64.zip'
$DllName   = 'WebView2Loader.dll'

function Fail($msg) {
    Write-Host ''
    Write-Host '  ==============================================' -ForegroundColor Red
    Write-Host '   编译失败 FAIL  ' -ForegroundColor Red
    Write-Host $msg -ForegroundColor Red
    Write-Host '  ==============================================' -ForegroundColor Red
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '  ==============================================' -ForegroundColor Cyan
Write-Host '   Dotobe 桌面客户端 v2.1 · 一键编译' -ForegroundColor Cyan
Write-Host '  ==============================================' -ForegroundColor Cyan
Write-Host ''

# ---------- 1. Node.js ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail '未找到 Node.js，请安装 Node 18+ 并加入 PATH。' }
Write-Host "  [1/6] Node.js        : $(& node --version)"

# ---------- 2. tauri CLI ----------
$tauriCli = Join-Path $TauriDir 'node_modules\.bin\tauri.cmd'
if (-not (Test-Path $tauriCli)) {
    Write-Host '  [提示] 未找到 tauri CLI，正在 npm install …'
    Push-Location $TauriDir
    & npm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'npm install 失败。' }
    Pop-Location
}
Write-Host '  [2/6] Tauri CLI      : 已就绪'

# ---------- 3. Rust ----------
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) { Fail '未找到 cargo，请安装 Rust。' }
Write-Host "  [3/6] Rust           : $(& cargo --version)"

# ---------- 4. MSVC 工具链 ----------
$toolchains = & rustup toolchain list 2>$null
if (($toolchains | Select-String 'x86_64-pc-windows-msvc').Count -eq 0) {
    Fail "未安装 msvc 工具链，请执行：rustup target add x86_64-pc-windows-msvc"
}
Write-Host "  [4/6] Rust 工具链    : $Toolchain"

# ---------- 5. VS Build Tools（vcvars64） ----------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vcvars = $null
if (Test-Path $vswhere) {
    $vsRoot = & $vswhere -latest -products '*' `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null | Select-Object -First 1
    if ($vsRoot) {
        $cand = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path $cand) { $vcvars = $cand }
    }
}
if (-not $vcvars) {
    $fallback = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    if (Test-Path $fallback) { $vcvars = $fallback }
}
if (-not $vcvars) {
    Fail '未找到 VS Build Tools 2022 的 vcvars64.bat。请安装「VS 生成工具 2022」并勾选「使用 C++ 的桌面开发」。'
}
Write-Host '  [5/6] VS Build Tools : 已找到'

# ---------- 6. 打包资源 ----------
if (-not (Test-Path (Join-Path $DistDir $DllName))) {
    Fail "缺少打包资源 $DllName，请放到 dist\ 目录。"
}
Write-Host "  [6/6] 打包资源       : $DllName 已就绪"
Write-Host ''
Write-Host '  开始编译（首次较慢，请耐心等待）…'
Write-Host ''

# ---------- 进入 MSVC 环境并编译 ----------
$env:RUSTUP_TOOLCHAIN = $Toolchain
Push-Location $TauriDir
try {
    & $vcvars | Out-Null
    & npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { Fail "编译失败（退出码 $LASTEXITCODE），请查看上方日志。" }
} finally {
    Pop-Location
}

$exe = Join-Path $BuildDir $ExeName
if (-not (Test-Path $exe)) { Fail "编译完成但未找到产物：$exe" }

Write-Host ''
Write-Host "  [OK] 编译成功：$exe" -ForegroundColor Green
Write-Host ''

# ---------- 打包绿色版 zip ----------
if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir | Out-Null }
$stage = Join-Path $env:TEMP ("dotobe_bundle_" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item $exe (Join-Path $stage $ProductExe) -Force
Copy-Item (Join-Path $DistDir $DllName) (Join-Path $stage $DllName) -Force

$zip = Join-Path $DistDir $ZipName
if (Test-Path $zip) { Remove-Item $zip -Force }
try {
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
} catch {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Fail 'zip 打包失败。'
}
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "  [OK] 绿色版已生成：$zip" -ForegroundColor Green
Write-Host ''
Write-Host '  ==============================================' -ForegroundColor Cyan
Write-Host '   编译完成 OK' -ForegroundColor Cyan
Write-Host '  ==============================================' -ForegroundColor Cyan
Write-Host ''
