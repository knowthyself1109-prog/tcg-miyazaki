@echo off
chcp 932 >nul
title GitHub へアップロード
cd /d "C:\Users\knowt\OneDrive\デスクトップ\claude専用\tcg-miyazaki-public"
echo ==============================================
echo   GitHub へアップロードします
echo   ブラウザで認証画面が開いたら、サインインしてください
echo ==============================================
echo.
git push -u origin main
echo.
if %errorlevel%==0 (echo ★ アップロード成功しました) else (echo ×失敗しました。上のメッセージを確認してください)
echo.
pause
