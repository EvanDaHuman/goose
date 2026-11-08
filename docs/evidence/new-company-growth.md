# Live company research, November 7, 2026

Goose added **one new public repository prospect, one conditional qualification and one unsent outreach draft** through a live Naïve workflow. The successful recovery cycle took **19 seconds** and cost **$0.014628** in metered Naïve usage. All three research attempts together cost **$1.035874**, including the failed first attempt, within the unchanged **$2 daily growth allowance**.

This proves a working research and internal drafting path. It does not establish a customer, purchasing intent, a completed assessment of that repository, or paid demand. Nothing was sent to the project or its maintainers. The eight pre-existing prospect records have no new discovery session and are excluded from this result.

## What happened

| Attempt | Outcome | Metered cost |
| --- | --- | ---: |
| Initial live search | Found useful public source material but kept searching, reached repeated iteration limits and exhausted its task allowance without a structured result | $1.005013 terminal meter |
| Bounded retry | All provider web searches and fetches returned HTTP 429; the agent correctly returned an empty list | $0.016233 |
| Public-source fallback | Host fetched three public GitHub documents; Naïve assessed their excerpts; guarded results produced one prospect and one internal template draft | $0.014628 |
| Total | Failed attempts remain in the ledger and event history | **$1.035874** |

The first cycle originally reported **$0.978762 over 424 seconds**. Its saved terminal provider event later showed **$1.005013**, a **$0.026251** difference. The existing session and cost record were reconciled to that terminal meter with a separate audit event; the original cycle summary was retained. The terminal stop reason was `budget_paused`. A recovery intervention of **three founder minutes** was recorded. This figure is an operations intervention entry, not the time spent building the product.

The retry finished at `2026-11-08T00:03:38Z`, equivalent to November 7 in the configured Pacific timezone. Its transcript contains seven provider HTTP 429 responses and two repeated-call blocks. It created no prospect. Repeated model calls could not resolve the unavailable retrieval provider.

## Successful recovery and provenance

The initial agent had discovered [kingsdigitallab/pbw-django](https://github.com/kingsdigitallab/pbw-django), the Django version of the Prosopography of the Byzantine World. Recovery retained its public URLs rather than inventing a lead. The new fallback independently fetched repository metadata, its [requirements file](https://raw.githubusercontent.com/kingsdigitallab/pbw-django/master/requirements.txt), and its [README](https://raw.githubusercontent.com/kingsdigitallab/pbw-django/master/README.md) without authentication.

The host performed **four requests**, with three successful documents and one expected `pyproject.toml` HTTP 404. Retrieval timestamps were `2026-11-08T00:09:34Z`. The requirements file declared `django>=3.2.5` and `wagtail>=2.9,<3`; the README described Django 3.2.5. A minimum dependency constraint does not establish what version is deployed. Goose stores that uncertainty explicitly.

| Source | SHA256 of fetched response bytes |
| --- | --- |
| Repository metadata | `0b2c44931147dfc187196b518ad7ecea0616a047a69c7b5ce29ee56501d5c677` |
| requirements.txt | `80c941eb079518e1f8fe54fa262a4ce315c447df36514f60722217f04a9a24bb` |
| README.md | `753fb74336998843679c7da06c5436df2022a163886acffc72ea4d83696bb89d` |

Naïve session `ses_kgb71pw9dbr7r0cdmtn4708dej` completed at `2026-11-08T00:09:52Z`. It selected a potential Django upgrade assessment from the supplied excerpts. The result passed guards requiring every stored evidence quote to occur in the fetched page for that same repository. Generated names and factual summaries were discarded in favor of host-fetched repository metadata. Agent hypotheses about compatibility remain marked as unverified.

The resulting prospect is **Medium**, with an explicit requirement for executable assessment of the runtime, dependencies and acceptance contract. No customer relationship or purchasing budget is asserted. Its provenance is `Naive assessment of host-fetched evidence`. Its draft is attributed to `template`, states that deployed versions are unknown, and requests an assessment rather than promising an upgrade. Prospect outreach remains unsent and requires separate exact-message authorization.

The original successful cycle event counted zero separate qualification-stage calls because qualification happened inside the research assessment. A subsequent explicit audit entry corrected the summary to count the integrated qualification. The original event remains visible. Future cycles count integrated qualification directly.

## Durable evidence

The running checkout retains:

- `var/research/failed-session.json`, the original unsuccessful session transcript.
- `var/company/naive/ses_xzrhtmrw4ytbq6ttzny12xwz4t.jsonl`, its terminal usage and budget stop.
- `var/company/naive/ses_7q701s0gf122s48e9zeqe0pg6e.jsonl`, the provider-rate-limit retry.
- `var/company/research/public-sources-1794096573.json`, fetched excerpts, URLs, hashes, timestamps and the 404.
- `var/company/naive/ses_kgb71pw9dbr7r0cdmtn4708dej.jsonl`, the successful live assessment.
- `var/evidence/new-company-growth.json`, sanitized database provenance and cost evidence.
- `var/evidence/new-company-growth-before-summary-reconciliation.json`, the previous summary and draft snapshot.

These are local operational traces. The committed document reports their results without publishing credentials or private customer data.

## Bounds and verification

`lib/publicResearch.ts` allows only credential-free HTTPS requests to `github.com`, `api.github.com` and `raw.githubusercontent.com`. It sends no authorization headers or cookies, follows at most two redirects while checking each target, limits each response to 128 KiB and eight seconds, and caps each collection at five repositories and ten source requests. Excerpts are at most 6,000 characters. No downloaded repository code executes.

A prior rate-limit transcript triggers the fallback. It uses the original recovery URLs when available. Otherwise it can make one unauthenticated public [GitHub repository search](https://docs.github.com/en/rest/search/search#search-repositories), then inspect public [repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository). That future-discovery branch is covered by mocked contract tests; this live demonstration used recovered URLs. GitHub can also rate limit or become unavailable, in which case Goose records the retrieval errors and does not fabricate prospects.

The fallback uses one bounded Naïve assessment, records its cost against the growth allowance, and uses a conditional local template for the internal draft. Retrieval provenance is separate from agent judgment. All six new public-research tests and six existing growth-rule tests passed, including redirect rejection, unauthenticated headers, response limits, private repository exclusion, quote/source verification and conditional draft wording. TypeScript passed after these changes.
