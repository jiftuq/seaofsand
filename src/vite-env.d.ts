/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STDB_URI?: string;
  readonly VITE_STDB_DB?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
