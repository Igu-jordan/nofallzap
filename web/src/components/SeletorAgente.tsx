import { TIPO_AGENTE_LABEL, type AgentRow, type TipoAgente } from '../api';

/**
 * SELETOR DE AGENTE, FILTRADO PELO TIPO.
 *
 * Onde é grupo só aparece agente de grupo; onde é privado só aparece agente
 * de conversa privada. São dois trabalhos diferentes e trocar um pelo outro
 * é o caminho curto para preço sair na frente do grupo inteiro.
 *
 * A EXCEÇÃO QUE IMPORTA: o agente que já está escolhido aparece na lista
 * mesmo sendo do outro tipo, marcado como tal. Sem isso, uma configuração
 * antiga apontando para o tipo "errado" sumiria do campo, e o primeiro
 * salvamento de qualquer outra coisa apagaria em silêncio a escolha que já
 * estava lá. Melhor mostrar e deixar a pessoa decidir trocar.
 */
export function SeletorAgente({
  agents,
  tipo,
  valor,
  onChange,
  id,
  disabled,
  rotuloVazio = '— nenhum —',
  style,
}: {
  agents: AgentRow[];
  tipo: TipoAgente;
  valor: string | null;
  onChange: (agentId: string | null) => void;
  id?: string;
  disabled?: boolean;
  rotuloVazio?: string;
  style?: React.CSSProperties;
}) {
  const doTipo = agents.filter((a) => a.kind === tipo);
  const atual = valor ? agents.find((a) => a.id === valor) : null;
  const foraDoTipo = atual && atual.kind !== tipo ? atual : null;

  return (
    <select
      id={id}
      className="input"
      style={style}
      value={valor ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{rotuloVazio}</option>
      {doTipo.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.isActive ? '' : ' (inativo)'}
        </option>
      ))}
      {foraDoTipo && (
        <option value={foraDoTipo.id}>
          {foraDoTipo.name} — {TIPO_AGENTE_LABEL[foraDoTipo.kind].toLowerCase()}, troque quando puder
        </option>
      )}
      {doTipo.length === 0 && !foraDoTipo && (
        <option value="" disabled>
          nenhum agente {tipo === 'grupo' ? 'de grupo' : 'de conversa privada'} criado ainda
        </option>
      )}
    </select>
  );
}
