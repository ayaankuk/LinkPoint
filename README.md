# Tariff Trace AI (CaseHacks build)

Finds tariff money small Canadian importers are owed. Upload an invoice, the AI reads and classifies every line,
a rules engine finds refunds, the AI drafts the claim, and a licensed broker files it.

## Deploy to your Cloudflare account (about 10 minutes)

```bash
npm install
npx wrangler login                       # opens your browser, sign in to Cloudflare

# 1. Database (copy the database_id it prints into wrangler.jsonc → d1_databases)
npx wrangler d1 create dutyback
npm run db:init                          # creates the tables (re-run it if you deployed an older version: adds the ledger table)

# 2. Private document storage
npx wrangler r2 bucket create dutyback-docs
#    If R2 asks you to enable it with a card and you don't want to, delete the "r2_buckets" block in wrangler.jsonc.

# 3. Tariff index (meaning-based search)
npx wrangler vectorize create dutyback-tariffs --dimensions=768 --metric=cosine

# 4. Ship it
npm run deploy                           # prints your live https://dutyback.<you>.workers.dev link
```

Browser Rendering needs no setup (it's on the Workers Free plan with a small daily allowance); if it isn't available, Origin Detective reads the page text instead.

Then open the live link, click **Seed tariff index** in the footer once (loads the tariff headings into Vectorize).

**Optional, for the audit-trail story:** Cloudflare dashboard → AI → AI Gateway → create a gateway called `dutyback`,
then set `"AI_GATEWAY_ID": "dutyback"` in `wrangler.jsonc` and redeploy. Every AI call is then logged for the broker.

## Demo script (2 minutes)

Sample client: **Lakeshore Windows Inc.**, a fictional Ontario window manufacturer that exports about 30% of production.
One invoice shows every kind of finding:

| Line | What the scan finds | Amount |
|---|---|---|
| Aluminum window frames | Declared as raw extrusion (50%) instead of window frames (25%): wrong code | $8,000 refund |
| Aluminum window frames | 30% of finished windows are exported: drawback | $2,400 refund |
| Insulated glass units | Made in China, shipped from a U.S. warehouse | $4,500 refund |
| Crank and lock kits | Origin missing: Origin Detective finds "Taiwan" on the supplier page | $1,500 (pending until found) |
| Vinyl profiles | Exported share: drawback | $900 refund |
| Steel brackets | Made in Mexico | $2,000 refund |
| U.S.-made frames and vinyl | Avoidable next order by switching suppliers | $7,700 per order |

1. Home page → **Get a free scan** → **Get my free scan**. The app opens and scans Lakeshore's invoices: **$19,300 found**.
2. On the hardware card ("Origin not stated"), click **Find origin evidence**. It reads the supplier page, finds
   "Country of origin: Taiwan", and the $1,500 moves to **Recoverable now** ($19,300 recoverable).
3. **Draft claim** on the glass card → **Send to licensed broker** → open **Broker portal** → **Approve and file** →
   back on the client tab: Filed → Refund received.
4. Scroll to **Government relief you may qualify for** → **Draft my tariff impact summary**.
5. **Admin** → **Run monthly billing**: revenue by stream, paid by clients and by brokers.

The beauty distributor sample is still there as a second, smaller example ($1,700 found).

## Save your free AI allowance

Workers AI's free plan is 10,000 neurons a day, and it resets at 7pm Toronto time (after judging).
While building, set `"MOCK_AI": "1"` in `wrangler.jsonc` (no AI calls; the samples still work through the table reader).
Switch back to `"0"` for the final test and the demo.

Local run: `npx wrangler d1 execute dutyback --local --file=schema.sql` then `npx wrangler dev --local --var MOCK_AI:1`.

## What runs where (for the Cloudflare category)

| Need | Cloudflare piece | Why it isn't decoration |
| --- | --- | --- |
| Read invoices without sending data to an outside AI company | Workers AI (`toMarkdown`, Llama extraction) + R2 | Client trade data stays on one network |
| Match "30in ombre braid" to the right tariff heading | Workers AI embeddings + Vectorize | Keyword search fails on real product names |
| Claims take weeks or months | Workflows (`ClaimWorkflow`) | Durable steps: broker review → filed → refund → bill 20% fee |
| Tariff lists change overnight | Cron trigger + `recheckAll` | Re-checks every saved client and raises alerts |
| Broker needs to see why the AI decided | AI Gateway | Logs every AI request and response |
| Invoices often don't state origin | Browser Rendering (Origin Detective) | Opens the supplier's page, finds "Made in…", screenshots the evidence |
| Relief money exists but owners can't navigate it | Relief matcher + Workers AI | Matches the business to Ontario and federal programs and drafts the impact summary |
| Scans, claims, alerts | D1 | One database next to the code |

## API

- `POST /api/scan` (form: `file` or `text`, `client`, `exportShare` 0–100) → line items, findings, totals
- `POST /api/claim/draft` (`finding`, `line`) → claim summary, broker checklist, supplier email
- `POST /api/claim/send` → starts the claim Workflow; `GET /api/claim/:id` → status
- `POST /api/tariffs/simulate-update` → re-checks saved clients against a changed list (demo)
- `POST /api/origin` (`url`, `finding`, `line`) → origin found on the supplier page, evidence, screenshot, upgraded finding
- `POST /api/relief/draft` → tariff impact summary for a relief application
- `GET /api/broker/claims` → broker queue; `POST /api/broker/claims/:id/file` → broker approves, Workflow resumes, $250 fee booked
- `POST /api/billing/run-monthly` → books $299 monitoring + 20% of avoided surtax per client, and `BROKER_LICENCES` × $1,000
- `GET /api/admin/summary` → revenue by stream and payer, claims pipeline, recent ledger, success fees still pending
- `GET /api/health` → which bindings are live

## Three screens, one management system

| Page | Who | What it does |
|---|---|---|
| `/`, `/how-it-works`, `/brokers`, `/pricing`, `/about` | Everyone | Marketing site (Stitch designs, Tailwind compiled into `public/site.css`, fonts in `public/fonts/`, so no CDN needed on stage) |
| `/start` | Importer | Free scan signup; submitting opens `/app` and runs the scan (sample invoice if no file is attached) |
| `/app` | Importer | Scan invoices, find origin evidence, match relief programs, send claims |
| `/broker.html` | Licensed customs broker | Review prepared claims, approve and file; each filing books a $250 fee |
| `/admin.html` | Tariff Trace AI team | Ledger of every dollar by stream and payer, claims pipeline, monthly billing |

Every fee is written to the D1 `ledger` table as it happens. Prices live in `PRICES` at the top of `src/index.js`;
the number of paying broker firms is the `BROKER_LICENCES` variable in `wrangler.jsonc`.

The broker and admin pages have no login in this build. Before real use, put them behind Cloudflare Access
(Zero Trust → Access → add an application for `/broker.html`, `/admin.html`, `/api/broker/*`, `/api/admin/*`, `/api/billing/*`).

## Using your redacted shipment file

Paste its line items into the text box (a table with Description, Supplier, Qty, Value, Country of origin, Shipped from,
HS declared, Surtax paid works best), or upload the PDF. Check that names, account numbers and addresses are removed first.

## Important

- Tariff rates in `src/tariffs.js` are **demo assumptions**. Before real use, load Finance Canada's published
  counter-tariff list (HS numbers and surtax rates).
- The rules engine (`src/rules.js`) is a starting point; the licensed broker confirms every claim.
- Workflow delays are seconds for the demo (`BROKER_DELAY`, `REFUND_DELAY`); in real life they are days to months.


## Website styling

The Stitch pages originally loaded Tailwind and Google Fonts from CDNs. They now use a compiled `public/site.css`
and self-hosted fonts, so the site looks right even on bad venue Wi-Fi. If you edit classes in those pages, rebuild:
`npx tailwindcss@3 -c tailwind.config.cjs -i site.in.css -o public/site.css --minify` (config and input are in the repo).

Cloudflare resource names (D1 `dutyback`, R2 `dutyback-docs`, Vectorize `dutyback-tariffs`) are internal and unchanged;
the Worker itself is now named `tariff-trace-ai`.
