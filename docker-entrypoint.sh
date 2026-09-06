#!/bin/sh
set -e

# Um unico container serve os dois papeis. No EasyPanel voce cria dois
# servicos a partir da MESMA imagem, mudando so o comando:
#   nofallzap-api     -> "api"     (padrao)
#   nofallzap-worker  -> "worker"
#
# So a API mexe no schema do banco, para dois processos nao competirem pelo
# lock do Prisma no boot.

ROLE="${1:-api}"

apply_schema() {
  if [ -d "prisma/migrations" ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
    echo "[entrypoint] aplicando migrations versionadas..."
    npx prisma migrate deploy
  else
    # Primeira subida, sem migrations no repo: cria as tabelas a partir do
    # schema.prisma. Nao usa --accept-data-loss: se houver algo destrutivo,
    # e melhor falhar e voce olhar.
    echo "[entrypoint] sem migrations no repo — aplicando schema com db push"
    npx prisma db push --skip-generate
  fi
}

case "$ROLE" in
  api)
    apply_schema
    echo "[entrypoint] iniciando API + painel na porta ${PORT:-3000}"
    exec node dist/server.js
    ;;
  worker)
    echo "[entrypoint] iniciando worker (filas)"
    exec node dist/worker.js
    ;;
  link)
    # So o redirecionador publico do rodizio. Servico separado porque a
    # Autenticacao Basica do EasyPanel vale para o servico inteiro, e link
    # de campanha nao pode pedir login. Nao mexe no schema.
    echo "[entrypoint] iniciando link publico (rodizio) na porta ${PORT:-3000}"
    exec node dist/link.js
    ;;
  *)
    echo "[entrypoint] papel desconhecido: $ROLE (use 'api', 'worker' ou 'link')"
    exit 1
    ;;
esac
