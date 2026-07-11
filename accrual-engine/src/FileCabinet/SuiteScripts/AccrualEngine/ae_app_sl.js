/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * ae_app_sl.js  —  Accrual Workbench (modern SPA)
 * -----------------------------------------------
 * A single Suitelet that is BOTH the app shell and its JSON API:
 *   GET  (no ?api)      -> serves the self-contained SPA (ae_app.html)
 *   GET  ?api=<name>    -> returns JSON for that view
 *   POST {action,...}   -> performs an action, returns JSON
 *
 * The SPA calls this same URL with fetch(), so it runs on the user's live
 * session (no OAuth needed, unlike a RESTlet). All reads reuse ae_workbench_data
 * and all mutations reuse ae_actions, so the UI is a thin presentation layer
 * over the same engine the scheduled scripts use.
 */
define([
    'N/file', 'N/url', 'N/record', 'N/query', 'N/runtime', 'N/log', 'N/format',
    './lib/ae_constants', './lib/ae_util', './lib/ae_records',
    './lib/ae_workbench_data', './lib/ae_actions'
], function (file, url, record, query, runtime, log, format,
             C, util, records, data, actions) {
    'use strict';

    var RF = C.RULE_FIELD;
    var HTML_PATH = '/SuiteScripts/AccrualEngine/ae_app.html';

    function onRequest(context) {
        var req = context.request, res = context.response;
        try {
            if (req.method === 'POST') {
                return json(res, handlePost(req));
            }
            var api = req.parameters.api;
            if (api) {
                return json(res, handleApi(api, req.parameters));
            }
            return serveShell(res);
        } catch (e) {
            log.error({ title: 'ae_app_sl', details: (e && e.stack) || e });
            res.setHeader({ name: 'Content-Type', value: 'application/json' });
            res.write(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
        }
    }

    /* ------------------------------------------------------------------ *
     * Shell
     * ------------------------------------------------------------------ */
    function serveShell(res) {
        var html = file.load({ id: HTML_PATH }).getContents();
        var selfUrl = url.resolveScript({
            scriptId: 'customscript_ae_app_sl',
            deploymentId: 'customdeploy_ae_app_sl'
        });
        html = html.replace(/\{\{AE_URL\}\}/g, selfUrl);
        res.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
        res.write(html);
    }

    /* ------------------------------------------------------------------ *
     * GET JSON API
     * ------------------------------------------------------------------ */
    function handleApi(api, p) {
        var filters = {
            period: p.period || null, location: p.location || null,
            vendor: p.vendor || null, status: p.status || null, rule: p.rule || null
        };
        switch (api) {
            case 'bootstrap':   return { ok: true, data: bootstrap() };
            case 'dashboard':   return { ok: true, data: {
                                    tiles: data.dashboardTotals(filters),
                                    rollforward: withRunning(data.rollforward('period')) } };
            case 'rules':       return { ok: true, data: data.ruleList(false) };
            case 'rule':        return { ok: true, data: records.getRule(p.id) };
            case 'schedules':   return { ok: true, data: data.scheduleList(filters) };
            case 'reversals':   return { ok: true, data: data.reversalQueue(p.bucket || 'due') };
            case 'exceptions':  return { ok: true, data: data.exceptionQueue() };
            case 'rollforward': return { ok: true, data: withRunning(data.rollforward(p.groupby || 'period'),
                                    (p.groupby || 'period') === 'period') };
            case 'matching':    filters.status = C.SCHED_STATUS.POSTED;
                                return { ok: true, data: data.scheduleList(filters) };
            case 'lookup':      return { ok: true, data: lookup(p.type, p.q) };
            default: throw util.accrualError('AE_BAD_API', 'Unknown api: ' + api, false);
        }
    }

    /* ------------------------------------------------------------------ *
     * POST actions
     * ------------------------------------------------------------------ */
    function handlePost(req) {
        var body = JSON.parse(req.body || '{}');
        var a = body.action;
        var ids = body.ids || (body.scheduleId ? [body.scheduleId] : []);
        var out = [];
        switch (a) {
            case 'saveRule':
                return { ok: true, id: saveRule(body.rule) };
            case 'calculate':
            case 'post':
            case 'reverse':
            case 'reverse_reaccrue':
            case 'convert':
                ids.forEach(function (id) {
                    try { out.push(dispatchOne(a, id)); }
                    catch (e) { out.push({ ok: false, id: id, error: (e && e.message) || String(e) }); }
                });
                return { ok: true, results: out };
            case 'override':
                return { ok: true, result: actions.override(body.scheduleId, body.amount, body.qty, body.reason) };
            case 'match':
                return { ok: true, result: actions.matchBill(body.scheduleId, body.billId, body.amount, body.partial) };
            default:
                throw util.accrualError('AE_BAD_ACTION', 'Unknown action: ' + a, false);
        }
    }

    function dispatchOne(a, id) {
        switch (a) {
            case 'calculate': return actions.calculate(id);
            case 'post':      return actions.post(id);
            case 'reverse':   return actions.reverse(id, null);
            case 'reverse_reaccrue': return actions.reverseAndReaccrue(id);
            case 'convert':   return actions.convertToBill(id, null);
        }
    }

    /* ------------------------------------------------------------------ *
     * Rule create / update. Enum fields are set with setText because their
     * backing list value names ARE the engine tokens; reference + scalar fields
     * are set with setValue.
     * ------------------------------------------------------------------ */
    var ENUM_FIELDS = {
        calcType: RF.CALC_TYPE, qtySourceType: RF.QTY_SOURCE_TYPE, rateSource: RF.RATE_SOURCE,
        frequency: RF.FREQUENCY, reversalMethod: RF.REVERSAL_METHOD,
        reversalDateRule: RF.REVERSAL_DATE_RULE, billBehavior: RF.BILL_BEHAVIOR
    };
    var REF_FIELDS = {
        vendor: RF.VENDOR, subsidiary: RF.SUBSIDIARY, item: RF.ITEM, location: RF.LOCATION,
        journalCategory: RF.JOURNAL_CATEGORY, accrualAccount: RF.ACCRUAL_ACCOUNT,
        expenseAccount: RF.EXPENSE_ACCOUNT, owner: RF.OWNER, approver: RF.APPROVER
    };
    var NUM_FIELDS = {
        manualQty: RF.MANUAL_QTY, fixedAmount: RF.FIXED_AMOUNT, rate: RF.RATE,
        percentage: RF.PERCENTAGE, percentBasis: RF.PERCENT_BASIS,
        lookbackMonths: RF.LOOKBACK_MONTHS, varianceThreshold: RF.VARIANCE_THRESHOLD
    };
    var TEXT_FIELDS = {
        savedSearch: RF.SAVED_SEARCH, formula: RF.FORMULA, pluginScript: RF.PLUGIN_SCRIPT,
        memoTemplate: RF.MEMO_TEMPLATE, status: RF.STATUS
    };
    var DATE_FIELDS = { startDate: RF.START_DATE, endDate: RF.END_DATE };

    function saveRule(rule) {
        if (!rule) throw util.accrualError('AE_NO_RULE', 'No rule payload.', false);
        var rec = rule.id ? record.load({ type: C.RECORD.RULE, id: rule.id })
                          : record.create({ type: C.RECORD.RULE });
        if (rule.name !== undefined) rec.setValue({ fieldId: RF.NAME, value: rule.name });

        Object.keys(ENUM_FIELDS).forEach(function (k) {
            if (!util.isBlank(rule[k])) {
                try { rec.setText({ fieldId: ENUM_FIELDS[k], text: rule[k] }); } catch (e) { /* ignore bad token */ }
            }
        });
        Object.keys(REF_FIELDS).forEach(function (k) {
            if (!util.isBlank(rule[k])) rec.setValue({ fieldId: REF_FIELDS[k], value: rule[k] });
        });
        Object.keys(NUM_FIELDS).forEach(function (k) {
            if (!util.isBlank(rule[k])) rec.setValue({ fieldId: NUM_FIELDS[k], value: Number(rule[k]) });
        });
        Object.keys(TEXT_FIELDS).forEach(function (k) {
            if (rule[k] !== undefined) rec.setValue({ fieldId: TEXT_FIELDS[k], value: rule[k] });
        });
        Object.keys(DATE_FIELDS).forEach(function (k) {
            if (!util.isBlank(rule[k])) rec.setValue({ fieldId: DATE_FIELDS[k], value: parseDate(rule[k]) });
        });
        return rec.save({ enableSourcing: true, ignoreMandatoryFields: false });
    }

    /* ------------------------------------------------------------------ *
     * Bootstrap: enum option lists + small reference lists for the rule form.
     * ------------------------------------------------------------------ */
    function bootstrap() {
        return {
            user: { id: runtime.getCurrentUser().id, name: runtime.getCurrentUser().name },
            enums: {
                calcType: labeled(C.CALC_TYPE),
                frequency: labeled(C.FREQUENCY),
                rateSource: labeled(C.RATE_SOURCE),
                reversalMethod: labeled(C.REVERSAL_METHOD),
                reversalDateRule: labeled(C.REVERSAL_DATE_RULE),
                billBehavior: labeled(C.BILL_BEHAVIOR),
                qtySourceType: labeled(C.QTY_SOURCE)
            },
            refs: {
                subsidiary: smallList('subsidiary'),
                location: smallList('location'),
                journalCategory: journalCategories(),
                account: smallList('account')
            },
            periods: recentPeriods()
        };
    }

    function labeled(obj) {
        return Object.keys(obj).map(function (k) {
            var token = obj[k];
            return { value: token, label: prettify(token) };
        });
    }
    function prettify(t) {
        return String(t).replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    function smallList(type) {
        try {
            var col = type === 'account' ? 'acctname' : 'name';
            var rows = query.runSuiteQL({
                query: 'SELECT id, ' + col + ' AS name FROM ' + type +
                    (type === 'account' ? ' WHERE (isinactive = \'F\' OR isinactive IS NULL)' : '') +
                    ' ORDER BY name'
            }).asMappedResults();
            return rows.map(function (r) { return { id: r.id, name: r.name }; });
        } catch (e) { return []; }
    }

    function journalCategories() {
        try {
            var rows = query.runSuiteQL({
                query: 'SELECT id, name FROM customlist_ae_journal_category ORDER BY name'
            }).asMappedResults();
            return rows.map(function (r) { return { id: r.id, name: r.name }; });
        } catch (e) { return []; }
    }

    function recentPeriods() {
        try {
            var rows = query.runSuiteQL({
                query: 'SELECT id, periodname FROM accountingperiod ' +
                    'WHERE isquarter = \'F\' AND isyear = \'F\' ORDER BY startdate DESC FETCH FIRST 18 ROWS ONLY'
            }).asMappedResults();
            return rows.map(function (r) { return { id: r.id, name: r.periodname }; });
        } catch (e) { return []; }
    }

    /** Typeahead for large reference records (vendor, item). */
    function lookup(type, q) {
        if (!type || util.isBlank(q)) return [];
        var allowed = { vendor: 'entityid', item: 'itemid', employee: 'entityid' };
        if (!allowed[type]) return [];
        try {
            var rows = query.runSuiteQL({
                query: 'SELECT id, ' + allowed[type] + ' AS name FROM ' + type +
                    ' WHERE UPPER(' + allowed[type] + ') LIKE UPPER(?) ' +
                    'AND (isinactive = \'F\' OR isinactive IS NULL) ORDER BY name FETCH FIRST 20 ROWS ONLY',
                params: ['%' + q + '%']
            }).asMappedResults();
            return rows.map(function (r) { return { id: r.id, name: r.name }; });
        } catch (e) { return []; }
    }

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */
    function withRunning(rows, running) {
        var bal = 0;
        return rows.map(function (r) {
            var neu = Number(r.new_accruals || 0), rev = Number(r.reversals || 0), bills = Number(r.bills_applied || 0);
            var beginning = running ? bal : 0;
            var ending = beginning + neu - rev - bills;
            bal = ending;
            return { group: r.grp, beginning: beginning, newAccruals: neu,
                reversals: rev, billsApplied: bills, ending: ending };
        });
    }

    function parseDate(s) {
        if (s instanceof Date) return s;
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
        if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        try { return format.parse({ value: s, type: format.Type.DATE }); } catch (e) { return null; }
    }

    function json(res, obj) {
        res.setHeader({ name: 'Content-Type', value: 'application/json' });
        res.write(JSON.stringify(obj));
    }

    return { onRequest: onRequest };
});
