# DebugYourCareer

A mobile-first website for booking 1:1 career coaching sessions for Indian students and recent graduates. ₹89 diagnosis sessions, resume reviews, mock interviews, and placement-prep packs — booked online via Razorpay.

## What it does

- Sells five tiers of paid coaching (₹89 → ₹1,499) with Razorpay-hosted payment links
- Captures user details and session bookings into a lightweight SQLite store
- Exposes an admin dashboard at `/admin` for viewing users, payments, and event analytics
- Tracks page-views, payment completions, and bookings via custom events (Google Analytics / Facebook Pixel ready)

## Quick start

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Tech

- **Frontend:** Static HTML + CSS + vanilla JS (no framework)
- **Backend:** Express (Node 14+), SQLite via `sqlite3`
- **Payments:** Razorpay payment-button links (no SDK integration yet — the buttons go straight to hosted checkout)
- **Hosting:** Firebase Hosting (config in `firebase.json` / `.firebaserc`)

## Project layout

```
.
├── index.html                  # Main landing page
├── styles.css                  # All styles
├── script.js                   # Mobile menu, FAQ toggle, Razorpay fallback
├── server.js                   # Express + SQLite API
├── admin.html                  # Admin dashboard
├── view_db.py                  # CLI utility to inspect the SQLite DB
├── personality_sessions.db     # Local SQLite database (auto-created)
├── package.json
├── firebase.json / .firebaserc # Firebase Hosting config
└── assets/                     # Images + favicon
```

## Configuration

### Razorpay
The Razorpay payment-button URLs are hardcoded in `index.html` (search for `razorpay.com/payment-button`). To use your own, replace the `pl_…` IDs with your payment-link IDs from the Razorpay dashboard.

If you switch to the Razorpay JS SDK later, add your `key_id` in `script.js` and put `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` in a `.env` file (read on the server side).

**Important:** In the Razorpay dashboard, set each payment button's success redirect URL to `https://<your-domain>/?payment=success` so the booking flow below triggers when the user returns.

### Calendly
After a successful payment, `script.js` detects the `?payment=success` redirect, reveals the **Book your slot** section, and embeds the Calendly scheduler inline. Set your event URL in `script.js` under `BOOKING_CONFIG.url` (currently `https://calendly.com/jaikumar1240/debugyourcareer`).

### Analytics
Paste your GA4 / Facebook Pixel snippets into the `<head>` of `index.html`. Custom events fired by `script.js`:
- `page_view` — page visits
- `payment_completed` — successful payments
- `details_submitted` — form submission
- `session_booked` — booking confirmed

## API endpoints

| Method | Path                              | Purpose                       |
|--------|-----------------------------------|-------------------------------|
| GET    | `/`                               | Serve the landing page        |
| POST   | `/api/users`                      | Create or update a user       |
| GET    | `/api/users/:email`               | Fetch user by email           |
| GET    | `/api/users`                      | List all users (admin)        |
| POST   | `/api/events`                     | Track an analytics event      |
| GET    | `/api/analytics`                  | Aggregate analytics data      |
| POST   | `/api/sessions`                   | Create a session              |
| GET    | `/api/users/:userId/sessions`     | List a user's sessions        |
| PUT    | `/api/sessions/:sessionId`        | Update session status         |

## Database

SQLite, stored at `personality_sessions.db` (legacy filename — kept to avoid breaking the existing schema). Three tables:

- **users** — id, email, name, phone, age, profession, goals, experience, payment_method, payment_amount, payment_status, session_booked, session_id, created_at, updated_at
- **events** — id, user_id, event_name, event_data, timestamp
- **sessions** — id, user_id, session_date, session_type, status, notes, created_at

For production, swap to PostgreSQL or MySQL.

## Customising plans

The five pricing tiers live in the `#plans` section of `index.html`. To change price or copy:
- Update the `<span class="plan-amount">` and `<span class="plan-period">` for the card
- Update the mailto `subject` and `body` to match the new price
- For the ₹89 plan, the `<a href>` points to a Razorpay payment-button URL — update that too if the price changes

## Deployment

The repo is configured for **Firebase Hosting** (`firebase.json`). To deploy:

```bash
firebase deploy
```

Alternative targets — Vercel, Heroku, or any static-friendly host — work too. Only `server.js` requires Node; the rest is static.

## License

MIT

## Lead-first booking funnel (Firebase)

**Flow:** Book button → lead form (name, WhatsApp, email, status) → lead saved in Firestore → prefilled Razorpay popup → server verifies the payment → compact paid confirmation → prefilled Calendly page in the **same tab**.
Leads who don't pay stay in `/admin` with their stage (form filled / checkout closed / payment failed), so you can call them.

