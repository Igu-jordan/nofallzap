import { useEffect, useState, useCallback } from 'react';
import {
  api,
  MODELS,
  TIPO_AGENTE_LABEL,
  type AgentRow,
  type AgentInput,
  type TipoAgente,
} from '../api';
import { Toggle, ErrorBox } from '../components/Common';

const BLANK: AgentInput = {
  name: '',
  kind: 'grupo',
  systemPrompt: '',
  whenToSpeak: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 500,
};

/**
 * Exemplo escrito para grupo de rede, que e o caso dificil: varias pessoas
 * conversando entre si e ninguem conhecendo voce. Repare que ele descreve
 * SITUACOES, nao palavras — quem julga e a IA, nao um filtro de texto.
 */
const EXEMPLO_QUANDO_FALAR = `Fale quando:
- alguem pedir indicacao de quem faca [O QUE VOCE FAZ]
- alguem contar um problema que voce resolve
- alguem perguntar preco, prazo ou como funciona [SEU SERVICO]
- falarem com voce pelo nome

Fique quieto quando:
- o assunto for outro
- alguem ja tiver respondido a pergunta
- for so conversa do dia a dia, bom dia, piada`;

const EXAMPLE = `Voce atende o grupo de clientes da [SUA EMPRESA].

O que voce faz:
- responde duvidas sobre prazo de entrega e status de pedido
- explica as formas de pagamento aceitas
- avisa o horario de atendimento quando perguntarem

O que voce NAO faz:
- nunca promete desconto, prazo ou excecao que nao esteja escrita aqui
- nunca inventa numero de pedido ou valor
- se pedirem algo fora disso, diga que vai chamar alguem da equipe

Tom: educado, direto, informal. Trate por voce.`;

/**
 * Exemplo para agente de PRIVADO. Repare na diferenca de postura: aqui a
 * pessoa ja veio falar com voce, entao nao ha hora para escolher — e e aqui
 * que entra o que nao se diz na frente do grupo.
 */
const EXEMPLO_PRIVADO = `Voce conversa no privado com quem procurou a [DIJ DIGITAL].

A pessoa veio falar com voce, entao va direto ao ponto.

O que voce faz:
- entende o que a pessoa precisa antes de falar de preco
- explica como funciona o servico, em duas ou tres frases
- combina um horario para falar com alguem da equipe

O que voce NAO faz:
- nunca inventa preco, prazo ou desconto que nao esteja escrito aqui
- nunca pede documento, senha ou dado de cartao
- se pedirem algo fora disso, diga que vai chamar alguem da equipe

Tom: proximo, sem formalidade e sem parecer atendimento automatico.`;

