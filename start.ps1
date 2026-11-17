<#
.SYNOPSIS
    随心问答 · 一键启动（Windows）：检查环境 -> 依赖 -> 存储 -> 启动窗口

.DESCRIPTION
    启动链路只有一条：脚本把环境准备好，窗口由 Electron 打开，后端由桌面端托管（关窗口一起收掉）。

    步骤：
      1) 环境：uv / node / npm 是否存在、Node 版本、路径与磁盘、backend 目录可写
      2) 配置：backend/.env 不存在就从模板生成；JWT_SECRET 为空则自动生成
      3) 依赖：uv sync；桌面端缺 node_modules 时 npm ci
      4) 存储：调后端的 tools.db_info 让后端自己回答「用哪个库、连不连得上」，
         脚本不再另写一套解析规则（两套规则必然漂移）
      5) 数据库不可用时按情况处理：识别你自己的容器、帮你启动、或等你手动启动后重跑
      6) 端口：8010 被别的程序占用时直接报出来（带 PID 与进程名）
      7) 启动：npm start

    脚本自身输出同时写入仓库根目录的 start.log（已被 .gitignore 忽略）。出问题时贴这个文件。

.PARAMETER SkipDocker
    不启动任何容器，只用已经在运行的 MySQL

.PARAMETER DryRun
    只做检查并报告结论：不安装依赖、不启动窗口

.PARAMETER NonInteractive
    不等待任何键盘输入（供脚本 / 计划任务调用）；遇到需要决策的情况直接报错退出

.EXAMPLE
    .\start.ps1

.EXAMPLE
    .\start.ps1 -DryRun

.EXAMPLE
    .\start.ps1 -SkipDocker
