/// <reference types="vite/client" />

interface ImportMetaEnv {
  /// Endereço do serviço público do rodízio (o link não fica atrás da senha
  /// do painel, então mora em outro host). Ex: https://nofallzap-link.xxx
  readonly VITE_LINK_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
