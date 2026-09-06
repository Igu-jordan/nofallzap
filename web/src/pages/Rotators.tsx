import { useEffect, useState, useCallback } from 'react';
import { api, timeAgo, type RotatorRow, type RotatorDetail } from '../api';
import { Toggle, ErrorBox } from '../components/Common';

/**
 * RODÍZIO DE LINK.
 *
 * Um link só no anúncio, vários WhatsApp atendendo. O link mora num serviço
 * separado, sem senha — por isso o endereço não é o mesmo do painel.
 */

/// De onde sai o link público. Fica no serviço "link", que não tem senha.
const LINK_BASE =
  (import.meta.env.VITE_LINK_BASE as string | undefined)?.replace(/\/$/, '') ||
  window.location.origin.replace('-api.', '-link.');

export function Rotators({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<RotatorRow[]>([]);
  const [open, setOpen] = useState<RotatorDetail | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.listRotators());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function criar() {
    if (name.trim().length < 2) return;
    try {
      const r = await api.createRotator({ name: name.trim() });
      setName('');
      await load();
      await abrir(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function abrir(id: string) {
    try {
      setOpen(await api.getRotator(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) return <div className="empty">Carregando rodízios…</div>;

  return (
    <>
      <button className="crumb" onClick={onBack}>
        ← Todas as instâncias
      </button>

      <div className="toolbar">
        <div style={{ fontSize: 20, fontWeight: 700 }}>Rodízio de link</div>
      </div>

      <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16, maxWidth: 760 }}>
        Um link só para usar no anúncio. A cada clique ele manda o lead para um número diferente
        da lista. Número que caiu, que não está entregando ou que bateu o teto do dia sai da
        rotação sozinho — e volta quando normalizar.
      </div>

      <ErrorBox message={error} />

      <div className="toolbar">
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder="Nome do rodízio (ex: Campanha Setembro)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void criar()}
        />
        <button className="btn btn-primary" onClick={() => void criar()}>
          Criar rodízio
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="empty">Nenhum rodízio ainda. Crie o primeiro acima.</div>
      ) : (
        <div className="grid">
          {rows.map((r) => (
            <div key={r.id} className="card">
              <div className="card-head">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="card-title">{r.name}</div>
                  <div className="card-sub">
                    {r.strategy === 'sequential' ? 'sequencial' : 'aleatório'} ·{' '}
                    {r.totalDestinations} números
                    {r.outOfRotation > 0 && (
                      <span style={{ color: 'var(--danger)' }}>
                        {' '}
                        · {r.outOfRotation} fora
                      </span>
                    )}
                  </div>
                </div>
                <Toggle
                  checked={r.isActive}
                  onChange={(v) =>
                    void api.patchRotator(r.id, { isActive: v }).then(load).catch(() => undefined)
                  }
                />
              </div>

              <div
                className="jid"
                style={{
                  background: 'var(--bg)',
                  padding: '8px 10px',
                  borderRadius: 8,
                  margin: '10px 0',
                  wordBreak: 'break-all',
                }}
              >
                {LINK_BASE}/r/{r.slug}
              </div>

              <div className="stats">
                <div>
                  <div className="stat-num">{r.clicksToday}</div>
                  <div className="stat-label">cliques hoje</div>
                </div>
                <div>
                  <div className="stat-num">{r.clicksTotal}</div>
                  <div className="stat-label">no total</div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      void navigator.clipboard
                        ?.writeText(`${LINK_BASE}/r/${r.slug}`)
                        .catch(() => undefined)
                    }
                  >
                    Copiar link
                  </button>
                  <button className="btn btn-sm" onClick={() => void abrir(r.id)}>
                    Números
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <RotatorModal
          data={open}
          onClose={() => setOpen(null)}
          onChanged={async () => {
            await load();
            await abrir(open.id);
          }}
        />
      )}
    </>
  );
}

function RotatorModal({
  data,
  onClose,
  onChanged,
}: {
  data: RotatorDetail;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [numbers, setNumbers] = useState('');
  const [dailyCap, setDailyCap] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function adicionar() {
    if (!numbers.trim()) return;
    setBusy(true);
    try {
      const res = await api.addDestinations(data.id, { numbers, dailyCap });
      setNumbers('');
      if (res.invalidos.length) {
        setError(`Ignorei ${res.invalidos.length} linha(s) que não são número: ${res.invalidos.join(', ')}`);
      } else {
        setError(null);
      }
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head" style={{ marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <h2>{data.name}</h2>
            <p className="hint" style={{ margin: 0 }}>
              {LINK_BASE}/r/{data.slug}
            </p>
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            Fechar
          </button>
        </div>

        <ErrorBox message={error} />

        <div className="field">
          <label>Cole os números, um por linha</label>
          <textarea
            className="input"
            rows={4}
            placeholder={'11 99999-9999\n+55 11 98888-8888\n5511977777777'}
            value={numbers}
            onChange={(e) => setNumbers(e.target.value)}
          />
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
            Pode colar com máscara. Sem DDI, assumo 55.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
          <div className="field" style={{ marginBottom: 0, maxWidth: 180 }}>
            <label>Teto por dia (0 = sem limite)</label>
            <input
              className="input"
              type="number"
              min={0}
              value={dailyCap}
              onChange={(e) => setDailyCap(Number(e.target.value) || 0)}
            />
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={() => void adicionar()}>
            {busy ? 'Adicionando…' : 'Adicionar à lista'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <span style={{ color: 'var(--muted)' }}>Ordem:</span>
            <select
              className="input"
              style={{ width: 'auto' }}
              value={data.strategy}
              onChange={(e) =>
                void api
                  .patchRotator(data.id, { strategy: e.target.value })
                  .then(onChanged)
                  .catch(() => undefined)
              }
            >
              <option value="sequential">Sequencial (distribui igual)</option>
              <option value="random">Aleatório (sorteia)</option>
            </select>
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <Toggle
              checked={data.skipUnhealthy}
              onChange={(v) =>
                void api
                  .patchRotator(data.id, { skipUnhealthy: v })
                  .then(onChanged)
                  .catch(() => undefined)
              }
            />
            <span style={{ color: 'var(--muted)' }}>Pular número caído / que não entrega</span>
          </label>
        </div>

        {data.destinations.length === 0 ? (
          <div className="empty">Nenhum número na lista ainda.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Ativo</th>
                  <th>Número</th>
                  <th style={{ width: 90 }}>Hoje</th>
                  <th style={{ width: 90 }}>Total</th>
                  <th>Situação</th>
                  <th style={{ width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {data.destinations.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Toggle
                        checked={d.isActive}
                        onChange={(v) =>
                          void api
                            .patchDestination(d.id, { isActive: v })
                            .then(onChanged)
                            .catch(() => undefined)
                        }
                      />
                    </td>
                    <td>
                      <div>+{d.phoneNumber}</div>
                      {d.label && <div className="card-sub">{d.label}</div>}
                    </td>
                    <td>
                      {d.clicksToday}
                      {d.dailyCap > 0 && (
                        <span style={{ color: 'var(--muted)' }}> / {d.dailyCap}</span>
                      )}
                    </td>
                    <td>{d.clicksTotal}</td>
                    <td style={{ fontSize: 13 }}>
                      {d.outLabel ? (
                        <span style={{ color: 'var(--danger)' }}>fora — {d.outLabel}</span>
                      ) : (
                        <span style={{ color: 'var(--accent)' }}>na rotação</span>
                      )}
                      <div className="card-sub">
                        {d.instance
                          ? `instância ${d.instance.name}`
                          : 'número solto — o painel não vê se caiu'}
                        {d.lastClickAt ? ` · ${timeAgo(d.lastClickAt)}` : ''}
                      </div>
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() =>
                          void api.deleteDestination(d.id).then(onChanged).catch(() => undefined)
                        }
                      >
                        Tirar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
