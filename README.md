# NoFallZap

Painel multi-instância de WhatsApp sobre a **Evolution API**. Conecta vários
números ao mesmo tempo, cada um como uma instância independente, com isolamento
total entre eles.

Fases 1–5 do roadmap: instâncias, QR Code ao vivo, webhook multi-instância,
sincronização de grupos, agentes e o motor de IA respondendo nos grupos.

---

## O que já funciona

- Criar quantas instâncias quiser (`+ Adicionar WhatsApp`)
- QR Code dentro da interface, atualizando sozinho — **sem F5**
- Status ao vivo: conectado, aguardando QR, conectando, desconectado, reconectando, erro
- Sincronização automática de grupos ao conectar (com segunda passada para os grupos que a Evolution devolve sem nome)
- Isolamento por `instance_id` em tudo — grupos homônimos em números diferentes são entidades diferentes
- Webhook único para todas as instâncias, com identificação da origem e anti-duplicata
- Toggle de IA por grupo (padrão: **desligado**), agente por grupo, modo de participação
- Botão de emergência **PAUSAR TODAS AS IAs** (nível global)
- Pausa por instância e por grupo
- Desconectar ≠ Excluir (exclusão exige digitar o nome exato)
- Logs por instância e métricas diárias
- **Agentes** com prompt próprio, modelo e criatividade, reutilizáveis entre grupos
- **Motor de IA** com debounce por grupo, memória resumida e ritmo humano no envio
- **Filtro anti-loop**: mensagens vindas de qualquer número do próprio painel são ignoradas

---

## Deploy no EasyPanel

A Evolution API já está rodando. Crie os serviços abaixo **no mesmo projeto**
dela, para que se enxerguem pela rede interna.

### 1. Postgres

Template do EasyPanel. Anote usuário, senha e nome do banco.
**Não use o banco da Evolution** — este painel tem o schema dele.

### 2. Redis

Template do EasyPanel. Ative persistência (AOF). Sem isso a fila esvazia a cada
restart.

### 3. `nofallzap-api`

- **Source:** GitHub → este repositório → branch `main`
- **Build:** Dockerfile
- **Comando:** `api`
- **Porta:** `3000`
- **Domínio:** este é o único serviço que precisa de domínio público
- **Healthcheck:** `GET /health`

### 4. `nofallzap-worker`

- Mesmo repositório, mesmo Dockerfile
- **Comando:** `/app/docker-entrypoint.sh worker`
- **Sem porta e sem domínio**
- Pode escalar para 2, 3 réplicas quando o volume crescer

> **Atenção ao campo Comando.** O EasyPanel **substitui o entrypoint** da
> imagem, não só o CMD. Se você puser apenas `worker`, o container roda
> `sh -c worker` e morre com `worker: not found`. Tem que ser o caminho
> completo do script.

### 5. Variáveis de ambiente

Copie de `.env.example` e preencha nos dois serviços (API e worker).

O ponto que mais dá erro é o **DNS interno**. No EasyPanel os serviços se
resolvem por `<projeto>_<serviço>`. Se o seu projeto se chama `maturador` e a
Evolution é o serviço `evolution-api`, a URL fica:

```
EVOLUTION_BASE_URL=http://maturador_evolution-api:8080
WEBHOOK_PUBLIC_URL=http://maturador_nofallzap-api:3000/webhook/evolution
```

Confirme os nomes reais no painel antes de subir. Se o DNS interno não
funcionar, use o domínio público da API no `WEBHOOK_PUBLIC_URL` — mas aí o
webhook fica exposto na internet e o `WEBHOOK_SHARED_SECRET` passa a ser a
única proteção. Gere um segredo forte:

```bash
openssl rand -hex 24
```

### 6. Primeira subida

O `docker-entrypoint.sh` cria as tabelas sozinho (`prisma db push`) quando não
há migrations no repositório. Depois que o schema estabilizar, gere as
migrations versionadas para ter histórico:

```bash
# na sua máquina, com DATABASE_URL apontando para o banco
npx prisma migrate dev --name init
git add prisma/migrations && git commit -m "migrations iniciais"
```

A partir daí o entrypoint passa a usar `prisma migrate deploy` automaticamente.

---

## Rodar local

```bash
cp .env.example .env      # ajuste EVOLUTION_BASE_URL e EVOLUTION_GLOBAL_KEY
docker compose up --build
```

