# HYDRAFLEET / HYDRAlink Dashboard

## What is this?

HYDRAlink is the internal web dashboard for **HYDRAFLEET**, a taxi/ride-sharing fleet (~57 vehicles, ~52 drivers) operating on Bolt, Uber, and MyPOS in Austria. The dashboard handles driver settlements, invoice management, and CSV upload processing.

## Tech Stack

- **Frontend**: Single-page HTML/JS app (no framework, vanilla JS)
- **Database**: Supabase (project: `pkxcwfkfaaorwnbdmylg.supabase.co`)
- **Hosting**: Cloudflare Pages — Dashboard läuft auf `hydrafleet.pages.dev` (`hydrafleet.at` ist eine andere Seite, NICHT das Dashboard)
- **Automation**: n8n (self-hosted on Hetzner) — handles CSV processing, invoice PDF generation, Notion sync
- **Driver/Vehicle master data**: Notion (source of truth — never replace)
- **Notifications**: Telegram (implemented but currently deactivated)
- **Fonts**: Fraunces (logo), Inter (UI)
- **Branding**: "HYDRA" bold + "link" in gold (#F5B51B), dark theme default

## Repo Structure

```
index.html          — Login page (PIN-based auth via app_users table)
dashboard.html      — Main dashboard (single file, ~1300 lines)
setup.sql           — Supabase schema for app_users + customers tables
manifest.json       — PWA manifest
sw.js               — Service worker
*.png / *.svg       — App icons and favicons
```

## Dashboard Tabs

The dashboard (`dashboard.html`) has 3 tabs:

1. **Abrechnungen** — Driver settlement overview per week. Filters by week/driver/status. Shows earnings, deductions, payout per driver. Print/share individual settlements via WhatsApp.
2. **Rechnungen** — Invoice creation and archive. Company cards, line items, VAT handling, sequential auto-numbering (HF-YYYY-NNNN). PDF storage in Supabase.
3. **CSV Upload** (AbrBot) — Upload Bolt/Uber/MyPOS CSVs per week. Triggers n8n webhook for processing.

## Key Supabase Tables

- `settlements` — Processed driver settlement data per week
- `fahrer` — Driver records (synced from Notion)
- `rechnungen` — Invoice records with PDF storage
- `companies` — Invoice recipient companies
- `customers` — Customer/company data for Rechnungen tab
- `app_users` — Dashboard login credentials (PIN-based)

## Key n8n Workflows

- **AbrechnungsBot** (`RTeVugetfAjSTPQs`) — CSV settlement processing
- **Fahrer-Sync** (`ERBnlIVSkteL90Bg`) — Notion → Supabase driver sync via webhook
- **Full-Sync** (`bCyUwmFeuoG762yC`) — Full Notion → Supabase sync
- **Webhook endpoints:**
  - Dashboard → n8n: `https://n8n.hydrafleet.at/webhook/abrechnung-upload` + `/webhook/invoice`
  - Notion → n8n (fahrer-sync): `https://webhook.hydrafleet.at/webhook/fahrer-sync`

## Important Patterns & Gotchas

### Code Style
- Everything is in a single HTML file per page (no build step, no bundler)
- CSS variables for theming (light/dark mode via `data-theme` attribute)
- Supabase JS client loaded via CDN, initialized lazily
- All German UI labels ("Fahrer", "Abrechnung", "Rechnung", etc.)

### Known Pitfalls
- **Duplicate form field names** create arrays instead of strings → always sanitize/validate form payloads before sending to n8n
- **Fuzzy name matching** (threshold 0.92) causes "unbekannt" driver errors when CSV names differ from Notion — fix by aligning Notion names, not by building alias systems
- **JSON in HTML**: Escape `<` and `>` as Unicode escapes, strip newlines from user strings to prevent script injection
- **n8n API updates**: Only include `name`, `nodes`, `connections`, `settings` — strip all metadata fields
- **Supabase anon key** is in the frontend (public, RLS-protected) — this is intentional

### Design Principles
- **Keep it simple** — no overengineering. Always offer the simpler path first.
- **Notion stays as source of truth** for driver/vehicle master data
- **Supabase** handles transactional/historical data only
- **Iterate fast** — working solutions over lengthy planning

## Deployment

Push to `main` branch → Cloudflare Pages auto-deploys.

```bash
git add .
git commit -m "description"
git push origin main
```

## External Services

| Service | Purpose | Access |
|---------|---------|--------|
| Supabase | Database + storage | `pkxcwfkfaaorwnbdmylg.supabase.co` |
| n8n | Workflow automation | Self-hosted on Hetzner (Docker) |
| Notion | Driver/vehicle master data | Fuhrpark DB, Fahrer DB |
| Cloudflare Pages | Static hosting | Auto-deploy from GitHub |
| Nginx Proxy Manager | SSL for webhooks | `webhook.hydrafleet.at` |
| Telegram | Driver notifications | Implemented, currently deactivated |
