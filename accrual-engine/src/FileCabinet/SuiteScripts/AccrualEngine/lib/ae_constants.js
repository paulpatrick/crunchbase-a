/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_constants.js
 * ---------------
 * Single source of truth for every record id, field id and enumerated value
 * used by the Accrual Engine. Every other module imports from here so that a
 * schema change is made in exactly one place.
 *
 * Naming conventions
 *   customrecord_accrual_rule      -> field prefix custrecord_ar_
 *   customrecord_accrual_rate      -> field prefix custrecord_art_
 *   customrecord_accrual_schedule  -> field prefix custrecord_as_
 *   Bills - Accruals transactions  -> body field prefix custbody_ae_
 *
 * Enumerated values (calc types, statuses, ...) are backed by NetSuite custom
 * lists. The engine only ever compares against the *script id* of a list value
 * (the values in the ENUM objects below), never the raw internal id, so the
 * code is portable across accounts.
 */
define([], function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Custom record types
     * ------------------------------------------------------------------ */
    var RECORD = {
        RULE: 'customrecord_accrual_rule',
        RATE: 'customrecord_accrual_rate',
        SCHEDULE: 'customrecord_accrual_schedule',
        AUDIT: 'customrecord_accrual_audit'
    };

    /* ------------------------------------------------------------------ *
     * Custom transaction types (created in the target account by the admin).
     * The engine resolves these to internal ids at runtime via ae_config.
     * ------------------------------------------------------------------ */
    var TXN_TYPE = {
        ACCRUAL: 'customtransaction_bills_accruals',
        REVERSAL: 'customtransaction_bills_accruals_rev'
    };

    /* ------------------------------------------------------------------ *
     * Accrual Rule fields
     * ------------------------------------------------------------------ */
    var RULE_FIELD = {
        NAME: 'name',
        INACTIVE: 'isinactive',
        VENDOR: 'custrecord_ar_vendor',
        SUBSIDIARY: 'custrecord_ar_subsidiary',
        ITEM: 'custrecord_ar_item',
        LOCATION: 'custrecord_ar_location',
        JOURNAL_CATEGORY: 'custrecord_ar_journal_category',
        ACCRUAL_ACCOUNT: 'custrecord_ar_accrual_account',
        EXPENSE_ACCOUNT: 'custrecord_ar_expense_account',
        CALC_TYPE: 'custrecord_ar_calc_type',
        QTY_SOURCE_TYPE: 'custrecord_ar_qty_source_type',
        SAVED_SEARCH: 'custrecord_ar_saved_search',
        MANUAL_QTY: 'custrecord_ar_manual_qty',
        FIXED_AMOUNT: 'custrecord_ar_fixed_amount',
        RATE: 'custrecord_ar_rate',
        RATE_SOURCE: 'custrecord_ar_rate_source',
        PERCENTAGE: 'custrecord_ar_percentage',
        PERCENT_BASIS: 'custrecord_ar_percent_basis',
        FORMULA: 'custrecord_ar_formula',
        PLUGIN_SCRIPT: 'custrecord_ar_plugin_script',
        FREQUENCY: 'custrecord_ar_frequency',
        START_DATE: 'custrecord_ar_start_date',
        END_DATE: 'custrecord_ar_end_date',
        REVERSAL_METHOD: 'custrecord_ar_reversal_method',
        REVERSAL_DATE_RULE: 'custrecord_ar_reversal_date_rule',
        BILL_BEHAVIOR: 'custrecord_ar_bill_behavior',
        LOOKBACK_MONTHS: 'custrecord_ar_lookback_months',
        MEMO_TEMPLATE: 'custrecord_ar_memo_template',
        OWNER: 'custrecord_ar_owner',
        APPROVER: 'custrecord_ar_approver',
        STATUS: 'custrecord_ar_status',
        VARIANCE_THRESHOLD: 'custrecord_ar_variance_threshold'
    };

    /* ------------------------------------------------------------------ *
     * Accrual Rate (child of rule) fields
     * ------------------------------------------------------------------ */
    var RATE_FIELD = {
        RULE: 'custrecord_art_rule',
        EFF_START: 'custrecord_art_eff_start',
        EFF_END: 'custrecord_art_eff_end',
        LOCATION: 'custrecord_art_location',
        ITEM: 'custrecord_art_item',
        RATE: 'custrecord_art_rate',
        UOM: 'custrecord_art_uom',
        VENDOR: 'custrecord_art_vendor',
        NOTES: 'custrecord_art_notes'
    };

    /* ------------------------------------------------------------------ *
     * Accrual Schedule / period instance fields
     * ------------------------------------------------------------------ */
    var SCHED_FIELD = {
        NAME: 'name',
        RULE: 'custrecord_as_rule',
        PERIOD: 'custrecord_as_period',
        PERIOD_START: 'custrecord_as_period_start',
        PERIOD_END: 'custrecord_as_period_end',
        STATUS: 'custrecord_as_status',
        CALC_QTY: 'custrecord_as_calc_qty',
        CALC_RATE: 'custrecord_as_calc_rate',
        CALC_AMOUNT: 'custrecord_as_calc_amount',
        OVERRIDE_AMOUNT: 'custrecord_as_override_amount',
        OVERRIDE_QTY: 'custrecord_as_override_qty',
        OVERRIDE_REASON: 'custrecord_as_override_reason',
        ACCRUAL_TXN: 'custrecord_as_accrual_txn',
        REVERSAL_TXN: 'custrecord_as_reversal_txn',
        MATCHED_BILL: 'custrecord_as_matched_bill',
        CONVERTED_BILL: 'custrecord_as_converted_bill',
        REVERSAL_DATE: 'custrecord_as_reversal_date',
        REVERSAL_STATUS: 'custrecord_as_reversal_status',
        VARIANCE_AMOUNT: 'custrecord_as_variance_amount',
        MATCHED_AMOUNT: 'custrecord_as_matched_amount',
        CREATED_BY: 'custrecord_as_created_by',
        LAST_CALC_DATE: 'custrecord_as_last_calc_date',
        LAST_POSTED_DATE: 'custrecord_as_last_posted_date',
        EXCEPTION_REASON: 'custrecord_as_exception_reason',
        PREV_SCHEDULE: 'custrecord_as_prev_schedule',
        NEXT_SCHEDULE: 'custrecord_as_next_schedule',
        NOTES: 'custrecord_as_notes'
    };

    /* ------------------------------------------------------------------ *
     * Transaction body fields (shared by accrual + reversal + downstream
     * vendor bills that the engine touches).
     * ------------------------------------------------------------------ */
    var TXN_FIELD = {
        SOURCE_RULE: 'custbody_ae_source_rule',
        SOURCE_SCHEDULE: 'custbody_ae_source_schedule',
        ORIGINAL_ACCRUAL: 'custbody_ae_original_accrual',
        REVERSAL_TXN: 'custbody_ae_reversal_txn',
        MATCHED_BILL: 'custbody_ae_matched_bill',
        CONVERTED_BILL: 'custbody_ae_converted_bill',
        REVERSAL_DATE: 'custbody_ae_reversal_date',
        REVERSAL_STATUS: 'custbody_ae_reversal_status',
        REVERSAL_METHOD: 'custbody_ae_reversal_method',
        ACCRUAL_PERIOD: 'custbody_ae_accrual_period',
        ACCRUAL_TYPE: 'custbody_ae_accrual_type',
        JOURNAL_CATEGORY: 'custbody_ae_journal_category',
        ACCRUAL_MEMO: 'custbody_ae_accrual_memo'
    };

    var AUDIT_FIELD = {
        SCHEDULE: 'custrecord_aa_schedule',
        RULE: 'custrecord_aa_rule',
        ACTION: 'custrecord_aa_action',
        USER: 'custrecord_aa_user',
        TIMESTAMP: 'custrecord_aa_timestamp',
        SAVED_SEARCH: 'custrecord_aa_saved_search',
        QTY: 'custrecord_aa_qty',
        RATE: 'custrecord_aa_rate',
        AMOUNT: 'custrecord_aa_amount',
        VARIANCE: 'custrecord_aa_variance',
        DETAIL: 'custrecord_aa_detail'
    };

    /* ------------------------------------------------------------------ *
     * Enumerations. Values are the *script ids* of the backing custom list
     * values, so engine logic is account-independent.
     * ------------------------------------------------------------------ */
    var CALC_TYPE = {
        FIXED_AMOUNT: 'fixed_amount',
        MANUAL_QTY_RATE: 'manual_qty_rate',
        SEARCH_QTY_RATE: 'search_qty_rate',
        HOURS_RATE: 'hours_rate',
        PERCENTAGE: 'percentage',
        FORMULA: 'formula',
        PLUGIN: 'plugin'
    };

    var QTY_SOURCE = {
        MANUAL: 'manual',
        SAVED_SEARCH: 'saved_search',
        HOURS_IMPORT: 'hours_import',
        NONE: 'none'
    };

    var FREQUENCY = {
        MONTHLY: 'monthly',
        QUARTERLY: 'quarterly',
        ANNUAL: 'annual'
    };

    var REVERSAL_METHOD = {
        NEXT_PERIOD_FIRST_DAY: 'next_period_first_day', // reverse on first day of following period
        SAME_AS_DATE: 'on_reversal_date',               // reverse on the stored reversal date
        ON_BILL_MATCH: 'on_bill_match',                 // reverse only when a bill is matched
        MANUAL: 'manual',                               // never auto-reverse
        NONE: 'none'                                     // amortizing / no reversal
    };

    var REVERSAL_DATE_RULE = {
        FIRST_DAY_NEXT_MONTH: 'first_day_next_month',
        LAST_DAY_NEXT_MONTH: 'last_day_next_month',
        SPECIFIC_DATE: 'specific_date',
        PERIOD_END: 'period_end'
    };

    var BILL_BEHAVIOR = {
        MATCH_AND_REVERSE: 'match_and_reverse',   // reverse accrual when bill arrives
        MATCH_ONLY: 'match_only',                 // link bill, keep accrual open
        ACCUMULATE: 'accumulate',                 // annual settlement, match at year end
        CONVERT: 'convert'                        // accrual is converted into the bill
    };

    var RATE_SOURCE = {
        RULE: 'rule',                 // flat rate stored on the rule
        RATE_TABLE: 'rate_table'      // versioned customrecord_accrual_rate lookup
    };

    /* Schedule life-cycle statuses */
    var SCHED_STATUS = {
        DRAFT: 'draft',
        CALCULATED: 'calculated',
        POSTED: 'posted',
        REVERSED: 'reversed',
        PARTIALLY_MATCHED: 'partially_matched',
        MATCHED: 'matched_to_bill',
        CONVERTED: 'converted_to_bill',
        REACCRUED: 'reaccrued',
        CLOSED: 'closed',
        EXCEPTION: 'exception'
    };

    /* Reversal life-cycle (independent of schedule status) */
    var REVERSAL_STATUS = {
        NOT_REQUIRED: 'not_required',
        PENDING: 'pending',
        REVERSED: 'reversed',
        FAILED: 'failed',
        CANCELLED: 'cancelled'
    };

    /* Audit action codes */
    var AUDIT_ACTION = {
        CALCULATE: 'calculate',
        RECALCULATE: 'recalculate',
        OVERRIDE: 'override',
        POST: 'post',
        UPDATE: 'update',
        REVERSE: 'reverse',
        REVERSE_REACCRUE: 'reverse_reaccrue',
        MATCH_BILL: 'match_bill',
        PARTIAL_MATCH: 'partial_match',
        CONVERT: 'convert',
        EXCEPTION: 'exception',
        CANCEL_REVERSAL: 'cancel_reversal'
    };

    return {
        RECORD: RECORD,
        TXN_TYPE: TXN_TYPE,
        RULE_FIELD: RULE_FIELD,
        RATE_FIELD: RATE_FIELD,
        SCHED_FIELD: SCHED_FIELD,
        TXN_FIELD: TXN_FIELD,
        AUDIT_FIELD: AUDIT_FIELD,
        CALC_TYPE: CALC_TYPE,
        QTY_SOURCE: QTY_SOURCE,
        FREQUENCY: FREQUENCY,
        REVERSAL_METHOD: REVERSAL_METHOD,
        REVERSAL_DATE_RULE: REVERSAL_DATE_RULE,
        BILL_BEHAVIOR: BILL_BEHAVIOR,
        RATE_SOURCE: RATE_SOURCE,
        SCHED_STATUS: SCHED_STATUS,
        REVERSAL_STATUS: REVERSAL_STATUS,
        AUDIT_ACTION: AUDIT_ACTION
    };
});
