import { useId, useState, type ReactNode } from 'react';
import {
  IconeAlerta,
  IconeCadeado,
  IconeCelular,
  IconeChama,
  IconeEscudo,
  IconeGrafico,
  IconeOlho,
  IconeOlhoFechado,
} from './Icons';

/**
 * PECAS DA TELA DE LOGIN.
 *
 * Separadas do formulario para que a pagina fique legivel: la fica a logica
 * de autenticar, aqui fica a aparencia de cada peca.
 */

/** Um benefício da coluna institucional: ícone + título + explicação. */
export function FeatureItem({
  icone,
  titulo,
  texto,
}: {
  icone: ReactNode;
  titulo: string;
  texto: string;
}) {
  return (
    <li className="login-feature">
      <span className="login-feature-icone">{icone}</span>
      <span>
        <span className="login-feature-titulo">{titulo}</span>
        <span className="login-feature-texto">{texto}</span>
      </span>
    </li>
  );
}

/**
 * Coluna da marca.
 *
 * O que está escrito aqui é o que o painel realmente faz — vários números num
 * lugar só, resposta automática, rodízio de link e a pausa de emergência.
 * Vitrine que promete o que o produto não entrega vira reclamação depois.
 */
export function BrandPanel() {
  return (
    <section className="login-marca">
      <div className="login-onda-1" aria-hidden="true" />
      <div className="login-onda-2" aria-hidden="true" />
      <div className="login-pontos login-pontos-a" aria-hidden="true" />
      <div className="login-pontos login-pontos-b" aria-hidden="true" />
      <img
        className="login-marca-dagua"
        src="/assets/branding/nofallzap-symbol.svg"
        alt=""
        aria-hidden="true"
      />

      <div className="login-marca-conteudo">
        <img
          className="login-marca-logo"
          src="/assets/branding/nofallzap-logo.svg"
          alt="NoFallZap"
        />

        <h1 className="login-headline">
          Mais controle
          <br />
          para o seu
          <br />
          <span>WhatsApp.</span>
        </h1>

        <p className="login-sub">
          Gerencie múltiplos números, automatize conversas e escale seus resultados com segurança.
        </p>

        <ul className="login-features">
          <FeatureItem
            icone={<IconeCelular size={22} />}
            titulo="Múltiplas instâncias"
            texto="Todos os seus números em um só lugar"
          />
          <FeatureItem
            icone={<IconeChama size={22} />}
            titulo="Maturação de chip"
            texto="Seus números conversando entre si, no ritmo certo"
          />
          <FeatureItem
            icone={<IconeGrafico size={22} />}
            titulo="Rodízio de link"
            texto="Um link no anúncio, vários WhatsApp atendendo"
          />
          <FeatureItem
            icone={<IconeEscudo size={22} />}
            titulo="Número que cai sai do ar"
            texto="O painel percebe sozinho e não queima seu chip"
          />
        </ul>
      </div>
    </section>
  );
}

/** Campo com ícone à esquerda. */
export function LoginInput({
  id,
  label,
  tipo,
  valor,
  onChange,
  placeholder,
  autoComplete,
  disabled,
  icone,
}: {
  id: string;
  label: string;
  tipo: string;
  valor: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  icone: ReactNode;
}) {
  return (
    <div className="login-campo">
      <label htmlFor={id}>{label}</label>
      <div className="login-campo-caixa">
        <span className="login-campo-icone">{icone}</span>
        <input
          id={id}
          type={tipo}
          value={valor}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
          required
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

/** Campo de senha, com o olho que mostra e esconde. */
export function PasswordInput({
  valor,
  onChange,
  disabled,
}: {
  valor: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [visivel, setVisivel] = useState(false);
  const id = useId();

  return (
    <div className="login-campo">
      <label htmlFor={id}>Senha</label>
      <div className="login-campo-caixa">
        <span className="login-campo-icone">
          <IconeCadeado size={20} />
        </span>
        <input
          id={id}
          type={visivel ? 'text' : 'password'}
          value={valor}
          placeholder="Sua senha"
          autoComplete="current-password"
          disabled={disabled}
          required
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="login-olho"
          onClick={() => setVisivel((v) => !v)}
          aria-label={visivel ? 'Ocultar senha' : 'Mostrar senha'}
          title={visivel ? 'Ocultar senha' : 'Mostrar senha'}
        >
          {visivel ? <IconeOlhoFechado size={20} /> : <IconeOlho size={20} />}
        </button>
      </div>
    </div>
  );
}

/** Caixa de erro do login. `role="alert"` faz o leitor de tela anunciar. */
export function AuthError({ mensagem }: { mensagem: string | null }) {
  if (!mensagem) return null;
  return (
    <div className="login-erro" role="alert">
      <IconeAlerta size={18} />
      <span>{mensagem}</span>
    </div>
  );
}

/** Caixa de seleção do "lembrar de mim". */
export function Lembrar({
  marcado,
  onChange,
  disabled,
}: {
  marcado: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="login-lembrar" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={marcado}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="login-caixinha" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2}>
          <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      Lembrar de mim
    </label>
  );
}
