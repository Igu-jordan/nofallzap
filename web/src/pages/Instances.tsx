import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  api,
  timeAgo,
  formatDay,
  STATUS_LABEL,
  type AcaoRisco,
  type InstanceSummary,
  type InstanceStatus,
} from '../api';
import { on } from '../socket';
import { StatusBadge, Avatar, ErrorBox } from '../components/Common';
import { QrModal } from '../components/QrModal';
import { PageHeader, SearchBar, DropdownMenu, MetricItem } from '../components/Layout';
import { SeloRisco, SeletorAcao } from '../components/Risco';
import {
  IconeAbrirFora,
  IconeCalendario,
  IconeCelular,
  IconeDetalhe,
  IconeEscudo,
  IconeGrupos,
  IconeIa,
  IconeMais,
  IconeQr,
  IconeRelogio,
} from '../components/Icons';

/// estados em que faz sentido oferecer o QR Code
const PRECISA_CONECTAR: InstanceStatus[] = ['awaiting_qr', 'disconnected', 'error'];

export function Instances({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<InstanceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<{ id: string; name: string } | null>(null);
  /// modal de "Adicionar WhatsApp": pergunta o nome e ja abre o QR
  const [adicionando, setAdicionando] = useState(false);
  /// filtro só de tela: mexe no que já foi carregado, não chama a API
  const [busca, setBusca] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await api.listInstances());
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

  // A tela se atualiza sozinha: status, grupos e remocoes chegam por socket.
  useEffect(() => {
    const offStatus = on<{ instanceId: string; status: InstanceStatus }>(
      'instance:status',
      (p) => {
        setItems((prev) =>
          prev.map((i) => (i.id === p.instanceId ? { ...i, ...p, status: p.status } : i)),
        );
        if (p.status === 'connected') setTimeout(() => void load(), 2500);
      },
    );
    const offGroups = on('instance:groups', () => void load());
    // a nota muda sozinha: quando ela muda, os cards já sabem
    const offRisco = on<{ instanceId: string }>('instance:risk', () => void load());
    const offRemoved = on<{ instanceId: string }>('instance:removed', (p) =>
      setItems((prev) => prev.filter((i) => i.id !== p.instanceId)),
    );
    return () => {
      offStatus();
      offGroups();
      offRemoved();
      offRisco();
    };
  }, [load]);

  /**
   * Cria a instancia e emenda direto no QR Code.
   *
   * Quem clica em "Adicionar WhatsApp" quer conectar um numero, nao cadastrar
   * um nome — por isso o nome e perguntado no modal e, assim que a instancia
   * nasce, o QR aparece sem mais nenhum clique.
   */
  async function criar(nome: string) {
    const instance = await api.createInstance(nome);
    setAdicionando(false);
    await load();
    setQrFor({ id: instance.id, name: instance.name });
  }

  const conectados = items.filter((i) => i.status === 'connected').length;

  const visiveis = useMemo(() => {
    const t = busca.trim().toLowerCase();
    if (!t) return items;
    return items.filter((i) =>
      [i.name, i.phoneNumber ?? '', i.profileName ?? '', STATUS_LABEL[i.status] ?? i.status]
        .join(' ')
        .toLowerCase()
        .includes(t),
    );
  }, [items, busca]);

  if (loading) return <div className="empty">Carregando instâncias…</div>;

  return (
    <>
      <PageHeader
        titulo="Seus WhatsApps"
        subtitulo="Gerencie seus números, acompanhe a atividade e mantenha seus WhatsApps sempre organizados."
        acoes={
          /* Sem plano contratado no sistema, não existe teto para mostrar —
             então mostra o que é verdade: quantos estão no ar. */
          <div className="resumo">
            <div className="resumo-icone">
              <IconeCelular />
            </div>
            <div>
              <div className="resumo-num">
                {conectados}
                {items.length > conectados && (
                  <span className="resumo-total"> / {items.length}</span>
                )}
              </div>
              <div className="resumo-label">
                {conectados === 1 ? 'número ativo' : 'números ativos'}
              </div>
            </div>
          </div>
        }
      />

      <ErrorBox message={error} />

      <div className="linha-ferramentas">
        <button className="btn btn-primary btn-grande" onClick={() => setAdicionando(true)}>
          <IconeMais size={18} />
          Adicionar WhatsApp
        </button>
        {items.length > 0 && <SearchBar valor={busca} onChange={setBusca} />}
      </div>

      {items.length > 0 && <ControleAlerta />}

      {items.length === 0 ? (
        <div className="empty">
          Nenhum WhatsApp conectado ainda.
          <br />
          Clique em Adicionar WhatsApp para conectar o primeiro.
        </div>
      ) : visiveis.length === 0 ? (
        <div className="empty">Nenhum número bate com “{busca}”.</div>
      ) : (
        <div className="grid">
          {visiveis.map((i) => (
            <CardInstancia
              key={i.id}
              instancia={i}
              onAbrir={() => onOpen(i.id)}
              onConectar={() => setQrFor({ id: i.id, name: i.name })}
            />
          ))}
        </div>
      )}

      {adicionando && (
        <NovoNumeroModal onFechar={() => setAdicionando(false)} onCriar={criar} />
      )}

      {qrFor && (
        <QrModal
          instanceId={qrFor.id}
          instanceName={qrFor.name}
          onClose={() => setQrFor(null)}
          onConnected={() => void load()}
        />
      )}
    </>
  );
}

