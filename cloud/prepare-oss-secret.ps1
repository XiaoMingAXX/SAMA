param()
$ErrorActionPreference = 'Stop'
$secretDirectory = Join-Path $PSScriptRoot '.secrets'
$destination = Join-Path $secretDirectory 'oss-credentials.json'
if (Test-Path -LiteralPath $destination) {
    throw "Credential file already exists: $destination. Move it aside deliberately before replacing it."
}
New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($identity)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $secretDirectory -AclObject $acl
$accessKeyId = Read-Host 'Dedicated RAM AccessKey ID (input hidden)' -AsSecureString
$accessKeySecret = Read-Host 'Dedicated RAM AccessKey Secret (input hidden)' -AsSecureString
function Read-PlainSecret([System.Security.SecureString] $value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
$payload = $null
try {
    if ($accessKeyId.Length -eq 0 -or $accessKeySecret.Length -eq 0) { throw 'Both fields are required.' }
    $payload = @{
        accessKeyId = Read-PlainSecret $accessKeyId
        accessKeySecret = Read-PlainSecret $accessKeySecret
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($destination, $payload, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Saved locally with restricted Windows permissions: $destination"
    Write-Host 'Do not paste this file into chat. Nothing was uploaded to the server.'
} finally {
    $payload = $null
    $accessKeyId.Dispose()
    $accessKeySecret.Dispose()
}
