import { useEffect, useState, useCallback } from 'react';
import { api, MODELS, type AgentRow, type AgentInput } from '../api';
import { Toggle, ErrorBox } from '../components/Common';

const BLANK: AgentInput = {
  name: '',
  systemPrompt: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 500,
};

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
        <div style={{ fontSize: 20, fontWeight: 700 }}>Agentes</div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}>
          + Novo agente
        </button>
      </div>

      <p style={{ color: 'var(--muted)', marginTop: 0, maxWidth: 700 }}>
        Um agente é um prompt reutilizável. O mesmo agente pode atender vários grupos, em
        instâncias diferentes. O que muda de um grupo para outro são as instruções específicas,
        configuradas na aba Grupos.
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          Nenhum agente ainda.
          <br />
          Crie um e depois associe a um grupo na aba Grupos da instância.
        </div>
      ) : (
        <div className="grid">
          {rows.map((a) => (
            <div key={a.id} className="card">
              <div className="card-head" style={{ marginBottom: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="card-title">{a.name}</div>
                  <div className="card-sub">{a.model}</div>
                </div>
                <Toggle
                  checked={a.isActive}
                  onChange={(v) => void api.patchAgent(a.id, { isActive: v }).then(load)}
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
                    setEditing({
                      id: a.id,
                      name: a.name,
                      systemPrompt: a.systemPrompt,
                      model: a.model,
                      temperature: a.temperature,
                      maxTokens: a.maxTokens,
                    })
                  }
                >
                  Editar
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => void remove(a)}>
                  Excluir
                </button>
              </div>
            </div>
          ))}
        </div>
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

            <div className="field">
              <label>
                Prompt do agente{' '}
                {!editing.id && (
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 8 }}
                    onClick={() => setEditing({ ...editing, systemPrompt: EXAMPLE })}
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
                placeholder={EXAMPLE}
                onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
              />
            </div>

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
