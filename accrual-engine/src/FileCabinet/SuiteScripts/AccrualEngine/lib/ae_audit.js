/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_audit.js
 * -----------
 * Append-only audit trail. Every calculate/post/reverse/match/convert action
 * writes an immutable customrecord_accrual_audit row capturing the inputs that
 * produced a number (saved search id, quantity, rate, amount, variance) plus
 * the acting user and timestamp. Historical calculation detail is never
 * overwritten — corrections are new rows.
 */
define([
    'N/record',
    'N/runtime',
    'N/log',
    './ae_constants'
], function (record, runtime, log, C) {
    'use strict';

    var AF = C.AUDIT_FIELD;

    /**
     * @param {Object} entry
     *   { schedule, rule, action, savedSearch, qty, rate, amount, variance,
     *     detail(object|string) }
     * @returns {Number|null} new audit record id (null on failure — auditing
     *          must never block the primary action).
     */
    function record_(entry) {
        try {
            var rec = record.create({ type: C.RECORD.AUDIT });
            if (entry.schedule) rec.setValue(AF.SCHEDULE, entry.schedule);
            if (entry.rule) rec.setValue(AF.RULE, entry.rule);
            rec.setValue(AF.ACTION, entry.action);
            rec.setValue(AF.USER, runtime.getCurrentUser().id);
            rec.setValue(AF.TIMESTAMP, nowDate());
            if (entry.savedSearch) rec.setValue(AF.SAVED_SEARCH, String(entry.savedSearch));
            if (entry.qty !== undefined && entry.qty !== null) rec.setValue(AF.QTY, entry.qty);
            if (entry.rate !== undefined && entry.rate !== null) rec.setValue(AF.RATE, entry.rate);
            if (entry.amount !== undefined && entry.amount !== null) rec.setValue(AF.AMOUNT, entry.amount);
            if (entry.variance !== undefined && entry.variance !== null) rec.setValue(AF.VARIANCE, entry.variance);
            rec.setValue(AF.DETAIL, stringifyDetail(entry.detail));
            return rec.save({ ignoreMandatoryFields: true });
        } catch (e) {
            log.error({ title: 'ae_audit.record failed', details: e });
            return null;
        }
    }

    function nowDate() {
        // Server scripts run in account timezone; a plain Date is fine for a
        // datetime field. Kept in a helper so it is easy to mock/adjust.
        return new Date();
    }

    function stringifyDetail(detail) {
        if (detail === undefined || detail === null) return '';
        if (typeof detail === 'string') return detail;
        try { return JSON.stringify(detail); } catch (e) { return String(detail); }
    }

    return { record: record_ };
});
