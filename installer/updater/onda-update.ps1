<#
  Onda Player - aggiornatore automatico per Windows (AGPLv3, come il progetto originale).

  Gira come SYSTEM ogni 2 minuti (attività pianificata "Onda Player\Aggiornamento", creata dall'installer di Onda).
  Il player, che non ha i permessi di amministratore, lascia in %ProgramData%\Onda Player\update:
    package.msi      l'installer ricevuto da Onda
    manifest.sig     firma (RSA, SHA-256, base64) del manifesto
    manifest.json    {"schema":"onda-update-1","version","kind":"msi","file","size","sha256","expires_at",...}
  La cartella è scrivibile da tutti gli utenti, quindi qui si fida solo della firma: copio i file in una cartella
  temporanea di SYSTEM, verifico la firma con la chiave pubblica scritta dall'installer di Onda
  (HKLM\SOFTWARE\Onda\Onda Player › UpdateKey), la scadenza e l'impronta del pacchetto; solo allora chiudo il player,
  installo in silenzio e lo riavvio nella sessione dell'utente collegato. L'esito va in status.json, che il player
  riferisce a Onda. Registro: %SystemRoot%\Temp\onda-player-update.log (o la cartella temporanea di SYSTEM).
#>
$ErrorActionPreference = 'Stop'
$stage = Join-Path $env:ProgramData 'Onda Player\update'
$manifestPath = Join-Path $stage 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { exit 0 }

$tmpRoot = [IO.Path]::GetTempPath()
$logFile = Join-Path $tmpRoot 'onda-player-update.log'
function Log([string]$msg) {
  try { Add-Content -LiteralPath $logFile -Value ("{0:u} {1}" -f (Get-Date), $msg) } catch { }
}

$work = Join-Path $tmpRoot ('onda-update-' + [guid]::NewGuid().ToString('N'))
$version = ''

function Write-Status([string]$state, [string]$detail) {
  # scrivo in una cartella mia e poi sposto: un collegamento lasciato al posto di status.json viene sostituito,
  # non seguito
  try {
    $obj = [ordered]@{ version = $version; state = $state; detail = $detail; at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    $tmp = Join-Path $work 'status.json'
    [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination (Join-Path $stage 'status.json') -Force
  } catch { Log "status.json non scritto: $_" }
}

function Clear-Stage {
  foreach ($n in 'manifest.json', 'manifest.sig', 'package.msi') {
    Remove-Item -LiteralPath (Join-Path $stage $n) -Force -ErrorAction SilentlyContinue
  }
}

function Get-PlayerUsers {
  # chi sta usando il player: lo riavvio nella sua sessione, anche se è bloccata o disconnessa (lì
  # Win32_ComputerSystem.UserName è vuoto). Senza player acceso: chi ha la sessione di Windows (explorer.exe).
  foreach ($name in 'onda-player.exe', 'explorer.exe') {
    $users = @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue | ForEach-Object {
        $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
        if ($o -and $o.User -and $o.User -ne 'SYSTEM') { if ($o.Domain) { "$($o.Domain)\$($o.User)" } else { $o.User } }
      } | Select-Object -Unique)
    if ($users.Count -gt 0) { return $users }
  }
  $u = (Get-CimInstance Win32_ComputerSystem).UserName
  if ($u) { return @($u) }
  return @()
}

function Start-PlayerForUser([string]$exe, [string[]]$users) {
  # il player è un'app con finestra: va avviato nella sessione di chi lo usava, non come SYSTEM
  if (-not $users -or $users.Count -eq 0) { Log 'Nessun utente collegato: il player partirà al prossimo accesso'; return }
  $user = $users[0]
  $name = 'Riavvio ' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  try {
    $action = New-ScheduledTaskAction -Execute $exe
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskPath '\Onda Player\' -TaskName $name -Action $action -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskPath '\Onda Player\' -TaskName $name
    Start-Sleep -Seconds 10
    Log "Player riavviato per $user"
  } catch { Log "Riavvio del player non riuscito per ${user}: $_" }
  finally { Unregister-ScheduledTask -TaskPath '\Onda Player\' -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
}

try {
  $item = Get-Item -LiteralPath $stage -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'la cartella di attesa è un collegamento' }
  New-Item -ItemType Directory -Path $work | Out-Null
  foreach ($n in 'manifest.json', 'manifest.sig', 'package.msi') {
    $src = Join-Path $stage $n
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "manca $n" }
    Copy-Item -LiteralPath $src -Destination (Join-Path $work $n)
  }
  Clear-Stage

  $reg = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Onda\Onda Player'
  if (-not $reg.UpdateKey) { throw 'chiave pubblica di Onda assente: installa il player con un installer scaricato da Onda' }
  $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
  $rsa.FromXmlString($reg.UpdateKey)
  $bytes = [IO.File]::ReadAllBytes((Join-Path $work 'manifest.json'))
  $sig = [Convert]::FromBase64String(([IO.File]::ReadAllText((Join-Path $work 'manifest.sig'))).Trim())
  if (-not $rsa.VerifyData($bytes, 'SHA256', $sig)) { throw 'firma non valida: pacchetto scartato' }

  $m = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  $version = [string]$m.version
  if ($m.schema -ne 'onda-update-1' -or $m.kind -ne 'msi') { throw 'manifesto di un altro tipo' }
  $expires = [DateTimeOffset]::Parse([string]$m.expires_at, [Globalization.CultureInfo]::InvariantCulture)
  if ($expires -lt [DateTimeOffset]::UtcNow) { throw 'manifesto scaduto' }
  $msi = Join-Path $work 'package.msi'
  if ((Get-Item -LiteralPath $msi).Length -ne [long]$m.size) { throw 'dimensione del pacchetto diversa' }
  if ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLower() -ne ([string]$m.sha256).ToLower()) {
    throw 'impronta del pacchetto diversa'
  }

  Log "Installo Onda Player $version"
  Write-Status 'installing' ''
  $players = Get-PlayerUsers
  Log ("Utenti del player: " + ($(if ($players.Count) { $players -join ', ' } else { 'nessuno' })))
  Get-Process -Name 'onda-player' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $msiLog = Join-Path $work 'msiexec.log'
  $p = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -Wait -PassThru -WindowStyle Hidden `
    -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart', '/l*v', "`"$msiLog`"")
  $installFolder = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Onda\Onda Player').InstallFolder
  if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) {
    Log "Installato $version (msiexec $($p.ExitCode))"
    Write-Status 'installed' ''
  } else {
    Log "msiexec non riuscito: $($p.ExitCode)"
    Copy-Item -LiteralPath $msiLog -Destination (Join-Path $tmpRoot 'onda-player-update-msiexec.log') -Force -ErrorAction SilentlyContinue
    Write-Status 'failed' "installazione non riuscita (msiexec $($p.ExitCode))"
  }
  if ($installFolder) { Start-PlayerForUser (Join-Path $installFolder 'onda-player.exe') $players }
} catch {
  Log "Aggiornamento scartato: $_"
  if (-not (Test-Path -LiteralPath $work)) { New-Item -ItemType Directory -Path $work -ErrorAction SilentlyContinue | Out-Null }
  Clear-Stage
  Write-Status 'failed' ([string]$_.Exception.Message)
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
