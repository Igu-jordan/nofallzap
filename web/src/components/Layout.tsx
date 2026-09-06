import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconeBusca, IconeTresPontos } from './Icons';

/**
 * PEÇAS DE LAYOUT reaproveitadas por todas as telas.
 */

/** Título + subtítulo + ações à direita. */
export function PageHeader({
  titulo,
  subtitulo,
  acoes,
}: {
  titulo: string;
  subtitulo?: string;
  acoes?: ReactNode;
}) {
  return (
    <div className="pagina-topo">
      <div className="pagina-topo-texto">
        <h1 className="pagina-titulo">{titulo}</h1>
        {subtitulo && <p className="pagina-sub">{subtitulo}</p>}
      </div>
      {acoes && <div className="acoes">{acoes}</div>}
    </div>
  );
}

/**
 * Busca. Filtra o que já está na tela — não chama a API.
 *
 * Feito de propósito assim: a lista de números já vem inteira do backend e
 * cabe na memória. Criar rota de busca no servidor seria trabalho e latência
 * para resolver um problema que não existe neste tamanho.
 */
export function SearchBar({
  valor,
  onChange,
  placeholder,
}: {
  valor: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="busca">
      <IconeBusca size={18} />
      <input
        type="search"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Buscar número, nome ou status...'}
        aria-label={placeholder ?? 'Buscar'}
      />
    </div>
  );
}

export type OpcaoMenu = {
  rotulo: string;
  icone?: ReactNode;
  onClick: () => void;
};

/** Menu de três pontos. Fecha ao clicar fora ou apertar Esc. */
export function DropdownMenu({ opcoes, rotulo }: { opcoes: OpcaoMenu[]; rotulo?: string }) {
  const [aberto, setAberto] = useState(false);
  const alvo = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;
    function fora(e: MouseEvent) {
      if (alvo.current && !alvo.current.contains(e.target as Node)) setAberto(false);
    }
    function esc(e: KeyboardEvent) {
      if (e.key === 'Escape') setAberto(false);
    }
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [aberto]);

  if (opcoes.length === 0) return null;

  return (
    <div className="menu-alvo" ref={alvo} onClick={(e) => e.stopPropagation()}>
      <button
        className={`menu-botao ${aberto ? 'aberto' : ''}`}
        onClick={() => setAberto((v) => !v)}
        aria-label={rotulo ?? 'Mais ações'}
        aria-expanded={aberto}
      >
        <IconeTresPontos size={18} />
      </button>
      {aberto && (
        <div className="menu-lista" role="menu">
          {opcoes.map((o) => (
            <button
              key={o.rotulo}
              role="menuitem"
              onClick={() => {
                setAberto(false);
                o.onClick();
              }}
            >
              {o.icone}
              {o.rotulo}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Uma métrica do card: ícone + valor + rótulo. */
export function MetricItem({
  icone,
  valor,
  label,
  neutro,
}: {
  icone: ReactNode;
  valor: ReactNode;
  label: string;
  neutro?: boolean;
}) {
  return (
    <div className="metrica">
      <div className={`metrica-topo ${neutro ? 'neutra' : ''}`}>{icone}</div>
      <div className="metrica-valor">{valor}</div>
      <div className="metrica-label">{label}</div>
    </div>
  );
}
