/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Hosted builds: the game server's address, e.g. https://api.example.com (see server-url.ts). */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
