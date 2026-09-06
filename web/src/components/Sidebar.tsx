import type { ReactNode } from 'react';
import {
  IconeAgentes,
  IconeCelular,
  IconeChama,
  IconeRodizio,
} from './Icons';

/**
 * SIDEBAR.
 *
 * A navegação continua sendo a mesma de antes — troca o hash da URL, e o
 * App decide o que renderizar. Só o formato mudou: era uma fileira de
 * botões no topo, virou uma coluna fixa.
 *
 * O menu lista SOMENTE as telas que existem. "Relatórios" e "Configurações"
 * ficaram de fora de propósito: colocar um item que abre o nada é pior do
 * que não ter o item.
 */

export type ItemMenu = {
  hash: string;
  rotulo: string;
  icone: ReactNode;
  /// prefixos de rota que também acendem este item
  casaCom?: (rota: string) => boolean;
};

export const ITENS_MENU: ItemMenu[] = [
  {
    hash: '',
    rotulo: 'Números',
    icone: <IconeCelular />,
    // o detalhe de uma instância continua sendo "Números"
    casaCom: (r) => r === '' || r === '/' || r.startsWith('/instance/'),
  },
  { hash: '/agentes', rotulo: 'Agentes', icone: <IconeAgentes /> },
  { hash: '/maturacao', rotulo: 'Maturação', icone: <IconeChama /> },
  { hash: '/rodizio', rotulo: 'Rodízio de link', icone: <IconeRodizio /> },
];

export function Sidebar({
  rota,
  aberta,
  onNavegar,
}: {
  rota: string;
  aberta: boolean;
  onNavegar: (hash: string) => void;
}) {
  return (
    <aside className={`sidebar ${aberta ? 'aberta' : ''}`}>
      {/* O símbolo vem do SVG oficial; o nome é texto de verdade. A logo
          completa traz "PAINEL MULTI-INSTÂNCIA" desenhado tão pequeno que
          numa sidebar de 280px vira borrão — em texto ele fica legível e
          acompanha o tamanho da fonte do sistema. */}
      <a
        className="sidebar-marca"
        href="#/"
        onClick={() => onNavegar('')}
        aria-label="NoFallZap — início"
      >
        <img src="/assets/branding/nofallzap-symbol.svg" alt="" />
        <div className="marca-texto">
          <div className="marca-nome">
            NoFall<span>Zap</span>
          </div>
          <div className="marca-sub">Painel multi-instância</div>
        </div>
      </a>

      <nav className="sidebar-nav">
        {ITENS_MENU.map((item) => {
          const ativo = item.casaCom ? item.casaCom(rota) : rota === item.hash;
          return (
            <button
              key={item.hash || 'home'}
              className={`nav-item ${ativo ? 'ativo' : ''}`}
              onClick={() => onNavegar(item.hash)}
              title={item.rotulo}
              aria-current={ativo ? 'page' : undefined}
            >
              {item.icone}
              <span className="rotulo">{item.rotulo}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-rodape">NoFallZap · painel multi-instância</div>
    </aside>
  );
}
