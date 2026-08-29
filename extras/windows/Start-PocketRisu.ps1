$ErrorActionPreference = 'Stop'

$installRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$serverEntry = Join-Path $installRoot 'server\node\server.cjs'
$localUrl = 'http://127.0.0.1:6001/'
$chromeProxy = 'C:\Program Files\Google\Chrome\Application\chrome_proxy.exe'
$chromeArgs = '--profile-directory=Default --app-id=ihfnfgbbghfdggoklmondlgbjipngdfb'

function Test-PocketRisuReady {
    try {
        $response = Invoke-WebRequest -Uri $localUrl -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

try {
    if (-not (Test-Path -LiteralPath $serverEntry)) {
        throw "PocketRisu server entry was not found: $serverEntry"
    }

    if (-not (Test-PocketRisuReady)) {
        $node = (Get-Command node -ErrorAction Stop).Source
        Start-Process -FilePath $node `
            -ArgumentList @('server/node/server.cjs') `
            -WorkingDirectory $installRoot `
            -WindowStyle Hidden | Out-Null

        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 250
            if (Test-PocketRisuReady) { break }
        } while ([DateTime]::UtcNow -lt $deadline)
    }

    if (-not (Test-PocketRisuReady)) {
        throw 'PocketRisu server did not become ready within 30 seconds.'
    }

    if (Test-Path -LiteralPath $chromeProxy) {
        Start-Process -FilePath $chromeProxy -ArgumentList $chromeArgs | Out-Null
    } else {
        Start-Process $localUrl | Out-Null
    }
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        $_.Exception.Message,
        'PocketRisu 시작 실패',
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
    exit 1
}
