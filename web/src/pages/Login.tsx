import { useState } from 'react';
import { api } from '../api';
import { IconeGiro, IconePessoa, IconeSeta } from '../components/Icons';
import {
  AuthError,
  BrandPanel,
  Lembrar,
  LoginInput,
  PasswordInput,
} from '../components/LoginParts';

/**
 * TELA DE LOGIN.
 *
 * O painel tem uma conta só, definida no PANEL_USER/PANEL_PASSWORD do
 * servidor. Aqui não há cadastro nem recuperação de senha por e-mail: quem
 * troca a senha é quem tem acesso ao EasyPanel.
 *
 * Por isso o campo se chama "Usuário", e não "E-mail" — pedir e-mail quando
 * o que vale é um nome de usuário faz a pessoa errar o login sem entender.
 */
export function Login({ onEntrou }: { onEntrou: (usuario: string) => void }) {
  const [usuario, setUsuario] = useState('');
  const [senha, setSenha] = useState('');
  const [lembrar, setLembrar] = useState(false);
  const [entrando, setEntrando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (entrando) return; // trava o clique duplo
    setEntrando(true);
    setErro(null);
    try {
      const res = await api.login(usuario, senha, lembrar);
      onEntrou(res.usuario);
    } catch (err) {
      setErro((err as Error).message);
      setSenha('');
      setEntrando(false);
    }
  }

  return (
    <div className="login-tela">
      {/* A arte cobre a tela inteira, atrás das duas colunas: cortada no meio
          ela viraria um bloco preto do lado do formulário. */}
      <img
        className="login-fundo"
        src="/assets/branding/nofallzap-background.svg"
        alt=""
        aria-hidden="true"
      />
      <BrandPanel />

      <section className="login-lado">
        <form className="login-card" onSubmit={(e) => void enviar(e)}>
          <img
            className="login-card-logo"
            src="/assets/branding/nofallzap-logo.svg"
            alt="NoFallZap"
          />

          <h2 className="login-titulo">Bem-vindo de volta</h2>
          <p className="login-titulo-sub">
            Faça login para acessar seu painel e continuar gerenciando seus números.
          </p>

          <AuthError mensagem={erro} />

          <LoginInput
            id="login-usuario"
            label="Usuário"
            tipo="text"
            valor={usuario}
            onChange={setUsuario}
            placeholder="Seu usuário"
            autoComplete="username"
            disabled={entrando}
            icone={<IconePessoa size={20} />}
          />

          <PasswordInput valor={senha} onChange={setSenha} disabled={entrando} />

          <div className="login-linha-opcoes">
            <Lembrar marcado={lembrar} onChange={setLembrar} disabled={entrando} />
          </div>

          <button
            type="submit"
            className="login-botao"
            disabled={entrando || !usuario.trim() || !senha}
          >
            {entrando ? (
              <>
                <IconeGiro size={20} className="girando" />
                Entrando…
              </>
            ) : (
              <>
                Entrar no sistema
                <IconeSeta size={20} />
              </>
            )}
          </button>

          <p className="login-rodape">
            Esqueceu a senha? Ela fica na variável PANEL_PASSWORD do servidor — quem tem acesso ao
            EasyPanel consegue trocar.
          </p>
        </form>
      </section>
    </div>
  );
}
