#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f .env ]]; then
  echo "[ERROR] Salin .env.example menjadi .env dan isi seluruh CHANGE_ME terlebih dahulu." >&2
  exit 1
fi
if grep -q 'CHANGE_ME' .env; then
  echo "[ERROR] Masih ada nilai CHANGE_ME di .env." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] Docker tidak ditemukan. Pasang Docker Engine/Desktop terlebih dahulu." >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo "[ERROR] Gunakan Node.js 22 atau lebih baru." >&2; exit 1; }
docker compose up -d
npm install
npm run db:generate
npm run db:migrate -w @kantorai/api -- --name init
npm run db:seed
npm run dev