#>
param(
    [switch]$SkipDocker,
    [switch]$DryRun,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$desktop = Join-Path $root 'desktop'
$envFile = Join-Path $backend '.env'
$logFile = Join-Path $root 'start.log'

# 编码说明：PowerShell 5.1 读取外部命令输出的管道时按系统 ANSI 代码页（简体中文 936）解码，
# 而 node / python / docker 写的是 UTF-8 字节——中文会变乱码，且改 [Console]::OutputEncoding 无效（实测）。
# 因此本脚本有两条约定：
#   1) 需要解析输出的命令走文件重定向 + 按 UTF-8 读文件（见 Invoke-Native）；
#   2) 需要给人看进度的命令保留管道（见 Invoke-NativeLive），其输出以英文为主；
#      唯一会大量输出中文的桌面端用 Start-Process 直连控制台，不经过 PowerShell 转码。

# ============================================================
# 输出与日志
# ============================================================
$script:LogStream = $null

function Open-Log {
    try {
        $script:LogStream = New-Object System.IO.StreamWriter($logFile, $false, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
        $script:LogStream.AutoFlush = $true
    } catch {
        $script:LogStream = $null
    }
}

function Close-Log {
    if ($script:LogStream) {
        try { $script:LogStream.Dispose() } catch { }
        $script:LogStream = $null
    }
}

function Write-Log {
    param([string]$Message = '', [string]$Color = 'Gray')
    if ($Message) { Write-Host $Message -ForegroundColor $Color } else { Write-Host '' }
    if ($script:LogStream) {
        try { $script:LogStream.WriteLine($Message) } catch { }
    }
}

function Write-Step {
    param([string]$Message)
    Write-Log ''
    Write-Log "==> $Message" 'Cyan'
}

function Write-Ok {
    param([string]$Message)
    Write-Log "    + $Message" 'Green'
}

function Write-Info {
    param([string]$Message)
    Write-Log "    . $Message" 'DarkGray'
}

function Write-Warn {
    param([string]$Message)
    Write-Log "    ! $Message" 'Yellow'
}

function Write-Bad {
    param([string]$Message)
    Write-Log "    - $Message" 'Red'
}

function Write-Hint {
    param([string[]]$Lines)
    foreach ($line in $Lines) {
        Write-Log "      $line" 'Yellow'
    }
}

# ============================================================
# 外部命令
# ============================================================
# 为什么必须封装：脚本头部是 $ErrorActionPreference='Stop'，而原生外部命令往 stderr 写一行
# 就会被 PowerShell 抬成 NativeCommandError 并终止脚本（Docker 没启动时必然发生）。
# `2>$null` 只压显示、不拦错误流，逐处打补丁治不了本——以后新增一行命令又会复发。

# 为什么不用 `& $Exe | Out-String` 读输出：
# PowerShell 5.1 读原生命令的 stdout 时按系统 ANSI 代码页（简体中文 936）解码，
# 而 node / python / docker 写的是 UTF-8 字节——中文会被解成「锛氣€」或一串 U+FFFD。
# 改 [Console]::OutputEncoding 对这条路径无效（实测同样乱码）。
# 所以这里改走「重定向到临时文件 + 按 UTF-8 读文件」，彻底绕开控制台编码。
# 顺带的好处：stderr 不再经过 PowerShell 错误流，Stop 级别也不会被它打断。
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments = @())
    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $text = ''
    $code = -1
    try {
        $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $code = $process.ExitCode
        $outText = [System.IO.File]::ReadAllText($stdoutFile, [System.Text.Encoding]::UTF8)
        $errText = [System.IO.File]::ReadAllText($stderrFile, [System.Text.Encoding]::UTF8)
        $text = ($outText + "`n" + $errText).Trim()
    } catch {
        $text = $_.Exception.Message
        $code = -1
    } finally {
        $ErrorActionPreference = $previous
        Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
    [pscustomobject]@{ Code = $code; Text = $text.Trim() }
}

# 需要让用户看到实时输出的命令（uv sync / npm ci / npm start / docker compose）
function Invoke-NativeLive {
    param([string]$Exe, [string[]]$Arguments = @())
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $code = 0
    try {
        # 只接管 stdout：stderr 在 Current 级别的 Continue 下会正常显示且不中断，
        # 若用 2>&1 把错误流并进管道，npm / electron 的彩色输出与交互体验都会变差
        & $Exe @Arguments | Out-Host
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
    } catch {
        Write-Bad $_.Exception.Message
        $code = -1
    } finally {
        $ErrorActionPreference = $previous
    }
    return $code
}

function Test-CommandAvailable {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function ConvertTo-Version {
    param([string]$Text)
    $clean = ($Text -replace '[^0-9\.]', '')
    if (-not $clean) { return $null }
    try {
        return [version]$clean
    } catch {
        return $null
    }
}

# 比 Test-NetConnection 快得多：后者单次探测在 Windows 上常常 1-2 秒
function Test-TcpPort {
    param([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 800)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync($TargetHost, $Port)
        $connected = $task.Wait($TimeoutMs)
        $ok = ($connected -and $client.Connected)
        $client.Close()
        return $ok
    } catch {
        return $false
    }
}

function Read-EnvValue {
    param([string]$File, [string]$Key, [string]$Default = '')
    $pattern = '^' + [regex]::Escape($Key) + '=(.*)$'
    $found = Select-String -LiteralPath $File -Pattern $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { return $Default }
    $value = $found.Matches[0].Groups[1].Value.Trim()
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

# 返回 0 表示当前环境不能交互（-NonInteractive），调用方据此直接报错退出
function Read-Choice {
    param([string]$Prompt, [string[]]$Options, [int]$Default = 1)
    if ($NonInteractive) { return 0 }
    Write-Log ''
    Write-Log "    $Prompt"
    for ($i = 0; $i -lt $Options.Count; $i++) {
        Write-Log ("      [{0}] {1}" -f ($i + 1), $Options[$i])
    }
    while ($true) {
        $answer = Read-Host ("    请选择（直接回车 = {0}）" -f $Default)
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        $number = 0
        if ([int]::TryParse($answer.Trim(), [ref]$number)) {
            if ($number -ge 1 -and $number -le $Options.Count) { return $number }
        }
        Write-Warn '输入无效，请输入选项序号'
    }
}

# ============================================================
# Docker 探测
# ============================================================
function Get-DockerState {
    # not-installed / not-running / ready
    if (-not (Test-CommandAvailable 'docker')) { return 'not-installed' }
    $result = Invoke-Native docker @('info', '--format', '{{.ServerVersion}}')
    if ($result.Code -ne 0) { return 'not-running' }
    return 'ready'
}

function Find-ContainerByPort {
    param([int]$Port)
    $result = Invoke-Native docker @('ps', '-a', '--format', '{{.Names}}|{{.State}}|{{.Ports}}')
    if ($result.Code -ne 0) { return $null }
    $pattern = '^([^|]+)\|([^|]+)\|.*:{0}->' -f $Port
    foreach ($line in ($result.Text -split "\r?\n")) {
        if ($line -match $pattern) {
            return [pscustomobject]@{ Name = $matches[1].Trim(); State = $matches[2].Trim() }
        }
    }
    return $null
}

function Test-ComposeManaged {
    param([string]$Name)
    $result = Invoke-Native docker @('inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', $Name)
    if ($result.Code -ne 0) { return $false }
    $value = $result.Text.Trim()
    return ($value -ne '' -and $value -ne '<no value>')
}

function Start-DockerDesktop {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Docker\Docker\Docker Desktop.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            try {
                Start-Process -FilePath $candidate | Out-Null
                return $true
            } catch {
                return $false
            }
        }
    }
    return $false
}

function Wait-DockerReady {
    param([int]$TimeoutSeconds = 120)
    $elapsed = 0
    while ($elapsed -lt $TimeoutSeconds) {
        if ((Get-DockerState) -eq 'ready') { return $true }
        Start-Sleep -Seconds 3
        $elapsed += 3
        if ($elapsed % 15 -eq 0) { Write-Info ("等待 Docker 就绪… 已 {0} 秒" -f $elapsed) }
    }
    return $false
}

function Wait-Port {
    param([string]$TargetHost, [int]$Port, [int]$TimeoutSeconds = 180)
    $elapsed = 0
    while ($elapsed -lt $TimeoutSeconds) {
        if (Test-TcpPort -TargetHost $TargetHost -Port $Port) { return $true }
        Start-Sleep -Seconds 3
        $elapsed += 3
        if ($elapsed % 15 -eq 0) { Write-Info ("等待数据库端口… 已 {0} 秒" -f $elapsed) }
    }
    return $false
}

# ============================================================
# 存储判定：交给后端自己回答
# ============================================================
function Get-DbInfo {
    Push-Location $backend
    try {
        $result = Invoke-Native uv @('run', '--no-sync', 'python', '-m', 'tools.db_info')
    } finally {
        Pop-Location
    }
    # db_info 在「配置读得到、但连不上或密码加密」时照样输出一行完整 JSON，只是退出码非 0；
    # 因此只认输出里的 JSON 行，不能拿退出码当失败判据（否则这些情况会被误判成「读不到配置」）
    $line = ($result.Text -split "\r?\n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $line) { return $null }
    try {
        return ($line | ConvertFrom-Json)
    } catch {
        return $null
    }
}

# 数据库连不上时按情况处理；返回 $true 表示最终可用
function Resolve-MySql {
    param($Info)

    $connection = $Info.connection
    $targetHost = if ($connection.host) { $connection.host } else { '127.0.0.1' }
    $portText = if ($connection.port) { [string]$connection.port } else { '3306' }
    $dbName = if ($connection.name) { $connection.name } else { '' }
    if ($portText -notmatch '^\d{2,5}$') {
        Write-Bad ("DB_PORT 不合法（应为纯数字）：{0}" -f $portText)
        return $false
    }
    $targetPort = [int]$portText

    $isLocal = $targetHost -in @('127.0.0.1', 'localhost', '::1')

    if ($DryRun) {
        Write-Info ("Docker：{0}" -f (Get-DockerState))
        if (-not $isLocal) {
            Write-Warn 'DryRun：目标不是本机，脚本不会代管容器'
        } elseif (Test-TcpPort -TargetHost $targetHost -Port $targetPort) {
            Write-Warn 'DryRun：端口能连上，但认证或库名不对，请核对 DB_USER / DB_PASSWORD / DB_NAME'
        } else {
            Write-Warn 'DryRun：端口连不上。正常运行时脚本会按下面顺序处理：识别你的容器 / 帮你启动 / 起 compose'
            $container = $null
            if ((Get-DockerState) -eq 'ready') { $container = Find-ContainerByPort -Port $targetPort }
            if ($container) { Write-Info ("将检测到容器 {0}（{1}）" -f $container.Name, $container.State) }
        }
        return $false
    }

    if (-not $isLocal) {
        Write-Warn ('目标是非本机 MySQL（{0}），脚本不代管容器' -f $targetHost)
        if (Test-TcpPort -TargetHost $targetHost -Port $targetPort) {
            Write-Warn '端口能连上，但认证或库名不对；另需 DB_ALLOW_REMOTE=1'
        } else {
            Write-Bad ('{0}:{1} 连不上' -f $targetHost, $targetPort)
        }
        return $false
    }

    if ($SkipDocker) {
        Write-Warn '-SkipDocker：不启动任何容器'
        if (Test-TcpPort -TargetHost $targetHost -Port $targetPort) {
            Write-Warn '端口能连上，但认证或库名不对，请核对 DB_USER / DB_PASSWORD / DB_NAME'
        } else {
            Write-Bad ('{0}:{1} 连不上，且 -SkipDocker 不允许起容器' -f $targetHost, $targetPort)
            Write-Hint @('先启动你自己的 MySQL 后重跑，或去掉 -SkipDocker 让脚本起容器')
        }
        return $false
    }

    $dockerState = Get-DockerState
    Write-Info ("Docker：{0}" -f $dockerState)

    if ($dockerState -eq 'not-installed') {
        Write-Bad '未检测到 docker 命令，且数据库连不上'
        Write-Hint @(
            '二选一：',
            '  1) 安装 MySQL 8，把 backend/.env 的 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME 指向它',
            '  2) 安装 Docker Desktop 后重跑，脚本会自动起 suixinwenda-mysql',
            '想先用本机 SQLite：把 backend/.env 的 DB_BACKEND 改成 sqlite 后重跑'
        )
        return $false
    }

    if ($dockerState -eq 'not-running') {
        Write-Warn 'Docker Desktop 没有运行'
        $choice = Read-Choice -Prompt 'Docker 没在运行，怎么处理？' -Options @(
            '帮我启动 Docker Desktop（约 30-60 秒）',
            '我自己打开，好了按回车继续',
            '退出（想先用本机 SQLite：把 backend/.env 的 DB_BACKEND 改成 sqlite）'
        ) -Default 1
        if ($choice -eq 0) {
            Write-Bad '需要 Docker 才能自动起数据库，而当前是非交互模式'
            return $false
        }
        if ($choice -eq 3) { return $false }
        if ($choice -eq 1) {
            if (Start-DockerDesktop) {
                Write-Info '已请求启动 Docker Desktop，等待引擎就绪…'
            } else {
                Write-Warn '没找到 Docker Desktop.exe，请手动打开后重跑'
                return $false
            }
        } else {
            $null = Read-Host '    启动好后按回车继续'
        }
        if (-not (Wait-DockerReady -TimeoutSeconds 150)) {
            Write-Bad 'Docker 150 秒内仍未就绪'
            Write-Hint @('手动打开 Docker Desktop，等左下角出现 Engine running 后重跑本脚本')
            return $false
        }
        Write-Ok 'Docker 已就绪'
    }

    # Docker 可用：先看端口是否已经被某个 MySQL 占着
    if (Test-TcpPort -TargetHost $targetHost -Port $targetPort) {
        Write-Warn ('{0}:{1} 端口已可连接，但认证或库名不对' -f $targetHost, $targetPort)
        Write-Hint @('核对 backend/.env 的 DB_USER / DB_PASSWORD / DB_NAME（DB_PASSWORD 若由桌面端加密存放，请改回明文或走设置页）')
        return $false
    }

    $container = Find-ContainerByPort -Port $targetPort
    if ($container -and $container.State -eq 'running') {
        Write-Warn ('容器 {0} 正在运行，但数据库连不上' -f $container.Name)
        Write-Hint @('核对账号口令与库名；看容器日志：', ("  docker logs --tail 50 {0}" -f $container.Name))
        return $false
    }

    if ($container) {
        Write-Info ('检测到容器 {0}（{1}），它映射了 {2} 端口' -f $container.Name, $container.State, $targetPort)
        $managed = Test-ComposeManaged -Name $container.Name
        $startOption = if ($managed) { '用 docker compose 启动它（保留原有配置）' } else { ('帮我启动它（docker start {0}）' -f $container.Name) }
        $choice = Read-Choice -Prompt '这个容器没在运行，要启动它吗？' -Options @(
            $startOption,
            '我自己启动，好了按回车继续',
            '退出'
        ) -Default 1
        if ($choice -eq 0) {
            Write-Bad '数据库容器未运行，而当前是非交互模式'
            return $false
        }
        if ($choice -eq 3) { return $false }
        if ($choice -eq 1) {
            if ($managed) {
                Push-Location $root
                $composeCode = Invoke-NativeLive docker @('compose', 'up', '-d')
                Pop-Location
                if ($composeCode -ne 0) {
                    Write-Bad ('docker compose up -d 失败（退出码 {0}）' -f $composeCode)
                    return $false
                }
            } else {
                $startCode = Invoke-NativeLive docker @('start', $container.Name)
                if ($startCode -ne 0) {
                    Write-Bad ('docker start {0} 失败（退出码 {1}）' -f $container.Name, $startCode)
                    return $false
                }
            }
        } else {
            $null = Read-Host '    启动好后按回车继续'
        }
    } else {
        Write-Info '没有容器占用该端口，用仓库自带的 compose 起 MySQL 8'
        Write-Info '首次会拉取 mysql:8.0 镜像，约 2-5 分钟'
        Push-Location $root
        $composeCode = Invoke-NativeLive docker @('compose', 'up', '-d')
        Pop-Location
        if ($composeCode -ne 0) {
            Write-Bad ('docker compose up -d 失败（退出码 {0}），看上面的 docker 输出' -f $composeCode)
            return $false
        }
    }

    Write-Info '等待数据库端口…'
    if (-not (Wait-Port -TargetHost $targetHost -Port $targetPort -TimeoutSeconds 300)) {
        Write-Bad ('5 分钟内 {0}:{1} 仍连不上' -f $targetHost, $targetPort)
        Write-Hint @(
            '镜像可能还在拉取（网络慢）：稍后重跑本脚本即可，进度会保留',
            '容器状态异常：docker compose logs --tail 50 mysql'
        )
        return $false
    }

    # 端口通不等于库就绪：让后端真正连一次，顺带确认库存在、版本够
    Write-Info '复查数据库连接…'
    $recheck = Get-DbInfo
    if ($recheck -and $recheck.ok) {
        Write-Ok ('连接正常（{0}）' -f $recheck.location)
        return $true
    }
    if ($recheck -and ($recheck.error -match 'DB_PASSWORD') -and ($recheck.error -match '加密')) {
        Write-Ok '端口已通；密码由桌面端解密注入，连接验证交给启动后'
        return $true
    }
    if ($recheck -and $recheck.error) {
        Write-Bad ('仍连不上：{0}' -f $recheck.error)
        if ($recheck.error -match '库不存在|Unknown database') {
            Write-Hint @(
                '库不存在，先建空库再重跑：',
                ("  CREATE DATABASE {0} DEFAULT CHARACTER SET utf8mb4;" -f $dbName)
            )
        }
    } else {
        Write-Bad '复查失败（读不到后端存储配置）'
    }
    return $false
}

# ============================================================
# 主流程
# ============================================================
function Invoke-Main {
    Write-Log '随心问答 · 一键启动'
    Write-Log ("    时间 {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Write-Log ("    目录 {0}" -f $root)
    $mode = @()
    if ($DryRun) { $mode += 'DryRun' }
    if ($SkipDocker) { $mode += 'SkipDocker' }
    if ($NonInteractive) { $mode += 'NonInteractive' }
    if ($mode.Count -gt 0) { Write-Log ("    参数 {0}" -f ($mode -join ' ')) }

    # ---------- 1. 环境 ----------
    Write-Step '检查环境'
    Write-Info ("PowerShell {0}" -f $PSVersionTable.PSVersion)

    $missing = @()
    foreach ($name in @('uv', 'node', 'npm')) {
        if (-not (Test-CommandAvailable $name)) { $missing += $name }
    }
    if ($missing.Count -gt 0) {
        Write-Bad ('缺少命令：' + ($missing -join '、'))
        Write-Hint @(
            '先安装后重试：',
            '  uv      https://docs.astral.sh/uv/',
            '  Node.js https://nodejs.org/（要求 22.12 以上）'
        )
        return 1
    }

    $nodeVersion = (Invoke-Native node @('-v')).Text.Trim()
    $nodeParsed = ConvertTo-Version $nodeVersion
    if (-not $nodeParsed -or $nodeParsed -lt [version]'22.12') {
        Write-Bad ('Node 版本过低：{0}，要求 22.12 以上' -f $nodeVersion)
        Write-Hint @('升级 Node.js 后重试：https://nodejs.org/')
        return 1
    }
    Write-Ok ('uv / node {0} / npm 就绪' -f $nodeVersion)

    $hasNonAscii = [bool]($root -match '[^\x00-\x7F]')
    $hasSpace = [bool]($root -match '\s')
    if ($hasNonAscii) {
        Write-Warn '项目路径含中文：开发运行通常没问题，但 PyInstaller 打包会失败'
    }
    if ($hasSpace) {
        Write-Warn '项目路径含空格：部分工具链会出错，建议移到纯英文无空格路径'
    }
    if (-not $hasNonAscii -and -not $hasSpace) {
        Write-Ok '项目路径无中文与空格'
    }

    $driveLetter = $root.Substring(0, 1)
    $drive = Get-PSDrive -Name $driveLetter -ErrorAction SilentlyContinue
    if ($drive -and $drive.Free -lt 1610612736) {
        Write-Warn ('{0} 盘剩余 {1:N1} GB，首次安装约需 1.5 GB' -f $driveLetter, ($drive.Free / 1GB))
    }

    $probeFile = Join-Path $backend '.start-write-probe'
    try {
        [System.IO.File]::WriteAllText($probeFile, '1')
        Remove-Item -LiteralPath $probeFile -Force
        Write-Ok 'backend 目录可写'
    } catch {
        Write-Bad 'backend 目录不可写（权限不足，或被杀毒软件锁定）'
        return 1
    }

    # ---------- 2. 配置 ----------
    Write-Step '准备配置'
    if (-not (Test-Path -LiteralPath $envFile)) {
        Copy-Item -LiteralPath (Join-Path $backend '.env.example') -Destination $envFile
        Write-Ok '已从模板生成 backend/.env'
    } else {
        Write-Ok 'backend/.env 已存在'
    }

    $jwtSecret = Read-EnvValue -File $envFile -Key 'JWT_SECRET' -Default ''
    if ([string]::IsNullOrWhiteSpace($jwtSecret)) {
        $bytes = New-Object byte[] 48
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $jwtSecret = ([Convert]::ToBase64String($bytes)) -replace '[^A-Za-z0-9]', ''
        $content = [System.IO.File]::ReadAllText($envFile)
        if ($content -match '(?m)^JWT_SECRET=') {
            $content = [regex]::Replace($content, '(?m)^JWT_SECRET=[^\r\n]*', "JWT_SECRET=$jwtSecret")
        } else {
            $content = $content.TrimEnd() + "`r`nJWT_SECRET=$jwtSecret`r`n"
        }
        [System.IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
        Write-Ok 'JWT_SECRET 为空，已生成并写回 backend/.env'
    } elseif ($jwtSecret.Length -lt 32) {
        # 非空但过短：绝不静默替换。换掉密钥会让所有已签发令牌立刻失效，
        # 用户只会看到「莫名其妙被登出」；与桌面端托管（只为空才生成）保持同一口径
        Write-Bad ("JWT_SECRET 长度不足 32 位（当前 {0} 位）" -f $jwtSecret.Length)
        Write-Hint @(
            '在 backend/.env 里把 JWT_SECRET 换成一个至少 32 位的随机串，再重跑本脚本：',
            'python -c "import secrets;print(secrets.token_urlsafe(48))"'
        )
        return 1
    } else {
        Write-Ok 'JWT_SECRET 已就绪'
    }

    $apiKey = Read-EnvValue -File $envFile -Key 'DEEPSEEK_API_KEY' -Default ''
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        Write-Warn '还没填 DEEPSEEK_API_KEY：可以先开窗口，聊天时会提示暂无可用模型'
        Write-Hint @('申请地址 https://platform.deepseek.com/ ，填进 backend/.env 后重跑本脚本')
    }

    $backendHost = Read-EnvValue -File $envFile -Key 'BACKEND_HOST' -Default '127.0.0.1'
    $backendPortText = Read-EnvValue -File $envFile -Key 'BACKEND_PORT' -Default '8010'
    if ($backendHost -notmatch '^[0-9A-Za-z\.\:\[\]\-]+$') {
        Write-Bad ('backend/.env 的 BACKEND_HOST 不合法：{0}' -f $backendHost)
        return 2
    }
    if ($backendPortText -notmatch '^\d{2,5}$') {
        Write-Bad ('backend/.env 的 BACKEND_PORT 不合法（应为纯数字）：{0}' -f $backendPortText)
        return 2
    }
    $backendPort = [int]$backendPortText
    $probeHost = if ($backendHost -in @('0.0.0.0', '::', '[::]')) { '127.0.0.1' } else { $backendHost }

    # ---------- 3. 后端依赖 ----------
    Write-Step '准备后端依赖'
    $venvReady = Test-Path -LiteralPath (Join-Path $backend '.venv')
    if ($DryRun) {
        if ($venvReady) {
            Write-Ok '依赖已就绪（DryRun 不执行 uv sync）'
        } else {
            Write-Warn '依赖未安装（DryRun 跳过安装，存储判定也只能跳过）'
        }
    } else {
        Push-Location $backend
        $syncCode = Invoke-NativeLive uv @('sync')
        Pop-Location
        if ($syncCode -ne 0) {
            Write-Bad ('uv sync 失败（退出码 {0}）' -f $syncCode)
            Write-Hint @(
                '常见原因：网络不通。可先设镜像源再重跑：',
                '  $env:UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"'
            )
            return 4
        }
        $venvReady = Test-Path -LiteralPath (Join-Path $backend '.venv')
        Write-Ok '依赖就绪'
    }

    # ---------- 4. 存储 ----------
    Write-Step '判定存储'
    $dbInfo = $null
    if ($venvReady) { $dbInfo = Get-DbInfo }

    if (-not $dbInfo) {
        Write-Warn '读不到后端存储配置（依赖未就绪或 db_info 执行失败），按 .env 粗判'
        $explicitBackend = (Read-EnvValue -File $envFile -Key 'DB_BACKEND' -Default '').Trim().ToLower()
        $dbHostRaw = (Read-EnvValue -File $envFile -Key 'DB_HOST' -Default '').Trim()
        $coarseBackend = if ($explicitBackend -in @('sqlite', 'mysql')) { $explicitBackend } elseif ($dbHostRaw) { 'mysql' } else { 'sqlite' }
        $coarseLocation = if ($coarseBackend -eq 'sqlite') {
            'backend/data/suixinwenda.db'
        } else {
            ('{0}:{1}/{2}' -f $dbHostRaw, (Read-EnvValue -File $envFile -Key 'DB_PORT' -Default '3306'), (Read-EnvValue -File $envFile -Key 'DB_NAME' -Default ''))
        }
        $dbInfo = [pscustomobject]@{
            backend    = $coarseBackend
            ok         = $false
            error      = '未经后端确认'
            location   = $coarseLocation
            connection = [pscustomobject]@{
                host = $dbHostRaw
                port = (Read-EnvValue -File $envFile -Key 'DB_PORT' -Default '3306')
                name = (Read-EnvValue -File $envFile -Key 'DB_NAME' -Default '')
            }
        }
    }

    if ($dbInfo.backend -eq 'sqlite') {
        Write-Ok ('本机 SQLite（{0}）' -f $dbInfo.location)
        Write-Info '不需要 MySQL，不检查 Docker'
    } else {
        Write-Info ('目标 MySQL：{0}' -f $dbInfo.location)
        $passwordEncrypted = ($dbInfo.error -match 'DB_PASSWORD') -and ($dbInfo.error -match '加密')
        if ($dbInfo.ok) {
            Write-Ok '连接正常'
        } elseif ($passwordEncrypted) {
            # 密码是桌面端加密存放的（DB_PASSWORD_ENC），脚本没有解密能力。
            # 这不算「数据库不可用」：桌面端启动后端时会解密注入，所以只检查端口与容器。
            Write-Info 'MySQL 密码在 .env 里是加密存放的（DB_PASSWORD_ENC），只有桌面端能解密'
            $connHost = if ($dbInfo.connection.host) { $dbInfo.connection.host } else { '127.0.0.1' }
            $connPort = 3306
            if ([string]$dbInfo.connection.port -match '^\d{2,5}$') { $connPort = [int]$dbInfo.connection.port }
            if (Test-TcpPort -TargetHost $connHost -Port $connPort) {
                Write-Ok ('{0}:{1} 端口可达，连接验证交给桌面端启动时完成' -f $connHost, $connPort)
            } else {
                Write-Info ('{0}:{1} 端口不通，需要先让数据库跑起来' -f $connHost, $connPort)
                $resolved = Resolve-MySql -Info $dbInfo
                if (-not $resolved) { return 3 }
            }
        } else {
            Write-Warn ('当前连不上：{0}' -f $dbInfo.error)
            $resolved = Resolve-MySql -Info $dbInfo
            if (-not $resolved) { return 3 }
        }
    }

    # ---------- 5. 服务端口 ----------
    Write-Step '检查服务端口'
    $healthUrl = "http://${probeHost}:${backendPort}/api/v1/health"
    $running = $null
    try {
        $running = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    } catch {
        $running = $null
    }
    # 健康检查通过 = 端口上跑的是本项目后端。
    # managed=true 说明是上次由桌面端托管、还没关干净的实例（再开一个只会抢锁）；
    # managed=false 是用户自己用 uvicorn 起的，桌面端会直接复用它——这种情况必须放行。
    $healthOk = [bool]($running -and $running.code -eq 0)
    if ($healthOk) {
        if ($running.data -and $running.data.managed -eq $true) {
            Write-Bad ('随心问答已在运行（端口 {0}），请先关闭窗口再重跑' -f $backendPort)
            Write-Info '若确认没有窗口：在任务管理器结束 python.exe 后重试'
            return 0
        }
        Write-Info '检测到已有后端在运行（非托管实例），桌面端会复用它，不再另起一个'
    }

    if (-not $healthOk) {
        $listeners = @()
        try {
            $listeners = @(Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue)
        } catch {
            $listeners = @()
        }
        if ($listeners.Count -gt 0) {
            $ownerPid = ($listeners | Select-Object -First 1).OwningProcess
            $ownerName = '未知'
            try {
                $ownerName = (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName
            } catch {
                $ownerName = '未知'
            }
            Write-Bad ('端口 {0} 被占用（PID {1}，进程 {2}）' -f $backendPort, $ownerPid, $ownerName)
            Write-Hint @('先结束它，或改 backend/.env 的 BACKEND_PORT 换一个空闲端口')
            return 1
        }
        Write-Ok ('{0} 空闲' -f $backendPort)
    }

    if ($DryRun) {
        Write-Step 'DryRun 完成'
        Write-Ok '以上检查全部通过，未启动窗口'
        return 0
    }

    # ---------- 6. 桌面端依赖 ----------
    Write-Step '准备桌面端依赖'
    $nodeModules = Join-Path $desktop 'node_modules'
    if (-not (Test-Path -LiteralPath $nodeModules)) {
        Push-Location $desktop
        if (Test-Path -LiteralPath (Join-Path $desktop 'package-lock.json')) {
            $installCode = Invoke-NativeLive npm @('ci')
        } else {
            $installCode = Invoke-NativeLive npm @('install')
        }
        Pop-Location
        if ($installCode -ne 0) {
            Write-Bad ('桌面端依赖安装失败（退出码 {0}）' -f $installCode)
            Write-Hint @(
                '常见原因：网络不通。可先换源再重跑：',
                '  npm config set registry https://registry.npmmirror.com'
            )
            return 4
        }
        Write-Ok '依赖已就绪'
    } else {
        Write-Ok '依赖已就绪'
    }

    # ---------- 7. 启动 ----------
    Write-Step '启动桌面端'
    Write-Info '后端由桌面端托管，关闭窗口时一并退出'
    Write-Info '后端日志：backend\backend.log'
    # 用 cmd.exe 包装启动，而不是 Start-Process npm：
    #   1) 装了 Node 的机器上 Get-Command npm 常解析成 npm.ps1（ExternalScript），
    #      把 .ps1 交给 Start-Process -FilePath 会报「%1 不是有效的 Win32 应用程序」；
    #   2) 也不能用 `npm start | Out-Host`——Electron 发现 stdout 是管道时按 UTF-8 字节写，
    #      PowerShell 5.1 按 GBK 解码，中文日志必然乱码。
    # cmd.exe 包一层后：npm 由 cmd 解析（.cmd 批处理正常），Electron 的 stdout 直连控制台走
    # WriteConsoleW，中文正常；-NoNewWindow 共享当前控制台（Ctrl+C 照常传递），-Wait 等窗口关闭取退出码。
    $desktopProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm start' -WorkingDirectory $desktop -NoNewWindow -PassThru -Wait
    $desktopCode = $desktopProcess.ExitCode

    if ($desktopCode -ne 0) {
        Write-Warn ('桌面端退出码 {0}' -f $desktopCode)
        Write-Hint @('若窗口停在「正在启动本地服务」，看 backend\backend.log 末尾')
    }
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        Write-Warn '窗口已关闭。还差一步才能聊天：填 backend/.env 的 DEEPSEEK_API_KEY 后重跑本脚本'
    }
    return 0
}

# ============================================================
# 入口
# ============================================================
Open-Log
$exitCode = 0
try {
    $exitCode = Invoke-Main
} catch {
    Write-Bad ('启动失败：{0}' -f $_.Exception.Message)
    Write-Hint @(
        '常见原因：npm 装依赖失败、backend\.env 写坏、8010 被占用',
        '完整输出见 start.log'
    )
    $exitCode = 5
} finally {
    if ($exitCode -ne 0) {
        Write-Log ''
        Write-Log ("    退出码 {0}（完整输出见 start.log）" -f $exitCode) 'Red'
    }
    Close-Log
}
exit $exitCode
