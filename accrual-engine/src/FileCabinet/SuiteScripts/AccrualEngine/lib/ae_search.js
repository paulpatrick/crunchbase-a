/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_search.js
 * ------------
 * Quantity drivers backed by NetSuite saved searches, plus the candidate-bill
 * lookup used by the Bill Matching tab.
 *
 * A quantity saved search is authored in NetSuite (so accountants own the
 * shipment/fulfillment logic) and referenced by script/internal id on the rule.
 * The engine only cares that the search exposes a numeric total it can read.
 * We add period date filters at run time so the same saved search can be reused
 * across every period.
 */
define([
    'N/search',
    'N/query',
    './ae_constants',
    './ae_util'
], function (search, query, C, util) {
    'use strict';

    /**
     * Run the rule's quantity saved search for a period and return the summed
     * quantity. The search is expected to have a numeric column tagged as the
     * quantity — by convention the first formulanumeric / sum column, otherwise
     * a column whose id is 'quantity'. Period bounds are injected as an extra
     * `trandate within` filter unless the search already constrains dates.
     *
     * @returns {{ quantity:Number, rows:Number, groups:Array }}
     */
    function runQuantitySearch(savedSearchId, ctx) {
        var s = search.load({ id: savedSearchId });

        // Inject period date bounds so one saved search serves every period.
        if (ctx.periodStart && ctx.periodEnd) {
            s.filters.push(search.createFilter({
                name: 'trandate',
                operator: search.Operator.WITHIN,
                values: [util.formatDate(ctx.periodStart), util.formatDate(ctx.periodEnd)]
            }));
        }

        var qtyColumn = pickQuantityColumn(s);
        if (!qtyColumn) {
            throw util.accrualError(
                'AE_SEARCH_NO_QTY_COL',
                'Saved search ' + savedSearchId + ' exposes no numeric quantity column.',
                true
            );
        }

        var total = 0;
        var rowCount = 0;
        var groups = [];
        var pagedData = s.runPaged({ pageSize: 1000 });
        pagedData.pageRanges.forEach(function (pageRange) {
            var page = pagedData.fetch({ index: pageRange.index });
            page.data.forEach(function (result) {
                var v = Number(result.getValue(qtyColumn) || 0);
                total += v;
                rowCount++;
                groups.push({
                    quantity: v,
                    location: safeText(result, 'location'),
                    item: safeText(result, 'item')
                });
            });
        });

        if (rowCount === 0) {
            throw util.accrualError(
                'AE_SEARCH_EMPTY',
                'Quantity saved search ' + savedSearchId + ' returned no rows for period ' +
                util.formatDate(ctx.periodStart) + ' - ' + util.formatDate(ctx.periodEnd) + '.',
                true
            );
        }

        return { quantity: util.round(total, 4), rows: rowCount, groups: groups };
    }

    /** Prefer a summary(SUM) numeric column, then an id === 'quantity' column. */
    function pickQuantityColumn(s) {
        var cols = s.columns;
        var summed = null;
        var byId = null;
        for (var i = 0; i < cols.length; i++) {
            var c = cols[i];
            if (c.summary === search.Summary.SUM && !summed) summed = c;
            if (String(c.name).toLowerCase() === 'quantity' && !byId) byId = c;
        }
        return summed || byId || null;
    }

    function safeText(result, colName) {
        try {
            return result.getText({ name: colName }) || result.getValue({ name: colName }) || '';
        } catch (e) {
            return '';
        }
    }

    /* ------------------------------------------------------------------ *
     * Candidate vendor bills for the Bill Matching tab.
     *
     * Finds standard Vendor Bills (transaction type VendBill) that are not yet
     * linked to an accrual schedule, filtered by vendor/subsidiary and a date
     * window derived from the rule's lookback months.
     * ------------------------------------------------------------------ */
    function findCandidateBills(opts) {
        var sql =
            'SELECT t.id, t.tranid, t.trandate, t.entity, t.foreigntotal AS total, ' +
            '       BUILTIN.DF(t.entity) AS vendorname ' +
            'FROM transaction t ' +
            'WHERE t.type = \'VendBill\' ' +
            '  AND t.trandate >= ? ';
        var params = [util.formatDate(opts.fromDate)];

        if (opts.vendor) { sql += ' AND t.entity = ? '; params.push(opts.vendor); }
        if (opts.subsidiary) {
            sql += ' AND EXISTS (SELECT 1 FROM transactionline tl ' +
                'WHERE tl.transaction = t.id AND tl.subsidiary = ?) ';
            params.push(opts.subsidiary);
        }
        // Exclude bills already matched/converted to a schedule.
        sql += ' AND NOT EXISTS (SELECT 1 FROM ' + C.RECORD.SCHEDULE + ' s ' +
            'WHERE s.' + C.SCHED_FIELD.MATCHED_BILL + ' = t.id ' +
            '   OR s.' + C.SCHED_FIELD.CONVERTED_BILL + ' = t.id) ';
        sql += ' ORDER BY t.trandate DESC';

        return query.runSuiteQL({ query: sql, params: params }).asMappedResults();
    }

    return {
        runQuantitySearch: runQuantitySearch,
        findCandidateBills: findCandidateBills
    };
});
