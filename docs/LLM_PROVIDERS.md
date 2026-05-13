# Plumage — LLM provider guide

Plumage routes persona synthesis and response generation through one of six
LLM providers. Picking the right provider/model combo is the single biggest
lever on demo data quality and on cost.

This document lives next to `lib/llm/models.ts` and `lib/llm/pricing.ts`,
which are the **authoritative** registry — when in doubt, trust the code.

## Quick guide for SEs

| Question | Answer |
|---|---|
| What is cheapest? | **Gemini 2.5 Flash-Lite** for both phases. Sub-cent per 100 responses. |
| What is safest for sensitive context? | **Anthropic** or **OpenAI**. Both rated `enterprise_safe`. |
| What is highest quality? | **Claude Sonnet 4.6** (default) or **Claude Opus 4.7** (overkill for most demos). |
| What should I use for personas? | The persona-recommended model for your chosen provider. Haiku, Flash-Lite, or GPT-4o Mini are all fine. |
| What should I use for response generation? | Claude Sonnet 4.6 or Gemini 2.5 Flash for most cases. GPT-4o is a solid OpenAI alternative. |
| Roughly what will this generation cost? | Open the cost-estimator panel on the Configure step — it shows a per-phase + total estimate live as you change settings. |

## Mode glossary

The model registry tags each model with a mode. The setup UI groups models
by mode so you can scan them quickly:

- **Economy** — cheap + business-safe. Default recommendation for cost-sensitive bulk runs.
- **Balanced** — sweet spot of quality and cost. Recommended for response generation.
- **Premium** — highest quality. Reserve for nuanced multilingual or executive-facing demos.
- **Ultra low cost** — DeepSeek and the very cheap nano tiers. Internal demo only.
- **Fast preview** — Groq's open-weight models. Use for a first-pass preview to validate quality before a real run.
- **Advanced** — OpenRouter. Lets you pin any third-party model ID. For power users.

## Provider matrix

| Provider | Best for | Risk | Notes |
|---|---|---|---|
| **Anthropic** | Polished demos, nuanced responses | enterprise_safe | Haiku for personas, Sonnet for responses. Default. |
| **OpenAI** | Familiar workflows, JSON reliability | enterprise_safe | GPT-4o Mini / GPT-4o pair. GPT-4.1 + GPT-5 variants available. |
| **Google Gemini** | Cost-sensitive bulk runs, multilingual | business_safe | Flash-Lite is the recommended economy default. Free tier exists for testing; paid tier preferred. |
| **DeepSeek** | Ultra-cheap bulk demo data | internal_demo_only | **Avoid sensitive customer/prospect context.** |
| **Groq** | First-pass preview runs | internal_demo_only | Open-weight models, extremely fast. Validate quality before final demos. |
| **OpenRouter** | Pinning a specific third-party model | business_safe | Pin exact model IDs (e.g. `anthropic/claude-3.5-haiku`). Avoid random/free fallback routing. |

## Recommended defaults

The registry sets `defaultForPersona` / `defaultForResponse` on one model per
provider per phase. When the user picks a provider in the setup UI, both
models default to those entries. Current picks:

| Provider | Persona default | Response default |
|---|---|---|
| Anthropic | Claude Haiku 4.5 | Claude Sonnet 4.6 |
| OpenAI | GPT-4o Mini | GPT-4o |
| Google | Gemini 2.5 Flash-Lite | Gemini 2.5 Flash-Lite |
| DeepSeek | DeepSeek Chat | DeepSeek Chat |
| Groq | GPT-OSS 20B | GPT-OSS 120B |
| OpenRouter | Custom model ID | Custom model ID |

The setup store starts on **Anthropic** for backward compatibility with
existing tests. The UI highlights **Google Gemini** as "Recommended for most
SEs" via the badge on the provider card — picking it gives you the cheapest
verified end-to-end setup.

## Pricing — verification

All prices are USD per 1M tokens (input / output). Values live in
`lib/llm/pricing.ts` with a `verifiedAt: YYYY-MM` field per model.

