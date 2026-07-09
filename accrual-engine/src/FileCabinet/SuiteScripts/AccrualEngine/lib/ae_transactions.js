/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_transactions.js
 * ------------------
 * Creation + linking of the actual NetSuite transactions the engine drives:
 *   - Bills - Accruals            (the accrual)
 *   - Bills - Accruals - Reversal (the reversal, negative)
 *   - Vendor Bill                 (convert-to-bill)
 * plus the schedule <-> transaction wiring and bill matching.
 *
 * Design rule from the spec: one accrual transaction == one vendor + one
 * subsidiary + one accounting period + one journal category. We enforce that
 * here (a rule with multiple journal categories must be split into multiple
 * rules) so downstream reporting stays clean.
 */
define([
    'N/record',
    'N/log',
    './ae_constants',
    './ae_config',
    './ae_util',
    './ae_records',
    './ae_audit'
], function (record, log, C, config, util, records, audit) {
    'use strict';

    var TF = C.TXN_FIELD;
    var SF = C.SCHED_FIELD;

    /* ================================================================== *
     * POST ACCRUAL
     * ================================================================== */
    /**
     * Create a Bills - Accruals transaction for a calculated schedule and wire
     * the two records together.
     *
     * @param {Object} p { rule, schedule, calcResult, amount, tranDate,
     *                      reversalDate, memo }
     * @returns {Number} accrual transaction internal id
     */
    function postAccrual(p) {
        var rule = p.rule;
        var schedule = p.schedule;
        var amount = util.round(p.amount, 2);

        if (!rule.vendor) {
            throw util.accrualError('AE_MISSING_VENDOR',
                'Cannot post an accrual without a vendor (rule "' + rule.name + '").', true);
        }
        if (amount === 0) {
            throw util.accrualError('AE_ZERO_AMOUNT',
                'Refusing to post a zero-amount accrual for rule "' + rule.name + '".', true);
        }

        var txn = record.create({ type: config.accrualType(), isDynamic: true });
        applyHeader(txn, rule, p.tranDate, schedule.period, p.memo);

        // Item vs expense line. Item-driven accruals preserve item/location
        // reporting; otherwise post to the configured expense/COGS account.
        addPrimaryLine(txn, rule, amount, /*qty*/ p.calcResult ? p.calcResult.quantity : 0);

        // Linking + reversal metadata stored on the accrual body.
        txn.setValue({ fieldId: TF.SOURCE_RULE, value: rule.id });
        txn.setValue({ fieldId: TF.SOURCE_SCHEDULE, value: schedule.id });
        txn.setValue({ fieldId: TF.ACCRUAL_PERIOD, value: schedule.period });
        txn.setValue({ fieldId: TF.ACCRUAL_TYPE, value: rule.name });
        txn.setValue({ fieldId: TF.REVERSAL_METHOD, value: rule.reversalMethod });
        if (rule.journalCategory) {
            txn.setValue({ fieldId: TF.JOURNAL_CATEGORY, value: rule.journalCategory });
        }
        if (needsReversal(rule) && p.reversalDate) {
            txn.setValue({ fieldId: TF.REVERSAL_DATE, value: p.reversalDate });
            txn.setValue({ fieldId: TF.REVERSAL_STATUS, value: C.REVERSAL_STATUS.PENDING });
        } else {
            txn.setValue({ fieldId: TF.REVERSAL_STATUS, value: C.REVERSAL_STATUS.NOT_REQUIRED });
        }
        txn.setValue({ fieldId: TF.ACCRUAL_MEMO, value: p.memo || '' });

        var txnId = txn.save({ enableSourcing: true, ignoreMandatoryFields: false });

        // Wire the schedule back to the accrual and advance its status.
        var schedUpdate = {};
        schedUpdate[SF.ACCRUAL_TXN] = txnId;
        schedUpdate[SF.CALC_AMOUNT] = amount;
        schedUpdate[SF.STATUS] = C.SCHED_STATUS.POSTED;
        schedUpdate[SF.LAST_POSTED_DATE] = new Date();
        if (needsReversal(rule) && p.reversalDate) {
            schedUpdate[SF.REVERSAL_DATE] = p.reversalDate;
            schedUpdate[SF.REVERSAL_STATUS] = C.REVERSAL_STATUS.PENDING;
        }
        records.updateSchedule(schedule.id, schedUpdate);

        audit.record({
            schedule: schedule.id, rule: rule.id, action: C.AUDIT_ACTION.POST,
            amount: amount, qty: p.calcResult && p.calcResult.quantity,
            rate: p.calcResult && p.calcResult.rate,
            savedSearch: rule.savedSearch,
            detail: { accrualTxn: txnId, reversalDate: p.reversalDate && util.formatDate(p.reversalDate) }
        });
        return txnId;
    }

    /* ================================================================== *
     * REVERSE ACCRUAL
     * ================================================================== */
    /**
     * Create a Bills - Accruals - Reversal that mirrors an accrual with negated
     * amounts. Copies vendor / subsidiary / lines / location / journal category.
     *
     * @param {Object} p { accrualId, reversalDate, scheduleId, ruleId, memo }
     * @returns {Number} reversal transaction id
     */
    function reverseAccrual(p) {
        if (util.isPeriodClosed(resolvePeriodForDate(p.reversalDate))) {
            throw util.accrualError('AE_REVERSAL_PERIOD_CLOSED',
                'Reversal date ' + util.formatDate(p.reversalDate) +
                ' falls in a closed period.', true);
        }

        var source = record.load({ type: config.accrualType(), id: p.accrualId });

        // Guard against double reversal.
        var existing = source.getValue(TF.REVERSAL_TXN);
        if (existing) {
            throw util.accrualError('AE_ALREADY_REVERSED',
                'Accrual ' + p.accrualId + ' already has reversal ' + existing + '.', true);
        }

        var rev = record.create({ type: config.reversalType(), isDynamic: true });
        rev.setValue({ fieldId: 'entity', value: source.getValue('entity') });
        rev.setValue({ fieldId: 'subsidiary', value: source.getValue('subsidiary') });
        rev.setValue({ fieldId: 'trandate', value: p.reversalDate });
        rev.setValue({ fieldId: 'memo',
            value: p.memo || ('Reversal of accrual ' + source.getValue('tranid') + ' / ' +
                (source.getValue(TF.ACCRUAL_TYPE) || '')) });

        copyLinesNegated(source, rev);

        // Reversal linkage.
        rev.setValue({ fieldId: TF.ORIGINAL_ACCRUAL, value: p.accrualId });
        rev.setValue({ fieldId: TF.SOURCE_RULE, value: source.getValue(TF.SOURCE_RULE) });
        rev.setValue({ fieldId: TF.SOURCE_SCHEDULE, value: source.getValue(TF.SOURCE_SCHEDULE) });
        rev.setValue({ fieldId: TF.JOURNAL_CATEGORY, value: source.getValue(TF.JOURNAL_CATEGORY) });
        rev.setValue({ fieldId: TF.REVERSAL_STATUS, value: C.REVERSAL_STATUS.REVERSED });

        var revId = rev.save({ enableSourcing: true });

        // Point the accrual at its reversal and mark it reversed.
        record.submitFields({
            type: config.accrualType(), id: p.accrualId,
            values: (function () {
                var v = {};
                v[TF.REVERSAL_TXN] = revId;
                v[TF.REVERSAL_STATUS] = C.REVERSAL_STATUS.REVERSED;
                return v;
            })()
        });

        if (p.scheduleId) {
            var su = {};
            su[SF.REVERSAL_TXN] = revId;
            su[SF.REVERSAL_STATUS] = C.REVERSAL_STATUS.REVERSED;
            su[SF.STATUS] = C.SCHED_STATUS.REVERSED;
            records.updateSchedule(p.scheduleId, su);
        }

        audit.record({
            schedule: p.scheduleId, rule: p.ruleId, action: C.AUDIT_ACTION.REVERSE,
            detail: { reversalTxn: revId, accrualTxn: p.accrualId,
                reversalDate: util.formatDate(p.reversalDate) }
        });
        return revId;
    }

    /* ================================================================== *
     * CONVERT TO VENDOR BILL
     * ================================================================== */
    /**
     * Create a real Vendor Bill from an accrual, then reverse the accrual so
     * expense is not double-counted. Marks the schedule Converted to Bill.
     *
     * @param {Object} p { accrualId, scheduleId, ruleId, billDate, reversalDate }
     * @returns {{ billId:Number, reversalId:Number }}
     */
    function convertToBill(p) {
        var source = record.load({ type: config.accrualType(), id: p.accrualId });

        var bill = record.create({ type: record.Type.VENDOR_BILL, isDynamic: true });
        bill.setValue({ fieldId: 'entity', value: source.getValue('entity') });
        bill.setValue({ fieldId: 'subsidiary', value: source.getValue('subsidiary') });
        bill.setValue({ fieldId: 'trandate', value: p.billDate || new Date() });
        bill.setValue({ fieldId: 'memo',
            value: 'Converted from accrual ' + source.getValue('tranid') });
        bill.setValue({ fieldId: TF.SOURCE_SCHEDULE, value: p.scheduleId });
        bill.setValue({ fieldId: TF.SOURCE_RULE, value: p.ruleId });
        bill.setValue({ fieldId: TF.ORIGINAL_ACCRUAL, value: p.accrualId });

        copyLinesToBill(source, bill);
        var billId = bill.save({ enableSourcing: true });

        // Reverse the accrual so the estimate backs out when the real bill posts.
        var reversalId = reverseAccrual({
            accrualId: p.accrualId,
            reversalDate: p.reversalDate || p.billDate || new Date(),
            scheduleId: p.scheduleId,
            ruleId: p.ruleId,
            memo: 'Reversal on conversion of accrual ' + source.getValue('tranid') + ' to bill'
        });

        var su = {};
        su[SF.CONVERTED_BILL] = billId;
        su[SF.STATUS] = C.SCHED_STATUS.CONVERTED;
        records.updateSchedule(p.scheduleId, su);

        audit.record({
            schedule: p.scheduleId, rule: p.ruleId, action: C.AUDIT_ACTION.CONVERT,
            detail: { bill: billId, reversal: reversalId, accrual: p.accrualId }
        });
        return { billId: billId, reversalId: reversalId };
    }

    /* ================================================================== *
     * MATCH BILL
     * ================================================================== */
    /**
     * Link a received vendor bill to an accrual schedule, compute variance and
     * (per rule bill behaviour) reverse the accrual.
     *
     * @param {Object} p { scheduleId, billId, billAmount, partial, ruleId }
     * @returns {{ variance:Number, reversalId:(Number|null), status:String }}
     */
    function matchBill(p) {
        var loaded = records.getSchedule(p.scheduleId);
        var schedule = loaded.data;
        var rule = records.getRule(schedule.rule);

        var accrued = !util.isBlank(schedule.overrideAmount)
            ? Number(schedule.overrideAmount) : schedule.calcAmount;
        var billAmount = util.round(p.billAmount, 2);
        var prevMatched = schedule.matchedAmount || 0;
        var newMatched = util.round(prevMatched + billAmount, 2);
        var variance = util.round(accrued - newMatched, 2);

        var reversalId = null;
        var status;

        if (p.partial || newMatched < accrued - 0.005) {
            status = C.SCHED_STATUS.PARTIALLY_MATCHED;
        } else {
            status = C.SCHED_STATUS.MATCHED;
        }

        // Reverse the accrual when the rule says so and we've fully matched.
        if (rule.billBehavior === C.BILL_BEHAVIOR.MATCH_AND_REVERSE &&
            status === C.SCHED_STATUS.MATCHED &&
            schedule.accrualTxn && !schedule.reversalTxn) {
            reversalId = reverseAccrual({
                accrualId: schedule.accrualTxn,
                reversalDate: new Date(),
                scheduleId: schedule.id,
                ruleId: rule.id,
                memo: 'Reversal on bill match, bill ' + p.billId
            });
        }

        var su = {};
        su[SF.MATCHED_BILL] = p.billId;
        su[SF.MATCHED_AMOUNT] = newMatched;
        su[SF.VARIANCE_AMOUNT] = variance;
        su[SF.STATUS] = (reversalId ? C.SCHED_STATUS.MATCHED : status);
        records.updateSchedule(schedule.id, su);

        // Also stamp the bill so it is traceable from the transaction side.
        try {
            record.submitFields({
                type: record.Type.VENDOR_BILL, id: p.billId,
                values: (function () {
                    var v = {};
                    v[TF.SOURCE_SCHEDULE] = schedule.id;
                    v[TF.SOURCE_RULE] = rule.id;
                    return v;
                })()
            });
        } catch (e) {
            log.audit({ title: 'matchBill: could not stamp bill body fields', details: e.message });
        }

        audit.record({
            schedule: schedule.id, rule: rule.id,
            action: p.partial ? C.AUDIT_ACTION.PARTIAL_MATCH : C.AUDIT_ACTION.MATCH_BILL,
            amount: billAmount, variance: variance,
            detail: { bill: p.billId, matchedTotal: newMatched, reversal: reversalId }
        });

        return { variance: variance, reversalId: reversalId, status: su[SF.STATUS] };
    }

    /* ================================================================== *
     * Shared line/header helpers
     * ================================================================== */

    function applyHeader(txn, rule, tranDate, periodId, memo) {
        txn.setValue({ fieldId: 'entity', value: rule.vendor });
        txn.setValue({ fieldId: 'subsidiary', value: rule.subsidiary });
        txn.setValue({ fieldId: 'trandate', value: tranDate });
        if (periodId) {
            try { txn.setValue({ fieldId: 'postingperiod', value: periodId }); } catch (e) { /* type may auto-post */ }
        }
        if (memo) txn.setValue({ fieldId: 'memo', value: memo });
    }

    /** Add the accrual's single value line (item or expense). */
    function addPrimaryLine(txn, rule, amount, qty) {
        if (rule.item) {
            txn.selectNewLine({ sublistId: 'item' });
            txn.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: rule.item });
            if (qty) txn.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qty });
            txn.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: amount });
            if (rule.location) {
                txn.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: rule.location });
            }
            txn.commitLine({ sublistId: 'item' });
        } else {
            txn.selectNewLine({ sublistId: 'expense' });
            txn.setCurrentSublistValue({ sublistId: 'expense', fieldId: 'account', value: rule.expenseAccount });
            txn.setCurrentSublistValue({ sublistId: 'expense', fieldId: 'amount', value: amount });
            if (rule.location) {
                txn.setCurrentSublistValue({ sublistId: 'expense', fieldId: 'location', value: rule.location });
            }
            txn.commitLine({ sublistId: 'expense' });
        }
    }

    /** Copy every item + expense line from source to target, negating amounts/qty. */
    function copyLinesNegated(source, target) {
        ['item', 'expense'].forEach(function (sublistId) {
            var count = source.getLineCount({ sublistId: sublistId });
            for (var i = 0; i < count; i++) {
                target.selectNewLine({ sublistId: sublistId });
                copyLineFields(source, target, sublistId, i, /*negate*/ true);
                target.commitLine({ sublistId: sublistId });
            }
        });
    }

    /** Copy lines from an accrual onto a vendor bill (positive). */
    function copyLinesToBill(source, bill) {
        ['item', 'expense'].forEach(function (sublistId) {
            var count = source.getLineCount({ sublistId: sublistId });
            for (var i = 0; i < count; i++) {
                bill.selectNewLine({ sublistId: sublistId });
                copyLineFields(source, bill, sublistId, i, /*negate*/ false);
                bill.commitLine({ sublistId: sublistId });
            }
        });
    }

    var LINE_FIELDS = {
        item: ['item', 'quantity', 'rate', 'amount', 'location', 'department', 'class', 'taxcode'],
        expense: ['account', 'amount', 'location', 'department', 'class', 'memo']
    };

    function copyLineFields(source, target, sublistId, i, negate) {
        LINE_FIELDS[sublistId].forEach(function (f) {
            var v = source.getSublistValue({ sublistId: sublistId, fieldId: f, line: i });
            if (v === '' || v === null || v === undefined) return;
            if (negate && (f === 'amount' || f === 'quantity') && !isNaN(Number(v))) {
                v = -Number(v);
            }
            target.setCurrentSublistValue({ sublistId: sublistId, fieldId: f, value: v });
        });
    }

    function needsReversal(rule) {
        return rule.reversalMethod &&
            rule.reversalMethod !== C.REVERSAL_METHOD.NONE &&
            rule.reversalMethod !== C.REVERSAL_METHOD.MANUAL;
    }

    function resolvePeriodForDate(date) {
        return util.resolveAccountingPeriod(date).id;
    }

    return {
        postAccrual: postAccrual,
        reverseAccrual: reverseAccrual,
        convertToBill: convertToBill,
        matchBill: matchBill,
        needsReversal: needsReversal
    };
});