export function Agents({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<(AgentInput & { id?: string }) | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.listAgents());
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

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const { id, ...data } = editing;
      if (id) await api.patchAgent(id, data);
      else await api.createAgent(data);
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(agent: AgentRow) {
    if (
      !confirm(
        `Excluir o agente "${agent.name}"?\n\nOs grupos que usam ele ficam sem agente e param de responder — nada mais é apagado.`,
      )
    )
      return;
    try {
      await api.deleteAgent(agent.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) return <div className="empty">Carregando agentes…</div>;

  return (
    <>
      <button className="crumb" onClick={onBack}>
        ← Todas as instâncias
      </button>

      <ErrorBox message={error} />

      <div className="toolbar">
        <h1 className="titulo-secao">Agentes</h1>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}>
          + Novo agente
        </button>
      </div>

      <p style={{ color: 'var(--muted)', marginTop: 0, maxWidth: 760 }}>
        Um agente é um prompt reutilizável, e existe de dois tipos. O <strong>de grupo</strong>
        fala em público, no meio de várias pessoas, e precisa escolher a hora de falar. O{' '}
        <strong>de conversa privada</strong> atende uma pessoa por vez, que já veio falar com ele
        — é ali que cabe preço e condição, que não se diz na frente do grupo. Cada campo do painel
        só oferece o tipo que cabe nele.
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          Nenhum agente ainda.
          <br />
          Crie um e depois associe a um grupo na aba Grupos da instância.
        </div>
      ) : (
        <>
          <SecaoAgentes
            titulo="Agentes de grupo"
            explicacao="Falam no grupo, na frente de todo mundo. Só estes aparecem no campo Agente da aba Grupos."
            agentes={rows.filter((a) => a.kind === 'grupo')}
            aoEditar={setEditing}
            aoExcluir={remove}
            aoAlternar={load}
            vazio="Nenhum agente de grupo ainda."
          />
          <SecaoAgentes
            titulo="Agentes de conversa privada"
            explicacao="Atendem uma pessoa por vez. São estes que aparecem em “Agente do privado”, no “Chamar no privado” do grupo e em cada conversa."
            agentes={rows.filter((a) => a.kind === 'privado')}
            aoEditar={setEditing}
            aoExcluir={remove}
            aoAlternar={load}
            vazio="Nenhum agente de conversa privada ainda. Sem um destes, quem chamar o número direto não recebe resposta."
          />
        </>
      )}

      {editing && (
        <div className="overlay" onClick={() => setEditing(null)}>
          <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <h2>{editing.id ? 'Editar agente' : 'Novo agente'}</h2>
            <p className="hint">
              Descreva o que ele faz, o que <strong>não</strong> pode fazer e o tom. Ser explícito
              sobre os limites evita que a IA invente preço ou prazo.
            </p>

            <div className="field">
              <label>Nome</label>
              <input
                className="input"
                value={editing.name}
                placeholder="Ex: Atendimento Comercial"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>

            {/*
              O TIPO VEM ANTES DO PROMPT, de propósito: ele muda o que se
              escreve embaixo. Agente de grupo precisa de critério de quando
              falar; agente de privado não — lá a pessoa já veio falar com ele.
            */}
            <div className="field">
              <label htmlFor="tipo-agente">Tipo</label>
              <select
                id="tipo-agente"
                className="input"
                value={editing.kind ?? 'grupo'}
                onChange={(e) =>
                  setEditing({ ...editing, kind: e.target.value as TipoAgente })
                }
              >
                <option value="grupo">{TIPO_AGENTE_LABEL.grupo} — fala no grupo</option>
                <option value="privado">
                  {TIPO_AGENTE_LABEL.privado} — atende uma pessoa por vez
                </option>
              </select>
              <div className="dica-campo">
                {(editing.kind ?? 'grupo') === 'grupo'
                  ? 'Fala na frente de todas as pessoas do grupo. Nunca diga preço, condição ou dado de cliente num agente de grupo — para isso existe o de conversa privada.'
                  : 'Conversa de um para um, com quem já procurou o número. É aqui que cabe preço, condição e proposta.'}
              </div>
            </div>

            <div className="field">
              <label>
                Prompt do agente{' '}
                {!editing.id && (
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 8 }}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        systemPrompt:
                          (editing.kind ?? 'grupo') === 'privado' ? EXEMPLO_PRIVADO : EXAMPLE,
                      })
                    }
                  >
                    usar exemplo
                  </button>
                )}
              </label>
              <textarea
                className="input"
                rows={12}
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
                value={editing.systemPrompt}
                placeholder={(editing.kind ?? 'grupo') === 'privado' ? EXEMPLO_PRIVADO : EXAMPLE}
                onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
              />
            </div>

            {/*
              QUANDO ESTE AGENTE ENTRA NA CONVERSA.

              Fica no agente, não no código: o mesmo painel atende grupos
              diferentes, e cada agente tem um trabalho diferente. Trocar o
              critério não pode exigir mexer no sistema.

              As travas de segurança (não responder conversa alheia, não
              insistir, na dúvida ficar quieto) continuam no sistema e valem
              para todo agente — são elas que protegem o chip.
            */}
            {(editing.kind ?? 'grupo') === 'grupo' && (
            <div className="field">
              <label>
                Quando entrar na conversa{' '}
                {!editing.id && (
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 8 }}
                    onClick={() =>
                      setEditing({ ...editing, whenToSpeak: EXEMPLO_QUANDO_FALAR })
                    }
                  >
                    usar exemplo
                  </button>
                )}
              </label>
              <textarea
                className="input"
                rows={5}
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
                value={editing.whenToSpeak ?? ''}
                placeholder={EXEMPLO_QUANDO_FALAR}
                onChange={(e) => setEditing({ ...editing, whenToSpeak: e.target.value })}
              />
              <div className="dica-campo">
                Vale só nos grupos com o modo <strong>Inteligente</strong>. Antes de escrever
                qualquer resposta, o painel lê a conversa e decide se é hora de falar — este texto
                é o critério dele. Em cima disso valem sempre as regras do sistema: não entrar em
                conversa entre outras pessoas, não insistir quando ninguém respondeu, e na dúvida
                ficar quieto. Vazio: decide só pelo prompt acima.
              </div>
            </div>
            )}

            <div style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 2 }}>
                <label>Modelo</label>
                <select
                  className="input"
                  value={editing.model}
                  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Criatividade</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={editing.temperature}
                  onChange={(e) =>
                    setEditing({ ...editing, temperature: Number(e.target.value) })
                  }
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Máx. tokens</label>
                <input
                  className="input"
                  type="number"
                  min={50}
                  max={8000}
                  step={50}
                  value={editing.maxTokens}
                  onChange={(e) => setEditing({ ...editing, maxTokens: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => setEditing(null)}>
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                disabled={
                  saving || editing.name.trim().length < 2 || editing.systemPrompt.trim().length < 10
                }
                onClick={() => void save()}
              >
                {saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Uma seção da lista: os agentes de um tipo só.
 *
 * Separar em duas listas em vez de um selo colorido no card é de propósito.
 * O selo você lê; a seção você entende sem ler — e a pergunta que a tela
 * precisa responder de relance é "eu já tenho agente de privado?", não "de
 * que tipo é este aqui".
 */
function SecaoAgentes({
  titulo,
  explicacao,
  agentes,
  vazio,
  aoEditar,
  aoExcluir,
  aoAlternar,
}: {
  titulo: string;
  explicacao: string;
  agentes: AgentRow[];
  vazio: string;
  aoEditar: (a: AgentInput & { id: string }) => void;
  aoExcluir: (a: AgentRow) => void;
  aoAlternar: () => Promise<void>;
}) {
  return (
    <section style={{ marginBottom: 30 }}>
      <h2 className="titulo-secao" style={{ fontSize: 17, marginBottom: 4 }}>
        {titulo}
      </h2>
      <p className="dica-campo" style={{ marginTop: 0, marginBottom: 14, maxWidth: 700 }}>
        {explicacao}
      </p>

      {agentes.length === 0 ? (
        <div className="empty">{vazio}</div>
      ) : (
        <div className="grid">
          {agentes.map((a) => (
            <div key={a.id} className="card">
              <div className="card-head" style={{ marginBottom: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="card-title">{a.name}</div>
                  <div className="card-sub">
                    {a.model}
                    {a.kind === 'grupo' && !a.whenToSpeak?.trim()
                      ? ' · sem critério de quando falar'
                      : ''}
                  </div>
                </div>
                <Toggle
                  checked={a.isActive}
                  onChange={(v) => void api.patchAgent(a.id, { isActive: v }).then(aoAlternar)}
                  title={a.isActive ? 'Agente ativo' : 'Agente inativo'}
                />
              </div>

              <div
                style={{
                  color: 'var(--muted)',
                  fontSize: 13,
                  maxHeight: 66,
                  overflow: 'hidden',
                  marginBottom: 12,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {a.systemPrompt.slice(0, 180)}
                {a.systemPrompt.length > 180 ? '…' : ''}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    aoEditar({
                      id: a.id,
                      name: a.name,
                      kind: a.kind,
                      systemPrompt: a.systemPrompt,
                      whenToSpeak: a.whenToSpeak ?? '',
                      model: a.model,
                      temperature: a.temperature,
                      maxTokens: a.maxTokens,
                    })
                  }
                >
                  Editar
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => aoExcluir(a)}>
                  Excluir
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
