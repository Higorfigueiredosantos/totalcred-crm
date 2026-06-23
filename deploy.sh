#!/bin/bash
set -e

echo "==> Atualizando código..."
cd /opt/totalcred
git pull

echo "==> Construindo imagens..."
docker build -t totalcred-backend:latest ./backend
docker build -t totalcred-frontend:latest ./frontend

echo "==> Parando containers standalone (se existirem)..."
docker compose down 2>/dev/null || true

echo "==> Fazendo deploy como Swarm stack..."
docker stack deploy -c swarm-stack.yml totalcred

echo ""
echo "✅ Deploy concluído! Acesse: https://app.totalcredsolucoes.com.br"
