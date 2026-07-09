/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_records.js
 * -------------
 * Thin, typed data-access layer over the three custom records. Everything that
 * reads or writes a rule / rate / schedule goes through here so field ids stay
 * confined to this module + ae_constants.
 */
define([
    'N/record',
    'N/search',
    'N/query',
    './ae_constants',
    './ae_util'
], function (record, search, query, C, util) {
    'use strict';

    var RF = C.RULE_FIELD;
    var TF = C.RATE_FIELD;
    var SF = C.SCHED_FIELD;

    /* ------------------------------------------------------------------ *
     * Rules
     * ------------------------------------------------------------------ */

    /**
     * Read a list-backed enum field as its token. The custom list values are
     * named with the engine tokens (e.g. "fixed_amount"), so getText() returns
     * the token. Falls back to getValue() when the field is stored as plain
     * text, so the engine works whether the field is a list or free-form text.
     */
    function enumToken(rec, fieldId) {
        var t = rec.getText(fieldId);
        if (t !== null && t !== undefined && t !== '') return String(t).trim();
        var v = rec.getValue(fieldId);
        return (v === null || v === undefined) ? '' : String(v).trim();
    }

    /** Load a rule record and flatten it into a plain object. */
    function getRule(ruleId) {
        var rec = record.load({ type: C.RECORD.RULE, id: ruleId });
        return {
            id: ruleId,
            name: rec.getValue(RF.NAME),
            inactive: rec.getValue(RF.INACTIVE),
            vendor: rec.getValue(RF.VENDOR),
            subsidiary: rec.getValue(RF.SUBSIDIARY),
            item: rec.getValue(RF.ITEM),
            location: rec.getValue(RF.LOCATION),
            journalCategory: rec.getValue(RF.JOURNAL_CATEGORY),
            accrualAccount: rec.getValue(RF.ACCRUAL_ACCOUNT),
            expenseAccount: rec.getValue(RF.EXPENSE_ACCOUNT),
            // Enum fields the engine compares to token constants are backed by
            // custom lists whose value *names* are the tokens, so we read the
            // text (not the numeric internal id).
            calcType: enumToken(rec, RF.CALC_TYPE),
            qtySourceType: enumToken(rec, RF.QTY_SOURCE_TYPE),
            savedSearch: rec.getValue(RF.SAVED_SEARCH),
            manualQty: Number(rec.getValue(RF.MANUAL_QTY) || 0),
            fixedAmount: Number(rec.getValue(RF.FIXED_AMOUNT) || 0),
            rate: Number(rec.getValue(RF.RATE) || 0),
            rateSource: enumToken(rec, RF.RATE_SOURCE),
            percentage: Number(rec.getValue(RF.PERCENTAGE) || 0),
            percentBasis: Number(rec.getValue(RF.PERCENT_BASIS) || 0),
            formula: rec.getValue(RF.FORMULA),
            pluginScript: rec.getValue(RF.PLUGIN_SCRIPT),
            frequency: enumToken(rec, RF.FREQUENCY),
            startDate: rec.getValue(RF.START_DATE),
            endDate: rec.getValue(RF.END_DATE),
            reversalMethod: enumToken(rec, RF.REVERSAL_METHOD),
            reversalDateRule: enumToken(rec, RF.REVERSAL_DATE_RULE),
            billBehavior: enumToken(rec, RF.BILL_BEHAVIOR),
            lookbackMonths: Number(rec.getValue(RF.LOOKBACK_MONTHS) || 6),
            memoTemplate: rec.getValue(RF.MEMO_TEMPLATE),
            owner: rec.getValue(RF.OWNER),
            approver: rec.getValue(RF.APPROVER),
            status: rec.getValue(RF.STATUS),
            varianceThreshold: Number(rec.getValue(RF.VARIANCE_THRESHOLD) || 0)
        };
    }

    /** Ids of all active rules, optionally filtered by frequency. */
    function getActiveRuleIds(frequency) {
        var sql =
            'SELECT id FROM ' + C.RECORD.RULE +
            ' WHERE ( isinactive = \'F\' OR isinactive IS NULL )';
        var params = [];
        if (frequency) {
            sql += ' AND ' + RF.FREQUENCY + ' = ?';
            params.push(frequency);
        }
        return query.runSuiteQL({ query: sql, params: params })
            .asMappedResults()
            .map(function (r) { return r.id; });
    }

    /* ------------------------------------------------------------------ *
     * Versioned rate resolution.
     *
     * Picks the most specific rate row from customrecord_accrual_rate whose
     * effective window contains `asOfDate` and whose location/item/vendor
     * either match the accrual context or are left blank (wildcard).
     * Specificity score favours exact location > item > vendor matches so a
     * site-specific rate beats a global one.
     * ------------------------------------------------------------------ */
    function resolveRate(ruleId, ctx, asOfDate) {
        var rows = query.runSuiteQL({
            query:
                'SELECT id, ' + TF.RATE + ' AS rate, ' + TF.LOCATION + ' AS location, ' +
                TF.ITEM + ' AS item, ' + TF.VENDOR + ' AS vendor, ' +
                TF.EFF_START + ' AS eff_start, ' + TF.EFF_END + ' AS eff_end ' +
                'FROM ' + C.RECORD.RATE + ' ' +
                'WHERE ' + TF.RULE + ' = ? ' +
                '  AND ( ' + TF.EFF_START + ' IS NULL OR ' + TF.EFF_START + ' <= ? ) ' +
                '  AND ( ' + TF.EFF_END + ' IS NULL OR ' + TF.EFF_END + ' >= ? )',
            params: [ruleId, util.formatDate(asOfDate), util.formatDate(asOfDate)]
        }).asMappedResults();

        var best = null;
        var bestScore = -1;
        rows.forEach(function (r) {
            var score = 0;
            if (!util.isBlank(r.location)) {
                if (String(r.location) !== String(ctx.location || '')) return; // mismatch
                score += 4;
            }
            if (!util.isBlank(r.item)) {
                if (String(r.item) !== String(ctx.item || '')) return;
                score += 2;
            }
            if (!util.isBlank(r.vendor)) {
                if (String(r.vendor) !== String(ctx.vendor || '')) return;
                score += 1;
            }
            if (score > bestScore) {
                bestScore = score;
                best = r;
            }
        });
        return best ? Number(best.rate) : null;
    }

    /* ------------------------------------------------------------------ *
     * Schedules
     * ------------------------------------------------------------------ */

    function getSchedule(scheduleId) {
        var rec = record.load({ type: C.RECORD.SCHEDULE, id: scheduleId });
        return { rec: rec, data: flattenSchedule(scheduleId, rec) };
    }

    function flattenSchedule(id, rec) {
        return {
            id: id,
            name: rec.getValue(SF.NAME),
            rule: rec.getValue(SF.RULE),
            period: rec.getValue(SF.PERIOD),
            periodStart: rec.getValue(SF.PERIOD_START),
            periodEnd: rec.getValue(SF.PERIOD_END),
            status: rec.getValue(SF.STATUS),
            calcQty: Number(rec.getValue(SF.CALC_QTY) || 0),
            calcRate: Number(rec.getValue(SF.CALC_RATE) || 0),
            calcAmount: Number(rec.getValue(SF.CALC_AMOUNT) || 0),
            overrideAmount: rec.getValue(SF.OVERRIDE_AMOUNT),
            overrideQty: rec.getValue(SF.OVERRIDE_QTY),
            overrideReason: rec.getValue(SF.OVERRIDE_REASON),
            accrualTxn: rec.getValue(SF.ACCRUAL_TXN),
            reversalTxn: rec.getValue(SF.REVERSAL_TXN),
            matchedBill: rec.getValue(SF.MATCHED_BILL),
            convertedBill: rec.getValue(SF.CONVERTED_BILL),
            reversalDate: rec.getValue(SF.REVERSAL_DATE),
            reversalStatus: rec.getValue(SF.REVERSAL_STATUS),
            varianceAmount: Number(rec.getValue(SF.VARIANCE_AMOUNT) || 0),
            matchedAmount: Number(rec.getValue(SF.MATCHED_AMOUNT) || 0)
        };
    }

    /**
     * Find an existing schedule for (rule, accounting period) so we never
     * create duplicate accruals for the same rule+period. Returns id or null.
     */
    function findScheduleForPeriod(ruleId, periodId) {
        var rows = query.runSuiteQL({
            query:
                'SELECT id FROM ' + C.RECORD.SCHEDULE +
                ' WHERE ' + SF.RULE + ' = ? AND ' + SF.PERIOD + ' = ?',
            params: [ruleId, periodId]
        }).asMappedResults();
        return rows.length ? rows[0].id : null;
    }

    /** Create a Draft schedule for a rule+period. Returns the new id. */
    function createSchedule(values) {
        var rec = record.create({ type: C.RECORD.SCHEDULE });
        rec.setValue(SF.RULE, values.rule);
        rec.setValue(SF.PERIOD, values.period);
        rec.setValue(SF.PERIOD_START, values.periodStart);
        rec.setValue(SF.PERIOD_END, values.periodEnd);
        rec.setValue(SF.STATUS, values.status || C.SCHED_STATUS.DRAFT);
        rec.setValue(SF.REVERSAL_STATUS, values.reversalStatus || C.REVERSAL_STATUS.NOT_REQUIRED);
        if (values.reversalDate) rec.setValue(SF.REVERSAL_DATE, values.reversalDate);
        if (values.name) rec.setValue(SF.NAME, values.name);
        if (values.prevSchedule) rec.setValue(SF.PREV_SCHEDULE, values.prevSchedule);
        return rec.save({ ignoreMandatoryFields: true });
    }

    /** Patch a set of fields onto a schedule with a single submitFields call. */
    function updateSchedule(scheduleId, values) {
        return record.submitFields({
            type: C.RECORD.SCHEDULE,
            id: scheduleId,
            values: values,
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
    }

    return {
        getRule: getRule,
        getActiveRuleIds: getActiveRuleIds,
        resolveRate: resolveRate,
        getSchedule: getSchedule,
        flattenSchedule: flattenSchedule,
        findScheduleForPeriod: findScheduleForPeriod,
        createSchedule: createSchedule,
        updateSchedule: updateSchedule
    };
});
