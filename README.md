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

If you switch to the Razorpay JS SDK later, update `RAZORPAY_CONFIG` in `script.js` with your `key_id` and add `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` to a `.env` file (read on the server side).

### Calendly (optional)
The site does not currently use Calendly — sessions are booked via Razorpay payment or via pre-filled email links. If you re-introduce Calendly, drop the embed URL into `script.js`.

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
