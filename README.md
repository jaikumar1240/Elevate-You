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

**Flow:** Book button → lead form (name, WhatsApp, email, status) → lead saved in Firestore → prefilled Razorpay popup → server verifies the payment → prefilled Calendly booking.
Leads who don't pay stay in `/admin` with their stage (form filled / checkout closed / payment failed), so you can call them.

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
   firebase functions:secrets:set CALENDLY_TOKEN       # optional: single-use booking links
   ```
3. Deploy the backend first, then the site:
   ```bash
   cd functions && npm ci && npm test && cd ..
   firebase deploy --only functions,firestore
   firebase deploy --only hosting
   ```
4. **Razorpay webhook** (Dashboard → Webhooks):
   - URL: `https://elevate-personality.web.app/api/razorpay-webhook`
   - Events: `payment.captured`, `order.paid`
   - Secret: same value as `RAZORPAY_WEBHOOK_SECRET`
5. **Calendly:** make the event's first custom question "WhatsApp number". It is prefilled as `a1`.

### Analytics (event dictionary)
| Step | Meta Pixel + CAPI (deduplicated by eventID) | GA4 |
|---|---|---|
| Book button clicked | — (not a conversion) | `select_item`, `lead_form_open` |
| New lead submitted | `Lead` (`lead_<phone>`) | `generate_lead` |
| Razorpay popup opened | `InitiateCheckout` (`checkout_<orderId>`) | `begin_checkout` |
| Payment verified | `Purchase` (`purchase_<paymentId>`) | `purchase` (transaction_id = paymentId) |
| Calendly slot booked | `Schedule` (`schedule_<paymentId>`) | `schedule` |

- **Meta:** optimise campaigns for **Lead**, or for **Purchase** once you get ~50 purchases a week. Test with the `META_TEST_EVENT_CODE` param in Events Manager → Test events.
- **GA4 / Google Ads:**
  - In GA4, mark `generate_lead`, `purchase` and `schedule` as key events.
  - Import them into Google Ads (Goals → Conversions → Import → GA4).
- **UTMs:** tag every ad with `utm_source`, `utm_medium`, `utm_campaign` and `utm_content`. They are stored first-touch on each lead and shown in `/admin`.

### Admin CRM
`https://elevate-personality.web.app/admin` has:
- Google sign-in, limited to jaikumar1240@gmail.com.
- Live leads with funnel stage and source.
- Call and WhatsApp buttons.
- CRM status, follow-up date and notes.
- CSV export.

`server.js` (Express/SQLite) is legacy and is not deployed.