/**
 * O INTERRUPTOR DOS TRÊS MODOS.
 *
 * Fica aqui, ao lado dos selos que ele comanda, e não numa tela de
 * configurações separada: a decisão "o que fazer quando um número ficar
 * vermelho" só faz sentido olhando para os números.
 *
 * Vale para todos os números. Um número específico pode ter o seu próprio
 * modo, na aba Configurações dele.
 */
function ControleAlerta() {
  const [acao, setAcao] = useState<AcaoRisco | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getRiskConfig()
      .then((c) => setAcao(c.acao))
      .catch((e) => setErro((e as Error).message));
  }, []);

  async function trocar(nova: AcaoRisco | null) {
    if (!nova) return;
    const anterior = acao;
    setAcao(nova); // responde na hora; volta atrás se o servidor recusar
    setSalvando(true);
    setErro(null);
    try {
      await api.setRiskConfig(nova);
    } catch (e) {
      setAcao(anterior);
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  if (!acao) return null;

  return (
    <div className="painel-alerta">
      <div className="painel-alerta-texto">
        <div className="painel-alerta-titulo">
          <IconeEscudo size={16} />
          Alerta de qualidade
        </div>
        <p>
          O painel mede a saúde de cada número com os dados daqui — entregas recusadas, quantas
          pessoas respondem e o volume para a idade do chip — e pinta o selo de verde, amarelo ou
          vermelho. Escolha o que ele faz quando um número entra no vermelho.
        </p>
      </div>
      <div className="painel-alerta-controle">
        <label htmlFor="acao-risco-global">Quando um número entrar em risco</label>
        <SeletorAcao id="acao-risco-global" valor={acao} onChange={trocar} disabled={salvando} />
        <ErrorBox message={erro} />
      </div>
    </div>
  );
}

function CardInstancia({
  instancia: i,
  onAbrir,
  onConectar,
}: {
  instancia: InstanceSummary;
  onAbrir: () => void;
  onConectar: () => void;
}) {
  const precisaConectar = PRECISA_CONECTAR.includes(i.status);
  /// só existe quando o número já conectou alguma vez
  const linkWhatsapp = i.phoneNumber ? `https://wa.me/${i.phoneNumber}` : null;

  function abrirWhatsapp() {
    if (linkWhatsapp) window.open(linkWhatsapp, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="card clickable" onClick={onAbrir}>
      <div className="card-head">
        <Avatar url={i.profilePicUrl} name={i.name} />
        <div className="card-identidade">
          <div className="card-title">{i.name}</div>
          <div className="card-sub">{i.phoneNumber ? `+${i.phoneNumber}` : 'sem número'}</div>
        </div>
        <StatusBadge status={i.status} />
        <DropdownMenu
          rotulo={`Ações de ${i.name}`}
          opcoes={[
            { rotulo: 'Ver detalhes', icone: <IconeDetalhe size={16} />, onClick: onAbrir },
            ...(precisaConectar
              ? [{ rotulo: 'Conectar (QR Code)', icone: <IconeQr size={16} />, onClick: onConectar }]
              : []),
            ...(linkWhatsapp
              ? [
                  {
                    rotulo: 'Abrir no WhatsApp',
                    icone: <IconeAbrirFora size={16} />,
                    onClick: abrirWhatsapp,
                  },
                ]
              : []),
          ]}
        />
      </div>

      {/* "Conectado" sozinho engana quando o envio esta sendo recusado */}
      {i.deliveryBlockedAt && (
        <div className="aviso-entrega">não está entregando — IA desligada automaticamente</div>
      )}

      {/* QUALIDADE. Aparece sempre, inclusive no verde: um selo que só
          existe quando há problema não ensina ninguém a ler o selo. */}
      <div className={`faixa-qualidade ${i.riskLevel}`}>
        <SeloRisco nivel={i.riskLevel} nota={i.riskScore} compacto />
        <span className="faixa-qualidade-texto">
          {i.riskReasons?.[0] ?? 'Ainda não medido.'}
        </span>
      </div>

      {i.riskPausedAt && (
        <div className="aviso-entrega">
          tirado do ar pelo alerta de qualidade — abra os detalhes para religar
        </div>
      )}
      {!i.riskPausedAt && i.throttledUntil && new Date(i.throttledUntil) > new Date() && (
        <div className="aviso-freio">ritmo reduzido automaticamente pelo alerta de qualidade</div>
      )}

      <div className="divisor" />

      <div className="metricas">
        <MetricItem icone={<IconeGrupos size={16} />} valor={i.groupsCount} label="grupos" />
        <MetricItem
          icone={<IconeIa size={16} />}
          valor={i.groupsWithAi}
          label="com IA"
          neutro={i.groupsWithAi === 0}
        />
        <MetricItem
          icone={<IconeRelogio size={16} />}
          valor={timeAgo(i.lastActivityAt)}
          label="última atividade"
          neutro
        />
        <MetricItem
          icone={<IconeCalendario size={16} />}
          valor={formatDay(i.createdAt)}
          label="criada em"
          neutro
        />
      </div>

      <div className="card-rodape">
        <button
          className="btn"
          onClick={(e) => {
            e.stopPropagation();
            onAbrir();
          }}
        >
          <IconeDetalhe size={16} />
          Ver detalhes
        </button>

        {precisaConectar ? (
          <button
            className="btn btn-verde"
            onClick={(e) => {
              e.stopPropagation();
              onConectar();
            }}
          >
            <IconeQr size={16} />
            Conectar
          </button>
        ) : (
          linkWhatsapp && (
            <button
              className="btn btn-verde"
              onClick={(e) => {
                e.stopPropagation();
                abrirWhatsapp();
              }}
            >
              <IconeAbrirFora size={16} />
              Abrir no WhatsApp
            </button>
          )
        )}
      </div>
    </div>
  );
}

/**
 * "Adicionar WhatsApp": pergunta so o nome interno.
 *
 * O erro fica dentro do modal de proposito. Se subisse para a tela de tras,
 * quem digitou um nome repetido veria o modal continuar aberto sem explicacao
 * nenhuma, com a mensagem escondida atras dele.
 */
function NovoNumeroModal({
  onFechar,
  onCriar,
}: {
  onFechar: () => void;
  onCriar: (nome: string) => Promise<void>;
}) {
  const [nome, setNome] = useState('');
  const [criando, setCriando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const valido = nome.trim().length >= 2;

  async function confirmar() {
    if (!valido || criando) return;
    setCriando(true);
    setErro(null);
    try {
      await onCriar(nome.trim());
    } catch (e) {
      setErro((e as Error).message);
      setCriando(false);
    }
  }

  return (
    <div className="overlay" onClick={onFechar}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Adicionar WhatsApp</h2>
        <p className="hint">
          Dê um nome interno para reconhecer este número no painel. Em seguida aparece o QR Code
          para conectar.
        </p>

        <ErrorBox message={erro} />

        <div className="field">
          <label htmlFor="novo-numero-nome">Nome interno</label>
          <input
            id="novo-numero-nome"
            className="input"
            autoFocus
            placeholder="ex: WhatsApp Suporte"
            value={nome}
            disabled={criando}
            onChange={(e) => setNome(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void confirmar()}
          />
          <div className="dica-campo">Só você vê este nome. O número vem do próprio WhatsApp.</div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onFechar} disabled={criando}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={() => void confirmar()} disabled={!valido || criando}>
            {criando ? 'Criando…' : 'Criar e conectar'}
          </button>
        </div>
      </div>
    </div>
  );
}
