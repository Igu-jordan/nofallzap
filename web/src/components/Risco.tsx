import { useState } from 'react';
import {
  ACOES_RISCO,
  NIVEL_RISCO_LABEL,
  formatDate,
  type AcaoRisco,
  type NivelRisco,
  type RiskSignals,
} from '../api';
import { IconeAlerta, IconeCheck, IconeEscudo, IconeRelogio } from './Icons';

/**
 * PEÇAS DO ALERTA DE QUALIDADE.
 *
 * A frase da nota aparece em todo lugar de propósito: esta medição é DO
 * PAINEL, feita com os dados que ele já tem. O WhatsApp não publica nota de
 * qualidade para este tipo de conexão — o semáforo oficial é da Cloud API
 * paga, outro produto. Se um dia alguém quiser encurtar o texto da tela,
 * essa é a parte que não pode sair.
 */

const ICONE_NIVEL: Record<NivelRisco, typeof IconeCheck> = {
  ok: IconeCheck,
  atencao: IconeAlerta,
  risco: IconeAlerta,
};

/** Selo verde/amarelo/vermelho. Vai no card do número e no cabeçalho. */
export function SeloRisco({
  nivel,
  nota,
  compacto,
  titulo,
}: {
  nivel: NivelRisco;
  nota: number;
  compacto?: boolean;
  titulo?: string;
}) {
  const Icone = ICONE_NIVEL[nivel];
  return (
    <span
      className={`selo-risco ${nivel} ${compacto ? 'compacto' : ''}`}
      title={titulo ?? 'Qualidade medida pelo painel'}
    >
      <Icone size={compacto ? 13 : 15} />
      {NIVEL_RISCO_LABEL[nivel]}
      <span className="selo-risco-nota">{nota}</span>
    </span>
  );
}

/** Lista dos motivos, do jeito que o servidor escreveu. */
export function MotivosRisco({ motivos, nivel }: { motivos: string[]; nivel: NivelRisco }) {
  if (motivos.length === 0) return null;
  return (
    <ul className={`motivos-risco ${nivel}`}>
      {motivos.map((m, idx) => (
        <li key={idx}>{m}</li>
      ))}
    </ul>
  );
}

/**
 * Escolha do modo.
 *
 * `padrao` só é passado no seletor de um número: lá existe a opção "seguir o
 * padrão do painel", que no seletor global não faria sentido.
 */
export function SeletorAcao({
  valor,
  onChange,
  padrao,
  disabled,
  id,
}: {
  valor: AcaoRisco | null;
  onChange: (v: AcaoRisco | null) => void;
  padrao?: AcaoRisco;
  disabled?: boolean;
  id?: string;
}) {
  const atual = ACOES_RISCO.find((a) => a.value === (valor ?? padrao));
  return (
    <div className="seletor-acao">
      <select
        id={id}
        className="input"
        value={valor ?? (padrao ? '' : 'avisar')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? (e.target.value as AcaoRisco) : null)}
      >
        {padrao && <option value="">Seguir o padrão do painel</option>}
        {ACOES_RISCO.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>
      {atual && <div className="dica-campo">{atual.desc}</div>}
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Os números crus que geraram a nota. Sem isto o selo vira adivinhação. */
export function SinaisRiscoTabela({ s }: { s: RiskSignals }) {
  const linhas: Array<[string, string]> = [
    ['Mensagens enviadas (24h)', `${s.enviadas24h} de um teto confortável de ${s.tetoSeguroDia}`],
    [
      'Entregas recusadas (24h)',
      s.recusadas24h === 0
        ? 'nenhuma'
        : `${s.recusadas24h}${s.enviadas24h > 0 ? ` (${pct(s.taxaRecusa)} do que saiu)` : ''}`,
    ],
    [
      'Conversas que este número começou (7 dias)',
      s.conversasIniciadas7d === 0 ? 'nenhuma' : String(s.conversasIniciadas7d),
    ],
    [
      'Dessas, quantas responderam',
      s.taxaResposta === null
        ? 'poucas conversas para medir'
        : `${s.conversasRespondidas7d} (${pct(s.taxaResposta)})`,
    ],
    [
      'Conversas novas (24h)',
      `${s.conversasIniciadas24h} de até ${s.tetoConversasNovas} sem chamar atenção`,
    ],
    ['Idade do número no painel', `${s.diasDeChip} ${s.diasDeChip === 1 ? 'dia' : 'dias'}`],
  ];

  return (
    <div className="sinais-risco">
      {linhas.map(([rotulo, valor]) => (
        <div className="sinal-linha" key={rotulo}>
          <span>{rotulo}</span>
          <span className="sinal-valor">{valor}</span>
        </div>
      ))}
    </div>
  );
}

/** A frase que impede o painel de mentir sobre a origem da nota. */
export function AvisoOrigemNota() {
  return (
    <p className="nota-origem">
      <IconeEscudo size={14} />
      Esta nota é medida pelo próprio painel, com os dados daqui. O WhatsApp não divulga nota de
      qualidade para esta forma de conexão — o único aviso que ele manda de verdade é o código de
      conta restrita, e quando ele chega a nota vai direto a zero.
    </p>
  );
}

/** Faixa de status quando o painel já agiu sozinho neste número. */
export function FaixaAcaoAutomatica({
  pausadoEm,
  freandoAte,
  silenciadoAte,
  onReligar,
  religando,
}: {
  pausadoEm: string | null;
  freandoAte: string | null;
  silenciadoAte: string | null;
  onReligar: () => void;
  religando?: boolean;
}) {
  const agora = Date.now();
  const freando = Boolean(freandoAte && new Date(freandoAte).getTime() > agora);
  const silenciado = Boolean(silenciadoAte && new Date(silenciadoAte).getTime() > agora);

  if (pausadoEm) {
    return (
      <div className="faixa-risco vermelha">
        <strong>O painel tirou este número do ar em {formatDate(pausadoEm)}.</strong> A IA e a
        maturação foram desligadas porque a qualidade entrou em risco. Ele continua conectado e
        recebendo — só parou de enviar pelo painel.
        <div className="faixa-risco-acoes">
          <button className="btn btn-sm" onClick={onReligar} disabled={religando}>
            {religando ? 'Religando…' : 'Eu sei do risco, religar mesmo assim'}
          </button>
        </div>
        <div className="dica-campo">
          Religar segura as ações automáticas por 12 horas. O alerta continua aparecendo.
        </div>
      </div>
    );
  }

  if (freando) {
    return (
      <div className="faixa-risco amarela">
        <IconeRelogio size={16} />
        <span>
          <strong>Ritmo reduzido automaticamente.</strong> Os envios deste número estão mais
          espaçados e a maturação anda pela metade até a qualidade melhorar.
        </span>
      </div>
    );
  }

  if (silenciado) {
    return (
      <div className="faixa-risco neutra">
        <IconeEscudo size={16} />
        <span>
          Ações automáticas seguradas até {formatDate(silenciadoAte)}. O alerta continua sendo
          mostrado; o painel só não desliga nem freia nada até lá.
        </span>
      </div>
    );
  }

  return null;
}

/** Botão de "medir agora", com o estado de espera dentro dele. */
export function BotaoRemedir({ onMedir }: { onMedir: () => Promise<void> }) {
  const [medindo, setMedindo] = useState(false);
  return (
    <button
      className="btn btn-sm"
      disabled={medindo}
      onClick={() => {
        setMedindo(true);
        void onMedir().finally(() => setMedindo(false));
      }}
    >
      {medindo ? 'Medindo…' : 'Medir agora'}
    </button>
  );
}
