# API contract — what the Feedback app needs from the backend

The app's scope ends when the server answers **2xx** to a submission. This page is for the
backend team: it lists exactly what the app sends and how it reacts to each response.

The app calls **one endpoint**. Its full URL is `feedbackUrl` in [`www/js/config.js`](www/js/config.js), and it must be **HTTPS**.
The path below is shown as `/feedback`, but any URL works.

The app requests the token for the `scope` set in `config.js` (e.g. `api://<client-id>/access_as_user`),
so the token's `aud` is that API. The backend team should confirm which scope/audience they validate.

---

## `POST /feedback` — one submission

**Request headers**
```
Content-Type: application/json
Authorization: Bearer <Entra access token of the signed-in crew member>
```

**Request body**
```json
{
  "id": "6f1c2a9e-3b4d-4c55-9a77-0e8b2f1d4c3a",
  "createdAt": "2026-11-02T07:18:13.686Z",
  "route": "02 Nov 2026 · DXB → LTN",
  "tail": "G7500 · A6-TWJ",
  "name": "Jane Smith",
  "ratings": {
    "crew": "exceptional",
    "comfort": "good",
    "catering": null,
    "overall": "exceptional"
  },
  "chooseAgain": true,
  "comments": "Lovely flight",
  "crew": "crew.member@transworld.com"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID v4) | Generated on the device. **Unique per submission** (see "Duplicates" below) |
| `createdAt` | ISO-8601 UTC | When the passenger submitted. Can be days before the request arrives |
| `route`, `tail` | string \| null | Entered by crew |
| `name` | string \| null | Optional |
| `ratings.crew`, `.comfort`, `.catering`, `.overall` | `"poor"` \| `"fair"` \| `"good"` \| `"exceptional"` \| null | Unanswered = null |
| `chooseAgain` | boolean \| null | |
| `comments` | string \| null | Free text |
| `crew` | string \| null | Signed-in crew username (also available from the token) |

### How the app reacts to each response

| Response | App behaviour |
|---|---|
| **2xx** (200 or 201) | Done. Record marked *sent*, and it's deleted from the device after 7 days. The response body is ignored |
| **401** | Gets a fresh token silently and resends straight away (up to 2 times). Still 401 after that → the record stays on the device and the status shows "crew sign-in needed" |
| **403** | Record stays on the device; the status shows "crew sign-in needed" |
| **400 / 404 / 409 / 422** (other 4xx) | Record marked *rejected* on the device and **never resent** |
| **408, 429, 5xx, timeout, no network** | Resent automatically: 15 min, 30 min, 1 h … up to every 6 h |

### Requirements for the backend

1. **Duplicates must return 2xx.** The same `id` can arrive more than once, for example when a
   response is lost on a bad connection and the device resends. Store it once, and answer
   **200** for a repeat. Answering 409 makes the device mark it *rejected*.
2. **Accept old `createdAt` values.** Records can arrive days after they were filled in.
3. **Validate the token** as for other Transworld APIs (signature, `iss`, `aud`).
   An expired token **must** return **401**, not 403 or 500. That's what makes the app refresh it.
4. **Don't return 4xx for temporary problems.** Database down, overloaded and similar should be
   **5xx** or **429** so the device tries again. Any other 4xx is treated as permanent.
5. **CORS isn't needed for the iOS/Android apps.** They send through native code, not the browser.
   It's only needed if the form is also opened in a web browser: then allow that site's origin
   with headers `Authorization, Content-Type` (including the `OPTIONS` preflight).
6. **Respond within 60 seconds.**

### Quick check with curl

```bash
curl -i -X POST "$API/feedback" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":"6f1c2a9e-3b4d-4c55-9a77-0e8b2f1d4c3a","createdAt":"2026-11-02T07:18:13Z","route":"TEST","tail":null,"name":null,"ratings":{"crew":"good","comfort":null,"catering":null,"overall":"good"},"chooseAgain":true,"comments":null,"crew":null}'
```

Expect `200`/`201` the first time and `200` when the same command is run again.
