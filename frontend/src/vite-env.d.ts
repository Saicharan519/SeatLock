/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The shared demo account offered on the sign-in page (hosted site only) */
  readonly VITE_DEMO_EMAIL?: string;
  readonly VITE_DEMO_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
