/**
 * TESTE DA PORTA DO PAINEL.
 *
 * Roda sem banco, sem Redis e sem Evolution: monta um Fastify de mentira com
 * as mesmas pecas do server.ts e bate nas rotas com app.inject.
 *
 *     npm run build:server && node scripts/teste-auth.mjs
 *
 * Existe por causa de um erro real: o guarda estava registrado com
 * app.register(), o Fastify criou escopo proprio, o hook morreu la dentro e a
 * API respondia 200 para qualquer um com a tela de login na frente. Passou
 * despercebido porque a tela funcionava. Os tres primeiros testes daqui
 * pegariam isso.
 */

process.env.DATABASE_URL ??= 'teste';
process.env.REDIS_URL ??= 'teste';
process.env.EVOLUTION_BASE_URL ??= 'teste';
process.env.EVOLUTION_GLOBAL_KEY ??= 'teste';
process.env.WEBHOOK_PUBLIC_URL ??= 'teste';
process.env.WEBHOOK_SHARED_SECRET ??= '12345678';
process.env.PANEL_USER = 'admin';
process.env.PANEL_PASSWORD = 'segredo123';
process.env.SESSION_SECRET = '0123456789abcdefghij';
process.env.LOG_LEVEL = 'error';

const Fastify = (await import('fastify')).default;
const { authGuard, authRoutes } = await import('../dist/routes/auth.js');

const app = Fastify();
// A MESMA ordem e a mesma forma de chamar do server.ts. Se alguem trocar por
// app.register(authGuard), os tres primeiros testes caem.
await authGuard(app);
await app.register(authRoutes);
await app.register(async (a) => a.get('/api/instances', async () => [{ id: '1' }]));
await app.register(async (a) => a.get('/api/settings', async () => ({ ok: true })));
await app.register(async (a) => a.post('/webhook/evolution', async () => ({ ok: true })));
app.get('/', async () => 'painel');

let ok = 0;
const falhas = [];
const t = (nome, cond) => (cond ? ok++ : falhas.push(nome));
const req = (o) => app.inject(o);
const LOGIN = { usuario: 'admin', senha: 'segredo123' };

// ---------------------------------------------------------- sem sessao
t('/api/instances bloqueada', (await req({ url: '/api/instances' })).statusCode === 401);
t('/api/settings bloqueada', (await req({ url: '/api/settings' })).statusCode === 401);
t('query string nao burla', (await req({ url: '/api/instances?x=1' })).statusCode === 401);
t('painel estatico aberto', (await req({ url: '/' })).statusCode === 200);
t('webhook aberto', (await req({ method: 'POST', url: '/webhook/evolution' })).statusCode === 200);
const me = await req({ url: '/api/auth/me' });
t('me responde sem sessao', me.statusCode === 200);
t('me diz que nao esta logado', JSON.parse(me.body).autenticado === false);

// ---------------------------------------------------------- login errado
const senhaRuim = await req({ method: 'POST', url: '/api/auth/login', payload: { ...LOGIN, senha: 'errada' } });
t('senha errada = 401', senhaRuim.statusCode === 401);
t('senha errada nao manda cookie', !senhaRuim.headers['set-cookie']);
const userRuim = await req({ method: 'POST', url: '/api/auth/login', payload: { ...LOGIN, usuario: 'outro' } });
t('usuario errado = 401', userRuim.statusCode === 401);
t('mesma mensagem nos dois casos', JSON.parse(senhaRuim.body).error === JSON.parse(userRuim.body).error);
t('sem corpo = 400', (await req({ method: 'POST', url: '/api/auth/login', payload: {} })).statusCode === 400);

// ---------------------------------------------------------- login certo
const bom = await req({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
t('login certo = 200', bom.statusCode === 200);
const setCookie = [].concat(bom.headers['set-cookie'] ?? [])[0] ?? '';
t('veio Set-Cookie', setCookie.includes('nfz_sess='));
t('cookie HttpOnly', setCookie.includes('HttpOnly'));
t('cookie SameSite=Lax', setCookie.includes('SameSite=Lax'));
const cookie = setCookie.split(';')[0];

t('rota liberada com cookie', (await req({ url: '/api/instances', headers: { cookie } })).statusCode === 200);
t('me reconhece o usuario',
  JSON.parse((await req({ url: '/api/auth/me', headers: { cookie } })).body).usuario === 'admin');

const adulterado = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
t('cookie adulterado volta a bloquear',
  (await req({ url: '/api/instances', headers: { cookie: adulterado } })).statusCode === 401);

// ---------------------------------------------------------- logout / lembrar
const saida = await req({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
t('logout = 200', saida.statusCode === 200);
t('logout zera o cookie', ([].concat(saida.headers['set-cookie'] ?? [])[0] ?? '').includes('Max-Age=0'));

const idade = (r) => Number(([].concat(r.headers['set-cookie'])[0] ?? '').match(/Max-Age=(\d+)/)[1]);
const curto = await req({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
const longo = await req({ method: 'POST', url: '/api/auth/login', payload: { ...LOGIN, lembrar: true } });
t('lembrar de mim dura muito mais', idade(longo) > idade(curto) * 10);

await app.close();
console.log(falhas.length ? 'FALHOU: ' + falhas.join(' | ') : `todos os ${ok} testes passaram`);
process.exit(falhas.length ? 1 : 0);