| Provider | Last verified |
|---|---|
| Anthropic | 2026-05 (official) |
| OpenAI 4o + 4.1 | 2026-05 |
| OpenAI 5 family | 2026-05 (manual — verify on your account) |
| Google Gemini | 2026-05 (manual) |
| DeepSeek | 2026-05 (manual) |
| Groq | 2026-05 (manual) |

**Recheck quarterly.** Provider pricing changes more often than expected.
When a price changes:
1. Update the entry in `lib/llm/pricing.ts`.
2. Bump `verifiedAt`.
3. If the model is no longer offered, set `deprecated: true` in
   `lib/llm/models.ts` so the dropdown stops listing it.

If a model has no pricing entry, the cost-estimator returns
`unknownPricing: true` for that phase and the UI shows "Pricing
unavailable" instead of fabricating a number.

## API keys — security model

**Plumage never persists API keys.** This is non-negotiable:

- Keys live in the in-memory Zustand `setup-store` only.
- Refreshing the browser clears all keys — by design.
- Saved Demo Profiles never include keys (the schema literally has no field for them).
- The server reads keys from the request body and uses them once per call. They are never logged.

When adding a new provider, do not introduce env-var fallbacks. The internal
team should re-enter their keys per session. Convenient persistence is not
worth the data-handling risk.

## Data-handling guidance per provider

Always follow your organization's data-handling policy. Plumage's UI
surfaces a per-provider risk badge under the API-key input — read it.

- **`enterprise_safe`** — usable with normal customer-facing prep work.
- **`business_safe`** — usable for general demo work; provider has a clear DPA
  but may retain content under a free tier.
- **`internal_demo_only`** — use for non-confidential demo context only. Do
  not paste prospect names, account details, or internal strategy.
- **`experimental`** — ad-hoc or hobby providers. Never paste sensitive
  context.

DeepSeek and Groq are flagged `internal_demo_only`. Use them for speed/cost
wins on generic demo data — not for any customer-specific work.

## Adding a new provider

1. Append the provider id to `LLM_PROVIDERS` in `lib/llm/models.ts`.
2. Add a `ProviderMeta` entry: label, blurb, API key hint, concurrency,
   risk note, default-models marker, accent class.
3. Add at least one model with `defaultForPersona` and `defaultForResponse`.
4. Add pricing in `lib/llm/pricing.ts` (or omit if unknown — the estimator
   handles that path).
5. Add the dispatcher case in `lib/llm/json-call.ts`:
   - If the provider uses OpenAI's chat-completions wire format, point it
     at the existing `callOpenAICompatible` helper with a config object.
   - Otherwise add a dedicated `callX` function similar to `callGoogle`.
6. Make sure JSON output is reliable — either via a native `response_format`
   parameter or via a prompt that produces clean JSON (Plumage strips
   ``` fences automatically).
7. Run `pnpm typecheck && pnpm lint && pnpm build`.
8. Manually test connection + a small persona run before merging.

## Adding a new model to an existing provider

1. Add it to the `MODELS` array in `lib/llm/models.ts` with full metadata.
2. Add pricing (or omit + leave a TODO comment if unknown).
3. If it should be the new recommended default, set `defaultForPersona` or
   `defaultForResponse` and clear the same flag on the previous default.
4. Update `MODEL_SPEED_TPS` in `lib/generation/cost-estimator.ts` if you
   have a credible TPS estimate.

## OpenRouter — custom model IDs

The OpenRouter provider supports any model ID OpenRouter exposes. The UI
ships a "Custom model ID" sentinel option that reveals a text input for the
upstream ID (e.g. `anthropic/claude-3.5-haiku`). Plumage forwards that ID
verbatim to OpenRouter's `/v1/chat/completions` endpoint.

Curated suggestions (also available in the dropdown):
- `anthropic/claude-3.5-haiku` — solid persona model
- `google/gemini-2.5-flash` — solid response model

**Avoid `:free` and random-router fallback variants** for production-like
demo data. Pin specific provider routes for repeatability.
