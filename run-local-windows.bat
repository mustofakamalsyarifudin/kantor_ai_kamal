@echo off
setlocal
cd /d "%~dp0"
echo =====================================================
echo  KantorAI - Local Development Setup
echo =====================================================
if not exist ".env" (
  echo [ERROR] File .env belum ada.
  echo Salin .env.example menjadi .env, lalu ubah semua CHANGE_ME.
  echo DB_PASSWORD harus sama dengan password di DATABASE_URL.
  pause
  exit /b 1
)
findstr /C:"CHANGE_ME" .env >nul
if %errorlevel%==0 (
  echo [ERROR] Masih ada nilai CHANGE_ME di .env. Ubah terlebih dahulu.
  pause
  exit /b 1
)
where docker >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Docker tidak ditemukan. Pasang Docker Desktop terlebih dahulu.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan. Pasang Node.js 22 atau lebih baru.
  pause
  exit /b 1
)
node -e "const v=Number(process.versions.node.split('.')[0]); if(v<22) process.exit(1)"
if errorlevel 1 (
  echo [ERROR] KantorAI memerlukan Node.js 22 atau lebih baru.
  pause
  exit /b 1
)
echo [1/6] Menyalakan PostgreSQL dan Redis...
docker compose up -d
if errorlevel 1 goto failed
echo Menunggu PostgreSQL siap...
for /L %%i in (1,1,30) do (
  docker compose exec -T postgres pg_isready -U kantorai -d kantorai >nul 2>nul
  if not errorlevel 1 goto database_ready
  timeout /t 2 /nobreak >nul
)
echo [ERROR] PostgreSQL tidak siap setelah sekitar 60 detik.
goto failed
:database_ready
echo [2/6] Menginstal dependency...
call npm.cmd install
if errorlevel 1 goto failed
echo [3/6] Membuat Prisma Client...
call npm.cmd run db:generate
if errorlevel 1 goto failed
echo [4/6] Menyiapkan migration database...
call npm.cmd run db:migrate -w @kantorai/api -- --name init
if errorlevel 1 goto failed
echo [5/6] Membuat admin, departemen dan agent awal...
call npm.cmd run db:seed
if errorlevel 1 goto failed
echo [6/6] Menjalankan web dan API...
call npm.cmd run dev
goto end
:failed
echo.
echo [ERROR] Ada langkah yang gagal. Baca pesan terminal sebelum mencoba lagi.
pause
:end
endlocal
