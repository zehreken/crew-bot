@echo off
REM Build crew-assign with MSVC. No CMake needed - ImGui's Win32+DX11 backend
REM only wants the Windows SDK, which comes with Visual Studio.

setlocal

set VSROOT=C:\Program Files\Microsoft Visual Studio\2022\Community
set VCVARS=%VSROOT%\VC\Auxiliary\Build\vcvars64.bat

if not exist "%VCVARS%" (
    echo ERROR: cannot find vcvars64.bat at:
    echo   %VCVARS%
    echo Edit VSROOT at the top of this script to point at your Visual Studio.
    exit /b 1
)

REM Sets up cl.exe, the Windows SDK headers and the linker search paths.
call "%VCVARS%" >nul
if errorlevel 1 (
    echo ERROR: vcvars64.bat failed.
    exit /b 1
)

cd /d "%~dp0"

if not exist vendor\imgui\imgui.cpp (
    echo ERROR: vendor\imgui is missing. Run:
    echo   git clone --depth 1 https://github.com/ocornut/imgui.git vendor\imgui
    exit /b 1
)
if not exist vendor\json.hpp (
    echo ERROR: vendor\json.hpp is missing. Download it from:
    echo   https://github.com/nlohmann/json/releases/latest/download/json.hpp
    exit /b 1
)

if not exist build mkdir build

REM /EHsc      - nlohmann/json throws on malformed input
REM /utf-8     - source and execution charset, so Swedish names survive
REM /std:c++17 - std::filesystem
REM /MP        - compile the translation units in parallel
cl /nologo /std:c++17 /EHsc /utf-8 /O2 /MP /W3 ^
   /I vendor\imgui /I vendor\imgui\backends /I vendor ^
   /Fo:build\ /Fe:build\crew-assign.exe ^
   src\main.cpp ^
   vendor\imgui\imgui.cpp ^
   vendor\imgui\imgui_draw.cpp ^
   vendor\imgui\imgui_tables.cpp ^
   vendor\imgui\imgui_widgets.cpp ^
   vendor\imgui\backends\imgui_impl_win32.cpp ^
   vendor\imgui\backends\imgui_impl_dx11.cpp ^
   /link d3d11.lib dxgi.lib d3dcompiler.lib user32.lib gdi32.lib shell32.lib

if errorlevel 1 (
    echo.
    echo BUILD FAILED
    exit /b 1
)

REM Console self-test: same io.h / crews.h the GUI uses, no window needed.
cl /nologo /std:c++17 /EHsc /utf-8 /O2 /W3 ^
   /I vendor ^
   /Fo:build\selftest_ /Fe:build\selftest.exe ^
   src\selftest.cpp

if errorlevel 1 (
    echo.
    echo SELFTEST BUILD FAILED
    exit /b 1
)

echo.
echo Built build\crew-assign.exe and build\selftest.exe
