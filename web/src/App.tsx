import { useEffect, useState } from 'react';
import { api } from './api';
import { on } from './socket';
import { Instances } from './pages/Instances';
import { InstanceDetail } from './pages/InstanceDetail';
import { Agents } from './pages/Agents';
import { Warmup } from './pages/Warmup';

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1));
  const [aiEnabled, setAiEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = () => setRoute(window.location.hash.slice(1));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  useEffect(() => {
    api
      .settings()
      .then((s) => setAiEnabled(s.aiGloballyEnabled))
      .catch(() => undefined);
    return on<{ enabled: boolean }>('system:ai', (p) => setAiEnabled(p.enabled));
  }, []);

  /**
   * BOTAO DE EMERGENCIA (nivel global).
   * Nao desconecta nenhum WhatsApp — apenas impede novos envios automaticos.
   */
  async function toggleGlobalAi() {
    if (aiEnabled && !confirm('Pausar TODAS as IAs?\n\nOs WhatsApps continuam conectados, mas nenhuma resposta automática será enviada.')) {
      return;
    }
    setBusy(true);
    try {
      const res = await api.setGlobalAi(!aiEnabled);
      setAiEnabled(res.aiGloballyEnabled);
    } finally {
      setBusy(false);
    }
  }

  const instanceId = route.startsWith('/instance/') ? route.replace('/instance/', '') : null;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          No<span>Fall</span>Zap
        </div>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>Painel multi-instância</span>
        <button
          className="btn btn-sm"
          style={{ marginLeft: 8 }}
          onClick={() => (window.location.hash = '/agentes')}
        >
          Agentes
        </button>
        <button
          className="btn btn-sm"
          style={{ marginLeft: 4 }}
          onClick={() => (window.location.hash = '/maturacao')}
        >
          Maturação
        </button>
        <div className="spacer" />
        <button
          className={`kill-switch ${aiEnabled ? '' : 'paused'}`}
          onClick={() => void toggleGlobalAi()}
          disabled={busy}
        >
          {aiEnabled ? 'PAUSAR TODAS AS IAs' : 'IAs PAUSADAS — retomar'}
        </button>
      </header>

      <main className="container">
        {!aiEnabled && (
          <div className="banner">
            Pausa global ativa. Nenhuma resposta automática está sendo enviada por nenhum número.
          </div>
        )}

        {route === '/agentes' ? (
          <Agents onBack={() => (window.location.hash = '')} />
        ) : route === '/maturacao' ? (
          <Warmup onBack={() => (window.location.hash = '')} />
        ) : instanceId ? (
          <InstanceDetail id={instanceId} onBack={() => (window.location.hash = '')} />
        ) : (
          <Instances onOpen={(id) => (window.location.hash = `/instance/${id}`)} />
        )}
      </main>
    </>
  );
}
