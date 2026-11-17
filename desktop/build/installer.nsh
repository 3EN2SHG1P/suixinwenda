; 文件：desktop/build/installer.nsh
; 职责：安装时把「兜底卸载脚本」放到 userData 固定位置，并在开始菜单放两个双击入口。
;
; 为什么要单独放一份脚本：
; 系统卸载入口由 NSIS 生成，安装目录一旦被移动/删除，卸载器本身就没了，
; Windows 会退化成 msiexec 并弹出「Windows Installer 用法」帮助窗口。
; 放在 %APPDATA%\suixinwenda-desktop\tools\ 的脚本不随安装目录搬动，永远能找到。
;
; 为什么用快捷方式而不是让用户双击 .ps1：
; Windows 默认把 .ps1 当文本打开；只有快捷方式带上 powershell -File 参数才能双击执行。

!macro customInstall
  CreateDirectory "$APPDATA\suixinwenda-desktop\tools"
  SetOutPath "$APPDATA\suixinwenda-desktop\tools"
  File "${BUILD_RESOURCES_DIR}\uninstall-clean.ps1"
  ; 恢复输出目录，避免影响后续安装步骤
  SetOutPath "$INSTDIR"

  ; 两个入口都要求脚本里二次确认（输入 yes），不会双击就删
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME} - 彻底卸载（保留数据）.lnk" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$APPDATA\suixinwenda-desktop\tools\uninstall-clean.ps1" -Apply'
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME} - 彻底卸载（含本地数据）.lnk" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$APPDATA\suixinwenda-desktop\tools\uninstall-clean.ps1" -Apply -PurgeData'
!macroend

!macro customUnInstall
  ; 常规卸载只删程序与快捷方式，绝不动 %APPDATA%\suixinwenda-desktop：
  ; 那里是明文聊天记录、附件与备份，删掉不可恢复；要彻底删除只能显式走
  ; 「彻底卸载（含本地数据）」（uninstall-clean.ps1 -PurgeData）
  Delete "$SMPROGRAMS\${SHORTCUT_NAME} - 彻底卸载（保留数据）.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME} - 彻底卸载（含本地数据）.lnk"
  RMDir /r "$APPDATA\suixinwenda-desktop\tools"
!macroend
