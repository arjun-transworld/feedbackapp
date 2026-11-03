// Crew authentication (Microsoft Entra ID / MSAL). Every API call carries the
// signed-in user's access token. Entra settings come from config.js.
//
// Browser:   the shared TransworldAuth (MSAL.js).
// iOS / Android app: MSAL.js redirects do not work inside the app's WebView, so
//            sign-in uses the native MSAL plugin. The native uploader then gets fresh
//            tokens from the same MSAL cache on its own, so queued uploads still go out
//            with a valid token on behalf of the user, even hours later with the app closed.

import { ENTRA, isConfigured } from "./config.js";
import { getJSON, setJSON } from "./store.js";

const ACCOUNT_KEY = "tw.feedback.account";
const NOT_CONFIGURED = "Entra settings are missing: fill in clientId, tenantId and scope in www/js/config.js.";

export const isNative = !!window.Capacitor?.isNativePlatform?.();

let webAuthReady = null;

function decodeJwt(token) {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(part))));
}

export function getAccount() {
  return getJSON(ACCOUNT_KEY);
}

function initWebAuth() {
  // TransworldAuth builds the scope as api://<client_id>/<scope>, so pass only the last part.
  webAuthReady ??= new Promise((resolve) =>
    window.TransworldAuth.init({
      client_id: ENTRA.clientId,
      tenant_id: ENTRA.tenantId,
      scope: ENTRA.scope.replace(`api://${ENTRA.clientId}/`, ""),
      onSignedIn: resolve,
      onSignedOut: () => resolve(null),
    })
  );
  return webAuthReady;
}

/** Interactive sign-in (crew only, needs internet). */
export async function signIn() {
  if (!isConfigured) throw new Error(NOT_CONFIGURED);
  if (isNative) {
    const result = await window.Capacitor.Plugins.MsAuthPlugin.login({
      clientId: ENTRA.clientId,
      tenant: ENTRA.tenantId,
      scopes: [ENTRA.scope],
      keyHash: ENTRA.androidKeyHash, // Android only; ignored on iOS
    });
    const claims = decodeJwt(result.idToken || result.accessToken);
    setJSON(ACCOUNT_KEY, { name: claims.name, username: claims.preferred_username || claims.upn });
    return true;
  }
  return !!(await getAccessToken()); // redirects to Microsoft sign-in if needed
}

/** Browser only: a valid access token for the API, or null if redirecting to sign in. */
export async function getAccessToken() {
  if (!isConfigured) return null;
  await initWebAuth();
  const tokens = await window.TransworldAuth.getAccessToken();
  if (!tokens) return null;
  const a = window.TransworldAuth.getAccount();
  setJSON(ACCOUNT_KEY, { name: a?.name, username: a?.username });
  return tokens.accessToken;
}
