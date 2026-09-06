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
