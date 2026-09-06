import { useEffect, useState, useCallback } from 'react';
import {
  api,
  timeAgo,
  formatDate,
  type InstanceDetail as Detail,
  type GroupRow,
  type AgentRow,
  type EventRow,
  type InstanceStatus,
} from '../api';
import { on } from '../socket';
import { StatusBadge, Avatar, Toggle, ErrorBox } from '../components/Common';
import { QrModal } from '../components/QrModal';
import { Contacts } from './Contacts';

type Tab = 'overview' | 'groups' | 'contacts' | 'settings' | 'logs' | 'connection';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: 'Visão Geral' },
  { key: 'groups', label: 'Grupos' },
  { key: 'contacts', label: 'Conversas privadas' },
  { key: 'settings', label: 'Configurações' },
  { key: 'logs', label: 'Logs' },
  { key: 'connection', label: 'Conexão' },
];

export function InstanceDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.getInstance(id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const off = on<{ instanceId: string; status: InstanceStatus }>('instance:status', (p) => {
      if (p.instanceId === id) void load();
    });
    return off;
  }, [id, load]);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <div className="empty">Carregando…</div>;

  return (
    <>
      <button className="crumb" onClick={onBack}>
        ← Todas as instâncias
      </button>

      <div className="card-head" style={{ marginBottom: 20 }}>
        <Avatar url={data.profilePicUrl} name={data.name} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{data.name}</div>
          <div className="card-sub">
            {data.phoneNumber ? `+${data.phoneNumber}` : 'sem número'} · {data.evoName}
          </div>
        </div>
        <StatusBadge status={data.status} />
      </div>

      <ErrorBox message={error} />

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview data={data} />}
      {tab === 'groups' && <Groups instanceId={id} onChanged={load} />}
      {tab === 'contacts' && <Contacts instanceId={id} />}
      {tab === 'settings' && <Settings data={data} onChanged={load} />}
      {tab === 'logs' && <Logs instanceId={id} />}
      {tab === 'connection' && (
        <Connection data={data} onChanged={load} onOpenQr={() => setShowQr(true)} />
      )}

      {showQr && (
        <QrModal
          instanceId={id}
          instanceName={data.name}
          onClose={() => setShowQr(false)}
          onConnected={load}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------- Visão Geral */

function Overview({ data }: { data: Detail }) {
  const k = data.today;
  return (
    <>
      <div className="kpis">
        <Kpi n={data.groupsCount} label="grupos" />
        <Kpi n={data.groupsWithAi} label="grupos com IA" accent={data.groupsWithAi > 0} />
        <Kpi n={k.received} label="recebidas hoje" />
        <Kpi n={k.repliesSent} label="respostas da IA" />
        <Kpi n={k.ignoredByAi} label="ignoradas pela IA" />
        <Kpi n={k.errors} label="erros hoje" danger={k.errors > 0} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <Row label="Status" value={data.statusDetail ?? '—'} />
        <Row label="Última conexão" value={formatDate(data.lastConnectedAt)} />
        <Row label="Última atividade" value={timeAgo(data.lastActivityAt)} />
        <Row label="Criada em" value={formatDate(data.createdAt)} />
        <Row label="IA da instância" value={data.aiEnabled ? 'Ativa' : 'Pausada'} />
      </div>

      {data.recentErrors.length > 0 && (
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Erros recentes</div>
          {data.recentErrors.map((e) => (
            <div key={e.id} className="log-line error">
              <span className="ts">{formatDate(e.createdAt)}</span>
              <span>{e.message ?? e.event}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Kpi({ n, label, accent, danger }: { n: number; label: string; accent?: boolean; danger?: boolean }) {
  return (
    <div className="kpi">
      <div
        className="kpi-num"
        style={{ color: danger ? 'var(--danger)' : accent ? 'var(--accent)' : undefined }}
      >
        {n}
      </div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0' }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ Grupos */

function Groups({ instanceId, onChanged }: { instanceId: string; onChanged: () => void }) {
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, a] = await Promise.all([
        api.listGroups(instanceId, { q, ai: filter || undefined }),
        api.listAgents(),
      ]);
      setRows(g.items);
      setAgents(a);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [instanceId, q, filter]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250); // debounce da busca
    return () => clearTimeout(t);
  }, [load]);

  async function patch(group: GroupRow, data: Partial<GroupRow>) {
    // otimista: a UI responde na hora, e reverte se a API recusar
    setRows((prev) => prev.map((r) => (r.id === group.id ? { ...r, ...data } : r)));
    try {
      await api.patchGroup(group.id, data);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      void load();
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      await api.syncGroups(instanceId);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <ErrorBox message={error} />
      <div className="toolbar">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          placeholder="Pesquisar grupo…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" style={{ maxWidth: 160 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Todos</option>
          <option value="on">IA ligada</option>
          <option value="off">IA desligada</option>
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() => void sync()} disabled={syncing}>
          {syncing ? 'Sincronizando…' : 'Sincronizar grupos'}
        </button>
      </div>

      {loading ? (
        <div className="empty">Carregando grupos…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          Nenhum grupo encontrado.
          <br />
          Se o WhatsApp acabou de conectar, clique em Sincronizar grupos.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>IA</th>
                <th>Grupo</th>
                <th style={{ width: 90 }}>Part.</th>
                <th style={{ width: 180 }}>Agente</th>
                <th style={{ width: 150 }}>Modo</th>
                <th style={{ width: 210 }} title="Levar a conversa para o privado">
                  Chamar no privado
                </th>
                <th style={{ width: 120 }}>Atividade</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Toggle
                      checked={g.aiEnabled}
                      onChange={(v) => void patch(g, { aiEnabled: v })}
                      title={g.aiEnabled ? 'IA ativa neste grupo' : 'IA desligada'}
                    />
                  </td>
                  <td>
                    <div>{g.subject ?? <em style={{ color: 'var(--muted)' }}>sem nome</em>}</div>
                    <div className="jid">{g.remoteJid}</div>
                  </td>
                  <td>{g.participantsCount || '—'}</td>
                  <td>
                    <select
                      className="input"
                      value={g.agentId ?? ''}
                      onChange={(e) => void patch(g, { agentId: e.target.value || null })}
                    >
                      <option value="">— nenhum —</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="input"
                      value={g.participationMode}
                      onChange={(e) =>
                        void patch(g, {
                          participationMode: e.target.value as GroupRow['participationMode'],
                        })
                      }
                    >
                      <option value="mention">Só se mencionado</option>
                      <option value="always">Sempre</option>
                      <option value="keyword">Palavra-chave</option>
                      <option value="smart">Inteligente</option>
                    </select>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Toggle
                        checked={g.escalationEnabled}
                        disabled={!g.dmAgentId}
                        title={
                          g.dmAgentId
                            ? 'A IA pode levar a conversa para o privado'
                            : 'Escolha antes o agente que atende no privado'
                        }
                        onChange={(v) => void patch(g, { escalationEnabled: v })}
                      />
                      <select
                        className="input"
                        style={{ flex: 1 }}
                        value={g.dmAgentId ?? ''}
                        onChange={(e) => void patch(g, { dmAgentId: e.target.value || null })}
                      >
                        <option value="">— agente do privado —</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{timeAgo(g.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ----------------------------------------------------------- Configurações */

function Settings({ data, onChanged }: { data: Detail; onChanged: () => void }) {
  const [name, setName] = useState(data.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: {
    name?: string;
    aiEnabled?: boolean;
    rhythmEnabled?: boolean;
    activeMinutes?: number;
    pauseMinutes?: number;
    workStartHour?: number;
    workEndHour?: number;
  }) {
    setSaving(true);
    try {
      await api.patchInstance(data.id, patch);
      onChanged();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ErrorBox message={error} />
      <div className="card" style={{ maxWidth: 520 }}>
        <div className="field">
          <label>Nome interno</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div
          className="field"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>IA desta instância</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              Pausa todos os grupos deste número, sem desconectar o WhatsApp.
            </div>
          </div>
          <Toggle checked={data.aiEnabled} onChange={(v) => void save({ aiEnabled: v })} />
        </div>

        <button
          className="btn btn-primary"
          disabled={saving || name === data.name || name.trim().length < 2}
          onClick={() => void save({ name: name.trim() })}
        >
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
      </div>

      {/* --------------------------------------------------- ritmo humano */}
      <div className="card" style={{ maxWidth: 520, marginTop: 16 }}>
        <div style={{ fontWeight: 600 }}>Ritmo humano</div>
        <div style={{ color: 'var(--muted)', fontSize: 13, margin: '4px 0 14px' }}>
          Uma pessoa não fica grudada no WhatsApp. O ritmo vive no número, não no agente:
          quando ela larga o celular, some de todos os grupos ao mesmo tempo.
        </div>

        <div
          className="field"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>Ativar ritmo</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              {data.rhythmEnabled
                ? `Agora: ${data.rhythmState === 'active' ? 'ativo' : 'em pausa'}${
                    data.rhythmUntil ? ` até ${formatDate(data.rhythmUntil)}` : ''
                  }`
                : 'Responde a qualquer hora, sem pausa'}
            </div>
          </div>
          <Toggle
            checked={data.rhythmEnabled}
            onChange={(v) => void save({ rhythmEnabled: v })}
          />
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Fica ativo por (min)</label>
            <input
              className="input"
              type="number"
              min={1}
              max={1440}
              defaultValue={data.activeMinutes}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 1 && v <= 1440 && v !== data.activeMinutes) void save({ activeMinutes: v });
              }}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Descansa por (min)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={1440}
              defaultValue={data.pauseMinutes}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 0 && v <= 1440 && v !== data.pauseMinutes) void save({ pauseMinutes: v });
              }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Começa às (hora)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={23}
              defaultValue={data.workStartHour}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 0 && v <= 23 && v !== data.workStartHour) void save({ workStartHour: v });
              }}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Para às (hora)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={23}
              defaultValue={data.workEndHour}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 0 && v <= 23 && v !== data.workEndHour) void save({ workEndHour: v });
              }}
            />
          </div>
        </div>

        <div style={{ color: 'var(--muted)', fontSize: 12 }}>
          Fuso: {data.timezone}. As durações variam ±30% a cada ciclo, para o ritmo não virar um
          metrônomo.
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------- Logs */

function Logs({ instanceId }: { instanceId: string }) {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [level, setLevel] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setRows(await api.listEvents(instanceId, level || undefined));
    setLoading(false);
  }, [instanceId, level]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <div className="toolbar">
        <select className="input" style={{ maxWidth: 160 }} value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">Todos os níveis</option>
          <option value="info">Info</option>
          <option value="warn">Aviso</option>
          <option value="error">Erro</option>
        </select>
        <button className="btn" onClick={() => void load()}>
          Atualizar
        </button>
      </div>

      {loading ? (
        <div className="empty">Carregando…</div>
      ) : rows.length === 0 ? (
        <div className="empty">Nenhum evento registrado.</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {rows.map((e) => (
            <div key={e.id} className={`log-line ${e.level}`}>
              <span className="lvl">{e.level}</span>
              <span className="ts">{formatDate(e.createdAt)}</span>
              <span>{e.message ?? e.event}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- Conexão */

function Connection({
  data,
  onChanged,
  onOpenQr,
}: {
  data: Detail;
  onChanged: () => void;
  onOpenQr: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [showDelete, setShowDelete] = useState(false);

  async function run(action: string, fn: () => Promise<unknown>) {
    setBusy(action);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <ErrorBox message={error} />

      <div className="card" style={{ marginBottom: 16, maxWidth: 620 }}>
        <Row label="Estado atual" value={data.statusDetail ?? data.status} />
        <Row label="Última conexão" value={formatDate(data.lastConnectedAt)} />

        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void run('reconnect', async () => {
                const res = await api.reconnect(data.id);
                // sessao morta: nao adianta ficar tentando, abre o QR direto
                if (res.needsQr) onOpenQr();
                return res;
              })
            }
          >
            {busy === 'reconnect' ? 'Reconectando…' : 'Reconectar'}
          </button>
          <button className="btn" onClick={onOpenQr}>
            Gerar novo QR Code
          </button>
          <button
            className="btn"
            disabled={busy !== null || data.status !== 'connected'}
            onClick={() => void run('disconnect', () => api.disconnect(data.id))}
          >
            {busy === 'disconnect' ? 'Desconectando…' : 'Desconectar'}
          </button>
        </div>

        {/*
          Reconectar reautentica NA MESMA instancia da Evolution. Quando o que
          quebrou foi o estado de sessao guardado la (tipico depois de um 401),
          escanear por cima nao limpa nada: o numero volta a aparecer como
          conectado e todo envio continua sendo recusado.
        */}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Recriar sessão</div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
            Use quando o número <strong>aparece conectado mas não entrega</strong> — mensagem sai do
            painel e não chega em ninguém. Apaga a instância na Evolution e cria outra do zero, em
            vez de reautenticar por cima da sessão quebrada, que é o que o Reconectar faz.{' '}
            <strong>Grupos, agente, histórico e maturação continuam.</strong> Você só escaneia o QR
            de novo.
          </div>
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void run('reset', async () => {
                const res = await api.resetSession(data.id);
                onOpenQr();
                return res;
              })
            }
          >
            {busy === 'reset' ? 'Recriando…' : 'Recriar sessão e gerar QR novo'}
          </button>
        </div>
      </div>

      {/* Desconectar e Excluir NUNCA sao a mesma operacao. */}
      <div className="card" style={{ maxWidth: 620, borderColor: '#4b2320' }}>
        <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: 6 }}>
          Excluir instância
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
          Remove o número da Evolution API e apaga a sessão do WhatsApp. As configurações de
          conexão são perdidas. O histórico de mensagens e as métricas ficam salvos para consulta.
          <strong> Desconectar não é a mesma coisa</strong> — ele mantém tudo.
        </div>

        {!showDelete ? (
          <button className="btn btn-danger" onClick={() => setShowDelete(true)}>
            Quero excluir esta instância
          </button>
        ) : (
          <>
            <div className="field">
              <label>
                Para confirmar, digite exatamente: <strong>{data.name}</strong>
              </label>
              <input
                className="input"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={data.name}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setShowDelete(false)}>
                Cancelar
              </button>
              <button
                className="btn btn-danger"
                disabled={confirmName !== data.name || busy !== null}
                onClick={() =>
                  void run('delete', async () => {
                    await api.deleteInstance(data.id, confirmName);
                    window.location.hash = '';
                  })
                }
              >
                {busy === 'delete' ? 'Excluindo…' : 'Excluir definitivamente'}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
