import { useEffect, useState, useCallback } from 'react';
import { api, timeAgo, formatDate, type ContactRow, type ContactDetail } from '../api';
import { Toggle, ErrorBox } from '../components/Common';

/**
 * CONVERSAS PRIVADAS.
 *
 * Aqui aparecem as pessoas que saíram de um grupo para o privado e as que
 * chamaram o número por conta própria. O que a tela precisa responder de
 * relance: de onde essa pessoa veio, o que já foi dito, e a IA está falando?
 */
export function Contacts({ instanceId }: { instanceId: string }) {
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [open, setOpen] = useState<ContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.listContacts(instanceId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleAi(row: ContactRow, on: boolean) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, aiEnabled: on } : r)));
    try {
      await api.patchContact(row.id, { aiEnabled: on });
    } catch (e) {
      setError((e as Error).message);
      await load();
    }
  }

  async function openContact(id: string) {
    try {
      setOpen(await api.getContact(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(row: ContactRow) {
    const ok = window.confirm(
      `Apagar ${row.pushName ?? row.phoneNumber} e todo o histórico de conversa?\n\n` +
        'Isso apaga os dados dessa pessoa do painel de forma definitiva. ' +
        'A conversa no WhatsApp continua no aparelho.',
    );
    if (!ok) return;
    try {
      await api.deleteContact(row.id);
      setOpen(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) return <div className="empty">Carregando conversas…</div>;

  return (
    <>
      <ErrorBox message={error} />

      {rows.length === 0 ? (
        <div className="empty">
          Nenhuma conversa privada ainda. Ligue &quot;chamar no privado&quot; em algum grupo, ou
          espere alguém chamar este número direto.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>IA</th>
                <th>Pessoa</th>
                <th>Veio de</th>
                <th>Agente</th>
                <th>Mensagens</th>
                <th>Última</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Toggle checked={r.aiEnabled} onChange={(v) => void toggleAi(r, v)} />
                  </td>
                  <td>
                    <button className="linklike" onClick={() => void openContact(r.id)}>
                      {r.pushName ?? '(sem nome)'}
                    </button>
                    <div className="card-sub">+{r.phoneNumber}</div>
                  </td>
                  <td>
                    {r.originGroup ? (
                      <>
                        <div>{r.originGroup.subject ?? 'grupo sem nome'}</div>
                        <div className="card-sub">escalonado</div>
                      </>
                    ) : (
                      <span className="card-sub">chamou direto</span>
                    )}
                  </td>
                  <td>{r.agent?.name ?? <span className="card-sub">nenhum</span>}</td>
                  <td>{r.messageCount}</td>
                  <td className="card-sub">{r.lastActivityAt ? timeAgo(r.lastActivityAt) : '—'}</td>
                  <td>
                    <button className="btn btn-sm btn-danger" onClick={() => void remove(r)}>
                      Apagar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-head" style={{ marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{open.pushName ?? open.phoneNumber}</div>
                <div className="card-sub">
                  +{open.phoneNumber}
                  {open.originGroup
                    ? ` · veio do grupo ${open.originGroup.subject ?? ''}`
                    : ' · chamou direto'}
                </div>
              </div>
              <button className="btn btn-sm" onClick={() => setOpen(null)}>
                Fechar
              </button>
            </div>

            <div className="transcript">
              {open.messages.length === 0 ? (
                <div className="empty">Sem mensagens.</div>
              ) : (
                open.messages.map((m) => (
                  <div key={m.id} className={`bubble ${m.isFromAi ? 'mine' : ''}`}>
                    <div>{m.content}</div>
                    <div className="bubble-time">
                      {m.isFromAi ? 'IA · ' : ''}
                      {formatDate(m.createdAt)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
