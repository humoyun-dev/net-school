@echo off
rem Kuchli bloklash sinovi (P0c, faqat sinov kompyuteri uchun). Administrator sifatida:
rem   hard-lock-spike.cmd apply   - siyosatlarni qo'yadi (oldin ikkala kalitni zaxiraga oladi)
rem   hard-lock-spike.cmd revert  - qiymatlarni o'chiradi va zaxirani qaytaradi
rem Mahsulotdagi helper oldingi qiymatlarni o'zi aynan tiklaydi; bu skript faqat qo'lda sinov uchun.
setlocal
set SYS=HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System
set EXP=HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer
set BAK=%ProgramData%\netschool-spike
net session >nul 2>&1 || (echo Administrator sifatida oching & exit /b 5)
if /i "%~1"=="apply" goto apply
if /i "%~1"=="revert" goto revert
echo foydalanish: %~nx0 apply ^| revert
exit /b 2

:apply
if exist "%BAK%\system.reg" (echo Zaxira bor: avval "revert" qiling & exit /b 3)
mkdir "%BAK%" 2>nul
reg export "%SYS%" "%BAK%\system.reg" /y >nul 2>&1 || type nul > "%BAK%\system.none"
reg export "%EXP%" "%BAK%\explorer.reg" /y >nul 2>&1 || type nul > "%BAK%\explorer.none"
if not exist "%BAK%\system.reg" type nul > "%BAK%\system.reg"
reg add "%SYS%" /v DisableTaskMgr /t REG_DWORD /d 1 /f >nul
reg add "%SYS%" /v DisableLockWorkstation /t REG_DWORD /d 1 /f >nul
reg add "%SYS%" /v DisableChangePassword /t REG_DWORD /d 1 /f >nul
reg add "%SYS%" /v HideFastUserSwitching /t REG_DWORD /d 1 /f >nul
reg add "%EXP%" /v NoLogoff /t REG_DWORD /d 1 /f >nul
reg add "%EXP%" /v NoClose /t REG_DWORD /d 1 /f >nul
echo qo'yildi. Endi qayta kirmasdan Ctrl+Alt+Del va Ctrl+Shift+Esc ni sinang.
exit /b 0

:revert
for %%V in (DisableTaskMgr DisableLockWorkstation DisableChangePassword HideFastUserSwitching) do reg delete "%SYS%" /v %%V /f >nul 2>&1
for %%V in (NoLogoff NoClose) do reg delete "%EXP%" /v %%V /f >nul 2>&1
if exist "%BAK%\system.none" (del "%BAK%\system.none") else if exist "%BAK%\system.reg" for %%A in ("%BAK%\system.reg") do if %%~zA GTR 0 reg import "%BAK%\system.reg" >nul 2>&1
if exist "%BAK%\explorer.none" (del "%BAK%\explorer.none") else if exist "%BAK%\explorer.reg" reg import "%BAK%\explorer.reg" >nul 2>&1
rmdir /s /q "%BAK%" 2>nul
echo qaytarildi. Ctrl+Alt+Del ni yana sinang.
exit /b 0
