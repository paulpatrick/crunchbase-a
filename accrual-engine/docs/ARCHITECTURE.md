# Architecture

## Module dependency graph

```
ae_constants ─────────────┐ (imported by everything)
ae_util ──────────────────┤
ae_config ────────────────┤
   │                       │
ae_records ◀── ae_search ──┤
   │            │          │
ae_calc ◀───────┘          │
   │                       │
ae_transactions ◀── ae_audit
   │
ae_actions ──▶ (calc + transactions + records + audit)
   │
ae_workbench_data (read side)
   │
Scripts:  ae_workbench_sl / ae_workbench_cs
          ae_reversal_mr / ae_schedule_gen_mr / ae_accrual_txn_ue
```

Rule of thumb: **field ids live only in `ae_constants`**; **transaction writes
live only in `ae_transactions`**; **status transitions live only in
`ae_actions` + the M/R scripts**. UI never writes records directly — it calls
`ae_actions`.

## Calculation engine (`ae_calc`)

`calculate(rule, ctx) → { quantity, rate, amount, detail }`, normalized across
all calc types:

| Calc type token | Driver | Rate | Amount |
|-----------------|--------|------|--------|
| `fixed_amount` | — | — | rule.fixedAmount |
| `manual_qty_rate` | rule.manualQty | rate table / flat | qty × rate |
| `search_qty_rate` | saved-search sum | rate table / flat | qty × rate |
| `hours_rate` | ctx.hours | rate table / flat | hours × rate |
| `percentage` | basis | pct/100 | basis × pct |
| `formula` | tokens | — | guarded arithmetic (`{qty} {rate} {fixed} {pct} {basis}`) |
| `plugin` | delegated | delegated | delegated module |

Rates resolve through `ae_records.resolveRate` when `rateSource = rate_table`:
the most **specific** effective-dated row wins (location > item > vendor),
protecting historical accuracy as rates change.

## Reversal engine (`ae_reversal_mr`)

Runs daily. Selects accruals where `reversal_status = pending`,
`reversal_date <= today`, and no reversal link exists. For each, if the reversal
date's period is open it creates a negated `Bills - Accruals - Reversal`
mirroring vendor/subsidiary/lines/location/journal-category and links both ways;
if the period is closed (or the accrual is already reversed) it routes the
schedule to **Exceptions**. Idempotent and safe to re-run.

## State machine (schedule status)

```
Draft ─calculate▶ Calculated ─post▶ Posted ─┬─reverse──────▶ Reversed
                                            ├─match(full)──▶ Matched to Bill
                                            ├─match(part)──▶ Partially Matched ─▶ Matched to Bill
                                            ├─convert──────▶ Converted to Bill
                                            └─reverse&reaccrue▶ Reaccrued (+ new Draft next period)
any ─error▶ Exception ─resolve▶ (back to prior state)
```

## Mapping the nine use cases to rules

| # | Use case | Calc type | Frequency | Reversal method | Bill behavior | Notes |
|---|----------|-----------|-----------|-----------------|---------------|-------|
| 1 | Royalty (Caledonia, $5/ton, annual pay) | `search_qty_rate` | `monthly` | `manual` / `none` | `accumulate` | Accrue monthly, settle in March; match bill to accumulated schedules |
| 2 | Fair Oaks fee ($7/ton, monthly bill) | `search_qty_rate` | `monthly` | `on_bill_match` | `match_and_reverse` | Reverse when monthly bill arrives; show variance |
| 3 | Pellet shipping freight (slow bills) | `search_qty_rate` or `manual_qty_rate` | `monthly` | `next_period_first_day` | `match_and_reverse` | Reverse 1st of next month; lookback 5–6 mo; reverse-and-reaccrue |
| 4 | Accrued hauling ($/ton per site) | `search_qty_rate` | `monthly` | `next_period_first_day` | `match_and_reverse` | `rate_source = rate_table`, per-location versioned rates |
| 5 | Access fee ($/ton per site) | `search_qty_rate` | `monthly` | `next_period_first_day` | `match_and_reverse` | Like hauling; site/item filters in the saved search |
| 6 | Quarterly bonus (hours) | `hours_rate` | `quarterly` | `on_bill_match` / `manual` | `match_only` | Driver = hours import; accumulate over quarter |
| 7 | Annual bonus | `fixed_amount` or `percentage` | `annual` (accrued monthly) | `manual` | `match_only` | Monthly estimate + annual true-up via override |
| 8 | Insurance | `fixed_amount` | `monthly` | `next_period_first_day` or `none` | `match_only` | Reverse monthly or amortize (`reversal_method = none`) |
| 9 | Payroll (biweekly, straddles month) | `manual_qty_rate` or `formula` | `monthly` | `next_period_first_day` | `match_and_reverse` | Accrue unpaid days in current period; reverse next month |

The saved searches in use cases 1–5 are authored in NetSuite (accountants own
the shipment/fulfillment logic) and referenced by id on the rule; the engine
injects the period `trandate within` filter and sums the numeric column.

## Audit

`customrecord_accrual_audit` rows are written by `ae_audit.record` on every
calculate/override/post/reverse/match/convert, capturing saved-search id,
quantity, rate, amount, variance, user and timestamp. Overrides require a
reason (enforced in `ae_actions.override`). History is append-only — corrections
are new rows, never overwrites.

## Known limitations / next steps

- **Permissions fail-open** when a custom permission id is not installed
  (MVP convenience). Tighten to fail-closed before production.
- **Rollforward CSV export** is a client stub (`ae_export=T`); wire a
  server-side CSV stream or a saved search for large exports.
- **Bill matching** uses a client prompt for bill id + amount (MVP). The
  `findCandidateBills` query in `ae_search` supports a richer auto-suggest UI
  (the "Match Assistant" in the mockups) as a follow-up.
- **Hours import** (use case 6) currently expects `ctx.hours`; add an import
  record or saved-search hours driver for a fully hands-off quarterly bonus.
- Standard-table access from the external MCP connector is restricted to custom
  records; this does **not** affect deployed SuiteScript, which uses full
  `N/query`.
