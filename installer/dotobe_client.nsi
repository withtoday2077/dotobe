; ============================================================
;  途变客户端 · NSIS 安装包脚本
; ------------------------------------------------------------
;  作用：把「已构建好的绿色版」打成安装包
;        输入  desktop-client\dist\途变客户端-v2.1.exe
;              desktop-client\dist\WebView2Loader.dll
;        输出  desktop-client\dist\途变客户端-v2.1-setup.exe
;
;  用法：双击 desktop-client\build_installer.bat（推荐）
;        或  "C:\Program Files (x86)\NSIS\makensis.exe" installer\dotobe_client.nsi
;
;  与 Tauri 自带打包的关系：
;    `npx tauri build` 也会产出 NSIS 安装包（目标 release\bundle\nsis\*.exe，
;    内嵌 WebView2 离线运行时、按用户安装）。本脚本用于「绿色版已构建好、
;    只想单独再出一个安装包」的场景，安装行为可定制（见下方参数）。
;
;  可覆盖参数（makensis /D 传入，build_installer.ps1 会自动传）：
;    APP_EXE_SRC / APP_DLL_SRC / OUT_FILE / PRODUCT_VERSION
;    WEBVIEW2_SETUP=完整路径 → 内嵌 WebView2 离线运行时（缺失时联网下载）
; ============================================================

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 32

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

; ---------------- 参数（可被 /D 覆盖） ----------------
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "途变客户端"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "2.1.0"
!endif
!ifndef PRODUCT_VERSION4        ; 版本资源需要四段式
  !define PRODUCT_VERSION4 "2.1.0.0"
!endif
!ifndef PRODUCT_PUBLISHER
  !define PRODUCT_PUBLISHER "Dotobe"
!endif
!ifndef PRODUCT_KEY
  !define PRODUCT_KEY "DotobeClient"
!endif
!ifndef APP_EXE
  !define APP_EXE "途变客户端.exe"        ; 安装后的可执行文件名
!endif
!ifndef APP_EXE_SRC
  !define APP_EXE_SRC "..\dist\途变客户端-v2.1.exe"
!endif
!ifndef APP_DLL_SRC
  !define APP_DLL_SRC "..\dist\WebView2Loader.dll"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\dist\途变客户端-v2.1-setup.exe"
!endif
!ifndef DEFAULT_DIR
  !define DEFAULT_DIR "$LOCALAPPDATA\Programs\Dotobe"   ; 按用户安装，无需管理员
!endif
!ifndef UNINST_KEY
  !define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}"
!endif

; ---------------- 基本信息 ----------------
Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "${DEFAULT_DIR}"
InstallDirRegKey HKCU "Software\${PRODUCT_KEY}" "InstallDir"
RequestExecutionLevel user          ; 按用户安装：不弹 UAC；如需装到 Program Files 改 admin + $PROGRAMFILES64
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${PRODUCT_VERSION4}"
VIAddVersionKey "ProductName"     "${PRODUCT_NAME}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} 安装程序"
VIAddVersionKey "FileVersion"     "${PRODUCT_VERSION4}"
VIAddVersionKey "ProductVersion"  "${PRODUCT_VERSION}"
VIAddVersionKey "CompanyName"     "${PRODUCT_PUBLISHER}"
VIAddVersionKey "LegalCopyright"  "© ${PRODUCT_PUBLISHER}"

; ---------------- 界面 ----------------
!define MUI_ABORTWARNING
!define MUI_ICON "..\dist_prepare\icon.ico"
!define MUI_UNICON "..\dist_prepare\icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${PRODUCT_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ============================================================
;  初始化
; ============================================================
Function .onInit
  ; 已安装过 → 用原目录，避免升装到新位置留下两份
  ReadRegStr $0 HKCU "Software\${PRODUCT_KEY}" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

; 应用正在运行 → 文件被占用，提示先退出
; 注意：只在「主程序已存在」时才做占用检测——文件不存在时 FileOpen 也会报错，
;       不能把「目录还没有装过」误判成「程序正在运行」。
Function CheckRunning
check_running_loop:
  IfFileExists "$INSTDIR\${APP_EXE}" check_running_test check_running_ok
check_running_test:
  ClearErrors
  FileOpen $9 "$INSTDIR\${APP_EXE}" "a"
  ${IfNot} ${Errors}
    FileClose $9
    Goto check_running_ok
  ${EndIf}
  IfSilent check_running_silent          ; 静默安装不弹窗，直接放弃
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
    "${PRODUCT_NAME} 正在运行，请先退出后再安装。$\n$\n点击「确定」重试，或「取消」退出安装。" \
    IDOK check_running_loop IDCANCEL check_running_abort
check_running_silent:
  Abort "目标程序正在运行，安装已取消"
check_running_ok:
  Return
check_running_abort:
  Abort
FunctionEnd

