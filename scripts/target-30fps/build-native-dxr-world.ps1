param([switch]$Run)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$destination = Join-Path $projectRoot 'artifacts/four-horizons/target-30fps/native-dxr-world'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$vcRoot = 'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.44.35207'
$sdkRoot = 'C:/Program Files (x86)/Windows Kits/10'
$sdkVersion = '10.0.19041.0'
$compiler = Join-Path $vcRoot 'bin/Hostx64/x64/cl.exe'
$shaderCompiler = Join-Path $sdkRoot "bin/$sdkVersion/x64/dxc.exe"
$shader = Join-Path $destination 'native-dxr-world.dxil'
$executable = Join-Path $destination 'native-dxr-world.exe'
& $shaderCompiler -T cs_6_5 -E main -O3 -Fo $shader (Join-Path $PSScriptRoot 'native-dxr-world.hlsl')
if($LASTEXITCODE -ne 0){throw 'DXC shader compilation failed'}
$arguments = @('/nologo','/std:c++17','/EHsc','/O2','/MT',"/I$vcRoot/include", "/I$sdkRoot/Include/$sdkVersion/um", "/I$sdkRoot/Include/$sdkVersion/shared", "/I$sdkRoot/Include/$sdkVersion/ucrt", "/I$sdkRoot/Include/$sdkVersion/winrt", (Join-Path $PSScriptRoot 'native-dxr-world.cpp'), "/Fo$destination/native-dxr-world.obj", "/Fe$executable", '/link', "/LIBPATH:$vcRoot/lib/x64", "/LIBPATH:$sdkRoot/Lib/$sdkVersion/um/x64", "/LIBPATH:$sdkRoot/Lib/$sdkVersion/ucrt/x64", 'd3d12.lib','dxgi.lib','dxguid.lib','user32.lib')
& $compiler @arguments
if($LASTEXITCODE -ne 0){throw 'Native benchmark compilation failed'}
$evidence = [ordered]@{timestamp=(Get-Date).ToUniversalTime().ToString('o'); compiler=$compiler; shaderCompiler=$shaderCompiler; compileArguments=$arguments; shaderTarget='cs_6_5'; sourceSha256=(Get-FileHash (Join-Path $PSScriptRoot 'native-dxr-world.cpp') -Algorithm SHA256).Hash.ToLower(); shaderSourceSha256=(Get-FileHash (Join-Path $PSScriptRoot 'native-dxr-world.hlsl') -Algorithm SHA256).Hash.ToLower(); executableSha256=(Get-FileHash $executable -Algorithm SHA256).Hash.ToLower(); compilationGpuUsed=$false}
$evidence | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $destination 'build.json') -Encoding utf8
if($Run){
  & $executable (Join-Path $projectRoot 'public/acceleration/visibility-world') $destination $shader
  if($LASTEXITCODE -ne 0){throw 'Native DXR benchmark failed'}
}
