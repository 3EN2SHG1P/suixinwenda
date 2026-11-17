<#
.SYNOPSIS
  随心问答（SuiXinWenDa）安装残留清理与「彻底卸载」兜底脚本。

.DESCRIPTION
  为什么不直接用系统卸载入口：
  NSIS 会把安装路径写进「注册表卸载项 + 开始菜单快捷方式 + 卸载器自身」三处。
  一旦安装目录被移动或删除，三处同时失效；此时点「设置 → 应用 → 卸载」，
  Windows 找不到卸载程序，会退化成 msiexec，弹出一个「Windows Installer 用法」帮助窗口。

  本脚本不依赖安装目录（安装时被复制到 %APPDATA%\suixinwenda-desktop\tools\）：
  它扫描注册表卸载项、快捷方式、常见安装目录与残留进程，列出清单后等你确认再删。

  默认干跑（只看不删）。真正删除要加 -Apply。

.PARAMETER Apply
  真正执行删除。不加时只打印将要删除的内容。

.PARAMETER PurgeData
  连本地用户数据一起删：%APPDATA%\suixinwenda-desktop（会话库、附件、备份、配置、登录态）。
  不可逆，默认保留。

.PARAMETER InstallDir
  额外指定安装目录（装到自定义路径时必须给，脚本不猜非标准路径）。

.PARAMETER Yes
  跳过二次确认与结尾停顿（给自动化/命令行用；双击快捷方式时不要加）。

.EXAMPLE
  .\uninstall-clean.ps1
  干跑：列出当前能清理什么。

.EXAMPLE
  .\uninstall-clean.ps1 -Apply
  清掉安装残留，保留本地数据。

.EXAMPLE
  .\uninstall-clean.ps1 -Apply -PurgeData
  连本地会话、备份、配置一起删（不可逆）。
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$PurgeData,
  [string[]]$InstallDir = @(),
  [switch]$Yes
)

$ErrorActionPreference = 'Continue'
# 兼容历史安装名：早期版本用过「随心问」与 SuiXinWen，一并纳入匹配，避免旧安装残留清不掉
$ProductPattern = '随心问答|随心问|SuiXinWenDa|SuiXinWen'
$UninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
# 打包态的固定位置：与 desktop/src/main.js 的 app.getPath('userData') 一致
$UserDataDir = Join-Path $env:APPDATA 'suixinwenda-desktop'
# 品牌改名（SuiXinWen → SuiXinWenDa）之前的数据目录：只在 -PurgeData 时一并清理
$LegacyUserDataDirs = @((Join-Path $env:APPDATA 'suixinwen-desktop'))
$ShortcutRoots = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  (Join-Path $env:PUBLIC 'Desktop')
)

function Write-Step($text) { Write-Host "[随心问答] $text" }
function Write-Item($action, $target) { Write-Host ("  {0,-6} {1}" -f $action, $target) }

# --- 1. 收集：注册表卸载项 ---
function Get-UninstallEntries {
  $found = @()
  foreach ($root in $UninstallRoots) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if (-not $props) { return }
      $name = [string]$props.DisplayName
      if ($name -and ($name -match $ProductPattern)) {
        $found += $props
      }
    }
  }
  return $found
}

# 从卸载项里还原安装目录：InstallLocation 优先，其次从 UninstallString 的 exe 反推
function Get-PathsOfEntry($entry) {
  $paths = @()
  if ($entry.InstallLocation) { $paths += [string]$entry.InstallLocation }
  $cmd = [string]$entry.UninstallString
  if ($cmd) {
    $exe = [regex]::Match($cmd, '"([^"]+)"').Groups[1].Value
    if (-not $exe) { $exe = ($cmd -split ' ')[0] }
    if ($exe) {
      $parent = Split-Path -Path $exe -Parent
      if ($parent) { $paths += $parent }
    }
  }
  return $paths
}

