/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_util.js
 * ----------
 * Small, dependency-light helpers shared across the engine: date arithmetic,
 * accounting-period resolution, list-value lookups, rounding, memo templating
 * and a typed error used to route problems into the Exceptions queue.
 */
define(['N/query', 'N/format', 'N/error'], function (query, format, error) {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Typed error. Throwing an AccrualError with `exception:true` tells the
     * engine to move the schedule to the Exceptions queue instead of failing
     * the whole run.
     * ------------------------------------------------------------------ */
    function accrualError(code, message, isException) {
        var e = error.create({ name: code, message: message, notifyOff: true });
        e.isAccrualException = isException !== false; // default true
        return e;
    }

    /* ------------------------------------------------------------------ *
     * Rounding to cents. NetSuite money math should never carry float noise
     * into a posted transaction line.
     * ------------------------------------------------------------------ */
    function round(value, places) {
        var p = typeof places === 'number' ? places : 2;
        var f = Math.pow(10, p);
        return Math.round((Number(value) + Number.EPSILON) * f) / f;
    }

    function isBlank(v) {
        return v === null || v === undefined || v === '' ||
            (typeof v === 'number' && isNaN(v));
    }

    /* ------------------------------------------------------------------ *
     * Date helpers. All work on native Date objects in local (account) time.
     * ------------------------------------------------------------------ */
    function startOfMonth(d) {
        return new Date(d.getFullYear(), d.getMonth(), 1);
    }

    function endOfMonth(d) {
        return new Date(d.getFullYear(), d.getMonth() + 1, 0);
    }

    function firstDayNextMonth(d) {
        return new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }

    function lastDayNextMonth(d) {
        return new Date(d.getFullYear(), d.getMonth() + 2, 0);
    }

    function addMonths(d, n) {
        return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
    }

    function startOfQuarter(d) {
        var q = Math.floor(d.getMonth() / 3);
        return new Date(d.getFullYear(), q * 3, 1);
    }

    function endOfQuarter(d) {
        var q = Math.floor(d.getMonth() / 3);
        return new Date(d.getFullYear(), q * 3 + 3, 0);
    }

    function startOfYear(d) {
        return new Date(d.getFullYear(), 0, 1);
    }

    function endOfYear(d) {
        return new Date(d.getFullYear(), 11, 31);
    }

    /** Inclusive day count between two dates. */
    function daysBetween(a, b) {
        var ms = 24 * 60 * 60 * 1000;
        var da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
        var db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
        return Math.round((db - da) / ms) + 1;
    }

    function formatDate(d) {
        return format.format({ value: d, type: format.Type.DATE });
    }

    function sameDay(a, b) {
        return a && b &&
            a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
    }

    /* ------------------------------------------------------------------ *
     * Given a frequency and any date inside the target period, return the
     * period's start / end dates.
     * ------------------------------------------------------------------ */
    function periodBounds(frequency, C, anyDateInPeriod) {
        var d = anyDateInPeriod;
        switch (frequency) {
            case C.FREQUENCY.QUARTERLY:
                return { start: startOfQuarter(d), end: endOfQuarter(d) };
            case C.FREQUENCY.ANNUAL:
                return { start: startOfYear(d), end: endOfYear(d) };
            case C.FREQUENCY.MONTHLY:
            default:
                return { start: startOfMonth(d), end: endOfMonth(d) };
        }
    }

    /* ------------------------------------------------------------------ *
     * Resolve the NetSuite accountingperiod internal id whose date range
     * contains `date`. Returns { id, name, startdate, enddate, closed }.
     * ------------------------------------------------------------------ */
    function resolveAccountingPeriod(date) {
        var rows = query.runSuiteQL({
            query:
                'SELECT id, periodname, startdate, enddate, closed, isquarter, isyear ' +
                'FROM accountingperiod ' +
                'WHERE isquarter = \'F\' AND isyear = \'F\' ' +
                '  AND startdate <= ? AND enddate >= ? ' +
                'ORDER BY startdate DESC',
            params: [formatDate(date), formatDate(date)]
        }).asMappedResults();

        if (!rows.length) {
            throw accrualError(
                'AE_NO_PERIOD',
                'No open base accounting period contains ' + formatDate(date),
                true
            );
        }
        var r = rows[0];
        return {
            id: r.id,
            name: r.periodname,
            startdate: r.startdate,
            enddate: r.enddate,
            closed: String(r.closed).toUpperCase() === 'T' ||
                String(r.closed).toUpperCase() === 'TRUE'
        };
    }

    function isPeriodClosed(periodId) {
        var rows = query.runSuiteQL({
            query: 'SELECT closed, alllocked, aplocked FROM accountingperiod WHERE id = ?',
            params: [periodId]
        }).asMappedResults();
        if (!rows.length) return true;
        var r = rows[0];
        function truthy(v) {
            var s = String(v).toUpperCase();
            return s === 'T' || s === 'TRUE';
        }
        return truthy(r.closed) || truthy(r.alllocked) || truthy(r.aplocked);
    }

    /* ------------------------------------------------------------------ *
     * Given a reversal-date rule + the period bounds, compute the date on
     * which the accrual should reverse.
     * ------------------------------------------------------------------ */
    function computeReversalDate(reversalDateRule, C, periodEnd, specificDate) {
        switch (reversalDateRule) {
            case C.REVERSAL_DATE_RULE.PERIOD_END:
                return periodEnd;
            case C.REVERSAL_DATE_RULE.LAST_DAY_NEXT_MONTH:
                return lastDayNextMonth(periodEnd);
            case C.REVERSAL_DATE_RULE.SPECIFIC_DATE:
                return specificDate || firstDayNextMonth(periodEnd);
            case C.REVERSAL_DATE_RULE.FIRST_DAY_NEXT_MONTH:
            default:
                return firstDayNextMonth(periodEnd);
        }
    }

    /* ------------------------------------------------------------------ *
     * Memo templating. Replaces {token} placeholders with values from ctx.
     * Unknown tokens are left intact so nothing is silently dropped.
     * Supported tokens: {rule} {vendor} {period} {qty} {rate} {amount}
     * ------------------------------------------------------------------ */
    function renderMemo(template, ctx) {
        if (isBlank(template)) return '';
        return String(template).replace(/\{(\w+)\}/g, function (m, key) {
            return (ctx && ctx[key] !== undefined && ctx[key] !== null)
                ? String(ctx[key]) : m;
        });
    }

    return {
        accrualError: accrualError,
        round: round,
        isBlank: isBlank,
        startOfMonth: startOfMonth,
        endOfMonth: endOfMonth,
        firstDayNextMonth: firstDayNextMonth,
        lastDayNextMonth: lastDayNextMonth,
        addMonths: addMonths,
        startOfQuarter: startOfQuarter,
        endOfQuarter: endOfQuarter,
        startOfYear: startOfYear,
        endOfYear: endOfYear,
        daysBetween: daysBetween,
        formatDate: formatDate,
        sameDay: sameDay,
        periodBounds: periodBounds,
        resolveAccountingPeriod: resolveAccountingPeriod,
        isPeriodClosed: isPeriodClosed,
        computeReversalDate: computeReversalDate,
        renderMemo: renderMemo
    };
});
