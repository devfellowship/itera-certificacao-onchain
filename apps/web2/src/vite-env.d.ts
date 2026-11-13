/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the TestMyAgent API. Default: the production API. */
  readonly VITE_TMA_API_URL?: string
  /** DFL federate endpoint of Login with DFL. Default: https://learn.devfellowship.com/auth/federate */
  readonly VITE_DFL_FEDERATE_URL?: string
  /** 'true' turns the hosted runs on (web2 = ingested only for now, Tainan TG 23889). Default: off. */
  readonly VITE_TMA_WEB2_HOSTED?: string
  /** Fleet-wide trajectory wall of Decision Graph analytics (studio S9 link). Default: DEFAULT_FLEET_WALL_URL. */
  readonly VITE_TMA_FLEET_WALL_URL?: string
  /** Base URL of `tma studio serve` for the S10a dry-run panel (C5-T10). Default: empty = panel hidden. */
  readonly VITE_TMA_STUDIO_SERVE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