# 目录安全阀：候选路径都来自「注册表卸载项 / 安装器默认位置 / 用户显式 -InstallDir」，
# 来源本身可信，所以这里只做黑名单校验——盘符根、用户目录、系统目录、AppData 这类
# 一旦误删就不可挽回的位置一律拒绝。
#
# 为什么不再要求「路径名必须含产品名」：安装器允许装到任意目录（实测装到
# %TEMP%\sxw-install-dir 是合法的），按名字过滤会把真正要删的目录放过，
# 只留下一堆删不掉的注册表项。
function Test-SafeDirectory([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  try { $full = [IO.Path]::GetFullPath($path).TrimEnd('\') } catch { return $false }
  if ($full -match '^[A-Za-z]:$') { return $false }
  if ($full -match '^[A-Za-z]:\\Windows($|\\)') { return $false }
  if ($full -match '^[A-Za-z]:\\Program Files') { return $false }
  if ($full -match '^[A-Za-z]:\\Users\\[^\\]+$') { return $false }
  if ($full -match '^[A-Za-z]:\\Users\\[^\\]+\\(Desktop|Documents|Downloads|AppData|OneDrive)$') { return $false }
  $protected = @(
    $env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA, $env:PUBLIC,
    $env:SystemRoot, $env:SystemDrive, $env:ProgramData
  )
  foreach ($item in $protected) {
    if ($item -and ($full -eq ([IO.Path]::GetFullPath($item).TrimEnd('\')))) { return $false }
  }
  return $true
}

# --- 2. 收集：快捷方式 ---
function Get-MatchingShortcuts {
  $found = @()
  foreach ($root in $ShortcutRoots) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem $root -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -match $ProductPattern) { $found += $_.FullName }
    }
  }
  return $found
}

Write-Step ("模式：" + $(if ($Apply) { '执行删除' } else { '干跑（只看不删，加 -Apply 才真删）' }))
Write-Host ''

$entries = Get-UninstallEntries
$shortcuts = Get-MatchingShortcuts

# 安装目录候选：注册表反推 + 常见默认位置 + 用户显式指定
$candidateDirs = @()
foreach ($entry in $entries) { $candidateDirs += Get-PathsOfEntry $entry }
$candidateDirs += @(
  # 「随心问」是早期版本用过的目录名，保留兜底
  (Join-Path $env:LOCALAPPDATA 'Programs\随心问'),
  (Join-Path $env:LOCALAPPDATA 'Programs\随心问答'),
  (Join-Path $env:LOCALAPPDATA 'Programs\SuiXinWenDa'),
  # 「SuiXinWen」是改名前的安装目录名，保留兜底
  (Join-Path $env:LOCALAPPDATA 'Programs\SuiXinWen'),
  (Join-Path ${env:ProgramFiles} 'SuiXinWenDa'),
  (Join-Path ${env:ProgramFiles} 'SuiXinWen'),
  (Join-Path ${env:ProgramFiles(x86)} 'SuiXinWenDa'),
  (Join-Path ${env:ProgramFiles(x86)} 'SuiXinWen')
)
$candidateDirs += $InstallDir

$dirs = @()
foreach ($dir in $candidateDirs) {
  if ([string]::IsNullOrWhiteSpace($dir)) { continue }
  # 先看存不存在：默认候选（Program Files 等）大概率不存在，
  # 对不存在的路径报「跳过」只会让清单变得嘈杂
  if (-not (Test-Path $dir)) { continue }
  if (-not (Test-SafeDirectory $dir)) {
    Write-Item '跳过' "$dir（系统目录，请用「设置 → 应用」里的卸载入口）"
    continue
  }
  $full = [IO.Path]::GetFullPath($dir).TrimEnd('\')
  if ($dirs -contains $full) { continue }
  $dirs += $full
}

$existingDirs = @($dirs | Where-Object { Test-Path $_ })
$missingDirs = @($dirs | Where-Object { -not (Test-Path $_) })

Write-Host '--- 将要删除 ---'
if ($entries.Count -eq 0) { Write-Host '  （无）注册表卸载项' } else { $entries | ForEach-Object { Write-Item '删除' ("注册表卸载项：" + $_.PSChildName + "（" + $_.DisplayName + "）") } }
if ($shortcuts.Count -eq 0) { Write-Host '  （无）快捷方式' } else { $shortcuts | ForEach-Object { Write-Item '删除' ("快捷方式：" + $_) } }
if ($existingDirs.Count -eq 0) { Write-Host '  （无）安装目录' } else { $existingDirs | ForEach-Object { Write-Item '删除' ("安装目录：" + $_) } }
if ($PurgeData -and (Test-Path $UserDataDir)) {
  Write-Item '删除' ("本地数据（会话/附件/备份/配置）：" + $UserDataDir)
} elseif (Test-Path $UserDataDir) {
  Write-Item '保留' ("本地数据：" + $UserDataDir + "（加 -PurgeData 才删）")
}
if ($PurgeData) {
  foreach ($legacyDir in $LegacyUserDataDirs) {
    if (Test-Path $legacyDir) { Write-Item '删除' ("本地数据（改名前的旧目录）：" + $legacyDir) }
  }
}

if (-not $PurgeData -and $entries.Count -eq 0 -and $shortcuts.Count -eq 0 -and $existingDirs.Count -eq 0) {
  Write-Host ''
  Write-Step '没有需要清理的安装残留。'
  if (-not $Yes) { Read-Host '按回车关闭' | Out-Null }
  exit 0
}

if (-not $Apply) {
  Write-Host ''
  Write-Step '以上为干跑结果，未删除任何内容。确认无误后执行： .\uninstall-clean.ps1 -Apply'
  if (-not $Yes) { Read-Host '按回车关闭' | Out-Null }
  exit 0
}

if (-not $Yes) {
  Write-Host ''
  $answer = Read-Host '确认删除以上项目？输入 yes 继续'
  if ($answer -ne 'yes') {
    Write-Step '已取消，未做任何修改。'
    if (-not $Yes) { Read-Host '按回车关闭' | Out-Null }
    exit 1
  }
}

# --- 3. 执行 ---
Write-Host ''
Write-Step '先结束运行中的进程（否则文件被占用删不掉）'
foreach ($name in @('SuiXinWenDa', 'suixinwenda-backend')) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      Stop-Process -Id $_.Id -Force -ErrorAction Stop
      Write-Item '结束' ("$name（pid=" + $_.Id + "）")
    } catch {
      Write-Item '失败' ("$name（pid=" + $_.Id + "）：" + $_.Exception.Message)
    }
  }
}
Start-Sleep -Milliseconds 500

$failed = 0
foreach ($entry in $entries) {
  try {
    Remove-Item -LiteralPath $entry.PSPath -Recurse -Force -ErrorAction Stop
    Write-Item '已删' ("注册表：" + $entry.PSChildName)
  } catch {
    $failed++
    Write-Item '失败' ("注册表：" + $entry.PSChildName + "：" + $_.Exception.Message)
  }
}

foreach ($lnk in $shortcuts) {
  try {
    Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop
    Write-Item '已删' ("快捷方式：" + $lnk)
  } catch {
    $failed++
    Write-Item '失败' ("快捷方式：" + $lnk + "：" + $_.Exception.Message)
  }
}

foreach ($dir in $existingDirs) {
  try {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
    Write-Item '已删' ("目录：" + $dir)
  } catch {
    $failed++
    Write-Item '失败' ("目录：" + $dir + "：" + $_.Exception.Message)
  }
}

# 本地数据放最后：脚本自身就在里面，删掉后 PowerShell 仍能继续跑完
if ($PurgeData -and (Test-Path $UserDataDir)) {
  try {
    Remove-Item -LiteralPath $UserDataDir -Recurse -Force -ErrorAction Stop
    Write-Item '已删' ("本地数据：" + $UserDataDir)
  } catch {
    $failed++
    Write-Item '失败' ("本地数据：" + $UserDataDir + "：" + $_.Exception.Message)
  }
}
# 改名前的旧数据目录：只在 -PurgeData 时清理，正常使用不会被迁移逻辑读到
if ($PurgeData) {
  foreach ($legacyDir in $LegacyUserDataDirs) {
    if (-not (Test-Path $legacyDir)) { continue }
    try {
      Remove-Item -LiteralPath $legacyDir -Recurse -Force -ErrorAction Stop
      Write-Item '已删' ("旧数据目录：" + $legacyDir)
    } catch {
      $failed++
      Write-Item '失败' ("旧数据目录：" + $legacyDir + "：" + $_.Exception.Message)
    }
  }
}

# 最后清掉自己所在的 tools 目录：卸载完成后它就没用了。
# 只在「脚本正是安装器放到 tools 里的那一份」时才删——否则用户从仓库里跑一次 -Apply
# 会把 desktop/build 整个删掉。
$toolDir = Join-Path $UserDataDir 'tools'
if ($PSScriptRoot) {
  try {
    $self = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
    $expected = [IO.Path]::GetFullPath($toolDir).TrimEnd('\')
    if ($self -eq $expected -and (Test-Path $toolDir)) {
      Remove-Item -LiteralPath $toolDir -Recurse -Force -ErrorAction Stop
      Write-Item '已删' ("工具目录：" + $toolDir)
    }
  } catch {
    Write-Item '跳过' ("工具目录：" + $toolDir + "（下次安装会覆盖）")
  }
}

Write-Host ''
if ($failed -gt 0) {
  Write-Step ("完成，但有 $failed 项删除失败（多半是被占用或权限不足：关掉相关程序后重跑一次）")
} else {
  Write-Step '清理完成。'
}
if (-not $Yes) { Read-Host '按回车关闭' | Out-Null }
exit $(if ($failed -gt 0) { 2 } else { 0 })
