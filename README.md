# Visual Lexicon Worker

Staging Cloudflare Worker for Visual Lexicon.

## Deploy

Push to the `staging` branch to deploy the staging Worker.

## Required GitHub Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Do not commit secret values.

## Safety

Production deployment is intentionally disabled.

This repo does not configure:

- production routes
- DNS
- billing
- Webflow CMS changes
- api.visuallexicon.org

## Test

After deploy:

/health
