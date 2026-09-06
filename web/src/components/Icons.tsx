/**
 * ÍCONES.
 *
 * Desenhados aqui, no mesmo traço de 1.8 da referência, em vez de instalar
 * uma biblioteca inteira: o painel usa uma dúzia de ícones e cada um vira
 * SVG direto no HTML — sem dependência nova, sem peso de bundle e sem risco
 * de o build quebrar por causa de pacote.
 */

type Props = { size?: number; className?: string };

function Svg({ size = 20, className, children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconeCelular = (p: Props) => (
  <Svg {...p}>
    <rect x="5" y="2" width="14" height="20" rx="3" />
    <path d="M11 18h2" />
  </Svg>
);

export const IconeAgentes = (p: Props) => (
  <Svg {...p}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V4M9 14h.01M15 14h.01M2 13v2M22 13v2" />
  </Svg>
);

export const IconeChama = (p: Props) => (
  <Svg {...p}>
    <path d="M12 2c1.5 3.5-1 5-2.5 6.5A6.5 6.5 0 0 0 12 22a6.5 6.5 0 0 0 6.5-6.5c0-3.5-2.5-5.5-3.5-8-1 1.5-1.5 2.5-3 3.5C13 8 13 4.5 12 2Z" />
  </Svg>
);

export const IconeRodizio = (p: Props) => (
  <Svg {...p}>
    <path d="M4 10V9a4 4 0 0 1 4-4h9" />
    <path d="m14 2 3 3-3 3" />
    <path d="M20 14v1a4 4 0 0 1-4 4H7" />
    <path d="m10 22-3-3 3-3" />
  </Svg>
);

export const IconeBusca = (p: Props) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Svg>
);

export const IconeMenu = (p: Props) => (
  <Svg {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);

export const IconeTresPontos = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="12" cy="19" r="1.4" />
  </Svg>
);

export const IconeGrupos = (p: Props) => (
  <Svg {...p}>
    <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
    <circle cx="9" cy="7" r="3.2" />
    <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
    <path d="M16.5 4.1a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconeIa = (p: Props) => (
  <Svg {...p}>
    <path d="m12 3 1.6 4.6L18 9.2l-4.4 1.6L12 15.4l-1.6-4.6L6 9.2l4.4-1.6L12 3Z" />
    <path d="M18.5 15.5 19.3 18l2.2.8-2.2.8-.8 2.4-.8-2.4-2.2-.8 2.2-.8.8-2.5Z" />
  </Svg>
);

export const IconeRelogio = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3 1.8" />
  </Svg>
);

export const IconeCalendario = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="3" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
);

export const IconeAbrirFora = (p: Props) => (
  <Svg {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Svg>
);

export const IconeQr = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 14h3v3h-3zM20 14v.01M20 20v.01M14 20v.01M17 20v.01" />
  </Svg>
);

export const IconeDetalhe = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4.5M12 8h.01" />
  </Svg>
);

export const IconeEscudo = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3l7 2.6v5.2c0 4.8-2.9 8.7-7 10.2-4.1-1.5-7-5.4-7-10.2V5.6L12 3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const IconeMais = (p: Props) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconeHistorico = (p: Props) => (
  <Svg {...p}>
    <path d="M3.5 9.5A9 9 0 1 1 3 12" />
    <path d="M3 4.5v5h5" />
    <path d="M12 7.5V12l3.2 1.9" />
  </Svg>
);

export const IconeEmail = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="m3.5 7 7.6 5.3a1.6 1.6 0 0 0 1.8 0L20.5 7" />
  </Svg>
);

export const IconeCadeado = (p: Props) => (
  <Svg {...p}>
    <rect x="4" y="10" width="16" height="11" rx="3" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    <path d="M12 14.5v2.5" />
  </Svg>
);

export const IconeOlho = (p: Props) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3.2" />
  </Svg>
);

export const IconeOlhoFechado = (p: Props) => (
  <Svg {...p}>
    <path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.7" />
    <path d="M6.5 7.6A16.7 16.7 0 0 0 2.5 12s3.5 6 9.5 6a9.4 9.4 0 0 0 4-.86" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </Svg>
);

export const IconeSeta = (p: Props) => (
  <Svg {...p}>
    <path d="M4 12h15" />
    <path d="m13 6 6 6-6 6" />
  </Svg>
);

export const IconeGiro = (p: Props) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
  </Svg>
);

export const IconeCheck = (p: Props) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
);

export const IconeAlerta = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V13M12 16.5h.01" />
  </Svg>
);

export const IconeGrafico = (p: Props) => (
  <Svg {...p}>
    <path d="M3 21h18" />
    <path d="M6 21V11M11 21V5M16 21v-7M21 21v-4" />
  </Svg>
);

export const IconeSair = (p: Props) => (
  <Svg {...p}>
    <path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H15" />
    <path d="M10 8 6 12l4 4" />
    <path d="M6 12h9" />
  </Svg>
);

export const IconePessoa = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Svg>
);
