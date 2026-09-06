import { useEffect, useState } from 'react';
import { api } from './api';
import { on } from './socket';
import { Instances } from './pages/Instances';
import { InstanceDetail } from './pages/InstanceDetail';
import { Agents } from './pages/Agents';
import { Warmup } from './pages/Warmup';
import { Rotators } from './pages/Rotators';
import { Login } from './pages/Login';
import { Sidebar } from './components/Sidebar';
import { IconeMenu } from './components/Icons';
import { resetSocket } from './socket';

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1));
  const [aiEnabled, setAiEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  /// só tem efeito no celular, onde a sidebar vira gaveta
  const [menuAberto, setMenuAberto] = useState(false);
  /**
   * null = ainda perguntando ao servidor quem está logado.
   *
   * Esse terceiro estado existe para a tela não piscar o login por um
   * instante antes de descobrir que a sessão era válida.
   */
  const [usuario, setUsuario] = useState<string | null | undefined>(null);

  useEffect(() => {
    const handler = () => setRoute(window.location.hash.slice(1));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  // Quem está logado. Enquanto não responde, a tela fica em branco.
  useEffect(() => {
    api
      .me()
      .then((r) => setUsuario(r.usuario ?? undefined))
      .catch(() => setUsuario(undefined));
  }, []);

  useEffect(() => {
    if (!usuario) return;
    api
      .settings()
      .then((s) => setAiEnabled(s.aiGloballyEnabled))
      .catch(() => undefined);
    return on<{ enabled: boolean }>('system:ai', (p) => setAiEnabled(p.enabled));
  }, [usuario]);

  async function sair() {
    try {
      await api.logout();
    } finally {
      // Derruba o socket junto: sem isso ele seguiria recebendo eventos com
      // a sessão já encerrada, até o próximo F5.
      resetSocket();
      setUsuario(undefined);
      window.location.hash = '';
    }
  }

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

  if (usuario === null) return <div className="carregando-sessao" />;

  if (usuario === undefined) {
    return (
      <Login
        onEntrou={(u) => {
          // O socket foi recusado enquanto não havia sessão; reconecta agora
          // para a tela voltar a se atualizar sozinha.
          resetSocket();
          setUsuario(u);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      {/* Arte de fundo da marca. Fica atrás de tudo e não captura clique. */}
      <div className="fundo-decorativo" aria-hidden="true" />

      <Sidebar rota={route} aberta={menuAberto} onNavegar={navegar} usuario={usuario} onSair={() => void sair()} />
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
