import { useEffect, useState, useCallback } from 'react';
import {
  api,
  timeAgo,
  timeUntil,
  formatDate,
  MODELS,
  type WarmupConfig,
  type WarmupInstance,
  type WarmupThread,
} from '../api';
import { Toggle, ErrorBox, StatusBadge } from '../components/Common';

export function Warmup({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<WarmupConfig | null>(null);
  const [rows, setRows] = useState<WarmupInstance[]>([]);
  const [threads, setThreads] = useState<WarmupThread[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, t] = await Promise.all([api.getWarmup(), api.warmupThreads()]);
      setCfg(w.config);
      setRows(w.instances);
      setTotal(w.totalMessages);
      setThreads(t);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // o contador desce a cada segundo sem bater na API — so o relogio anda
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function patch(data: Partial<WarmupConfig>) {
    if (!cfg) return;
    setSaving(true);
    setCfg({ ...cfg, ...data });
    try {
      await api.patchWarmup(data);
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function toggleInstance(row: WarmupInstance, on: boolean) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, warmupEnabled: on } : r)));
    try {
      await api.setWarmupInstance(row.id, on);
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    }
  }

  if (loading || !cfg) return <div className="empty">Carregando maturação…</div>;

  const ativos = rows.filter((r) => r.warmupEnabled && r.status === 'connected').length;

  return (
    <>
      <button className="crumb" onClick={onBack}>
        ← Todas as instâncias
      </button>

      <div className="toolbar">
        <div style={{ fontSize: 20, fontWeight: 700 }}>Maturação de chip</div>
        <div className="spacer" />
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>
          {cfg.enabled ? 'Aquecimento ligado' : 'Aquecimento desligado'}
        </span>
        <Toggle checked={cfg.enabled} onChange={(v) => void patch({ enabled: v })} />
      </div>

      <div
        className="banner"
        style={{
          background: 'rgba(210,153,34,0.12)',
          borderColor: 'var(--warn)',
          color: '#f0d58c',
          fontWeight: 400,
          lineHeight: 1.5,
        }}
      >
        <strong>Leia antes de ligar.</strong> Aquecimento de chip contraria os termos de uso do
        WhatsApp. Ele reduz <em>um</em> sinal de risco, não todos — números aquecidos são banidos
        com frequência quando o uso posterior é agressivo. Se o padrão for identificado, o
        conjunto de números pode cair junto, porque eles formam um grafo entre si. O risco é seu:
        cai o número da empresa, com os contatos e o histórico. A alternativa sem esse risco é a
        API oficial do WhatsApp Business.
      </div>

      <ErrorBox message={error} />

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-num" style={{ color: ativos > 1 ? 'var(--accent)' : 'var(--warn)' }}>
            {ativos}
          </div>
          <div className="kpi-label">números aquecendo</div>
        </div>
        <div className="kpi">
          <div className="kpi-num">{rows.reduce((s, r) => s + r.sentToday, 0)}</div>
          <div className="kpi-label">mensagens hoje</div>
        </div>
        <div className="kpi">
          <div className="kpi-num">{total}</div>
          <div className="kpi-label">mensagens no total</div>
        </div>
      </div>

      {ativos < 2 && (
        <div className="error-box">
          A maturação precisa de <strong>pelo menos 2 números conectados</strong> com o
          aquecimento ligado — eles conversam entre si. Com um só, nada acontece.
        </div>
      )}

      {/* ------------------------------------------------------ configuração */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Ritmo do aquecimento</div>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
          A conversa é <strong>por turnos</strong>: quem falou não fala de novo até o outro
          responder. <em>Intervalo</em> é o tempo para alguém <strong>puxar assunto novo</strong>;
          <em>resposta</em> é o tempo para <strong>responder</strong> uma mensagem recebida — bem
          menor, porque ninguém demora uma hora para responder "já almoçou?" e ainda soa natural.
          O teto diário sobe em rampa: um chip novo que dispara 30 mensagens no primeiro dia
          chama muito mais atenção do que um que começa com 4 e cresce ao longo de semanas.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
          <Num label="Início (hora)" value={cfg.startHour} min={0} max={23} onSave={(v) => void patch({ startHour: v })} />
          <Num label="Fim (hora)" value={cfg.endHour} min={0} max={23} onSave={(v) => void patch({ endHour: v })} />
          <Num label="Intervalo mín. (min)" value={cfg.minIntervalMinutes} min={1} max={1440} onSave={(v) => void patch({ minIntervalMinutes: v })} />
          <Num label="Intervalo máx. (min)" value={cfg.maxIntervalMinutes} min={2} max={1440} onSave={(v) => void patch({ maxIntervalMinutes: v })} />
          <Num label="Resposta mín. (min)" value={cfg.replyMinMinutes} min={1} max={720} onSave={(v) => void patch({ replyMinMinutes: v })} />
          <Num label="Resposta máx. (min)" value={cfg.replyMaxMinutes} min={2} max={720} onSave={(v) => void patch({ replyMaxMinutes: v })} />
          <Num label="Dias de rampa" value={cfg.rampUpDays} min={0} max={180} onSave={(v) => void patch({ rampUpDays: v })} />
          <Num label="Teto inicial/dia" value={cfg.capStart} min={0} max={500} onSave={(v) => void patch({ capStart: v })} />
          <Num label="Teto final/dia" value={cfg.capEnd} min={0} max={500} onSave={(v) => void patch({ capEnd: v })} />
        </div>

        <div className="field" style={{ marginTop: 14, maxWidth: 320 }}>
          <label>Modelo que escreve as mensagens</label>
          <select
            className="input"
            value={cfg.model}
            disabled={saving}
            onChange={(e) => void patch({ model: e.target.value })}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* --------------------------------------------------------- números */}
      <div className="card" style={{ padding: 0, marginBottom: 20, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 60 }}>Aquecer</th>
              <th style={{ width: 200 }}>Número</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 90 }}>Hoje</th>
              <th style={{ width: 170 }}>Próxima mensagem</th>
              <th>Última que enviou</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Toggle
                    checked={r.warmupEnabled}
                    disabled={r.status !== 'connected'}
                    onChange={(v) => void toggleInstance(r, v)}
                    title={r.status !== 'connected' ? 'Precisa estar conectado' : ''}
                  />
                </td>
                <td>
                  <div>{r.name}</div>
                  <div className="jid">{r.phoneNumber ? `+${r.phoneNumber}` : 'sem número'}</div>
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {r.warmupEnabled ? (
                    <>
                      <span
                        style={{ color: r.sentToday >= r.dailyCap ? 'var(--warn)' : undefined }}
                      >
                        {r.sentToday} / {r.dailyCap}
                      </span>
                      <div className="kpi-label">{r.daysWarming}d aquecendo</div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>

                <td>
                  {!r.warmupEnabled ? (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  ) : r.sentToday >= r.dailyCap ? (
                    <span style={{ color: 'var(--warn)', fontSize: 13 }}>
                      teto do dia atingido
                      <div className="kpi-label">volta amanhã</div>
                    </span>
                  ) : (
                    <>
                      <span
                        style={{
                          fontWeight: 600,
                          color:
                            r.nextTurnAt && new Date(r.nextTurnAt).getTime() <= Date.now()
                              ? 'var(--accent)'
                              : undefined,
                        }}
                      >
                        {timeUntil(r.nextTurnAt)}
                      </span>
                      <div className="kpi-label">
                        {r.nextTurnAt ? formatDate(r.nextTurnAt).split(' ')[1] : 'aguardando vez'}
                        {r.intervalMinutes ? ` · intervalo sorteado: ${r.intervalMinutes} min` : ''}
                      </div>
                    </>
                  )}
                </td>

                <td style={{ fontSize: 13 }}>
                  {r.lastText ? (
                    <>
                      <div style={{ color: 'var(--text)' }}>{r.lastText}</div>
                      <div className="kpi-label">
                        para {r.lastPartner} · {timeAgo(r.lastSentAt)}
                      </div>
                    </>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>nada enviado ainda</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ color: 'var(--muted)', fontSize: 13, margin: '-8px 0 20px' }}>
        A mensagem <strong>não existe antes de ser enviada</strong> — o texto é gerado no
        instante do disparo, com o histórico da dupla em mãos. Se fosse escrita com
        antecedência, ela ignoraria o que a outra pessoa respondeu no meio-tempo. O que dá para
        prever é <em>quando</em> sai, não <em>o quê</em>.
      </div>

      {/* ------------------------------------------------------- conversas */}
      <div style={{ fontWeight: 600, marginBottom: 10 }}>Conversas geradas</div>
      {threads.length === 0 ? (
        <div className="empty">
          Nenhuma conversa ainda. Ligue o aquecimento em pelo menos dois números conectados.
        </div>
      ) : (
        <div className="grid">
          {threads.map((t) => (
            <div key={t.id} className="card">
              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                {t.a} ↔ {t.b}
              </div>
              <div className="card-sub" style={{ marginBottom: 10 }}>
                {t.messageCount} mensagens · {timeAgo(t.lastMessageAt)}
              </div>
              {t.messages.map((m, i) => (
                <div key={i} style={{ fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: 'var(--muted)' }}>{m.from}: </span>
                  {m.content}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Campo numérico que só salva ao sair (evita uma requisição por tecla). */
function Num({
  label,
  value,
  min,
  max,
  onSave,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onSave: (v: number) => void;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= min && n <= max && n !== value) onSave(n);
          else setV(String(value));
        }}
      />
    </div>
  );
}