Painel em `http://localhost:3000`.

Sem Docker:

```bash
npm install
npx prisma generate
npx prisma db push
npm run dev          # API na 3000
npm run dev:worker   # worker, em outro terminal
npm --prefix web run dev   # painel na 5173, com proxy para a 3000
```

---

## Arquitetura em uma tela

```
 Evolution API
      │  webhook (endpoint ÚNICO, header x-webhook-secret)
      ▼
 POST /webhook/evolution
      │  valida segredo → resolve instance_id → responde 200 na hora
      ▼
 FILA 1: ingest          concorrência alta, sem ordenação
      │                  persiste mensagem, atualiza métricas
      ▼
 FILA 2: decide          jobId = grp:{instance_id}:{group_id} + debounce
      │                  5 mensagens em rajada = 1 processamento
      │                  portão de decisão → prompt → OpenAI
      ▼
 FILA 3: send:{instance} rate limit POR INSTÂNCIA
                         presença "digitando" + delay humano
```

O webhook **nunca** faz trabalho pesado. É isso que permite os WhatsApps A, B e
C receberem em paralelo sem um travar o outro.

### Ordem de decisão antes de responder (fase 5)

```
sistema global ativo? → instância conectada? → IA da instância?
→ IA do grupo? → agente ativo? → filtros → cooldown → limite diário
→ motor de decisão → fila de envio
```

Cooldown e limite diário vêm **antes** do motor de decisão de propósito: são
checagens de Redis baratíssimas e evitam pagar uma chamada de IA que o
cooldown ia barrar logo depois.

---

## Estrutura

```
src/
├── config/env.ts           validação das variáveis (falha rápido no boot)
├── lib/                    prisma, redis, locks, pub/sub, logger
├── evolution/client.ts     cliente da Evolution API v2
├── queues/index.ts         as três filas + debounce por grupo
├── routes/
│   ├── webhook.ts          endpoint único multi-instância
│   ├── instances.ts        CRUD, QR, reconectar, desconectar, excluir
│   ├── groups.ts           listagem, toggle de IA, agente por grupo
│   └── settings.ts         botão de emergência + agentes
├── services/
│   ├── instanceService.ts  ciclo de vida + reconciliação
│   ├── groupSync.ts        sincronização com isolamento por instância
│   └── eventLog.ts         logs e métricas
├── realtime/io.ts          Socket.IO alimentado por pub/sub do Redis
├── server.ts               API + painel estático
└── worker.ts               consumidor da fila ingest + reconciliação

web/                        painel React (Vite), servido pela própria API
prisma/schema.prisma        modelo de dados
```

---

## Como ligar a IA em um grupo

1. Ponha a `OPENAI_API_KEY` nas variáveis de ambiente da **api e do worker**
2. No painel, aba **Agentes** → crie um agente com o prompt dele
3. Abra a instância → aba **Grupos** → escolha o agente no grupo
4. Ligue o toggle de IA **do grupo**
5. Ligue a IA **da instância** (aba Configurações da instância)
6. Confirme que o botão vermelho no topo não está em pausa global

Os cinco níveis precisam estar ligados. Quando a IA não responde, a aba
**Logs** diz exatamente por quê (`ai_skipped` traz o motivo em texto).

## Próximos passos

1. Autenticação do painel (as variáveis `PANEL_*` existem mas o login ainda
   não está plugado — hoje a proteção é o Basic Auth do EasyPanel)
2. Modo de participação "inteligente" (a IA decide sozinha se entra na
   conversa) — dobra o custo por grupo, ficou para depois
3. Horário de funcionamento por grupo
4. Ramp-up automático do teto diário para maturação de chip novo

---

## Avisos

- **Autenticação ainda não implementada.** Mantenha o domínio da API restrito
  (IP allowlist do EasyPanel, ou sem domínio público) até a fase 5.
- **Risco de ban.** Volume alto de envio automático em grupos é o padrão que o
  WhatsApp mais pune. Rate limit por instância, jitter, teto diário e horário
  de funcionamento não são luxo.
- **Capacidade da Evolution.** Cada instância é uma sessão Baileys em memória.
  Para 50+ números, prepare mais de um container da Evolution — a coluna
  `instances.evolution_server_id` já existe no schema para isso.