After payment, the same browser retains a "Continue booking" link without charging again. Refresh/Back never automatically redirects. If local storage is unavailable, the immediate link and redirect still work; WhatsApp support can recover the paid booking. There is no dependency on Calendly's embed JavaScript or browser popup permissions.

**Payment reminder:** about 30 minutes after an unpaid form submission, the `paymentReminders` function (runs every 10 min) emails the lead once from your Gmail. The email has a one-click link (`/?resume=<token>`) that reopens the form already filled in, plus a WhatsApp help link. Leads older than 24h are skipped. Clicks show up in the lead's timeline in `/admin` and as the GA4 event `reminder_click`.

### One-time setup
1. In the Firebase console (project `elevate-personality`):
   - Enable **Firestore** (region asia-south1).
   - Turn on **Authentication → Google** sign-in.
2. Set the secrets. Enter `none` to switch an integration off.
   ```bash
   firebase functions:secrets:set RAZORPAY_KEY_ID
   firebase functions:secrets:set RAZORPAY_KEY_SECRET
   firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET
   firebase functions:secrets:set META_CAPI_TOKEN      # Events Manager → Pixel → Settings → Conversions API
   firebase functions:secrets:set GMAIL_APP_PASSWORD   # Google account → App passwords (for lead/payment alerts)
   firebase functions:secrets:set CALENDLY_TOKEN       # keep "none"; optional single-use links are separate from sync
   firebase functions:secrets:set CALENDLY_SYNC_TOKEN --project elevate-personality
   firebase functions:secrets:set GA4_API_SECRET --project elevate-personality
   ```
   Enter secrets only at the CLI's private prompt, never in chat, frontend code, or Git:
   - **Calendly Free:** Profile menu → Developer → Personal access tokens (or Integrations if Developer is unavailable). Create a token with `users:read`, `event_types:read`, and `scheduled_events:read`; the last scope includes invitee reads. This is `CALENDLY_SYNC_TOKEN`, not the optional single-use-link token.
   - **GA4:** Admin → Data streams → the web stream `G-TQDPKWBBW0` → Measurement Protocol API secrets → Create. Store the secret value as `GA4_API_SECRET`.
   - Both new secrets are bound only to `bookingSync`; they are not added to the public `api` function. Missing secret versions must be configured before deployment.
   Set these non-secret values in `functions/.env.elevate-personality` before a non-interactive deployment:
   ```dotenv
   GA4_MEASUREMENT_ID=G-TQDPKWBBW0
   GA4_BOOKING_DEBUG=false
   ```
3. Deploy the backend first, then the site:
   ```bash
   cd functions && npm ci && npm test && cd ..
   firebase deploy --only functions,firestore
   firebase deploy --only hosting
   ```
   Firebase Hosting deploys exclude hidden directories and logs. The Hosting emulator serves from the repository root and does not apply those exclusions; keep it bound to localhost.
   Automatic cleanup of old function images is disabled in `elevate-personality`; monitor Artifact Registry storage and configure retention when appropriate.
4. **Razorpay webhook** (Dashboard → Webhooks):
   - URL: `https://elevate-personality.web.app/api/razorpay-webhook`
   - Events: `payment.captured`, `order.paid`
   - Secret: same value as `RAZORPAY_WEBHOOK_SECRET`
5. **Calendly:** make the event's first custom question "WhatsApp number". It is prefilled as `a1`.

### Initial booking synchronization

`bookingSync` runs every five minutes. Each invocation examines at most 20 due payments and makes at most 50 Calendly requests, preserving pagination progress and backing off on errors/rate limits. Fair due-time ordering avoids repeatedly favoring new payments. A full unmatched scan waits ten minutes before checking again; no expiry is imposed on paid booking entitlement. Polling incurs Firebase reads/execution costs.

Each payment has an opaque reference passed in Calendly's `utm_term`. Original ad UTMs, including the original keyword, remain unchanged in Firestore. Confirmation requires that reference, the configured event type, the snapshotted email, active event/invitee status, and a creation timestamp after payment. Browser `/api/booked` assertions cannot mark a booking confirmed. Transactions/leases prevent duplicate history entries, and older payments cannot overwrite a newer payment's lead status.

This records **initial booking only**, not live appointment status. Use Calendly for cancellations/rescheduling. Old paid-but-unbooked records gain a reference when a fresh link is issued; uncorrelated historical bookings need manual review. Legacy browser-confirmed bookings are labeled separately in the CRM and are not automatically backfilled as API-confirmed conversions. Returning customers with such records are asked to check their confirmation email or contact support instead of being prompted to book again.

