# ============================================================
#  途变客户端 · NSIS 安装包打包脚本
#  · 把绿色版（dist\途变客户端-v2.1.exe + WebView2Loader.dll）打成安装包
#  · 自动定位 makensis（PATH → 系统 NSIS → Tauri 内置缓存）
#  · 默认内嵌 WebView2 离线运行时（约 +150MB，断网机器可装）；
#    加 -NoWebView2 出小体积包（缺失时安装界面引导联网下载）
#  · 产物：dist\途变客户端-v2.1-setup.exe
#
#  用法：双击 build_installer.bat
#        或  powershell -ExecutionPolicy Bypass -File build_installer.ps1 [-NoWebView2]
#
#  注意：请先用 build_client.bat 构建出绿色版，再跑本脚本。
# ============================================================
param(
    [switch]$NoWebView2,      # 不内嵌 WebView2 离线运行时
    [string]$Version = ""     # 版本号（默认读 tauri.conf.json）
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$Root         = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallerDir = Join-Path $Root 'installer'
$DistDir      = Join-Path $Root 'dist'
$NsiFile      = Join-Path $InstallerDir 'dotobe_client.nsi'
$ConfFile     = Join-Path $Root 'tauri\src-tauri\tauri.conf.json'
$ExeSrc       = Join-Path $DistDir '途变客户端-v2.1.exe'
$DllSrc       = Join-Path $DistDir 'WebView2Loader.dll'
$OutFile      = Join-Path $DistDir '途变客户端-v2.1-setup.exe'

function Fail($msg) {
    Write-Host ''
    Write-Host '  ==============================================' -ForegroundColor Red
    Write-Host '   打包失败 FAIL  ' -ForegroundColor Red
    Write-Host $msg -ForegroundColor Red
    Write-Host '  ==============================================' -ForegroundColor Red
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '  ==============================================' -ForegroundColor Cyan
Write-Host '   途变客户端 · NSIS 安装包打包' -ForegroundColor Cyan
Write-Host '  ==============================================' -ForegroundColor Cyan
Write-Host ''

# ---------- 1. 定位 makensis ----------
$Makensis = $null
$cand = @()
$cmd = Get-Command makensis -ErrorAction SilentlyContinue
if ($cmd) { $cand += $cmd.Source }
$cand += (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe')
$cand += (Join-Path $env:ProgramFiles 'NSIS\makensis.exe')
$cand += (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe')
foreach ($c in $cand) { if ($c -and (Test-Path $c)) { $Makensis = $c; break } }
if (-not $Makensis) {
    Fail @"
未找到 makensis（NSIS 编译器）。安装其一即可：
  · Tauri 构建过一次后会自动缓存：$env:LOCALAPPDATA\tauri\NSIS
  · 或安装 NSIS 3：https://nsis.sourceforge.io/Download
"@
}
$nsisVer = (& $Makensis /VERSION 2>&1 | Out-String).Trim()
Write-Host "  [1/5] NSIS           : $Makensis ($nsisVer)"

# ---------- 2. 版本号 ----------
if (-not $Version) {
    if (Test-Path $ConfFile) {
        try { $Version = (Get-Content $ConfFile -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
    }
    if (-not $Version) { $Version = '2.1.0' }
}
$Version4 = if ($Version -match '^\d+\.\d+\.\d+\.\d+$') { $Version } else { "$Version.0" }
Write-Host "  [2/5] 版本号         : $Version"

# ---------- 3. 检查绿色版产物 ----------
if (-not (Test-Path $ExeSrc)) {
    Fail @"
未找到绿色版主程序：$ExeSrc

请先构建绿色版（双击 build_client.bat），或确认 dist 目录下有该文件。
安装包脚本的输入就是绿色版 exe，不负责编译 Rust 代码。
"@
}
$exeMB = [math]::Round((Get-Item $ExeSrc).Length / 1MB, 1)
Write-Host "  [3/5] 主程序         : 途变客户端-v2.1.exe ($exeMB MB)"
if (Test-Path $DllSrc) {
    Write-Host '                       WebView2Loader.dll 已就绪'
} else {
    Write-Host '                       [警告] 缺少 WebView2Loader.dll，安装包将不含该文件' -ForegroundColor Yellow
}

# ---------- 4. WebView2 离线运行时（可选内嵌） ----------
$wv2Arg = $null
if (-not $NoWebView2) {
    $wv2 = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'tauri') -Recurse -Filter 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe' -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if ($wv2) {
        $wv2Arg = "/DWEBVIEW2_SETUP=$($wv2.FullName)"
        $wv2MB = [math]::Round($wv2.Length / 1MB, 1)
        Write-Host "  [4/5] WebView2 离线包 : 内嵌（$wv2MB MB，未装运行时的机器可断网安装）"
    } else {
        Write-Host '  [4/5] WebView2 离线包 : [警告] 未找到缓存，改为联网下载引导' -ForegroundColor Yellow
    }
} else {
    Write-Host '  [4/5] WebView2 离线包 : 按参数跳过（未装运行时时引导联网下载）'
}

# ---------- 5. 编译安装包 ----------
Write-Host '  [5/5] 正在编译安装包 …'
Write-Host ''
$args = @('-INPUTCHARSET', 'UTF8')          # 脚本为 UTF-8（含中文界面文案）
if ($wv2Arg) { $args += $wv2Arg }
$args += @("/DPRODUCT_VERSION=$Version", "/DPRODUCT_VERSION4=$Version4", $NsiFile)

Push-Location $InstallerDir                   # 脚本内相对路径以 nsi 所在目录为准
& $Makensis @args
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail "makensis 编译失败（退出码 $code）。" }

if (-not (Test-Path $OutFile)) { Fail "编译未报错，但未找到产物：$OutFile" }
$setupMB = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)

# 体积校验：内嵌 WebView2 的包应在 100MB 以上，否则说明离线包没真正打进去
if ($wv2Arg -and $setupMB -lt 100) {
    Fail @"
产物只有 $setupMB MB，但按参数应内嵌 WebView2 离线运行时（约 200MB）——
说明离线包没有被真正打进安装包。请检查 installer\dotobe_client.nsi 中
EnsureWebView2 的 File 命令是否在 !ifdef WEBVIEW2_SETUP 分支内。
"@
}

Write-Host ''
Write-Host '  ==============================================' -ForegroundColor Green
Write-Host '   打包完成 OK' -ForegroundColor Green
Write-Host "   安装包：$OutFile" -ForegroundColor Green
Write-Host "   大小：$setupMB MB    版本：$Version" -ForegroundColor Green
Write-Host '  ==============================================' -ForegroundColor Green
Write-Host ''
Write-Host '  说明：按用户安装（无需管理员），默认目录 %LOCALAPPDATA%\Programs\Dotobe，' -ForegroundColor Gray
Write-Host '        用户在安装界面可改；卸载入口在 设置 → 应用 → 已安装的应用。' -ForegroundColor Gray
Write-Host ''
