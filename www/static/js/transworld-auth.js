/**
 * Transworld Common Auth (Entra ID / MSAL.js)
 * ============================================================
 * Single source of truth for how every Transworld app signs users
 * in via Microsoft Entra ID and gets access tokens for backend APIs.
 *
 * DO NOT write your own msalConfig / PublicClientApplication in your
 * app. Include this file and call TransworldAuth.init(...) instead —
 * see the onboarding doc for the 10-line integration.
 *
 * Why this exists: every app used to hardcode its own clientId /
 * tenantId / cacheLocation. One typo or drift (e.g. sessionStorage
 * instead of localStorage) silently breaks single sign-on between
 * apps. Centralizing it here means there is exactly one place that
 * can get it wrong, and one place to fix it.
 * ============================================================
 */
(function (window) {
  "use strict";

  // Served by the platform team's backend — NOT a static file — so the
  // real clientId/tenantId/scope live in exactly one place (the backend
  // config/secrets), not copy-pasted into every app's source.

  const MSAL_LOCAL_PATH = "/static/js/msal-browser.min.js";
  const MSAL_CDN_FALLBACK = "https://alcdn.msauth.net/browser/3.7.1/js/msal-browser.min.js";

  let msalInstance = null;
  let authConfig = null;
  const accountChangeHandlers = [];

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function ensureMsalLoaded() {
    if (window.msal) return;
    try {
      await loadScript(MSAL_LOCAL_PATH);
    } catch (e) {
      console.warn("[TransworldAuth] Local MSAL bundle not found at " + MSAL_LOCAL_PATH + " — falling back to Microsoft's CDN.");
    }
    if (!window.msal) {
      await loadScript(MSAL_CDN_FALLBACK);
    }
  }

  async function fetchAuthConfig(CONFIG_ENDPOINT) {
    const res = await fetch(CONFIG_ENDPOINT, { credentials: "same-origin" });
    if (!res.ok) {
      throw new Error("[TransworldAuth] Could not load " + CONFIG_ENDPOINT + " (status " + res.status + ")");
    }
    const cfg = await res.json();
    if (!cfg.clientId || !cfg.tenantId || !cfg.scope) {
      throw new Error("[TransworldAuth] " + CONFIG_ENDPOINT + " response is missing clientId/tenantId/scope.");
    }
    return cfg;
  }

  function notifyAccountChange(account) {
    accountChangeHandlers.forEach(function (fn) {
      try { fn(account); } catch (e) { console.error(e); }
    });
  }

  const TransworldAuth = {
    /**
     * Call once per page, on load.
     * options:
     *   onSignedIn(account)   - fired once a signed-in account is found
     *   onSignedOut(message)  - fired if no account is signed in (message
     *                           is set on real failures, undefined on a
     *                           plain "not signed in yet")
     *   autoPromptSignIn      - if true, immediately redirects to sign-in
     *                           when no account is found (default: false).
     *                           Use true for apps where every page requires
     *                           auth; use false for a landing page that
     *                           shows its own "Sign in" button.
     */
    async init(options) {
      options = options || {};
      try {
        if (!("CONFIG_ENDPOINT" in options)) {
            options.CONFIG_ENDPOINT = "http://localhost:8000/auth/config";
        }
        if (!("client_id" in options)) {
          authConfig = await fetchAuthConfig(options.CONFIG_ENDPOINT);
        }
        else {
          authConfig = {
            tenantId:options.tenant_id,
            clientId:options.client_id,
            scope:`api://${options.client_id}/${options.scope}`
          }
        }
      } catch (err) {
        console.error(err);
        if (options.onSignedOut) options.onSignedOut("Could not load authentication configuration.");
        return;
      }

      try {
        await ensureMsalLoaded();
      } catch (err) {
        if (options.onSignedOut) options.onSignedOut("Could not load the Microsoft sign-in library.");
        return;
      }

      const msalConfig = {
        auth: {
          clientId: authConfig.clientId,
          authority: "https://login.microsoftonline.com/" + authConfig.tenantId,
          redirectUri: window.location.origin,
        },
        cache: {
          // Fixed here, on purpose — apps do not get to choose this.
          // localStorage is what makes cross-page / cross-tab SSO work.
          cacheLocation: "localStorage",
          storeAuthStateInCookie: false,
        },
      };

      msalInstance = new msal.PublicClientApplication(msalConfig);
      await msalInstance.initialize();

      let response;
      try {
        response = await msalInstance.handleRedirectPromise();
      } catch (err) {
        if (options.onSignedOut) options.onSignedOut("Sign-in failed: " + err.message);
        return;
      }

      if (response && response.account) {
        msalInstance.setActiveAccount(response.account);
      }

      const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
      if (account) {
        msalInstance.setActiveAccount(account);
        if (options.onSignedIn) options.onSignedIn(account);
        notifyAccountChange(account);
      } else if (options.autoPromptSignIn) {
        this.signIn();
      } else {
        if (options.onSignedOut) options.onSignedOut();
      }
    },

    /** Redirects to Microsoft sign-in. loginHint is optional (prefills the email field). */
    signIn(loginHint) {
      if (!msalInstance || !authConfig) {
        console.error("[TransworldAuth] signIn() called before init() finished.");
        return;
      }
      const request = { scopes: [authConfig.scope, "User.Read"] };
      if (loginHint) request.loginHint = loginHint;
      msalInstance.loginRedirect(request);
    },

    /** Signs the user out (clears local cache and redirects through Entra logout). */
    async signOut() {
      if (!msalInstance) return;
      await msalInstance.logoutPopup();
      parent.location.reload();
    },

    /** Returns the signed-in account object, or null. */
    getAccount() {
      return msalInstance ? msalInstance.getActiveAccount() : null;
    },

    /**
     * Returns a valid access token for backend API calls, or null if the
     * page is being redirected to sign in (caller should stop and return —
     * the page is navigating away, there is nothing more to do).
     *
     * scopes: optional array of scopes to request. Defaults to this app's
     * own backend API scope (authConfig.scope). Pass a different array
     * (e.g. ["User.Read"]) to get a token audienced to a different
     * resource, such as Microsoft Graph.
     */
    async getAccessToken(scopes) {
      if (!msalInstance || !authConfig) {
        console.error("[TransworldAuth] getAccessToken() called before init() finished.");
        return null;
      }
      const account = msalInstance.getActiveAccount();
      if (!account) {
        this.signIn();
        return null;
      }
      const request = { scopes: scopes || [authConfig.scope], account: account };
      try {
        const result = await msalInstance.acquireTokenSilent(request);
        return {
          accessToken: result.accessToken,
          idToken: result.idToken,
          roles: result.idTokenClaims?.roles || []
        }
      } catch (err) {
        console.error("Token Error:", err);
        console.error("Error Code:", err.errorCode);
        console.error("Message:", err.errorMessage);

        await msalInstance.acquireTokenRedirect(request);
        return null;
      }
    },

    async getGraphProfile() {
      const tokens = await this.getAccessToken(["User.Read"]);
      if (!tokens) {
        return null; // getAccessToken() is redirecting the page to sign in
      }

      try {
        const response = await fetch(
          "https://graph.microsoft.com/v1.0/me?$select=id,displayName,department,jobTitle,officeLocation",
          {
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`
            }
          }
        );

        if (!response.ok) {
          const errorBody = await response.json();
          console.error("Graph API error:", errorBody);
          return null;
        }

        const profile = await response.json();
        return profile;
      } catch (err) {
        console.error("Graph API call failed:", err);
        return null;
      }
    },

    /** Register a callback fired whenever the active account is set. */
    onAccountChange(fn) {
      accountChangeHandlers.push(fn);
    },

    /**
     * Navigate to another Transworld app by the key registered in the
     * "/auth/config" response's "apps" map (e.g. "hscode", "login").
     * Same-tab, same-origin navigation — this is what preserves SSO.
     */
    goToApp(appKey) {
      if (!authConfig || !authConfig.apps || !authConfig.apps[appKey]) {
        console.error('[TransworldAuth] Unknown app key "' + appKey + '"');
        return;
      }
      window.location.href = authConfig.apps[appKey];
    },
  };

  window.TransworldAuth = TransworldAuth;
})(window);
