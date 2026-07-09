/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_workbench_data.js
 * --------------------
 * Read-side queries that feed the Accrual Workbench Suitelet: dashboard tiles,
 * schedule lists per tab, reversal queues, exception queue, bill-match
 * candidates and the liability rollforward. All queries run against the custom
 * records (fully queryable) and join to rules for labels.
 *
 * Kept separate from rendering so the numbers can be unit-checked and reused by
 * the Vendor / Location profile views.
 */
define([
    'N/query',
    './ae_constants',
    './ae_util'
], function (query, C, util) {
    'use strict';

    var S = C.RECORD.SCHEDULE;
    var SF = C.SCHED_FIELD;
    var R = C.RECORD.RULE;
    var RF = C.RULE_FIELD;

    /** Convenience: run SuiteQL and return mapped rows. */
    function run(sql, params) {
        return query.runSuiteQL({ query: sql, params: params || [] }).asMappedResults();
    }

    /* ------------------------------------------------------------------ *
     * Dashboard tiles
     * ------------------------------------------------------------------ */
    function dashboardTotals(filters) {
        var where = buildScheduleWhere(filters);
        var rows = run(
            'SELECT ' + SF.STATUS + ' AS status, ' +
            '       COUNT(*) AS cnt, ' +
            '       SUM(NVL(' + SF.OVERRIDE_AMOUNT + ', ' + SF.CALC_AMOUNT + ')) AS amount ' +
            'FROM ' + S + ' s ' + where.clause +
            ' GROUP BY ' + SF.STATUS, where.params);

        var out = {
            posted: 0, pending: 0, reversalsDue: 0, unmatched: 0, exceptions: 0,
            postedCount: 0, pendingCount: 0
        };
        rows.forEach(function (r) {
            var amt = Number(r.amount || 0);
            switch (r.status) {
                case C.SCHED_STATUS.POSTED:
                case C.SCHED_STATUS.PARTIALLY_MATCHED:
                    out.posted += amt; out.postedCount += Number(r.cnt); break;
                case C.SCHED_STATUS.DRAFT:
                case C.SCHED_STATUS.CALCULATED:
                    out.pending += amt; out.pendingCount += Number(r.cnt); break;
                case C.SCHED_STATUS.EXCEPTION:
                    out.exceptions += Number(r.cnt); break;
            }
        });
        out.reversalsDue = countReversalsDue(filters);
        out.unmatched = countUnmatchedBills(filters);
        return out;
    }

    function countReversalsDue(filters) {
        var rows = run(
            'SELECT COUNT(*) AS cnt FROM ' + S + ' s ' +
            'WHERE ' + SF.REVERSAL_STATUS + ' = ? ' +
            '  AND ' + SF.REVERSAL_DATE + ' <= ?',
            [C.REVERSAL_STATUS.PENDING, util.formatDate(new Date())]);
        return rows.length ? Number(rows[0].cnt) : 0;
    }

    function countUnmatchedBills(filters) {
        var rows = run(
            'SELECT COUNT(*) AS cnt FROM ' + S + ' s ' +
            'WHERE ' + SF.STATUS + ' IN (?, ?) ',
            [C.SCHED_STATUS.POSTED, C.SCHED_STATUS.PARTIALLY_MATCHED]);
        return rows.length ? Number(rows[0].cnt) : 0;
    }

    /* ------------------------------------------------------------------ *
     * Schedule list for the Current Period tab (and generic filtered lists)
     * ------------------------------------------------------------------ */
    function scheduleList(filters) {
        var where = buildScheduleWhere(filters);
        return run(
            'SELECT s.id, ' +
            '  BUILTIN.DF(s.' + SF.RULE + ') AS rulename, ' +
            '  BUILTIN.DF(r.' + RF.VENDOR + ') AS vendor, ' +
            '  BUILTIN.DF(r.' + RF.LOCATION + ') AS location, ' +
            '  BUILTIN.DF(s.' + SF.PERIOD + ') AS period, ' +
            '  s.' + SF.CALC_QTY + ' AS qty, ' +
            '  s.' + SF.CALC_RATE + ' AS rate, ' +
            '  s.' + SF.CALC_AMOUNT + ' AS amount, ' +
            '  s.' + SF.OVERRIDE_AMOUNT + ' AS override_amount, ' +
            '  s.' + SF.STATUS + ' AS status, ' +
            '  s.' + SF.REVERSAL_DATE + ' AS reversal_date, ' +
            '  s.' + SF.ACCRUAL_TXN + ' AS accrual_txn, ' +
            '  s.' + SF.MATCHED_BILL + ' AS matched_bill, ' +
            '  s.' + SF.VARIANCE_AMOUNT + ' AS variance ' +
            'FROM ' + S + ' s ' +
            'LEFT JOIN ' + R + ' r ON r.id = s.' + SF.RULE + ' ' +
            where.clause +
            ' ORDER BY rulename', where.params);
    }

    /* ------------------------------------------------------------------ *
     * Reversal queues (Reversal Manager tab)
     * ------------------------------------------------------------------ */
    function reversalQueue(bucket) {
        var today = util.formatDate(new Date());
        var clause, params;
        switch (bucket) {
            case 'due':
                clause = 'WHERE s.' + SF.REVERSAL_STATUS + ' = ? AND s.' + SF.REVERSAL_DATE + ' <= ?';
                params = [C.REVERSAL_STATUS.PENDING, today]; break;
            case 'future':
                clause = 'WHERE s.' + SF.REVERSAL_STATUS + ' = ? AND s.' + SF.REVERSAL_DATE + ' > ?';
                params = [C.REVERSAL_STATUS.PENDING, today]; break;
            case 'failed':
                clause = 'WHERE s.' + SF.REVERSAL_STATUS + ' = ?';
                params = [C.REVERSAL_STATUS.FAILED]; break;
            case 'reversed':
                clause = 'WHERE s.' + SF.REVERSAL_STATUS + ' = ?';
                params = [C.REVERSAL_STATUS.REVERSED]; break;
            case 'missing':
                clause = 'WHERE s.' + SF.REVERSAL_DATE + ' IS NULL AND s.' + SF.STATUS + ' = ?';
                params = [C.SCHED_STATUS.POSTED]; break;
            default:
                clause = 'WHERE s.' + SF.REVERSAL_STATUS + ' = ?';
                params = [C.REVERSAL_STATUS.PENDING];
        }
        return run(
            'SELECT s.id, BUILTIN.DF(s.' + SF.RULE + ') AS rulename, ' +
            '  s.' + SF.REVERSAL_DATE + ' AS reversal_date, ' +
            '  s.' + SF.REVERSAL_STATUS + ' AS reversal_status, ' +
            '  s.' + SF.ACCRUAL_TXN + ' AS accrual_txn, ' +
            '  s.' + SF.REVERSAL_TXN + ' AS reversal_txn, ' +
            '  s.' + SF.EXCEPTION_REASON + ' AS reason, ' +
            '  NVL(s.' + SF.OVERRIDE_AMOUNT + ', s.' + SF.CALC_AMOUNT + ') AS amount ' +
            'FROM ' + S + ' s ' + clause +
            ' ORDER BY s.' + SF.REVERSAL_DATE, params);
    }

    /* ------------------------------------------------------------------ *
     * Exceptions tab
     * ------------------------------------------------------------------ */
    function exceptionQueue() {
        return run(
            'SELECT s.id, BUILTIN.DF(s.' + SF.RULE + ') AS rulename, ' +
            '  s.' + SF.EXCEPTION_REASON + ' AS reason, ' +
            '  BUILTIN.DF(s.' + SF.PERIOD + ') AS period, ' +
            '  s.' + SF.STATUS + ' AS status ' +
            'FROM ' + S + ' s WHERE s.' + SF.STATUS + ' = ? ' +
            'ORDER BY s.id DESC', [C.SCHED_STATUS.EXCEPTION]);
    }

    /* ------------------------------------------------------------------ *
     * Liability rollforward. Groups schedules by accounting period and rolls
     * beginning -> new accruals -> reversals -> bills applied -> ending.
     * `groupBy` is one of: period, vendor, location, rule.
     * ------------------------------------------------------------------ */
    function rollforward(groupBy) {
        var dim;
        switch (groupBy) {
            case 'vendor':   dim = 'BUILTIN.DF(r.' + RF.VENDOR + ')'; break;
            case 'location': dim = 'BUILTIN.DF(r.' + RF.LOCATION + ')'; break;
            case 'rule':     dim = 'BUILTIN.DF(s.' + SF.RULE + ')'; break;
            case 'period':
            default:         dim = 'BUILTIN.DF(s.' + SF.PERIOD + ')'; break;
        }
        // New accruals = posted amount; reversals = reversed amount (negative);
        // bills applied = matched amount. Ending is derived in the caller as a
        // running total when grouped by period.
        return run(
            'SELECT ' + dim + ' AS grp, ' +
            '  SUM(CASE WHEN s.' + SF.STATUS + ' IN (\'' + C.SCHED_STATUS.POSTED + '\',\'' +
                C.SCHED_STATUS.PARTIALLY_MATCHED + '\',\'' + C.SCHED_STATUS.MATCHED + '\',\'' +
                C.SCHED_STATUS.REVERSED + '\',\'' + C.SCHED_STATUS.CONVERTED + '\') ' +
            '           THEN NVL(s.' + SF.OVERRIDE_AMOUNT + ', s.' + SF.CALC_AMOUNT + ') ELSE 0 END) AS new_accruals, ' +
            '  SUM(CASE WHEN s.' + SF.REVERSAL_STATUS + ' = \'' + C.REVERSAL_STATUS.REVERSED + '\' ' +
            '           THEN NVL(s.' + SF.OVERRIDE_AMOUNT + ', s.' + SF.CALC_AMOUNT + ') ELSE 0 END) AS reversals, ' +
            '  SUM(NVL(s.' + SF.MATCHED_AMOUNT + ', 0)) AS bills_applied ' +
            'FROM ' + S + ' s LEFT JOIN ' + R + ' r ON r.id = s.' + SF.RULE + ' ' +
            'GROUP BY ' + dim + ' ORDER BY grp', []);
    }

    /* ------------------------------------------------------------------ *
     * Vendor / Location profile: open accruals for an entity.
     * ------------------------------------------------------------------ */
    function openAccrualsForVendor(vendorId) {
        return run(
            'SELECT s.id, BUILTIN.DF(s.' + SF.RULE + ') AS rulename, ' +
            '  BUILTIN.DF(s.' + SF.PERIOD + ') AS period, ' +
            '  BUILTIN.DF(r.' + RF.LOCATION + ') AS location, ' +
            '  s.' + SF.CALC_QTY + ' AS qty, s.' + SF.CALC_RATE + ' AS rate, ' +
            '  NVL(s.' + SF.OVERRIDE_AMOUNT + ', s.' + SF.CALC_AMOUNT + ') AS amount, ' +
            '  s.' + SF.REVERSAL_DATE + ' AS reversal_date, s.' + SF.STATUS + ' AS status ' +
            'FROM ' + S + ' s LEFT JOIN ' + R + ' r ON r.id = s.' + SF.RULE + ' ' +
            'WHERE r.' + RF.VENDOR + ' = ? AND s.' + SF.STATUS + ' IN (?, ?) ' +
            'ORDER BY s.' + SF.PERIOD,
            [vendorId, C.SCHED_STATUS.POSTED, C.SCHED_STATUS.PARTIALLY_MATCHED]);
    }

    /* ------------------------------------------------------------------ *
     * Rules list (Accrual Rules tab)
     * ------------------------------------------------------------------ */
    function ruleList(activeOnly) {
        var clause = activeOnly ? 'WHERE (r.isinactive = \'F\' OR r.isinactive IS NULL) ' : '';
        return run(
            'SELECT r.id, r.name, ' +
            '  BUILTIN.DF(r.' + RF.CALC_TYPE + ') AS calc_type, ' +
            '  BUILTIN.DF(r.' + RF.VENDOR + ') AS vendor, ' +
            '  BUILTIN.DF(r.' + RF.LOCATION + ') AS location, ' +
            '  BUILTIN.DF(r.' + RF.FREQUENCY + ') AS frequency, ' +
            '  r.isinactive AS inactive ' +
            'FROM ' + R + ' r ' + clause + ' ORDER BY r.name', []);
    }

    /* ------------------------------------------------------------------ *
     * WHERE builder shared by dashboard + list. filters: {period, location,
     * vendor, status}.
     * ------------------------------------------------------------------ */
    function buildScheduleWhere(filters) {
        filters = filters || {};
        var parts = [];
        var params = [];
        if (filters.period)   { parts.push('s.' + SF.PERIOD + ' = ?'); params.push(filters.period); }
        if (filters.status)   { parts.push('s.' + SF.STATUS + ' = ?'); params.push(filters.status); }
        if (filters.rule)     { parts.push('s.' + SF.RULE + ' = ?'); params.push(filters.rule); }
        if (filters.location) {
            parts.push('EXISTS (SELECT 1 FROM ' + R + ' rr WHERE rr.id = s.' + SF.RULE +
                ' AND rr.' + RF.LOCATION + ' = ?)');
            params.push(filters.location);
        }
        if (filters.vendor) {
            parts.push('EXISTS (SELECT 1 FROM ' + R + ' rv WHERE rv.id = s.' + SF.RULE +
                ' AND rv.' + RF.VENDOR + ' = ?)');
            params.push(filters.vendor);
        }
        return {
            clause: parts.length ? ('WHERE ' + parts.join(' AND ') + ' ') : '',
            params: params
        };
    }

    return {
        dashboardTotals: dashboardTotals,
        scheduleList: scheduleList,
        reversalQueue: reversalQueue,
        exceptionQueue: exceptionQueue,
        rollforward: rollforward,
        openAccrualsForVendor: openAccrualsForVendor,
        ruleList: ruleList
    };
});
