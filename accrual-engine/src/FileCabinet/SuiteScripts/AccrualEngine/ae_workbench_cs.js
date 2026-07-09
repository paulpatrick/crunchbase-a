/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * ae_workbench_cs.js
 * ------------------
 * Client behaviour for the Accrual Workbench Suitelet. Collects the schedule
 * ids the user checked in a sublist, stashes them (plus any prompted values)
 * into the hidden action fields, and submits the form back to the Suitelet's
 * POST handler. Also handles view navigation, filter apply, and CSV export.
 */
define(['N/currentRecord', 'N/url'], function (currentRecord, url) {
    'use strict';

    // The actionable sublist depends on the view; try each known id.
    var SUBLISTS = ['custpage_sched', 'custpage_match_list', 'custpage_rev_list'];

    function pageInit() { /* no-op; hook kept for future defaulting */ }

    /** Return the id of whichever actionable sublist is present on this page. */
    function activeSublist(rec) {
        for (var i = 0; i < SUBLISTS.length; i++) {
            try {
                if (rec.getLineCount({ sublistId: SUBLISTS[i] }) >= 0) {
                    // getLineCount throws if the sublist doesn't exist.
                    return SUBLISTS[i];
                }
            } catch (e) { /* not this one */ }
        }
        return null;
    }

    /** Collect raw schedule ids of checked rows. */
    function selectedIds(rec) {
        var sublistId = activeSublist(rec);
        if (!sublistId) return [];
        var ids = [];
        var n = rec.getLineCount({ sublistId: sublistId });
        for (var i = 0; i < n; i++) {
            var checked = rec.getSublistValue({ sublistId: sublistId, fieldId: 'sel', line: i });
            if (checked === true || checked === 'T') {
                ids.push(rec.getSublistValue({ sublistId: sublistId, fieldId: 'rawid', line: i }));
            }
        }
        return ids;
    }

    function setHidden(rec, field, value) {
        rec.setValue({ fieldId: field, value: value === undefined || value === null ? '' : String(value) });
    }

    /** Generic multi-row action (calculate/post/reverse/convert/...). */
    function aeAction(action) {
        var rec = currentRecord.get();
        var ids = selectedIds(rec);
        if (!ids.length) { alert('Select at least one schedule first.'); return; }

        var verb = action.replace(/_/g, ' ');
        if ((action === 'reverse' || action === 'convert' || action === 'reverse_reaccrue') &&
            !confirm('Confirm "' + verb + '" for ' + ids.length + ' schedule(s)?')) {
            return;
        }
        setHidden(rec, 'custpage_ae_action', action);
        setHidden(rec, 'custpage_ae_selected', ids.join(','));
        setHidden(rec, 'custpage_ae_view_post', currentView());
        submitForm();
    }

    /** Bill matching: one row at a time, prompt for bill id + amount. */
    function aeMatch(partial) {
        var rec = currentRecord.get();
        var ids = selectedIds(rec);
        if (ids.length !== 1) { alert('Select exactly one accrual to match.'); return; }

        var billId = prompt('Vendor Bill internal id to match:');
        if (!billId) return;
        var amount = prompt('Bill amount:');
        if (amount === null) return;

        setHidden(rec, 'custpage_ae_action', 'match');
        setHidden(rec, 'custpage_ae_selected', ids[0]);
        setHidden(rec, 'custpage_ae_bill', billId);
        setHidden(rec, 'custpage_ae_amount', amount);
        setHidden(rec, 'custpage_ae_partial', partial ? 'T' : 'F');
        setHidden(rec, 'custpage_ae_view_post', 'matching');
        submitForm();
    }

    /** Override prompt (reason required — enforced server-side too). */
    function aeOverride() {
        var rec = currentRecord.get();
        var ids = selectedIds(rec);
        if (ids.length !== 1) { alert('Select exactly one schedule to override.'); return; }
        var amount = prompt('Override amount:');
        if (amount === null) return;
        var reason = prompt('Reason for override (required):');
        if (!reason) { alert('A reason is required.'); return; }
        setHidden(rec, 'custpage_ae_action', 'override');
        setHidden(rec, 'custpage_ae_selected', ids[0]);
        setHidden(rec, 'custpage_ae_amount', amount);
        setHidden(rec, 'custpage_ae_reason', reason);
        setHidden(rec, 'custpage_ae_view_post', 'current');
        submitForm();
    }

    function aeGoto(view) { window.location.href = viewUrl(view); }

    function aeNewRule() {
        window.open('/app/common/custom/custrecordentry.nl?rectype=' + rectype('customrecord_accrual_rule'));
    }

    function aeApplyFilters() {
        var rec = currentRecord.get();
        var params = { ae_view: currentView() };
        ['custpage_flt_period', 'custpage_flt_location', 'custpage_flt_vendor', 'custpage_flt_status']
            .forEach(function (f) {
                var v;
                try { v = rec.getValue({ fieldId: f }); } catch (e) { v = null; }
                if (v) params[f.replace('custpage_flt_', '')] = v;
            });
        window.location.href = viewUrl(currentView(), params);
    }

    function aeExportRollforward() {
        // Re-request the rollforward view with an export flag the Suitelet can
        // honour by streaming CSV (handled server-side when ae_export=T).
        var params = new URLSearchParams(window.location.search);
        params.set('ae_export', 'T');
        window.location.href = window.location.pathname + '?' + params.toString();
    }

    /* helpers */
    function submitForm() {
        // NetSuite renders the Suitelet form as 'main_form'.
        if (typeof NLDoMainFormButtonAction === 'function') {
            document.forms['main_form'].submit();
        } else {
            document.forms[0].submit();
        }
    }
    function currentView() {
        var p = new URLSearchParams(window.location.search);
        return p.get('ae_view') || 'dashboard';
    }
    function viewUrl(view, extra) {
        var p = new URLSearchParams(window.location.search);
        p.set('ae_view', view);
        if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
        return window.location.pathname + '?' + p.toString();
    }
    function rectype(scriptId) {
        // Placeholder: the New Rule button ideally resolves the numeric rectype;
        // NetSuite also accepts the script id via the custom record UI.
        return scriptId;
    }

    return {
        pageInit: pageInit,
        aeAction: aeAction,
        aeMatch: aeMatch,
        aeOverride: aeOverride,
        aeGoto: aeGoto,
        aeNewRule: aeNewRule,
        aeApplyFilters: aeApplyFilters,
        aeExportRollforward: aeExportRollforward
    };
});
