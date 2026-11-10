@echo off
chcp 936 >nul
setlocal

cd /d "%~dp0"

echo.
echo   ==========================================
echo     钥匙 - 电脑端 一键打包
echo   ==========================================
echo.

echo [1/2] 同步前端 + 内嵌界面资源 ...
call bun run build >nul 2>&1
if errorlevel 1 (
  echo       失败: bun 不可用
  goto fail
)
py desktop\embed_assets.py
if errorlevel 1 (
  echo       失败: embed_assets.py 出错
  goto fail
)

echo.
echo [2/2] 打包 exe（内嵌窗口，不需要浏览器）...
py desktop\build_exe.py
if errorlevel 1 (
  echo       失败: build_exe.py 出错
  goto fail
)

echo.
if exist "desktop\dist\钥匙.exe" explorer "desktop\dist"
goto end

:fail
echo.
echo   打包中断，请检查上面的错误。
echo.

:end
endlocal
