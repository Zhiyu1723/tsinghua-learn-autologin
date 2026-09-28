<#
  清华网络学堂自动登录 —— 账号密码的本地加密保存

  两种用法（由主程序调用）：
    -Save -Path <文件>  从标准输入读 JSON，用 Windows DPAPI 加密后写入文件
    -Load -Path <文件>  解密文件，把 JSON 写到标准输出

  加密用的是 Windows 自带的 DPAPI（Data Protection API），密钥由系统按
  "当前电脑 + 当前用户"保管：文件被复制到别的电脑或别的用户下都解不开，
  也不需要你另外记一个密码。

  账号密码的输入由主程序在终端里完成（不在这里弹窗）。
#>

[CmdletBinding()]
param(
    [switch]$Save,
    [switch]$Load,
    [string]$Path
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot 在参数默认值里可能是空的，所以默认路径在这里补
if ([string]::IsNullOrEmpty($Path)) {
    $Path = Join-Path $PSScriptRoot 'credentials.dat'
}

# 出错信息也按 UTF-8 写到标准错误，免得中文被控制台代码页改坏
function Write-StderrText([string]$text) {
    $err = [Console]::OpenStandardError()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text + [Environment]::NewLine)
    $err.Write($bytes, 0, $bytes.Length)
    $err.Flush()
}

trap {
    Write-StderrText ('出错了：' + $_.Exception.Message)
    exit 1
}

# 附加熵：让别的程序无法直接拿 ProtectedData 解开我们的文件
function Get-Entropy {
    return [System.Text.Encoding]::UTF8.GetBytes('tsinghua-learn-autologin/v1')
}

function Protect-Bytes([byte[]]$data) {
    Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
    return [System.Security.Cryptography.ProtectedData]::Protect(
        $data, (Get-Entropy), [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
}

function Unprotect-Bytes([byte[]]$data) {
    Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
    return [System.Security.Cryptography.ProtectedData]::Unprotect(
        $data, (Get-Entropy), [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
}

# 读写标准输入输出时一律用 UTF-8 原始字节，避免被控制台代码页改坏
function Read-StdinText {
    $stdin = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdin.CopyTo($ms)
    return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
}

function Write-StdoutText([string]$text) {
    $out = [Console]::OpenStandardOutput()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
}

if ($Save) {
    $json = Read-StdinText
    $obj = $json | ConvertFrom-Json
    if ([string]::IsNullOrEmpty($obj.username) -or [string]::IsNullOrEmpty($obj.password)) { exit 5 }

    $plain = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
    $enc = Protect-Bytes $plain

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllBytes($Path, $enc)
    exit 0
}

if ($Load) {
    if (-not (Test-Path -LiteralPath $Path)) { exit 6 }
    try {
        $enc = [System.IO.File]::ReadAllBytes($Path)
        $plain = Unprotect-Bytes $enc
        Write-StdoutText ([System.Text.Encoding]::UTF8.GetString($plain))
        exit 0
    } catch {
        Write-StderrText ('解密失败：' + $_.Exception.Message)
        exit 7
    }
}

Write-StderrText '用法：credential-store.ps1 -Save -Path <文件> | -Load -Path <文件>'
exit 2
