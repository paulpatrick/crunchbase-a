# NetSuite Accrual Engine / Accrual Workbench

A reusable, configuration-driven accrual platform for NetSuite, built on
SuiteScript 2.1 + custom transaction types. It replicates and improves the
journal-style **auto-reversal** that the custom `Bills - Accruals` transaction
type lacks, and adds accrual rules, period schedules, bill matching, convert-to-bill,
reverse-and-reaccrue, a liability rollforward, and a full audit trail.

New accruals are (mostly) **configuration, not code**: a Rule + Rate + reversal
behaviour + bill behaviour. The nine use cases in the brief (royalty, Fair Oaks
fee, pellet shipping freight, hauling, access fee, quarterly/annual bonus,
insurance, payroll) are all expressible as rules.

> This project lives in `accrual-engine/` alongside an unrelated legacy scraper
> (`scraper.rb`) that predates it and is untouched.

---

## The chain

```
Accrual Rule ─▶ Accrual Schedule (period instance) ─▶ Bills-Accrual txn
                                                          │
                                    ┌─────────────────────┼─────────────────────┐
                                    ▼                     ▼                      ▼
                          Reversal txn           Matched Vendor Bill     Converted Vendor Bill
```

Every generated transaction links back to its **rule** and **schedule** for
auditability (body fields `custbody_ae_source_rule` / `custbody_ae_source_schedule`).

---

## Repository layout

```
accrual-engine/
├── src/
│   ├── manifest.xml                     SDF account-customization manifest
│   ├── deploy.xml                       what gets deployed
│   ├── FileCabinet/SuiteScripts/AccrualEngine/
│   │   ├── lib/
│   │   │   ├── ae_constants.js          record/field ids + enum tokens (single source of truth)
│   │   │   ├── ae_config.js             runtime resolution of custom transaction type ids
│   │   │   ├── ae_util.js               date/period math, period resolution, memo templating, typed errors
│   │   │   ├── ae_records.js            typed data-access + versioned rate resolution
│   │   │   ├── ae_search.js             saved-search quantity drivers + candidate-bill lookup
│   │   │   ├── ae_calc.js               calculation engine (7 calc types)
│   │   │   ├── ae_transactions.js       post / reverse / convert / match transaction layer
│   │   │   ├── ae_audit.js              append-only audit trail
│   │   │   ├── ae_actions.js            command layer (permission-gated) used by the workbench
│   │   │   └── ae_workbench_data.js     read-side queries for the workbench
│   │   ├── ae_reversal_mr.js            Phase 1: daily reversal Map/Reduce
│   │   ├── ae_schedule_gen_mr.js        Phase 2/3: period schedule generator
│   │   ├── ae_accrual_txn_ue.js         Phase 1: defaults reversal fields on direct edits
│   │   ├── ae_workbench_sl.js           Phase 2-5: Accrual Workbench Suitelet
│   │   └── ae_workbench_cs.js           workbench client script
│   └── Objects/
│       ├── customrecord_accrual_rule.xml
│       ├── customrecord_accrual_rate.xml
│       ├── customrecord_accrual_schedule.xml
│       ├── customrecord_accrual_audit.xml
│       ├── customlist_ae_*.xml          enum lists (value names ARE the engine tokens)
│       ├── custbody_ae_*.xml            transaction body linking/reversal fields
│       └── customscript_ae_*.xml        script + deployment records
├── suitecloud.config.js
├── package.json
└── docs/
    ├── ARCHITECTURE.md
    └── DEPLOYMENT.md
```

---

## Build phases (status)

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Core reversal engine — reversal fields, reversal M/R, auto-linking | ✅ implemented |
| 2 | Accrual Rule + Schedule records, workbench list/detail, fixed & manual×rate | ✅ implemented |
| 3 | Saved-search quantity drivers, exceptions | ✅ implemented |
| 4 | Bill matching + convert-to-bill + reverse-and-reaccrue | ✅ implemented |
| 5 | Liability rollforward + audit reporting | ✅ implemented (CSV export stub) |

MVP calc types (Fixed, Manual Qty×Rate, Saved-Search Qty×Rate) are complete;
Hours×Rate and Percentage share the same shape; Formula and Plug-in are wired
as extension points.

---

## Key design decisions

- **One accrual == one vendor + one subsidiary + one accounting period + one
  journal category.** Journal category is kept at header level; rules that span
  categories are split. This keeps GL reporting clean.
- **Enum portability.** Fields the engine *compares* (calc type, frequency,
  reversal method, …) are custom lists whose **value names are the engine
  tokens**, read via `getText()`. Status fields the engine *writes*
  (schedule/reversal status) are free-form text storing tokens. Fields that are
  just passed through (vendor, item, period, accounts) are normal List/Record.
  Net effect: the engine logic is account-independent and never depends on
  numeric internal ids.
- **Exceptions, never silent skips.** Closed-period reversals, empty saved
  searches, missing rates, etc. move the schedule to the **Exceptions** queue
  with a reason, so nothing disappears at month-end.
- **Idempotency.** The schedule generator never creates a second schedule for
  the same rule+period; the reversal M/R never double-reverses (it filters out
  accruals that already carry a reversal link).
- **Auditability.** `customrecord_accrual_audit` captures the inputs behind
  every number (saved-search id, qty, rate, amount, variance, user, timestamp);
  history is append-only.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for detail and
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) to deploy.

---

## Deploy (short version)

```bash
cd accrual-engine
npm install
npx suitecloud account:setup           # authenticate to the target account (use SANDBOX)
npx suitecloud project:validate --server
npx suitecloud project:deploy
```

Then set the two custom-transaction-type script ids in
`lib/ae_constants.js` → `TXN_TYPE` if they differ from
`customtransaction_bills_accruals` / `_rev`, and schedule
`AE Daily Reversal Engine` to run daily.
