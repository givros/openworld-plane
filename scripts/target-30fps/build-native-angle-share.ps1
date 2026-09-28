param([switch]$Run)
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$destination=Join-Path $projectRoot 'artifacts/four-horizons/target-30fps/native-angle-share'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$vcRoot='C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.44.35207'
$sdkRoot='C:/Program Files (x86)/Windows Kits/10'
$sdkVersion='10.0.19041.0'
$headerRoot='C:/Program Files/Epic Games/UE_5.8/Engine/Source/ThirdParty/OpenGL'
$libraries='C:/Users/limou/AppData/Local/ms-playwright/chromium-1217/chrome-win64'
$compiler=Join-Path $vcRoot 'bin/Hostx64/x64/cl.exe'
$executable=Join-Path $destination 'native-angle-share.exe'
$arguments=@('/nologo','/std:c++17','/EHsc','/O2','/MT',"/I$vcRoot/include","/I$sdkRoot/Include/$sdkVersion/um","/I$sdkRoot/Include/$sdkVersion/shared","/I$sdkRoot/Include/$sdkVersion/ucrt","/I$sdkRoot/Include/$sdkVersion/winrt","/I$headerRoot",(Join-Path $PSScriptRoot 'native-angle-share.cpp'),"/Fo$destination/native-angle-share.obj","/Fe$executable",'/link',"/LIBPATH:$vcRoot/lib/x64","/LIBPATH:$sdkRoot/Lib/$sdkVersion/um/x64","/LIBPATH:$sdkRoot/Lib/$sdkVersion/ucrt/x64",'d3d12.lib','d3d11.lib','dxgi.lib','dxguid.lib','user32.lib')
& $compiler @arguments
if($LASTEXITCODE -ne 0){throw 'Native ANGLE fixture compilation failed'}
$evidence=[ordered]@{timestamp=(Get-Date).ToUniversalTime().ToString('o');compiler=$compiler;compileArguments=$arguments;libraries=$libraries;sourceSha256=(Get-FileHash (Join-Path $PSScriptRoot 'native-angle-share.cpp')).Hash.ToLower();executableSha256=(Get-FileHash $executable).Hash.ToLower();dlls=@()}
foreach($name in @('libEGL.dll','libGLESv2.dll','chrome.dll')){$path=Join-Path $libraries $name;$evidence.dlls += @{name=$name;sha256=(Get-FileHash $path).Hash.ToLower()}}
$evidence | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $destination 'build.json') -Encoding utf8
if($Run){& $executable $libraries $destination;if($LASTEXITCODE -ne 0){throw 'Native ANGLE fixture failed'}}
