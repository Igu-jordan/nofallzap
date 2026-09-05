import { useEffect, useState } from 'react';
import { api, STATUS_LABEL, type InstanceStatus } from '../api';
import { on } from '../socket';
import { ErrorBox } from './Common';

/**
 * Modal de conexao.
 *
 * O QR chega por Socket.IO (evento instance:qr, disparado pelo webhook
 * QRCODE_UPDATED da Evolution). O usuario NUNCA precisa dar F5 — quando o
 * status vira "connected", o modal se fecha sozinho.
 */
export function QrModal({
  instanceId,
  instanceName,
  onClose,
  onConnected,
}: {
  instanceId: string;
  instanceName: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<InstanceStatus>('awaiting_qr');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [age, setAge] = useState(0);

  // estado inicial
  useEffect(() => {
    api
      .getQr(instanceId)
      .then((res) => {
        if (res.connected) {
          setStatus('connected');
          onConnected();
          return;
        }
        setQr(res.base64);
        if (res.status) setStatus(res.status as InstanceStatus);
      })
      .catch((e) => setError((e as Error).message));
  }, [instanceId]);

  // eventos em tempo real
  useEffect(() => {
    const offQr = on<{ instanceId: string; base64: string }>('instance:qr', (p) => {
      if (p.instanceId !== instanceId) return;
      setQr(p.base64);
      setStatus('awaiting_qr');
      setAge(0);
    });

    const offStatus = on<{ instanceId: string; status: InstanceStatus }>(
      'instance:status',
      (p) => {
        if (p.instanceId !== instanceId) return;
        setStatus(p.status);
        if (p.status === 'connected') {
          setQr(null);
          onConnected();
          setTimeout(onClose, 1600);
        }
      },
    );

    return () => {
      offQr();
      offStatus();
    };
  }, [instanceId, onClose, onConnected]);

  // contador de "idade" do QR — a Evolution rotaciona sozinha e reemite
  useEffect(() => {
    const t = setInterval(() => setAge((a) => a + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await api.refreshQr(instanceId);
      if (res.base64) {
        setQr(res.base64);
        setAge(0);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  const connected = status === 'connected';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{instanceName}</h2>
        <p className="hint">
          {connected
            ? 'Conectado. Buscando perfil e grupos…'
            : 'Abra o WhatsApp no celular → Aparelhos conectados → Conectar aparelho.'}
        </p>

        <ErrorBox message={error} />

        <div className="qr-frame">
          {connected ? (
            <div style={{ color: '#1a9c4b', fontWeight: 700, fontSize: 15 }}>
              ✓ WhatsApp conectado
            </div>
          ) : qr ? (
            <img src={qr} alt="QR Code" />
          ) : (
            <div style={{ color: '#666' }}>Gerando QR Code…</div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span className={`badge ${status}`}>
            <span className="dot" />
            {STATUS_LABEL[status]}
          </span>
          {!connected && qr && (
            <span style={{ color: 'var(--muted)' }}>QR gerado há {age}s</span>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {connected ? 'Fechar' : 'Cancelar'}
          </button>
          {!connected && (
            <button className="btn btn-primary" onClick={refresh} disabled={refreshing}>
              {refreshing ? 'Gerando…' : 'Atualizar QR Code'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
