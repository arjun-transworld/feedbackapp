# Prints the Android signature hash that Entra ID and www/js/config.js (androidKeyHash) need.
#
# Debug key (emulator / Android Studio "Run"):
#   powershell -ExecutionPolicy Bypass -File tools\android-keyhash.ps1
# Release key:
#   powershell -ExecutionPolicy Bypass -File tools\android-keyhash.ps1 -Keystore C:\keys\release.jks -Alias upload -StorePass <password>
#
# The debug keystore is created the first time Android Studio builds any app.
param(
    [string]$Keystore = "$env:USERPROFILE\.android\debug.keystore",
    [string]$Alias = "androiddebugkey",
    [string]$StorePass = "android",
    [string]$Package = "com.transworld.jets.feedback"
)

$keytool = @(
    "$env:JAVA_HOME\bin\keytool.exe",
    "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe",
    "C:\Program Files\Android\Android Studio\jre\bin\keytool.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $keytool) { throw "keytool not found. Install Android Studio (or set JAVA_HOME)." }
if (-not (Test-Path $Keystore)) { throw "Keystore not found: $Keystore. For the debug key, build any project in Android Studio once." }

$listing = & $keytool -list -v -keystore $Keystore -alias $Alias -storepass $StorePass
$match = $listing | Select-String 'SHA1:\s*([0-9A-Fa-f:]+)' | Select-Object -First 1
if (-not $match) { throw "Could not read the SHA1 fingerprint. Check the alias and password." }

$bytes = [byte[]]($match.Matches[0].Groups[1].Value -split ':' | ForEach-Object { [Convert]::ToByte($_, 16) })
$hash = [Convert]::ToBase64String($bytes)

""
"Signature hash (androidKeyHash / Entra 'Signature hash'):"
"  $hash"
""
"Redirect URI Entra will show:"
"  msauth://$Package/$([Uri]::EscapeDataString($hash))"
""
"AndroidManifest.xml <data android:path> value:"
"  /$hash"
