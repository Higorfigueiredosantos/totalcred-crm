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

echo "==> Forçando containers a pegarem a imagem :latest recém-buildada..."
# docker stack deploy não reinicia um serviço se a referência da imagem
# (tag) não mudou, mesmo com conteúdo novo por trás do mesmo ":latest" -
# sem isso o servidor continua rodando o binário antigo depois do deploy.
docker service update --force --image totalcred-backend:latest totalcred_backend
docker service update --force --image totalcred-frontend:latest totalcred_frontend

echo ""
echo "✅ Deploy concluído! Acesse: https://app.totalcredsolucoes.com.br"
