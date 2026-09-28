param([string]$Capture,[string]$Output='artifacts/four-horizons/target-30fps/native-angle-replay')
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$destination=Join-Path $projectRoot 'artifacts/four-horizons/target-30fps/native-angle-replay'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$vcRoot='C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.44.35207'
$sdkRoot='C:/Program Files (x86)/Windows Kits/10'
$sdkVersion='10.0.19041.0'
$headerRoot='C:/Program Files/Epic Games/UE_5.8/Engine/Source/ThirdParty/OpenGL'
$libraries='C:/Users/limou/AppData/Local/ms-playwright/chromium-1217/chrome-win64'
$compiler=Join-Path $vcRoot 'bin/Hostx64/x64/cl.exe'
$executable=Join-Path $destination 'native-angle-replay.exe'
$arguments=@('/nologo','/std:c++17','/EHsc','/O2','/MT',"/I$vcRoot/include","/I$sdkRoot/Include/$sdkVersion/um","/I$sdkRoot/Include/$sdkVersion/shared","/I$sdkRoot/Include/$sdkVersion/ucrt","/I$sdkRoot/Include/$sdkVersion/winrt","/I$sdkRoot/Include/$sdkVersion/cppwinrt","/I$headerRoot",(Join-Path $PSScriptRoot 'native-angle-replay.cpp'),"/Fo$destination/native-angle-replay.obj","/Fe$executable",'/link',"/LIBPATH:$vcRoot/lib/x64","/LIBPATH:$sdkRoot/Lib/$sdkVersion/um/x64","/LIBPATH:$sdkRoot/Lib/$sdkVersion/ucrt/x64",'runtimeobject.lib','windowsapp.lib','user32.lib')
& $compiler @arguments
if($LASTEXITCODE -ne 0){throw 'Native ANGLE player compilation failed'}
[ordered]@{timestamp=(Get-Date).ToUniversalTime().ToString('o');compiler=$compiler;compileArguments=$arguments;libraries=$libraries;executableSha256=(Get-FileHash $executable).Hash.ToLower();sources=@(Get-ChildItem "$PSScriptRoot/native-angle-replay*", "$PSScriptRoot/native-angle-context.h" | Where-Object { -not $_.PSIsContainer } | ForEach-Object { @{file=$_.Name;sha256=(Get-FileHash $_.FullName).Hash.ToLower()} })} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $destination 'build.json') -Encoding utf8
if($Capture){& $executable $libraries $Capture $Output;if($LASTEXITCODE -ne 0){throw 'Native ANGLE replay failed'}}
