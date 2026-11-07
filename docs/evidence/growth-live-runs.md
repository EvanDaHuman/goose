# Growth agents: first live runs (2026-11-07)

Two growth cycles with the live agents on Naive (model `z-ai/glm-5.3-flash`), started with `npm run growth`. Figures are from the
company database (`events`, `naive_sessions`, `cost_entries` and `prospects`, all with no job). Nothing was sent: no e-mail
provider is connected and every draft is stored in `/ops/company`.

| | Run 1 | Run 2 (after the fix) |
| --- | --- | --- |
| New prospects found by the research agent | 0 kept (3 submitted, lost by a bug) | 3 |
| Qualified by the qualification agent / by local rules | 5 / 3 | 4 / 2 |
| Drafts by the outreach agent / by the template | 2 / 3 | 5 / 1 |
| Metered cost | $0.1156 | $0.1392 |
| Duration | 741 s | 498 s |

## What run 1 found
- **Results lost when a session ended idle.** 6 of 14 sessions submitted a valid structured result but were recorded as "ended
  without a structured result", including the research agent's 3 confirmed prospects. Naive carries the result of a session that
  ends `idle` on its final `session.idle` event, not on the session object. Fixed in `lib/naive/run.ts`; this runner is shared by
  the delivery agents, so it affected them too. In run 2 no session lost its result.
- **The outreach guard was too strict about the name.** It rejected a good draft addressed to "the Bethel web applications team"
  because the full name "Bethel University" was missing. It now needs one distinctive word of the name.

## Prospects the research agent found (run 2)
Each has public evidence with a URL and a public organisational contact channel (GitHub issues); the guard rejects personal
e-mail addresses and phone numbers.

| Prospect | Qualification |
| --- | --- |
| [JustFixNYC, tenants2](https://github.com/JustFixNYC/tenants2) | High, `django-lts-upgrade` |
| [Archives Portal Europe Foundation, Topic-Detection](https://github.com/ArchivesPortalEuropeFoundation/Topic-Detection) | Medium, `flask-inplace-upgrade` |
| [National Center for Genome Resources, virtualgenome](https://github.com/adf-ncgr/virtualgenome) | Medium, `flask-inplace-upgrade` |

## The guards at work (run 2)
- Two qualifications were rejected because a reason cited a source outside the prospect's public pages; local rules were used.
- One draft (JustFixNYC) was rejected because it linked to a page that was not part of the prospect's evidence; the template was used.

## Not shown by these runs
- Whether any organisation would reply or buy: nobody has been contacted.
- How well the agents' High/Medium/Low scores predict a real fit: there are no outcomes to compare them with yet.
