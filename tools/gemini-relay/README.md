# Gemini relay

Deploy once in each desired region (`us-central1` and `asia-northeast1`), using the same secret for every deployment:

```sh
gcloud run deploy gemini-relay --source tools/gemini-relay --region <region> --allow-unauthenticated --set-env-vars RELAY_KEY=<secret> --timeout 3600 --memory 256Mi --cpu 1 --concurrency 20 --max-instances 3
```

Or as a Cloudflare Worker, so requests leave from a Cloudflare address instead of a Google Cloud one. `wrangler.toml` places it near `aws:us-east-1`; change `[placement] region` for another region:

```sh
npx wrangler deploy --config tools/gemini-relay/wrangler.toml
npx wrangler secret put RELAY_KEY --config tools/gemini-relay/wrangler.toml
```

`GET /health` on the Worker answers with the Cloudflare data center (`colo`) it ran in.

Use a random secret of at least 16 characters. Enter each deployment's HTTPS URL and the secret in the corresponding app settings, or configure the laptop defaults below. The relay accepts only Google Vertex AI and AI Studio hosts.

For the laptop Node server, copy `gemini-relay.local.example.json` to `gemini-relay.local.json` at the repository root and replace its fake values with the deployed HTTPS URL and a random key of at least 16 characters. The local file is git-ignored. You can omit either region URL or the optional `rotateUrls` array of HTTPS relay URLs. With a relay mode selected, an empty URL or key setting uses the corresponding value from this file. In rotate mode, an empty relay list uses `rotateUrls` from the file, then the US and Japan URL fields if that list is absent or empty. The server reads it on each authenticated request, so edits need no restart. Keep the file private; signed-in clients receive the configured defaults.
