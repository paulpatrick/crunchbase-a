/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * ae_accrual_txn_ue.js  —  Phase 1
 * --------------------------------
 * Deploy on BOTH custom transaction types (Bills - Accruals and
 * Bills - Accruals - Reversal). Keeps the reversal metadata coherent when a
 * user creates or edits an accrual directly (outside the workbench):
 *
 *   beforeSubmit  - default a Reversal Date from the rule's reversal-date rule
 *                   when the method requires one and the user left it blank;
 *                   default Reversal Status to Pending / Not Required.
 *   afterSubmit   - on a manually created accrual, if it points at a schedule
 *                   but the schedule does not yet point back, wire the link so
 *                   the workbench and rollforward stay consistent.
 */
define([
    'N/record',
    'N/log',
    './lib/ae_constants',
    './lib/ae_util',
    './lib/ae_records',
    './lib/ae_transactions'
], function (record, log, C, util, records, txns) {
    'use strict';

    var TF = C.TXN_FIELD;
    var SF = C.SCHED_FIELD;

    function beforeSubmit(context) {
        if (context.type === context.UserEventType.DELETE) return;
        var rec = context.newRecord;

        // Only manage reversal metadata on the accrual type, not the reversal.
        var ruleId = rec.getValue(TF.SOURCE_RULE);
        var method = rec.getValue(TF.REVERSAL_METHOD);
        var status = rec.getValue(TF.REVERSAL_STATUS);
        var revDate = rec.getValue(TF.REVERSAL_DATE);

        // Nothing to do if the transaction isn't engine-managed.
        if (!ruleId && !method && !revDate) return;

        try {
            var rule = ruleId ? records.getRule(ruleId) : null;
            var effectiveMethod = method || (rule && rule.reversalMethod);

            var requiresReversal = effectiveMethod &&
                effectiveMethod !== C.REVERSAL_METHOD.NONE &&
                effectiveMethod !== C.REVERSAL_METHOD.MANUAL;

            if (requiresReversal) {
                if (util.isBlank(revDate) && rule) {
                    var tranDate = rec.getValue('trandate') || new Date();
                    var bounds = util.periodBounds(rule.frequency, C, tranDate);
                    var computed = util.computeReversalDate(
                        rule.reversalDateRule, C, bounds.end, null);
                    rec.setValue({ fieldId: TF.REVERSAL_DATE, value: computed });
                }
                if (util.isBlank(status)) {
                    rec.setValue({ fieldId: TF.REVERSAL_STATUS, value: C.REVERSAL_STATUS.PENDING });
                }
                if (util.isBlank(rec.getValue(TF.REVERSAL_METHOD)) && effectiveMethod) {
                    rec.setValue({ fieldId: TF.REVERSAL_METHOD, value: effectiveMethod });
                }
            } else if (util.isBlank(status)) {
                rec.setValue({ fieldId: TF.REVERSAL_STATUS, value: C.REVERSAL_STATUS.NOT_REQUIRED });
            }
        } catch (e) {
            // Never block a save because of defaulting; log for review.
            log.error({ title: 'ae_accrual_txn_ue.beforeSubmit', details: e });
        }
    }

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.CREATE) return;
        var rec = context.newRecord;
        var scheduleId = rec.getValue(TF.SOURCE_SCHEDULE);
        if (!scheduleId) return;

        try {
            var loaded = records.getSchedule(scheduleId);
            if (!loaded.data.accrualTxn) {
                var upd = {};
                upd[SF.ACCRUAL_TXN] = rec.id;
                if (loaded.data.status === C.SCHED_STATUS.DRAFT ||
                    loaded.data.status === C.SCHED_STATUS.CALCULATED) {
                    upd[SF.STATUS] = C.SCHED_STATUS.POSTED;
                    upd[SF.LAST_POSTED_DATE] = new Date();
                }
                records.updateSchedule(scheduleId, upd);
            }
        } catch (e) {
            log.error({ title: 'ae_accrual_txn_ue.afterSubmit link', details: e });
        }
    }

    return {
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});
