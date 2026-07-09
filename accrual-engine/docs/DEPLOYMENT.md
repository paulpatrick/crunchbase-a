# Deployment Guide

## Prerequisites in the target account

1. **Two custom transaction types** must already exist (they do, per the brief):
   - `Bills - Accruals`  → script id expected: `customtransaction_bills_accruals`
   - `Bills - Accruals - Reversal` → `customtransaction_bills_accruals_rev`

   If your script ids differ, edit `lib/ae_constants.js` → `TXN_TYPE` **before**
   deploying, and update the `<recordtype>` references in
   `Objects/customscript_ae_accrual_txn_ue.xml`.

2. Features enabled: Custom Records, Server & Client SuiteScript, Custom
   Transactions. (Subsidiaries / Locations optional — the engine degrades
   gracefully in a non-OneWorld account; `subsidiary` becomes optional.)

3. SuiteCloud CLI installed (`npm install` in `accrual-engine/`).

## Deploy

> Point the CLI at your **SANDBOX** first. Confirm via
> Setup → Company → Company Information → *Account ID* (a `_SB1` suffix = sandbox).

```bash
cd accrual-engine
npm install
npx suitecloud account:setup            # choose/authenticate the sandbox
npx suitecloud project:validate --server
npx suitecloud project:deploy
```

The deploy pushes, in dependency order:

1. Custom lists (`customlist_ae_*`) — enum tokens.
2. Custom records (rule, rate, schedule, audit).
3. Transaction body fields (`custbody_ae_*`) onto the accrual/reversal types + vendor bills.
4. Script files + Script/Deployment records.

## Post-deploy configuration

1. **Verify transaction-type script ids** resolve — open any accrual and confirm
   the `custbody_ae_*` fields render.
2. **Schedule the reversal engine.** `AE Daily Reversal Engine`
   (`customscript_ae_reversal_mr`) ships as `NOTSCHEDULED`. Set its deployment to
   run **daily** (early AM). Optionally set the `custscript_ae_rev_accrual_type`
   parameter if your accrual type script id is non-default.
3. **Schedule / run the generator.** `AE Schedule Generator`
   (`customscript_ae_schedule_gen_mr`) materialises period schedules from active
   rules. Run it monthly (and quarterly/annually) — or on demand from Saved
   Deployments — with `custscript_ae_gen_autocalc` checked to pre-calculate.
4. **Permissions.** Create custom permissions (or roles) matching the ids in
   `lib/ae_actions.js` → `PERM` (`custperm_ae_calculate`, `_post`, `_reverse`,
   `_match`, `_convert`, `_override`, `_edit_rule`). Administrators bypass all
   checks; if a permission id is absent the action is allowed (fail-open for MVP
   — tighten before go-live).
5. **Workbench access.** `Accrual Workbench` Suitelet
   (`customscript_ae_workbench_sl` / `customdeploy_ae_workbench_sl`) is deployed
   to all roles. Add its URL to a Center tab / menu.

## Seeding rules (via MCP or UI)

Custom records can be created directly through the NetSuite MCP connector
(`ns_createRecord`) or the UI. Minimum viable rule for a fixed monthly accrual:

| Field | Value |
|-------|-------|
| Name | Insurance – General Liability |
| Calculation Type | `fixed_amount` |
| Fixed Amount | 16000 |
| Subsidiary | (your subsidiary) |
| Accrual Account / Expense Account | (GL accounts) |
| Frequency | `monthly` |
| Default Reversal Method | `next_period_first_day` |
| Default Reversal Date Rule | `first_day_next_month` |
| Bill Behavior | `match_only` |

## Smoke test

1. Create one `fixed_amount` rule.
2. Run `AE Schedule Generator` (auto-calc on) → a Draft/Calculated schedule appears.
3. Open **Accrual Workbench → Current Period**, select the schedule, **Post Accrual**.
4. Confirm a `Bills - Accruals` transaction with `custbody_ae_*` links + a reversal date.
5. Set the reversal date to today, run **AE Daily Reversal Engine** → a
   `Bills - Accruals - Reversal` is created and linked; schedule status → Reversed.
