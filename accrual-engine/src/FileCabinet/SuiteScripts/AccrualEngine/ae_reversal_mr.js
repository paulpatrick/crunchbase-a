/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * ae_reversal_mr.js  —  Phase 1: Core Reversal Engine
 * ---------------------------------------------------
 * Runs daily. Finds Bills - Accruals transactions that are due to reverse and
 * creates the matching Bills - Accruals - Reversal, replicating the behaviour
 * NetSuite gives journals natively but which the custom transaction type lacks.
 *
 * Due criteria (getInputData):
 *   - Reversal Date <= today
 *   - Reversal Status is Pending (not already Reversed / Cancelled)
 *   - No linked reversal transaction exists
 *
 * Per accrual (map/reduce):
 *   - If the reversal date's accounting period is open  -> create reversal.
 *   - If the period is closed                            -> route to the
 *     Exceptions queue (schedule status = Exception) and leave the accrual for
 *     a human, never silently skipping it.
 *
 * The script is idempotent: an accrual that already carries a reversal link is
 * filtered out, so a re-run cannot double-reverse.
 */
define([
    'N/search',
    'N/record',
    'N/runtime',
    'N/log',
    './lib/ae_constants',
    './lib/ae_util',
    './lib/ae_transactions',
    './lib/ae_records',
    './lib/ae_audit'
], function (search, record, runtime, log, C, util, txns, records, audit) {
    'use strict';

    var TF = C.TXN_FIELD;

    /**
     * Emit the internal ids of accruals whose reversal is due. Uses a saved,
     * ad-hoc search on the accrual custom transaction type. We resolve the
     * custom transaction type search id from the script parameter so the search
     * is portable.
     */
    function getInputData() {
        var accrualSearchType = getParam('custscript_ae_rev_accrual_type') || C.TXN_TYPE.ACCRUAL;
        var todayStr = util.formatDate(new Date());

        return search.create({
            type: accrualSearchType,
            filters: [
                [TF.REVERSAL_STATUS, 'is', C.REVERSAL_STATUS.PENDING],
                'AND',
                [TF.REVERSAL_DATE, 'onorbefore', todayStr],
                'AND',
                [TF.REVERSAL_TXN, 'anyof', '@NONE@'],
                'AND',
                ['mainline', 'is', 'T']
            ],
            columns: [
                'internalid',
                TF.SOURCE_RULE,
                TF.SOURCE_SCHEDULE,
                TF.REVERSAL_DATE
            ]
        });
    }

    function map(context) {
        var row = JSON.parse(context.value);
        var accrualId = row.id || row.values['internalid'].value || row.values['internalid'];
        var ruleId = flatVal(row.values[TF.SOURCE_RULE]);
        var scheduleId = flatVal(row.values[TF.SOURCE_SCHEDULE]);
        var reversalDate = parseNsDate(flatVal(row.values[TF.REVERSAL_DATE]));

        context.write({
            key: String(accrualId),
            value: JSON.stringify({
                accrualId: accrualId,
                ruleId: ruleId,
                scheduleId: scheduleId,
                reversalDate: reversalDate ? reversalDate.getTime() : null
            })
        });
    }

    function reduce(context) {
        var data = JSON.parse(context.values[0]);
        var reversalDate = data.reversalDate ? new Date(data.reversalDate) : new Date();

        try {
            var revId = txns.reverseAccrual({
                accrualId: data.accrualId,
                reversalDate: reversalDate,
                scheduleId: data.scheduleId,
                ruleId: data.ruleId,
                memo: null
            });
            log.audit({
                title: 'Reversed accrual ' + data.accrualId,
                details: 'Reversal txn ' + revId + ' dated ' + util.formatDate(reversalDate)
            });
        } catch (e) {
            handleReversalFailure(data, e);
        }
    }

    function summarize(summary) {
        var errs = 0;
        summary.mapSummary.errors.iterator().each(function (k, e) {
            log.error({ title: 'map error key ' + k, details: e }); errs++; return true;
        });
        summary.reduceSummary.errors.iterator().each(function (k, e) {
            log.error({ title: 'reduce error key ' + k, details: e }); errs++; return true;
        });
        log.audit({
            title: 'Accrual reversal M/R complete',
            details: 'usage=' + summary.usage + ' concurrency=' + summary.concurrency +
                ' errors=' + errs
        });
    }

    /* ------------------------------------------------------------------ *
     * Failure routing: closed-period or already-reversed problems become
     * Exceptions instead of hard failures, so the daily run always finishes.
     * ------------------------------------------------------------------ */
    function handleReversalFailure(data, e) {
        var isException = e && e.isAccrualException;
        log[isException ? 'audit' : 'error']({
            title: 'Reversal deferred to Exceptions: accrual ' + data.accrualId,
            details: (e && e.message) || e
        });

        try {
            if (data.scheduleId) {
                var upd = {};
                upd[C.SCHED_FIELD.STATUS] = C.SCHED_STATUS.EXCEPTION;
                upd[C.SCHED_FIELD.REVERSAL_STATUS] = C.REVERSAL_STATUS.FAILED;
                upd[C.SCHED_FIELD.EXCEPTION_REASON] = (e && e.message) || String(e);
                records.updateSchedule(data.scheduleId, upd);
            }
            // Flag the accrual too so the Reversals tab shows it as failed.
            record.submitFields({
                type: C.TXN_TYPE.ACCRUAL, id: data.accrualId,
                values: (function () {
                    var v = {}; v[TF.REVERSAL_STATUS] = C.REVERSAL_STATUS.FAILED; return v;
                })()
            });
            audit.record({
                schedule: data.scheduleId, rule: data.ruleId,
                action: C.AUDIT_ACTION.EXCEPTION,
                detail: { accrual: data.accrualId, error: (e && e.message) || String(e) }
            });
        } catch (inner) {
            log.error({ title: 'Failed to record reversal exception', details: inner });
        }
    }

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */
    function getParam(name) {
        try { return runtime.getCurrentScript().getParameter({ name: name }); }
        catch (e) { return null; }
    }

    function flatVal(v) {
        if (v === null || v === undefined) return null;
        if (typeof v === 'object') return v.value !== undefined ? v.value : (v.text || null);
        return v;
    }

    function parseNsDate(v) {
        if (!v) return null;
        if (v instanceof Date) return v;
        var d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});
