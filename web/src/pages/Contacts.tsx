import { useEffect, useRef, useState, useCallback } from 'react';
import { api, timeAgo, formatDate, type ContactRow, type ContactDetail } from '../api';
import { Toggle, ErrorBox } from '../components/Common';
import { IconeHistorico } from '../components/Icons';

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
                    <div className="card-acoes-linha">
                      {/* O nome ja abria a conversa, mas ninguem descobria: um
                          sublinhado discreto nao parece botao. */}
                      <button
                        className="btn btn-sm"
                        disabled={r.messageCount === 0}
                        title={
                          r.messageCount === 0
                            ? 'Nenhuma mensagem trocada ainda'
                            : 'Ver as mensagens trocadas'
                        }
                        onClick={() => void openContact(r.id)}
                      >
                        <IconeHistorico size={15} />
                        Histórico
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => void remove(r)}>
                        Apagar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <HistoricoModal contato={open} onFechar={() => setOpen(null)} />}
    </>
  );
}

/// o backend devolve as ultimas 100; acima disso o aviso aparece
const TETO_TRANSCRICAO = 100;

/**
 * HISTORICO DA CONVERSA.
 *
 * Abre já no fim, como qualquer aplicativo de mensagem: o que interessa é a
 * última coisa que foi dita, não a primeira.
 */
function HistoricoModal({
  contato,
  onFechar,
}: {
  contato: ContactDetail;
  onFechar: () => void;
}) {
  const fim = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fim.current?.scrollIntoView({ block: 'end' });
  }, [contato.id]);

  const daIa = contato.messages.filter((m) => m.isFromAi).length;

  return (
    <div className="overlay" onClick={onFechar}>
      <div className="modal modal-largo" onClick={(e) => e.stopPropagation()}>
        <div className="card-head historico-topo">
          <div className="card-identidade">
            <div className="historico-nome">{contato.pushName ?? contato.phoneNumber}</div>
            <div className="card-sub">
              +{contato.phoneNumber}
              {contato.originGroup
                ? ` · veio do grupo ${contato.originGroup.subject ?? ''}`
                : ' · chamou direto'}
            </div>
          </div>
          <button className="btn btn-sm" onClick={onFechar}>
            Fechar
          </button>
        </div>

        {contato.messages.length > 0 && (
          <div className="historico-resumo">
            {contato.messages.length}{' '}
            {contato.messages.length === 1 ? 'mensagem' : 'mensagens'} · {daIa} da IA
            {contato.messages.length >= TETO_TRANSCRICAO && ' · mostrando as mais recentes'}
          </div>
        )}

        <div className="transcript">
          {contato.messages.length === 0 ? (
            <div className="empty">Nenhuma mensagem trocada ainda.</div>
          ) : (
            <>
              {contato.messages.map((m) => (
                <div key={m.id} className={`bubble ${m.isFromAi ? 'mine' : ''}`}>
                  <div className="bubble-texto">{m.content || <i>(sem texto)</i>}</div>
                  <div className="bubble-time">
                    {m.isFromAi ? 'IA · ' : ''}
                    {formatDate(m.createdAt)}
                  </div>
                </div>
              ))}
              <div ref={fim} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