The worker uses single-field `bookingSyncAt` and `conversionAt` due-time queries; Firestore's default single-field indexes suffice. No new composite index is required.

### Analytics (event dictionary)
| Step | Meta | GA4 |
|---|---|---|
| Book button clicked | — (not a conversion) | `select_item`, `lead_form_open` |
| New lead submitted | `Lead` (`lead_<phone>`) | `generate_lead` |
| Razorpay popup opened | `InitiateCheckout` (`checkout_<orderId>`) | `begin_checkout` |
| Payment verified | `Purchase` (`purchase_<paymentId>`) | `purchase` (transaction_id = paymentId) |
| API-confirmed initial booking | Server-only `Schedule` (`schedule_<paymentId>`) | Server-only `schedule` |

- Lead and Purchase retain their existing browser/server behavior. Schedule is produced only after API confirmation, never on a redirect, calendar open, or browser message.
- **Meta:** test with `META_TEST_EVENT_CODE` in Events Manager → Test events. Retries reuse `schedule_<paymentId>`. Bookings outside the seven-day send window are visibly skipped rather than restamped.
- **GA4 / Google Ads:**
  - Real `client_id` and available `session_id` are read through `gtag('get', ...)`, without waiting for analytics during submission/navigation. Missing IDs remain missing; phone-derived lead IDs are never used as Google user IDs.
  - The payload contains no name, email, phone, or prefilled booking URL. Explicit `ga-disable-G-TQDPKWBBW0`, Do Not Track, Global Privacy Control, and `window.dycAnalyticsConsent` are honored at capture/submission. An existing consent manager can set `analyticsStorage`, `adUserData`, and `adPersonalization` to `GRANTED`/`DENIED` on that object. Contact-form consent does not grant analytics consent.
  - Bookings older than 72 hours are skipped; session association is included only within the session's 24-hour window. Platform attribution/processing and browser blocking still apply.
  - `accepted` means HTTP acceptance, **not verified reporting**. Ambiguous network sends and interrupted GA4 sends are flagged for review and are not automatically resent. Custom events do not have a general exactly-once delivery guarantee.
  - Verify payloads first with `sendGa4Booking({ ..., validateOnly: true })`, which uses `/debug/mp/collect` and does not ingest events or validate the API secret. For a designated test booking, set `GA4_BOOKING_DEBUG=true` in `functions/.env`, deploy the function, and confirm `schedule` in DebugView. Remove the debug setting after verification.
  - After confirming reporting, mark `schedule` as a GA4 key event. If importing to Google Ads (Goals → Conversions → Import → GA4), first check for an existing booking conversion to avoid duplicate actions. Campaign goals/bidding are not changed by this code.
- **UTMs:** tag every ad with `utm_source`, `utm_medium`, `utm_campaign` and `utm_content`. They are stored first-touch on each lead and shown in `/admin`.

### Rollout and recovery

Run the Node.js 22 backend tests, configure both private secrets, then deploy Functions/Firestore before Hosting. Verify an agreed test-mode payment/booking and its Meta Test Events/GA4 reporting before treating the integration as live. Do not create real charges or appointments as an automated check.

For real transaction-concurrency coverage, use Java 21+ and the local Firestore emulator (the test hardcodes an isolated demo project and never calls Calendly/analytics):
```bash
firebase emulators:exec --project demo-dyc-booking --only firestore \
  'cd functions && node --test test/booking-emulator.test.js'
```
The ordinary `cd functions && npm test` run skips this one emulator-only test when no emulator is configured.

`/admin` shows each recent payment's pending/error/review/confirmed sync state and independent Meta/GA4 delivery states. `ambiguous_match`, `missing_booking_identity`, or `legacy_booking_unverified` needs review rather than guessed association; `unconfirmed_booking` means conversions were held because no API confirmation exists. Stale booked records are removed from the polling queue so they cannot block other payments. Authentication failures and rate limits retain the paid state and apply shared backoff. Conversion failures cannot undo a booking or send the customer back to payment. The initial-booking KPI is a historical milestone, not an appointment-status guarantee.

For missing credentials, configure the secret and redeploy `bookingSync`; retryable delivery states are revisited automatically. Do not blindly reset a GA4 `ambiguous`/`rejected` state: check reporting and request history first. The admin displays up to the latest 2,000 leads/payments; use Firestore for older records.

### Admin CRM
`https://elevate-personality.web.app/admin` has:
- Google sign-in, limited to jaikumar1240@gmail.com.
- Live leads with funnel stage and source.
- Call and WhatsApp buttons.
- CRM status, follow-up date and notes.
- CSV export.

`server.js` (Express/SQLite) is legacy and is not deployed.
