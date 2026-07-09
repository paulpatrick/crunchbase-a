/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * ae_workbench_sl.js  —  Accrual Workbench (Phases 2-5)
 * -----------------------------------------------------
 * The single operator screen for the accrual platform. A GET renders one of the
 * views below (chosen by the `ae_view` param); a POST performs an action on the
 * selected schedule(s) and redirects back to the originating view.
 *
 * Views (mirroring the UI mockups):
 *   dashboard   1  Summary tiles + rollforward + reversals-due
 *   rules       2  Accrual Rules list
 *   current     4  Current Period schedules with Calculate/Post/Reverse/Convert
 *   matching    6  Bill Matching candidates + variance
 *   reversals   8  Reversal Manager queues
 *   exceptions 11  Exceptions queue
 *   rollforward10  Liability rollforward (exportable)
 *   history        Posted/reversed/matched history
 *
 * Rendering uses native N/ui/serverWidget so the workbench inherits the account
 * theme (the mockups' branding is illustrative only).
 */
define([
    'N/ui/serverWidget',
    'N/redirect',
    'N/url',
    'N/runtime',
    'N/log',
    './lib/ae_constants',
    './lib/ae_util',
    './lib/ae_workbench_data',
    './lib/ae_actions'
], function (ui, redirect, url, runtime, log, C, util, data, actions) {
    'use strict';

    var SCRIPT_ID = 'customscript_ae_workbench_sl';
    var DEPLOY_ID = 'customdeploy_ae_workbench_sl';

    var VIEWS = ['dashboard', 'rules', 'current', 'matching', 'reversals',
        'exceptions', 'rollforward', 'history'];

    function onRequest(context) {
        if (context.request.method === 'POST') {
            return handlePost(context);
        }
        var view = context.request.parameters.ae_view || 'dashboard';
        if (VIEWS.indexOf(view) === -1) view = 'dashboard';

        var form = ui.createForm({ title: 'Accrual Workbench' });
        addNavigation(form, view);
        addHiddenActionFields(form);
        form.clientScriptModulePath = './ae_workbench_cs.js';

        try {
            switch (view) {
                case 'rules':       renderRules(form, context); break;
                case 'current':     renderCurrentPeriod(form, context); break;
                case 'matching':    renderMatching(form, context); break;
                case 'reversals':   renderReversals(form, context); break;
                case 'exceptions':  renderExceptions(form, context); break;
                case 'rollforward': renderRollforward(form, context); break;
                case 'history':     renderHistory(form, context); break;
                case 'dashboard':
                default:            renderDashboard(form, context); break;
            }
        } catch (e) {
            log.error({ title: 'workbench render error (' + view + ')', details: e });
            form.addField({ id: 'custpage_err', type: ui.FieldType.INLINEHTML, label: ' ' })
                .defaultValue = '<p style="color:#b00">Error rendering view: ' +
                    escapeHtml((e && e.message) || String(e)) + '</p>';
        }

        context.response.writePage(form);
    }

    /* ================================================================== *
     * Navigation + shared chrome
     * ================================================================== */
    function addNavigation(form, active) {
        var labels = {
            dashboard: 'Dashboard', rules: 'Accrual Rules', current: 'Current Period',
            matching: 'Bill Matching', reversals: 'Reversals', exceptions: 'Exceptions',
            rollforward: 'Rollforward', history: 'History'
        };
        var links = VIEWS.map(function (v) {
            var href = viewUrl(v);
            var style = v === active
                ? 'font-weight:bold;text-decoration:none;color:#1f7a3d;border-bottom:2px solid #1f7a3d;padding:4px 10px;'
                : 'text-decoration:none;color:#555;padding:4px 10px;';
            return '<a href="' + href + '" style="' + style + '">' + labels[v] + '</a>';
        }).join(' | ');
        var fld = form.addField({ id: 'custpage_nav', type: ui.FieldType.INLINEHTML, label: ' ' });
        fld.defaultValue = '<div style="margin:6px 0 12px 0;font-size:13px;">' + links + '</div>';
    }

    function addHiddenActionFields(form) {
        addHidden(form, 'ae_action');
        addHidden(form, 'ae_selected');
        addHidden(form, 'ae_view_post');
        addHidden(form, 'ae_bill');
        addHidden(form, 'ae_amount');
        addHidden(form, 'ae_reason');
        addHidden(form, 'ae_partial');
    }

    function addHidden(form, id) {
        var f = form.addField({ id: 'custpage_' + id, type: ui.FieldType.TEXT, label: id });
        f.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        return f;
    }

    function viewUrl(view) {
        return url.resolveScript({
            scriptId: SCRIPT_ID, deploymentId: DEPLOY_ID, params: { ae_view: view }
        });
    }

    /* ================================================================== *
     * 1. DASHBOARD
     * ================================================================== */
    function renderDashboard(form, context) {
        var filters = readFilters(context);
        addFilterFields(form, context, filters, ['period', 'location', 'vendor']);

        var t = data.dashboardTotals(filters);
        var html =
            tileRow([
                tile('Total Accrual Liability', money(t.posted), 'Posted, unreversed'),
                tile('Pending (Not Posted)', money(t.pending), t.pendingCount + ' schedules'),
                tile('Reversals Due', String(t.reversalsDue), 'On or before today'),
                tile('Unmatched Bills / Open', String(t.unmatched), 'Awaiting a bill'),
                tile('Exceptions', String(t.exceptions), 'Require attention')
            ]);

        var rf = data.rollforward('period');
        html += '<h3 style="margin-top:18px;">Accrual Liability Rollforward</h3>';
        html += rollforwardTable(rf, true);

        var dueField = form.addField({ id: 'custpage_dash', type: ui.FieldType.INLINEHTML, label: ' ' });
        dueField.defaultValue = html;

        form.addButton({ id: 'custpage_goreversals', label: 'View Reversals Due',
            functionName: 'aeGoto("reversals")' });
        form.addButton({ id: 'custpage_gocurrent', label: 'Open Current Period',
            functionName: 'aeGoto("current")' });
    }

    /* ================================================================== *
     * 2. ACCRUAL RULES
     * ================================================================== */
    function renderRules(form, context) {
        form.addButton({ id: 'custpage_newrule', label: 'New Rule', functionName: 'aeNewRule()' });
        var rows = data.ruleList(true);
        var list = form.addSublist({ id: 'custpage_rules', type: ui.SublistType.LIST, label: 'Active Rules' });
        list.addField({ id: 'name', type: ui.FieldType.TEXT, label: 'Rule' });
        list.addField({ id: 'calc_type', type: ui.FieldType.TEXT, label: 'Type' });
        list.addField({ id: 'vendor', type: ui.FieldType.TEXT, label: 'Vendor' });
        list.addField({ id: 'location', type: ui.FieldType.TEXT, label: 'Location' });
        list.addField({ id: 'frequency', type: ui.FieldType.TEXT, label: 'Frequency' });
        list.addField({ id: 'status', type: ui.FieldType.TEXT, label: 'Status' });
        list.addField({ id: 'link', type: ui.FieldType.TEXT, label: 'Open' });
        rows.forEach(function (r, i) {
            setText(list, 'name', i, r.name);
            setText(list, 'calc_type', i, r.calc_type);
            setText(list, 'vendor', i, r.vendor);
            setText(list, 'location', i, r.location);
            setText(list, 'frequency', i, r.frequency);
            setText(list, 'status', i, isTrue(r.inactive) ? 'Inactive' : 'Active');
            setText(list, 'link', i, recordLink(C.RECORD.RULE, r.id, 'Edit'));
        });
    }

    /* ================================================================== *
     * 4. CURRENT PERIOD
     * ================================================================== */
    function renderCurrentPeriod(form, context) {
        var filters = readFilters(context);
        addFilterFields(form, context, filters, ['period', 'location', 'status']);

        form.addButton({ id: 'custpage_calc', label: 'Calculate', functionName: 'aeAction("calculate")' });
        form.addButton({ id: 'custpage_recalc', label: 'Recalculate', functionName: 'aeAction("recalculate")' });
        form.addButton({ id: 'custpage_post', label: 'Post Accrual', functionName: 'aeAction("post")' });
        form.addButton({ id: 'custpage_rev', label: 'Reverse', functionName: 'aeAction("reverse")' });
        form.addButton({ id: 'custpage_rerev', label: 'Reverse & Reaccrue', functionName: 'aeAction("reverse_reaccrue")' });
        form.addButton({ id: 'custpage_conv', label: 'Convert to Bill', functionName: 'aeAction("convert")' });

        var rows = data.scheduleList(filters);
        var list = form.addSublist({ id: 'custpage_sched', type: ui.SublistType.LIST, label: 'Schedules' });
        list.addField({ id: 'sel', type: ui.FieldType.CHECKBOX, label: 'Select' });
        list.addField({ id: 'rawid', type: ui.FieldType.TEXT, label: 'ID' })
            .updateDisplayType({ displayType: ui.FieldDisplayType.DISABLED });
        list.addField({ id: 'rulename', type: ui.FieldType.TEXT, label: 'Rule' });
        list.addField({ id: 'vendor', type: ui.FieldType.TEXT, label: 'Vendor' });
        list.addField({ id: 'location', type: ui.FieldType.TEXT, label: 'Location' });
        list.addField({ id: 'period', type: ui.FieldType.TEXT, label: 'Period' });
        list.addField({ id: 'qty', type: ui.FieldType.TEXT, label: 'Qty' });
        list.addField({ id: 'rate', type: ui.FieldType.TEXT, label: 'Rate' });
        list.addField({ id: 'amount', type: ui.FieldType.TEXT, label: 'Amount' });
        list.addField({ id: 'override', type: ui.FieldType.TEXT, label: 'Override' });
        list.addField({ id: 'status', type: ui.FieldType.TEXT, label: 'Status' });
        list.addField({ id: 'revdate', type: ui.FieldType.TEXT, label: 'Reversal Date' });
        list.addField({ id: 'accrual', type: ui.FieldType.TEXT, label: 'Accrual' });
        list.addField({ id: 'idcol', type: ui.FieldType.TEXT, label: 'Schedule' });

        rows.forEach(function (r, i) {
            setText(list, 'rawid', i, r.id);
            setText(list, 'rulename', i, r.rulename);
            setText(list, 'vendor', i, r.vendor);
            setText(list, 'location', i, r.location);
            setText(list, 'period', i, r.period);
            setText(list, 'qty', i, num(r.qty));
            setText(list, 'rate', i, num(r.rate));
            setText(list, 'amount', i, money(effective(r)));
            setText(list, 'override', i, util.isBlank(r.override_amount) ? '' : money(r.override_amount));
            setText(list, 'status', i, prettyStatus(r.status));
            setText(list, 'revdate', i, r.reversal_date || '');
            setText(list, 'accrual', i, r.accrual_txn ? recordTxnLink(r.accrual_txn, '#' + r.accrual_txn) : '');
            setText(list, 'idcol', i, recordLink(C.RECORD.SCHEDULE, r.id, String(r.id)));
        });
        // Stash raw ids for the client to collect on action.
        stashIds(form, rows);
    }

    /* ================================================================== *
     * 6. BILL MATCHING
     * ================================================================== */
    function renderMatching(form, context) {
        var filters = readFilters(context);
        filters.status = C.SCHED_STATUS.POSTED;
        addFilterFields(form, context, filters, ['vendor', 'location']);

        form.addButton({ id: 'custpage_match', label: 'Match Selected', functionName: 'aeMatch(false)' });
        form.addButton({ id: 'custpage_pmatch', label: 'Partially Match', functionName: 'aeMatch(true)' });
        form.addButton({ id: 'custpage_mrev', label: 'Match & Reverse', functionName: 'aeMatch(false)' });

        var rows = data.scheduleList(filters);
        var list = form.addSublist({ id: 'custpage_match_list', type: ui.SublistType.LIST,
            label: 'Open Accruals — enter Bill and Bill Amount to match' });
        list.addField({ id: 'sel', type: ui.FieldType.CHECKBOX, label: 'Select' });
        list.addField({ id: 'rawid', type: ui.FieldType.TEXT, label: 'ID' })
            .updateDisplayType({ displayType: ui.FieldDisplayType.DISABLED });
        list.addField({ id: 'rulename', type: ui.FieldType.TEXT, label: 'Rule' });
        list.addField({ id: 'vendor', type: ui.FieldType.TEXT, label: 'Vendor' });
        list.addField({ id: 'period', type: ui.FieldType.TEXT, label: 'Period' });
        list.addField({ id: 'accrued', type: ui.FieldType.TEXT, label: 'Accrued Amount' });
        list.addField({ id: 'variance', type: ui.FieldType.TEXT, label: 'Last Variance' });
        list.addField({ id: 'idcol', type: ui.FieldType.TEXT, label: 'Schedule' });

        rows.forEach(function (r, i) {
            setText(list, 'rawid', i, r.id);
            setText(list, 'rulename', i, r.rulename);
            setText(list, 'vendor', i, r.vendor);
            setText(list, 'period', i, r.period);
            setText(list, 'accrued', i, money(effective(r)));
            setText(list, 'variance', i, util.isBlank(r.variance) ? '' : money(r.variance));
            setText(list, 'idcol', i, String(r.id));
        });
        stashIds(form, rows);
    }

    /* ================================================================== *
     * 8. REVERSAL MANAGER
     * ================================================================== */
    function renderReversals(form, context) {
        var bucket = context.request.parameters.bucket || 'due';
        var bucketField = form.addField({ id: 'custpage_bucket', type: ui.FieldType.SELECT, label: 'Queue' });
        [['due', 'Due Now / Overdue'], ['future', 'Future'], ['failed', 'Failed'],
         ['reversed', 'Reversed'], ['missing', 'Missing Reversal Date']]
            .forEach(function (b) { bucketField.addSelectOption({ value: b[0], text: b[1] }); });
        bucketField.defaultValue = bucket;

        form.addButton({ id: 'custpage_crev', label: 'Create Reversal', functionName: 'aeAction("reverse")' });
        form.addButton({ id: 'custpage_retry', label: 'Retry Failed', functionName: 'aeAction("reverse")' });

        var rows = data.reversalQueue(bucket);
        var list = form.addSublist({ id: 'custpage_rev_list', type: ui.SublistType.LIST, label: 'Reversals' });
        list.addField({ id: 'sel', type: ui.FieldType.CHECKBOX, label: 'Select' });
        list.addField({ id: 'rawid', type: ui.FieldType.TEXT, label: 'ID' })
            .updateDisplayType({ displayType: ui.FieldDisplayType.DISABLED });
        list.addField({ id: 'rulename', type: ui.FieldType.TEXT, label: 'Rule' });
        list.addField({ id: 'amount', type: ui.FieldType.TEXT, label: 'Amount' });
        list.addField({ id: 'revdate', type: ui.FieldType.TEXT, label: 'Reversal Date' });
        list.addField({ id: 'revstatus', type: ui.FieldType.TEXT, label: 'Reversal Status' });
        list.addField({ id: 'reason', type: ui.FieldType.TEXT, label: 'Reason' });
        list.addField({ id: 'accrual', type: ui.FieldType.TEXT, label: 'Accrual' });
        list.addField({ id: 'reversal', type: ui.FieldType.TEXT, label: 'Reversal' });
        list.addField({ id: 'idcol', type: ui.FieldType.TEXT, label: 'Schedule' });
        rows.forEach(function (r, i) {
            setText(list, 'rawid', i, r.id);
            setText(list, 'rulename', i, r.rulename);
            setText(list, 'amount', i, money(r.amount));
            setText(list, 'revdate', i, r.reversal_date || '');
            setText(list, 'revstatus', i, prettyStatus(r.reversal_status));
            setText(list, 'reason', i, r.reason || '');
            setText(list, 'accrual', i, r.accrual_txn ? recordTxnLink(r.accrual_txn, '#' + r.accrual_txn) : '');
            setText(list, 'reversal', i, r.reversal_txn ? recordTxnLink(r.reversal_txn, '#' + r.reversal_txn) : '');
            setText(list, 'idcol', i, recordLink(C.RECORD.SCHEDULE, r.id, String(r.id)));
        });
        stashIds(form, rows);
    }

    /* ================================================================== *
     * 11. EXCEPTIONS
     * ================================================================== */
    function renderExceptions(form, context) {
        var rows = data.exceptionQueue();
        var list = form.addSublist({ id: 'custpage_exc_list', type: ui.SublistType.LIST, label: 'Exceptions' });
        list.addField({ id: 'rulename', type: ui.FieldType.TEXT, label: 'Rule' });
        list.addField({ id: 'period', type: ui.FieldType.TEXT, label: 'Period' });
        list.addField({ id: 'reason', type: ui.FieldType.TEXT, label: 'Exception' });
        list.addField({ id: 'idcol', type: ui.FieldType.TEXT, label: 'Open' });
        rows.forEach(function (r, i) {
            setText(list, 'rulename', i, r.rulename);
            setText(list, 'period', i, r.period);
            setText(list, 'reason', i, r.reason || '');
            setText(list, 'idcol', i, recordLink(C.RECORD.SCHEDULE, r.id, 'Resolve'));
        });
    }

    /* ================================================================== *
     * 10. ROLLFORWARD
     * ================================================================== */
    function renderRollforward(form, context) {
        var groupBy = context.request.parameters.groupby || 'period';
        var gb = form.addField({ id: 'custpage_groupby', type: ui.FieldType.SELECT, label: 'Group By' });
        [['period', 'Accounting Period'], ['vendor', 'Vendor'],
         ['location', 'Location'], ['rule', 'Accrual Rule']]
            .forEach(function (g) { gb.addSelectOption({ value: g[0], text: g[1] }); });
        gb.defaultValue = groupBy;

        var rows = data.rollforward(groupBy);
        var html = '<h3>Liability Rollforward by ' + groupBy + '</h3>' +
            rollforwardTable(rows, groupBy === 'period');
        form.addField({ id: 'custpage_rf', type: ui.FieldType.INLINEHTML, label: ' ' }).defaultValue = html;
        form.addButton({ id: 'custpage_export', label: 'Export CSV', functionName: 'aeExportRollforward()' });
    }

    /* ================================================================== *
     * HISTORY
     * ================================================================== */
    function renderHistory(form, context) {
        var filters = readFilters(context);
        addFilterFields(form, context, filters, ['period', 'vendor']);
        var rows = data.scheduleList(filters).filter(function (r) {
            return [C.SCHED_STATUS.REVERSED, C.SCHED_STATUS.MATCHED,
                C.SCHED_STATUS.CONVERTED, C.SCHED_STATUS.CLOSED].indexOf(r.status) !== -1;
        });
        var list = form.addSublist({ id: 'custpage_hist', type: ui.SublistType.LIST, label: 'History' });
        list.addField({ id: 'rulename', type: ui.FieldType.TEXT, label: 'Rule' });
        list.addField({ id: 'period', type: ui.FieldType.TEXT, label: 'Period' });
        list.addField({ id: 'amount', type: ui.FieldType.TEXT, label: 'Amount' });
        list.addField({ id: 'status', type: ui.FieldType.TEXT, label: 'Status' });
        list.addField({ id: 'variance', type: ui.FieldType.TEXT, label: 'Variance' });
        list.addField({ id: 'idcol', type: ui.FieldType.TEXT, label: 'Open' });
        rows.forEach(function (r, i) {
            setText(list, 'rulename', i, r.rulename);
            setText(list, 'period', i, r.period);
            setText(list, 'amount', i, money(effective(r)));
            setText(list, 'status', i, prettyStatus(r.status));
            setText(list, 'variance', i, util.isBlank(r.variance) ? '' : money(r.variance));
            setText(list, 'idcol', i, recordLink(C.RECORD.SCHEDULE, r.id, String(r.id)));
        });
    }

    /* ================================================================== *
     * POST handler / action dispatch
     * ================================================================== */
    function handlePost(context) {
        var p = context.request.parameters;
        var action = p.custpage_ae_action;
        var view = p.custpage_ae_view_post || 'current';
        var selected = (p.custpage_ae_selected || '').split(',')
            .map(function (s) { return s.trim(); })
            .filter(function (s) { return s.length; });

        var results = [];
        selected.forEach(function (scheduleId) {
            try {
                results.push(dispatch(action, scheduleId, p, context));
            } catch (e) {
                log.error({ title: 'action ' + action + ' failed for ' + scheduleId, details: e });
                results.push({ ok: false, id: scheduleId, error: (e && e.message) || String(e) });
            }
        });

        var ok = results.filter(function (r) { return r.ok; }).length;
        var fail = results.length - ok;
        redirect.toSuitelet({
            scriptId: SCRIPT_ID, deploymentId: DEPLOY_ID,
            parameters: { ae_view: view, ae_done: action, ae_ok: ok, ae_fail: fail }
        });
    }

    function dispatch(action, scheduleId, p) {
        switch (action) {
            case 'calculate':
            case 'recalculate':   return actions.calculate(scheduleId);
            case 'post':          return actions.post(scheduleId);
            case 'reverse':       return actions.reverse(scheduleId, null);
            case 'reverse_reaccrue': return actions.reverseAndReaccrue(scheduleId);
            case 'convert':       return actions.convertToBill(scheduleId, null);
            case 'override':      return actions.override(scheduleId,
                                        p.custpage_ae_amount, null, p.custpage_ae_reason);
            case 'match':         return actions.matchBill(scheduleId, p.custpage_ae_bill,
                                        p.custpage_ae_amount, p.custpage_ae_partial === 'T');
            default:
                throw util.accrualError('AE_UNKNOWN_ACTION', 'Unknown action: ' + action, false);
        }
    }

    /* ================================================================== *
     * Rendering helpers
     * ================================================================== */
    function readFilters(context) {
        var p = context.request.parameters;
        return {
            period: p.period || p.custpage_flt_period || null,
            location: p.location || p.custpage_flt_location || null,
            vendor: p.vendor || p.custpage_flt_vendor || null,
            status: p.status || p.custpage_flt_status || null
        };
    }

    function addFilterFields(form, context, filters, which) {
        var grp = form.addFieldGroup({ id: 'custpage_flt_grp', label: 'Filters' });
        which.forEach(function (f) {
            var source = { period: 'accountingperiod', location: 'location',
                vendor: 'vendor' }[f];
            var fld;
            if (f === 'status') {
                fld = form.addField({ id: 'custpage_flt_status', type: ui.FieldType.SELECT,
                    label: 'Status', container: 'custpage_flt_grp' });
                fld.addSelectOption({ value: '', text: '- All -' });
                Object.keys(C.SCHED_STATUS).forEach(function (k) {
                    fld.addSelectOption({ value: C.SCHED_STATUS[k], text: prettyStatus(C.SCHED_STATUS[k]) });
                });
            } else {
                fld = form.addField({ id: 'custpage_flt_' + f, type: ui.FieldType.SELECT,
                    label: cap(f), source: source, container: 'custpage_flt_grp' });
            }
            if (filters[f]) fld.defaultValue = filters[f];
        });
        // filters submit via GET
        form.addButton({ id: 'custpage_applyflt', label: 'Apply Filters', functionName: 'aeApplyFilters()' });
    }

    function tile(label, value, sub) {
        return '<td style="border:1px solid #ddd;border-radius:6px;padding:12px 16px;min-width:150px;">' +
            '<div style="font-size:11px;color:#888;text-transform:uppercase;">' + escapeHtml(label) + '</div>' +
            '<div style="font-size:22px;font-weight:bold;margin:4px 0;">' + escapeHtml(value) + '</div>' +
            '<div style="font-size:11px;color:#999;">' + escapeHtml(sub || '') + '</div></td>';
    }
    function tileRow(tiles) {
        return '<table cellspacing="10"><tr>' + tiles.join('') + '</tr></table>';
    }

    function rollforwardTable(rows, runningBalance) {
        var html = '<table border="0" cellspacing="0" cellpadding="6" ' +
            'style="border-collapse:collapse;font-size:12px;width:100%;max-width:900px;">' +
            '<tr style="background:#f2f2f2;text-align:right;">' +
            '<th style="text-align:left;">Group</th><th>Beginning</th><th>New Accruals</th>' +
            '<th>Reversals</th><th>Bills Applied</th><th>Adjustments</th><th>Ending</th></tr>';
        var running = 0;
        rows.forEach(function (r) {
            var beginning = runningBalance ? running : 0;
            var neu = Number(r.new_accruals || 0);
            var rev = Number(r.reversals || 0);
            var bills = Number(r.bills_applied || 0);
            var ending = beginning + neu - rev - bills;
            running = ending;
            html += '<tr style="text-align:right;border-top:1px solid #eee;">' +
                '<td style="text-align:left;">' + escapeHtml(r.grp || '(none)') + '</td>' +
                '<td>' + money(beginning) + '</td>' +
                '<td>' + money(neu) + '</td>' +
                '<td>(' + money(rev) + ')</td>' +
                '<td>(' + money(bills) + ')</td>' +
                '<td>$0.00</td>' +
                '<td><b>' + money(ending) + '</b></td></tr>';
        });
        html += '</table>';
        return html;
    }

    /* small formatting utils */
    function effective(r) {
        return util.isBlank(r.override_amount) ? Number(r.amount || 0) : Number(r.override_amount);
    }
    function money(v) {
        var n = Number(v || 0);
        return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function num(v) { return util.isBlank(v) ? '' : String(Number(v)); }
    function prettyStatus(s) {
        if (!s) return '';
        return String(s).replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
    function setText(list, id, line, value) {
        list.setSublistValue({ id: id, line: line, value: (value === null || value === undefined || value === '') ? ' ' : String(value) });
    }
    function isTrue(v) { var s = String(v).toUpperCase(); return s === 'T' || s === 'TRUE'; }
    function stashIds(form, rows) {
        addHidden(form, 'rowids').defaultValue = rows.map(function (r) { return r.id; }).join(',');
    }
    function recordLink(type, id, label) {
        var href = url.resolveRecord({ recordType: type, recordId: id, isEditMode: false });
        return '<a href="' + href + '" target="_blank">' + escapeHtml(label) + '</a>';
    }
    function recordTxnLink(id, label) {
        var href = '/app/accounting/transactions/transaction.nl?id=' + id;
        return '<a href="' + href + '" target="_blank">' + escapeHtml(label) + '</a>';
    }
    function escapeHtml(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    return { onRequest: onRequest };
});
