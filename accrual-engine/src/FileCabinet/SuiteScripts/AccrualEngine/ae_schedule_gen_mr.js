/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * ae_schedule_gen_mr.js  —  Phase 2/3
 * -----------------------------------
 * Materialises Accrual Schedule (period instance) records from active rules and
 * pre-calculates them so the Current Period tab opens with numbers already in
 * place. Safe to run repeatedly: it never creates a second schedule for the
 * same rule + accounting period.
 *
 * Script parameters:
 *   custscript_ae_gen_asof     (date)  - any date inside the target period.
 *                                        Defaults to today.
 *   custscript_ae_gen_frequency(text)  - optional: only process rules of this
 *                                        frequency (monthly/quarterly/annual).
 *   custscript_ae_gen_autocalc (checkbox) - if true, run the calc engine and
 *                                        store qty/rate/amount + reversal date;
 *                                        otherwise leave schedules in Draft.
 *
 * Rows failing calculation are written as Exception schedules, not dropped.
 */
define([
    'N/runtime',
    'N/log',
    './lib/ae_constants',
    './lib/ae_util',
    './lib/ae_records',
    './lib/ae_calc'
], function (runtime, log, C, util, records, calc) {
    'use strict';

    var SF = C.SCHED_FIELD;

    function getInputData() {
        var frequency = getParam('custscript_ae_gen_frequency');
        var ruleIds = records.getActiveRuleIds(frequency || null);
        return ruleIds.map(function (id) { return { ruleId: id }; });
    }

    function map(context) {
        var ruleId = JSON.parse(context.value).ruleId;
        var asOf = getAsOfDate();

        var rule = records.getRule(ruleId);
        if (rule.inactive) return;

        // Respect the rule's active window.
        if (rule.startDate && asOf < new Date(rule.startDate)) return;
        if (rule.endDate && asOf > new Date(rule.endDate)) return;

        var bounds = util.periodBounds(rule.frequency, C, asOf);
        var period = util.resolveAccountingPeriod(bounds.end);

        // Idempotency: skip if a schedule already exists for this rule+period.
        var existing = records.findScheduleForPeriod(ruleId, period.id);
        if (existing) {
            log.debug({ title: 'schedule exists', details: 'rule ' + ruleId + ' period ' + period.id });
            return;
        }

        var reversalDate = null;
        if (needsReversal(rule)) {
            reversalDate = util.computeReversalDate(rule.reversalDateRule, C, bounds.end, null);
        }

        var scheduleId = records.createSchedule({
            rule: ruleId,
            period: period.id,
            periodStart: bounds.start,
            periodEnd: bounds.end,
            status: C.SCHED_STATUS.DRAFT,
            reversalDate: reversalDate,
            reversalStatus: reversalDate ? C.REVERSAL_STATUS.PENDING : C.REVERSAL_STATUS.NOT_REQUIRED,
            name: rule.name + ' — ' + period.name
        });

        context.write({
            key: String(scheduleId),
            value: JSON.stringify({
                scheduleId: scheduleId, ruleId: ruleId,
                periodStart: bounds.start.getTime(), periodEnd: bounds.end.getTime()
            })
        });
    }

    function reduce(context) {
        if (!truthyParam('custscript_ae_gen_autocalc')) return; // leave in Draft
        var data = JSON.parse(context.values[0]);

        var rule = records.getRule(data.ruleId);
        var ctx = {
            periodStart: new Date(data.periodStart),
            periodEnd: new Date(data.periodEnd),
            asOfDate: new Date(data.periodEnd),
            location: rule.location,
            item: rule.item,
            vendor: rule.vendor
        };

        try {
            var result = calc.calculate(rule, ctx);
            var upd = {};
            upd[SF.CALC_QTY] = result.quantity;
            upd[SF.CALC_RATE] = result.rate;
            upd[SF.CALC_AMOUNT] = result.amount;
            upd[SF.STATUS] = C.SCHED_STATUS.CALCULATED;
            upd[SF.LAST_CALC_DATE] = new Date();
            records.updateSchedule(data.scheduleId, upd);
        } catch (e) {
            var isExc = e && e.isAccrualException;
            log[isExc ? 'audit' : 'error']({
                title: 'Calc exception schedule ' + data.scheduleId, details: (e && e.message) || e
            });
            var eu = {};
            eu[SF.STATUS] = C.SCHED_STATUS.EXCEPTION;
            eu[SF.EXCEPTION_REASON] = (e && e.message) || String(e);
            records.updateSchedule(data.scheduleId, eu);
        }
    }

    function summarize(summary) {
        var created = 0;
        summary.output.iterator().each(function () { created++; return true; });
        summary.mapSummary.errors.iterator().each(function (k, e) {
            log.error({ title: 'gen map error ' + k, details: e }); return true;
        });
        log.audit({ title: 'Schedule generation complete', details: 'schedules touched: ' + created });
    }

    /* helpers */
    function needsReversal(rule) {
        return rule.reversalMethod &&
            rule.reversalMethod !== C.REVERSAL_METHOD.NONE &&
            rule.reversalMethod !== C.REVERSAL_METHOD.MANUAL;
    }
    function getParam(n) {
        try { return runtime.getCurrentScript().getParameter({ name: n }); } catch (e) { return null; }
    }
    function truthyParam(n) {
        var v = getParam(n);
        return v === true || v === 'T' || v === 'true';
    }
    function getAsOfDate() {
        var v = getParam('custscript_ae_gen_asof');
        if (!v) return new Date();
        var d = new Date(v);
        return isNaN(d.getTime()) ? new Date() : d;
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});
