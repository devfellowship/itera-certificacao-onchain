import { buildFederateUrl } from '../config'

/** Sets `window.location` to the DFL federate URL. The `navigate` prop exists so a test can observe the target. */
export function LoginButton({
  navigate = (url: string) => window.location.assign(url),
}: {
  navigate?: (url: string) => void
}) {
  return (
    <button
      type="button"
      className="w2-btn"
      data-testid="login-dfl"
      onClick={() => navigate(buildFederateUrl(window.location.origin))}
    >
      Login with DFL
    </button>
  )
}
