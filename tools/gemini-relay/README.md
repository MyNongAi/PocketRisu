# Gemini relay

Deploy once in each desired region (`us-central1` and `asia-northeast1`), using the same secret in the app settings:

```sh
gcloud run deploy gemini-relay --source tools/gemini-relay --region <region> --allow-unauthenticated --set-env-vars RELAY_KEY=<secret> --timeout 3600 --memory 256Mi --cpu 1 --concurrency 20 --max-instances 3
```

Use a random secret of at least 16 characters. Enter each deployment's HTTPS URL in the corresponding app setting. The relay accepts only Google Vertex AI and AI Studio hosts.
