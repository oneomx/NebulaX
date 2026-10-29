/**
 * Windows 远端（OpenSSH Server）采集命令集（v1.5）
 *
 * 设计：
 * - Windows 默认 shell 为 cmd/PowerShell，无法执行 Linux 命令；
 *   这里提供与 ssh.ts Linux 脚本**同标记格式**的 PowerShell 脚本，
 *   保证解析层（__KEY__ / === M_XXX === / === DIAG: X ===）零改动复用。
 * - 统一经 -EncodedCommand（UTF-16LE base64）下发，
 *   规避 cmd 对引号/换行/特殊字符的转义问题。
 * - PowerShell 5.1 兼容（不用 ?? 、?. 等 7.x 语法）。
 */

/** 把 PowerShell 脚本编码为可安全下发的远程命令行 */
export function psCommand(script: string): string {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -EncodedCommand ${b64}`;
}

/**
 * 服务器信息采集（与 Linux 版同标记，输出同列格式）。
 * MEM/SWAP 单位 MB（free -m 同构）；DISK 带表头（解析层 slice(1)）；PROC 无表头 5 行。
 */
export const WIN_SERVER_INFO_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
"__HOST__"
$env:COMPUTERNAME
"__OS__"
if ($os.Caption) { $os.Caption } else { [Environment]::OSVersion.VersionString }
"__KERNEL__"
$os.Version
"__ARCH__"
$env:PROCESSOR_ARCHITECTURE
"__CPU__"
if ($cpu.Name) { $cpu.Name.Trim() }
"__CORES__"
$cs.NumberOfLogicalProcessors
"__MEM__"
$tot = [int]($os.TotalVisibleMemorySize / 1KB)
$free = [int]($os.FreePhysicalMemory / 1KB)
"$tot $($tot - $free) $free $tot"
"__SWAP__"
$pf = Get-CimInstance Win32_PageFileUsage
$ptot = 0; $pcur = 0
foreach ($p in $pf) { $ptot += $p.AllocatedBaseSize; $pcur += $p.CurrentUsage }
"$ptot $pcur $($ptot - $pcur)"
"__LOAD__"
$lp = @($cpu.LoadPercentage) | Where-Object { $_ -ne $null }
if ($lp.Count -gt 0) { [math]::Round(($lp | Measure-Object -Average).Average) } else { "" }
"__UPTIME__"
$ts = (Get-Date) - $os.LastBootUpTime
"up {0} days, {1} hours, {2} minutes" -f [int]$ts.TotalDays, $ts.Hours, $ts.Minutes
"__USERS__"
quser 2>$null | Select-Object -Skip 1 | ForEach-Object {
  $line = $_ -replace '^\\s*>?\\s*',''
  $f = $line -split '\\s{2,}'
  if ($f[0] -and $f[0] -notmatch 'USERNAME') { $f[0].Trim() }
}
"__IP__"
((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254*' }).IPAddress) -join ' '
"__DISK__"
"SOURCE SIZE USED AVAIL USE% MOUNT"
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $s = [math]::Round($_.Size / 1GB, 1); $f = [math]::Round($_.FreeSpace / 1GB, 1); $u = [math]::Round($s - $f, 1)
  $p = if ($s -gt 0) { [int][math]::Round($u / $s * 100) } else { 0 }
  "$($_.DeviceID) \${s}G \${u}G \${f}G \${p}% $($_.DeviceID)\\"
}
"__PROC__"
Get-Process | Sort-Object WS -Descending | Select-Object -First 5 | ForEach-Object {
  $c = if ($_.CPU) { [math]::Round($_.CPU, 1) } else { 0 }
  "{0,7} {1,8} {2,7}MB {3}" -f $_.Id, $c, [int]($_.WS / 1MB), $_.ProcessName
}
"__DOCKER__"
"__END__"
`.trim();

/** 诊断证据包（与 Linux 版同 section 键，消费方零改动） */
export const WIN_DIAG_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
"=== DIAG: TOP ==="
"PID CPU(s) Mem(MB) Name"
Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 | ForEach-Object {
  $c = if ($_.CPU) { [math]::Round($_.CPU, 1) } else { 0 }
  "{0} {1} {2:N0} {3}" -f $_.Id, $c, ($_.WS / 1MB), $_.ProcessName
}
""
"=== DIAG: FREE ==="
$os = Get-CimInstance Win32_OperatingSystem
$tot = [math]::Round($os.TotalVisibleMemorySize / 1KB)
$free = [math]::Round($os.FreePhysicalMemory / 1KB)
"Total: \${tot} MB   Used: $($tot - $free) MB   Free: $free MB"
""
"=== DIAG: DF ==="
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $s = [math]::Round($_.Size / 1GB, 1); $f = [math]::Round($_.FreeSpace / 1GB, 1)
  $p = if ($s -gt 0) { [math]::Round(($s - $f) / $s * 100, 1) } else { 0 }
  "$($_.DeviceID) Size: \${s}GB   Free: \${f}GB   Used: \${p}%"
}
""
"=== DIAG: DMESG_OOM ==="
"（Windows 无 dmesg；OOM/资源类系统错误见 JOURNAL_ERRORS 的 System 日志）"
""
"=== DIAG: JOURNAL_ERRORS ==="
Get-WinEvent -FilterHashtable @{LogName='System'; Level=2} -MaxEvents 20 | ForEach-Object {
  $m = if ($_.Message) { $_.Message -replace '\\s+', ' ' } else { '' }
  if ($m.Length -gt 200) { $m = $m.Substring(0, 200) }
  "{0} [{1}] {2}" -f $_.TimeCreated, $_.Id, $m
}
""
"=== DIAG: PS_TOP_MEM ==="
"PID Mem(MB) Name"
Get-Process | Sort-Object WS -Descending | Select-Object -First 14 | ForEach-Object {
  "{0} {1:N0} {2}" -f $_.Id, ($_.WS / 1MB), $_.ProcessName
}
""
"=== DIAG: PS_TOP_CPU ==="
"PID CPU(s) Name"
Get-Process | Sort-Object CPU -Descending | Select-Object -First 14 | ForEach-Object {
  $c = if ($_.CPU) { [math]::Round($_.CPU, 1) } else { 0 }
  "{0} {1} {2}" -f $_.Id, $c, $_.ProcessName
}
""
"=== DIAG: NETWORK ==="
"IPv4:"
Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { "{0}/{1}" -f $_.IPAddress, $_.PrefixLength }
""
"LISTENING:"
Get-NetTCPConnection -State Listen | Select-Object -First 20 | ForEach-Object { "{0}:{1}" -f $_.LocalAddress, $_.LocalPort }
""
"ESTABLISHED: $((Get-NetTCPConnection -State Established | Measure-Object).Count)"
""
"=== DIAG: SYSTEMD_FAILED ==="
"（自动启动但未运行的服务 ≈ failed units）"
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } | ForEach-Object {
  "{0}  {1}" -f $_.Status, $_.Name
}
""
"=== DIAG: UPTIME ==="
$ts = (Get-Date) - $os.LastBootUpTime
"up {0} days, {1} hours, {2} minutes" -f [int]$ts.TotalDays, $ts.Hours, $ts.Minutes
"=== DIAG_END ==="
`.trim();

/** 指标快照（与 Linux 版同标记；CPU/负载用 Win32_Processor.LoadPercentage，Windows 无 loadavg） */
export const WIN_METRICS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$os = Get-CimInstance Win32_OperatingSystem
$cpuObj = Get-CimInstance Win32_Processor
"=== M_HOST ==="
$env:COMPUTERNAME
"=== M_CPU ==="
$lp = @($cpuObj | Where-Object { $_.LoadPercentage -ne $null } | Select-Object -ExpandProperty LoadPercentage)
if ($lp.Count -gt 0) { [math]::Round(($lp | Measure-Object -Average).Average, 1) } else { "0" }
"=== M_MEM ==="
if ($os.TotalVisibleMemorySize -gt 0) {
  [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize * 100, 1)
} else { "0" }
"=== M_LOAD ==="
$lp2 = @($cpuObj | Where-Object { $_.LoadPercentage -ne $null } | Select-Object -ExpandProperty LoadPercentage)
if ($lp2.Count -gt 0) { [math]::Round(($lp2 | Measure-Object -Average).Average, 1) } else { "0" }
"=== M_DISK ==="
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $s = [math]::Round($_.Size / 1GB, 1); $f = [math]::Round($_.FreeSpace / 1GB, 1)
  $p = if ($s -gt 0) { [math]::Round(($s - $f) / $s * 100, 1) } else { 0 }
  "$($_.DeviceID) \${p}% \${f}G"
}
"=== M_CONN ==="
(Get-NetTCPConnection | Where-Object { $_.State -eq 'Established' } | Measure-Object).Count
"=== M_END ==="
`.trim();

/** 安全审计补充信息（Windows 检查集未覆盖时的基础信息：系统版本 + 异常服务） */
export const WIN_AUDIT_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version | Format-List
"自动启动但未运行的服务："
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } | Format-Table Name,Status
`.trim();

/**
 * Windows 服务器信息的负载数组归一化。
 * Windows 无 1/5/15 分钟负载均值，只采到单值（CPU 负载 %）；
 * 5/15 分钟位以 'N/A' 占位，前端可如实展示而不是误显示 0.00。
 */
export function windowsLoadArray(loadParts: string[]): string[] {
  if (loadParts.length === 0) return [];
  if (loadParts.length >= 3) return loadParts.slice(0, 3);
  return [loadParts[0], 'N/A', 'N/A'];
}
