@echo off
chcp 936 >nul
setlocal

cd /d "%~dp0"

echo.
echo   ==========================================
echo     钥匙 - 电脑端 一键打包
echo   ==========================================
echo.

echo [1/3] 同步前端到 www ...
call bun run build >nul 2>&1
if errorlevel 1 (
  echo       失败: bun 不可用
  goto fail
)
echo       完成

echo [2/3] 内嵌界面资源 ...
py desktop\embed_assets.py
if errorlevel 1 (
  echo       失败: embed_assets.py 出错
  goto fail
)

echo.
echo [3/3] 打包 exe，大约 1 分钟 ...
py -m PyInstaller --onefile --windowed --name 钥匙 --distpath "desktop\dist" --workpath "%TEMP%\keyapp-pyi" --specpath "%TEMP%\keyapp-pyi" desktop\keyapp_desktop_build.py
if errorlevel 1 (
  echo       失败: PyInstaller 出错
  goto fail
)

echo.
echo   ==========================================
echo     完成
echo     产物: %CD%\desktop\dist\钥匙.exe
echo   ==========================================
echo.
if exist "desktop\dist\钥匙.exe" explorer "desktop\dist"
goto end

:fail
echo.
echo   打包中断，请检查上面的错误。
echo.

:end
endlocal