; ============================================================
;  安装
; ============================================================
Section "程序文件（必需）" SecCore
  SectionIn RO
  Call CheckRunning

  SetOutPath "$INSTDIR"
  SetOverwrite on
  File "/oname=${APP_EXE}" "${APP_EXE_SRC}"
!if /FILEEXISTS "${APP_DLL_SRC}"
  File "/oname=WebView2Loader.dll" "${APP_DLL_SRC}"
!endif

  ; 卸载器与注册表（控制面板「应用和功能」可见）
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr   HKCU "Software\${PRODUCT_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr   HKCU "Software\${PRODUCT_KEY}" "Version"    "${PRODUCT_VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"     "${PRODUCT_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"  "${PRODUCT_VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"       "${PRODUCT_PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\${APP_EXE}"
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  ; 说明：安装版不创建 exe 旁的 data\ 目录——客户端数据目录优先级为
  ;       便携(exe 旁 data\) > location.json 重定向 > 系统默认(%APPDATA%\DotobeClientWeb)，
  ;       建了 data\ 会强制进入便携模式，安装版应使用系统默认位置。
  DetailPrint "提示：用户数据保存在 $APPDATA\DotobeClientWeb"

  Call EnsureWebView2
SectionEnd

Section "桌面快捷方式" SecDesktop
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXE}"
SectionEnd

Section "开始菜单快捷方式" SecStartMenu
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore}    "程序主体文件（必装）。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "在桌面创建快捷方式。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} "在开始菜单创建快捷方式与卸载入口。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ============================================================
;  WebView2 运行时检查（客户端基于 WebView2 渲染界面）
;  已装 → 跳过；未装 → 优先用内嵌离线包静默安装，否则引导联网下载
; ============================================================
Function EnsureWebView2
  ; 检测：HKLM(32 位视图) 与 HKCU 任一存在 pv 即视为已安装
  SetRegView 32
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  SetRegView 64
  ReadRegStr $2 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $1 != ""
  ${OrIf} $2 != ""
    DetailPrint "已检测到 WebView2 运行时（版本 $1$2），跳过安装。"
    Return
  ${EndIf}

!ifdef WEBVIEW2_SETUP
  ; 把离线运行时打进包（落在临时目录 $PLUGINSDIR，安装器退出后自动清理）
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=MicrosoftEdgeWebView2RuntimeInstallerX64.exe" "${WEBVIEW2_SETUP}"
  SetOutPath "$INSTDIR"
  DetailPrint "未检测到 WebView2 运行时，正在静默安装（内嵌离线包）…"
  SetDetailsPrint both
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstallerX64.exe" /silent /install' $3
  SetDetailsPrint listonly
  ${If} $3 == 0
    DetailPrint "WebView2 运行时安装完成。"
  ${Else}
    MessageBox MB_ICONEXCLAMATION \
      "WebView2 运行时安装未成功（返回码 $3）。$\n$\n若稍后程序无法启动，请手动安装：$\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703"
  ${EndIf}
!else
  IfSilent wv2_done                    ; 静默安装不弹窗（打包方自行保证运行时存在）
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "未检测到 Microsoft WebView2 运行时，${PRODUCT_NAME} 需要它才能显示界面。$\n$\n是否现在打开下载页面安装？" \
    IDYES wv2_open IDNO wv2_done
  wv2_open:
    ExecShell "open" "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
  wv2_done:
!endif
FunctionEnd

; ============================================================
;  卸载
; ============================================================
Section "Uninstall"
  ; 应用在跑 → 先要求退出（同样只在主程序存在时检测占用）
  IfFileExists "$INSTDIR\${APP_EXE}" un_check_running un_files
un_check_running:
  ClearErrors
  FileOpen $9 "$INSTDIR\${APP_EXE}" "a"
  ${IfNot} ${Errors}
    FileClose $9
    Goto un_files
  ${EndIf}
  IfSilent un_keep_data
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
    "${PRODUCT_NAME} 正在运行，请先退出后再卸载。$\n$\n点击「确定」重试，或「取消」退出卸载。" \
    IDOK un_check_running IDCANCEL un_done
un_files:

  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\uninstall.exe"

  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\卸载 ${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${PRODUCT_KEY}"

  ; 用户数据（登录会话、试卷缓存、草稿、知识树缓存）默认保留
  IfSilent un_keep_data               ; 静默卸载不弹窗，默认保留数据
  IfFileExists "$APPDATA\DotobeClientWeb\*.*" 0 un_keep_data
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除本地用户数据？$\n位置：$APPDATA\DotobeClientWeb$\n（包含登录会话、离线试卷、草稿；删除后需重新登录）" \
    IDYES un_del_data IDNO un_keep_data
  un_del_data:
    RMDir /r "$APPDATA\DotobeClientWeb"
    DetailPrint "已删除用户数据目录。"
  un_keep_data:

  ; 目录清理：非递归删除（空目录才删；用户放了别的文件则保留）
  RMDir "$INSTDIR"
un_done:
SectionEnd
