import { useEffect, useState } from 'react';
import { api } from './api';
import { on } from './socket';
import { Instances } from './pages/Instances';
import { InstanceDetail } from './pages/InstanceDetail';
import { Agents } from './pages/Agents';
import { Warmup } from './pages/Warmup';
import { Rotators } from './pages/Rotators';
import { Sidebar } from './components/Sidebar';
import { IconeMenu } from './components/Icons';

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1));
  const [aiEnabled, setAiEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  /// só tem efeito no celular, onde a sidebar vira gaveta
  const [menuAberto, setMenuAberto] = useState(false);

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

  function navegar(hash: string) {
    window.location.hash = hash;
    setMenuAberto(false);
  }

  const instanceId = route.startsWith('/instance/') ? route.replace('/instance/', '') : null;

  return (
    <div className="app-shell">
      {/* Arte de fundo da marca. Fica atrás de tudo e não captura clique. */}
      <div className="fundo-decorativo" aria-hidden="true" />

      <Sidebar rota={route} aberta={menuAberto} onNavegar={navegar} />
      <div
        className={`sidebar-veu ${menuAberto ? 'visivel' : ''}`}
        onClick={() => setMenuAberto(false)}
      />

      <main className="app-main">
        <div className="app-conteudo">
          {/* Faixa de topo: o hambúrguer só aparece no celular, e o botão de
              emergência fica sempre no mesmo canto, em qualquer tela. */}
          <div className="app-barra">
            <button
              className="hamburger"
              onClick={() => setMenuAberto(true)}
              aria-label="Abrir menu"
            >
              <IconeMenu />
            </button>
            <div className="spacer" />
            <button
              className={`kill-switch ${aiEnabled ? '' : 'paused'}`}
              onClick={() => void toggleGlobalAi()}
              disabled={busy}
            >
              {aiEnabled ? 'PAUSAR TODAS AS IAs' : 'IAs PAUSADAS — retomar'}
            </button>
          </div>

          {!aiEnabled && (
            <div className="banner">
              Pausa global ativa. Nenhuma resposta automática está sendo enviada por nenhum número.
            </div>
          )}

          {route === '/agentes' ? (
            <Agents onBack={() => navegar('')} />
          ) : route === '/maturacao' ? (
            <Warmup onBack={() => navegar('')} />
          ) : route === '/rodizio' ? (
            <Rotators onBack={() => navegar('')} />
          ) : instanceId ? (
            <InstanceDetail id={instanceId} onBack={() => navegar('')} />
          ) : (
            <Instances onOpen={(id) => navegar(`/instance/${id}`)} />
          )}
        </div>
      </main>
    </div>
  );
}
