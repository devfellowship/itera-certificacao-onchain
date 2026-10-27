/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the TestMyAgent API. Default: the production API. */
  readonly VITE_TMA_API_URL?: string
  /** DFL federate endpoint of Login with DFL. Default: https://learn.devfellowship.com/auth/federate */
  readonly VITE_DFL_FEDERATE_URL?: string
  /** 'true' turns the hosted runs on (web2 = ingested only for now, Tainan TG 23889). Default: off. */
  readonly VITE_TMA_WEB2_HOSTED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
