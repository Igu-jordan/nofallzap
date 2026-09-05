import { useEffect, useState, useCallback } from 'react';
import { api, timeAgo, formatDate, type InstanceSummary, type InstanceStatus } from '../api';
import { on } from '../socket';
import { StatusBadge, Avatar, ErrorBox } from '../components/Common';
import { QrModal } from '../components/QrModal';

export function Instances({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<InstanceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [qrFor, setQrFor] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.listInstances());
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

  // A tela se atualiza sozinha: status, grupos e remocoes chegam por socket.
  useEffect(() => {
    const offStatus = on<{ instanceId: string; status: InstanceStatus }>(
      'instance:status',
      (p) => {
        setItems((prev) =>
          prev.map((i) => (i.id === p.instanceId ? { ...i, ...p, status: p.status } : i)),
        );
        if (p.status === 'connected') setTimeout(() => void load(), 2500);
      },
    );
    const offGroups = on('instance:groups', () => void load());
    const offRemoved = on<{ instanceId: string }>('instance:removed', (p) =>
      setItems((prev) => prev.filter((i) => i.id !== p.instanceId)),
    );
    return () => {
      offStatus();
      offGroups();
      offRemoved();
    };
  }, [load]);

  async function create() {
    if (newName.trim().length < 2) return;
    setCreating(true);
    setError(null);
    try {
      const instance = await api.createInstance(newName.trim());
      setNewName('');
      await load();
      setQrFor({ id: instance.id, name: instance.name });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="empty">Carregando instâncias…</div>;

  return (
    <>
      <ErrorBox message={error} />

      <div className="toolbar">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          placeholder="Nome interno (ex: WhatsApp Suporte)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />
        <button
          className="btn btn-primary"
          onClick={() => void create()}
          disabled={creating || newName.trim().length < 2}
        >
          {creating ? 'Criando…' : '+ Adicionar WhatsApp'}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          Nenhum WhatsApp conectado ainda.
          <br />
          Dê um nome interno acima e clique em Adicionar.
        </div>
      ) : (
        <div className="grid">
          {items.map((i) => (
            <div key={i.id} className="card clickable" onClick={() => onOpen(i.id)}>
              <div className="card-head">
                <Avatar url={i.profilePicUrl} name={i.name} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="card-title">{i.name}</div>
                  <div className="card-sub">{i.phoneNumber ? `+${i.phoneNumber}` : 'sem número'}</div>
                </div>
                <StatusBadge status={i.status} />
              </div>

              <div className="stats">
                <div>
                  <div className="stat-num">{i.groupsCount}</div>
                  <div className="stat-label">grupos</div>
                </div>
                <div>
                  <div className="stat-num" style={{ color: i.groupsWithAi ? 'var(--accent)' : undefined }}>
                    {i.groupsWithAi}
                  </div>
                  <div className="stat-label">com IA</div>
                </div>
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div className="stat-num" style={{ fontSize: 13, fontWeight: 500 }}>
                    {timeAgo(i.lastActivityAt)}
                  </div>
                  <div className="stat-label">última atividade</div>
                </div>
              </div>

              <div className="meta">
                <span>criada em {formatDate(i.createdAt)}</span>
                {(i.status === 'awaiting_qr' ||
                  i.status === 'disconnected' ||
                  i.status === 'error') && (
                  <button
                    className="btn btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setQrFor({ id: i.id, name: i.name });
                    }}
                  >
                    Conectar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {qrFor && (
        <QrModal
          instanceId={qrFor.id}
          instanceName={qrFor.name}
          onClose={() => setQrFor(null)}
          onConnected={() => void load()}
        />
      )}
    </>
  );
}
