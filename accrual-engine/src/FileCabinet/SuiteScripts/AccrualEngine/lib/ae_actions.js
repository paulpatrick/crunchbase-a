/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_actions.js
 * -------------
 * The engine's command layer. Every workbench button ultimately calls one of
 * these functions. They orchestrate calc + transaction + audit, enforce the
 * "overrides require a reason" rule, and check role permissions before acting.
 *
 * Keeping this here (not in the Suitelet) means the same commands can be driven
 * from a scheduled script, a RESTlet, or a unit test.
 */
define([
    'N/runtime',
    'N/record',
    './ae_constants',
    './ae_util',
    './ae_records',
    './ae_calc',
    './ae_transactions',
    './ae_audit'
], function (runtime, record, C, util, records, calc, txns, audit) {
    'use strict';

    var SF = C.SCHED_FIELD;

    /* ------------------------------------------------------------------ *
     * Permission model. Maps an action to a role-permission checkbox on the
     * employee/role; for MVP we gate on a small set of custom permission
     * script-ids resolved from runtime. Admins pass everything.
     * ------------------------------------------------------------------ */
    var PERM = {
        calculate: 'custperm_ae_calculate',
        post: 'custperm_ae_post',
        reverse: 'custperm_ae_reverse',
        match: 'custperm_ae_match',
        convert: 'custperm_ae_convert',
        override: 'custperm_ae_override',
        edit_rule: 'custperm_ae_edit_rule'
    };

    function assertPermission(action) {
        var user = runtime.getCurrentUser();
        if (user.role === 3 /* Administrator */) return; // admin bypass
        var permId = PERM[action];
        if (!permId) return;
        // runtime.User.getPermission returns a runtime.Permission level for the
        // custom permission attached to the user's role.
        var granted = runtime.Permission.FULL;
        try { granted = user.getPermission({ name: permId }); } catch (e) { /* perm not installed -> allow */ }
        if (granted === runtime.Permission.NONE) {
            throw util.accrualError('AE_PERM_DENIED',
                'You do not have permission to ' + action + ' accruals.', false);
        }
    }

    /* ================================================================== *
     * CALCULATE / RECALCULATE
     * ================================================================== */
    function calculate(scheduleId) {
        assertPermission('calculate');
        var loaded = records.getSchedule(scheduleId);
        var schedule = loaded.data;
        var rule = records.getRule(schedule.rule);

        var ctx = {
            periodStart: schedule.periodStart && new Date(schedule.periodStart),
            periodEnd: schedule.periodEnd && new Date(schedule.periodEnd),
            asOfDate: schedule.periodEnd && new Date(schedule.periodEnd),
            location: rule.location, item: rule.item, vendor: rule.vendor
        };

        try {
            var result = calc.calculate(rule, ctx);
            var upd = {};
            upd[SF.CALC_QTY] = result.quantity;
            upd[SF.CALC_RATE] = result.rate;
            upd[SF.CALC_AMOUNT] = result.amount;
            upd[SF.STATUS] = C.SCHED_STATUS.CALCULATED;
            upd[SF.LAST_CALC_DATE] = new Date();
            upd[SF.EXCEPTION_REASON] = '';
            records.updateSchedule(scheduleId, upd);

            audit.record({
                schedule: scheduleId, rule: rule.id,
                action: schedule.status === C.SCHED_STATUS.CALCULATED
                    ? C.AUDIT_ACTION.RECALCULATE : C.AUDIT_ACTION.CALCULATE,
                qty: result.quantity, rate: result.rate, amount: result.amount,
                savedSearch: rule.savedSearch, detail: result.detail
            });
            return { ok: true, amount: result.amount, quantity: result.quantity, rate: result.rate };
        } catch (e) {
            routeException(scheduleId, rule.id, e);
            return { ok: false, error: (e && e.message) || String(e) };
        }
    }

    /* ================================================================== *
     * OVERRIDE (requires reason)
     * ================================================================== */
    function override(scheduleId, amount, qty, reason) {
        assertPermission('override');
        if (util.isBlank(reason)) {
            throw util.accrualError('AE_OVERRIDE_NO_REASON',
                'An override requires a reason/note.', false);
        }
        var upd = {};
        if (!util.isBlank(amount)) upd[SF.OVERRIDE_AMOUNT] = util.round(Number(amount), 2);
        if (!util.isBlank(qty)) upd[SF.OVERRIDE_QTY] = Number(qty);
        upd[SF.OVERRIDE_REASON] = reason;
        records.updateSchedule(scheduleId, upd);

        var loaded = records.getSchedule(scheduleId);
        audit.record({
            schedule: scheduleId, rule: loaded.data.rule, action: C.AUDIT_ACTION.OVERRIDE,
            amount: upd[SF.OVERRIDE_AMOUNT], qty: upd[SF.OVERRIDE_QTY],
            detail: { reason: reason }
        });
        return { ok: true };
    }

    /* ================================================================== *
     * POST
     * ================================================================== */
    function post(scheduleId) {
        assertPermission('post');
        var loaded = records.getSchedule(scheduleId);
        var schedule = loaded.data;
        var rule = records.getRule(schedule.rule);

        if (schedule.accrualTxn) {
            throw util.accrualError('AE_ALREADY_POSTED',
                'Schedule ' + scheduleId + ' already has accrual ' + schedule.accrualTxn + '.', false);
        }

        var calcResult = {
            quantity: schedule.calcQty, rate: schedule.calcRate, amount: schedule.calcAmount
        };
        var amount = calc.effectiveAmount(calcResult, schedule);
        var tranDate = schedule.periodEnd ? new Date(schedule.periodEnd) : new Date();

        var reversalDate = schedule.reversalDate ? new Date(schedule.reversalDate) : null;
        if (!reversalDate && txns.needsReversal(rule)) {
            var bounds = util.periodBounds(rule.frequency, C, tranDate);
            reversalDate = util.computeReversalDate(rule.reversalDateRule, C, bounds.end, null);
        }

        var memo = util.renderMemo(rule.memoTemplate || '{rule} {period}', {
            rule: rule.name, vendor: rule.vendor, period: schedule.period,
            qty: schedule.calcQty, rate: schedule.calcRate, amount: amount
        });

        var txnId = txns.postAccrual({
            rule: rule, schedule: schedule, calcResult: calcResult,
            amount: amount, tranDate: tranDate, reversalDate: reversalDate, memo: memo
        });
        return { ok: true, accrualTxn: txnId, amount: amount };
    }

    /* ================================================================== *
     * REVERSE  /  REVERSE & REACCRUE
     * ================================================================== */
    function reverse(scheduleId, reversalDate) {
        assertPermission('reverse');
        var loaded = records.getSchedule(scheduleId);
        var schedule = loaded.data;
        if (!schedule.accrualTxn) {
            throw util.accrualError('AE_NO_ACCRUAL',
                'Schedule has no accrual transaction to reverse.', false);
        }
        var revId = txns.reverseAccrual({
            accrualId: schedule.accrualTxn,
            reversalDate: reversalDate || new Date(),
            scheduleId: scheduleId, ruleId: schedule.rule
        });
        return { ok: true, reversalTxn: revId };
    }

    /**
     * Reverse the current accrual and create the next period's schedule, copying
     * the rule assumptions so the user can update qty/rate and re-post. Links
     * old -> new via prev/next schedule fields.
     */
    function reverseAndReaccrue(scheduleId) {
        assertPermission('reverse');
        var loaded = records.getSchedule(scheduleId);
        var schedule = loaded.data;
        var rule = records.getRule(schedule.rule);

        // 1. reverse current
        var revId = null;
        if (schedule.accrualTxn && !schedule.reversalTxn) {
            revId = txns.reverseAccrual({
                accrualId: schedule.accrualTxn, reversalDate: new Date(),
                scheduleId: scheduleId, ruleId: rule.id,
                memo: 'Reverse & reaccrue'
            });
        }

        // 2. next period bounds
        var curEnd = schedule.periodEnd ? new Date(schedule.periodEnd) : new Date();
        var nextAnchor = util.firstDayNextMonth(curEnd);
        var bounds = util.periodBounds(rule.frequency, C, nextAnchor);
        var nextPeriod = util.resolveAccountingPeriod(bounds.end);

        var existing = records.findScheduleForPeriod(rule.id, nextPeriod.id);
        var newScheduleId = existing || records.createSchedule({
            rule: rule.id, period: nextPeriod.id,
            periodStart: bounds.start, periodEnd: bounds.end,
            status: C.SCHED_STATUS.DRAFT,
            reversalDate: txns.needsReversal(rule)
                ? util.computeReversalDate(rule.reversalDateRule, C, bounds.end, null) : null,
            reversalStatus: txns.needsReversal(rule) ? C.REVERSAL_STATUS.PENDING : C.REVERSAL_STATUS.NOT_REQUIRED,
            name: rule.name + ' — ' + nextPeriod.name,
            prevSchedule: scheduleId
        });

        // 3. carry prior calc assumptions onto the new schedule
        var carry = {};
        carry[SF.CALC_QTY] = schedule.calcQty;
        carry[SF.CALC_RATE] = schedule.calcRate;
        carry[SF.CALC_AMOUNT] = schedule.calcAmount;
        carry[SF.STATUS] = C.SCHED_STATUS.CALCULATED;
        records.updateSchedule(newScheduleId, carry);

        // 4. link back
        var link = {}; link[SF.NEXT_SCHEDULE] = newScheduleId;
        link[SF.STATUS] = C.SCHED_STATUS.REACCRUED;
        records.updateSchedule(scheduleId, link);

        audit.record({
            schedule: scheduleId, rule: rule.id, action: C.AUDIT_ACTION.REVERSE_REACCRUE,
            detail: { reversal: revId, nextSchedule: newScheduleId, nextPeriod: nextPeriod.name }
        });
        return { ok: true, reversalTxn: revId, nextSchedule: newScheduleId };
    }

    /* ================================================================== *
     * MATCH BILL  /  CONVERT TO BILL
     * ================================================================== */
    function matchBill(scheduleId, billId, billAmount, partial) {
        assertPermission('match');
        return txns.matchBill({
            scheduleId: scheduleId, billId: billId,
            billAmount: Number(billAmount), partial: !!partial
        });
    }

    function convertToBill(scheduleId, billDate) {
        assertPermission('convert');
        var loaded = records.getSchedule(scheduleId);
        var schedule = loaded.data;
        if (!schedule.accrualTxn) {
            throw util.accrualError('AE_NO_ACCRUAL',
                'Schedule has no accrual to convert.', false);
        }
        return txns.convertToBill({
            accrualId: schedule.accrualTxn, scheduleId: scheduleId,
            ruleId: schedule.rule, billDate: billDate || new Date()
        });
    }

    /* ------------------------------------------------------------------ */
    function routeException(scheduleId, ruleId, e) {
        var upd = {};
        upd[SF.STATUS] = C.SCHED_STATUS.EXCEPTION;
        upd[SF.EXCEPTION_REASON] = (e && e.message) || String(e);
        records.updateSchedule(scheduleId, upd);
        audit.record({
            schedule: scheduleId, rule: ruleId, action: C.AUDIT_ACTION.EXCEPTION,
            detail: { error: (e && e.message) || String(e) }
        });
    }

    return {
        calculate: calculate,
        override: override,
        post: post,
        reverse: reverse,
        reverseAndReaccrue: reverseAndReaccrue,
        matchBill: matchBill,
        convertToBill: convertToBill
    };
});
