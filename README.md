# CF Worker Contact + Newsletter for Astro

This Cloudflare Worker exposes two JSON endpoints you can call from an Astro site:

- `POST /api/subscribe` → subscribes an email to Brevo.
- `POST /api/contact` → forwards contact-form payloads to Basin.

Both routes are protected with a per-site `siteKey` and CORS allowlists stored in KV.

## What this gives your Astro project

- A single backend endpoint for newsletter + contact forms.
- CORS protection by origin per site.
- Multi-tenant config in Cloudflare KV (`site:<siteKey>`).
- Honeypot support (`website` field) to quietly drop bot submissions.

---

## 1) Deploy this worker

```bash
npm install
npm run deploy
```

If this is your first deploy, also create and bind a KV namespace in `wrangler.toml`.

Example binding in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SITE_CONFIG"
id = "<your_kv_namespace_id>"
```

---

## 2) Seed site config (required)

Every Astro site that will call the Worker needs a KV record:

- key: `site:<siteKey>`
- value (JSON):

```json
{
  "enabled": true,
  "allowedOrigins": ["https://your-astro-site.com", "http://localhost:4321"],
  "brevo": {
    "apiKey": "<brevo_api_key>",
    "listId": 12
  },
  "basin": {
    "endpoint": "https://usebasin.com/f/xxxxxxxx"
  }
}
```

You can use the included seed script:

```bash
npm run seed:site-config -- \
  --site-key your-site-key \
  --origins https://your-astro-site.com,http://localhost:4321 \
  --brevo-api-key <brevo_api_key> \
  --brevo-list-id 12 \
  --basin-endpoint https://usebasin.com/f/xxxxxxxx
```

---

## 3) Add environment variables to Astro

In your Astro project, define:

```bash
PUBLIC_FORMS_WORKER_URL="https://<your-worker-subdomain>.workers.dev"
PUBLIC_FORMS_SITE_KEY="your-site-key"
```

> `PUBLIC_` vars are safe for client-side usage in Astro/Vite.

---

## 4) Astro contact form implementation (client-side)

Create `src/components/ContactForm.astro`:

```astro
---
const workerUrl = import.meta.env.PUBLIC_FORMS_WORKER_URL;
const siteKey = import.meta.env.PUBLIC_FORMS_SITE_KEY;
---

<form id="contact-form" class="stack" novalidate>
  <label>
    Name
    <input name="name" type="text" autocomplete="name" required />
  </label>

  <label>
    Email
    <input name="email" type="email" autocomplete="email" required />
  </label>

  <label>
    Message
    <textarea name="message" rows="5" required></textarea>
  </label>

  <!-- Honeypot: keep hidden from humans -->
  <input
    name="website"
    type="text"
    tabindex="-1"
    autocomplete="off"
    style="position:absolute;left:-9999px;opacity:0;pointer-events:none;"
    aria-hidden="true"
  />

  <button type="submit">Send message</button>
  <p id="contact-status" role="status" aria-live="polite"></p>
</form>

<script>
  const form = document.querySelector('#contact-form');
  const status = document.querySelector('#contact-status');

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = 'Sending...';

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    try {
      const response = await fetch(`${workerUrl}/api/contact`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-site-key': siteKey,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Unable to send message right now.');
      }

      form.reset();
      status.textContent = 'Thanks! Your message was sent.';
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : 'Unexpected error.';
    }
  });
</script>
```

Then include it on a page, for example `src/pages/contact.astro`:

```astro
---
import ContactForm from '../components/ContactForm.astro';
---

<h1>Contact</h1>
<ContactForm />
```

---

## 5) (Optional) Astro newsletter form implementation

You can reuse the same Worker for newsletter signup:

```astro
---
const workerUrl = import.meta.env.PUBLIC_FORMS_WORKER_URL;
const siteKey = import.meta.env.PUBLIC_FORMS_SITE_KEY;
---

<form id="newsletter-form">
  <label>
    Email
    <input name="email" type="email" required />
  </label>

  <!-- Honeypot -->
  <input name="website" type="text" tabindex="-1" style="position:absolute;left:-9999px;" />

  <button type="submit">Subscribe</button>
  <p id="newsletter-status" role="status" aria-live="polite"></p>
</form>

<script>
  const form = document.querySelector('#newsletter-form');
  const status = document.querySelector('#newsletter-status');

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = Object.fromEntries(new FormData(form).entries());

    const response = await fetch(`${workerUrl}/api/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-site-key': siteKey,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    status.textContent = response.ok && data.ok
      ? 'Subscribed!'
      : (data.error || 'Subscription failed.');
  });
</script>
```

---

## Request/response contract

### `POST /api/contact`

Request headers:

- `content-type: application/json`
- `x-site-key: <siteKey>` (or `?siteKey=` query param)

Request body (example):

```json
{
  "name": "Jane",
  "email": "jane@example.com",
  "message": "Hello!",
  "website": ""
}
```

Success response:

```json
{ "ok": true }
```

Error response shape:

```json
{ "ok": false, "error": "..." }
```

### `POST /api/subscribe`

Request body (example):

```json
{
  "email": "jane@example.com",
  "attributes": {
    "FIRSTNAME": "Jane"
  },
  "website": ""
}
```

---

## Local testing quick checks

```bash
# Contact
curl -i -X POST "http://127.0.0.1:8787/api/contact" \
  -H "Origin: http://localhost:4321" \
  -H "Content-Type: application/json" \
  -H "x-site-key: your-site-key" \
  --data '{"name":"Test","email":"test@example.com","message":"Hello","website":""}'

# Newsletter
curl -i -X POST "http://127.0.0.1:8787/api/subscribe" \
  -H "Origin: http://localhost:4321" \
  -H "Content-Type: application/json" \
  -H "x-site-key: your-site-key" \
  --data '{"email":"test@example.com","website":""}'
```

If you get `Origin not allowed`, verify `allowedOrigins` in KV exactly matches your Astro site origin.
