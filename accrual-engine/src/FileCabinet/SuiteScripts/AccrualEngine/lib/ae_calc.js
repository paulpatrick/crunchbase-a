/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_calc.js
 * ----------
 * The calculation engine. Given a flattened rule and a period context it
 * returns a normalised result { quantity, rate, amount, detail } regardless of
 * calculation type. Adding a new calc type means adding one case here and one
 * value to the calc-type custom list — no new scripts.
 *
 * MVP calc types (fully implemented): Fixed Amount, Manual Qty x Rate,
 * Saved Search Qty x Rate. Hours x Rate and Percentage reuse the same qty/rate
 * shape. Formula and Plugin are wired as extension points.
 */
define([
    './ae_constants',
    './ae_util',
    './ae_records',
    './ae_search'
], function (C, util, records, aeSearch) {
    'use strict';

    /**
     * @param {Object} rule    flattened rule (ae_records.getRule)
     * @param {Object} ctx     { periodStart, periodEnd, asOfDate, location,
     *                           item, vendor, hours, override }
     * @returns {Object} { quantity, rate, amount, detail }
     */
    function calculate(rule, ctx) {
        validateForCalc(rule);
        var asOf = ctx.asOfDate || ctx.periodEnd || new Date();
        var result;

        switch (rule.calcType) {
            case C.CALC_TYPE.FIXED_AMOUNT:
                result = calcFixed(rule);
                break;
            case C.CALC_TYPE.MANUAL_QTY_RATE:
                result = calcQtyRate(rule, ctx, asOf, rule.manualQty, 'manual');
                break;
            case C.CALC_TYPE.SEARCH_QTY_RATE:
                result = calcSearchQtyRate(rule, ctx, asOf);
                break;
            case C.CALC_TYPE.HOURS_RATE:
                result = calcQtyRate(rule, ctx, asOf, Number(ctx.hours || 0), 'hours');
                break;
            case C.CALC_TYPE.PERCENTAGE:
                result = calcPercentage(rule);
                break;
            case C.CALC_TYPE.FORMULA:
                result = calcFormula(rule, ctx);
                break;
            case C.CALC_TYPE.PLUGIN:
                result = calcPlugin(rule, ctx);
                break;
            default:
                throw util.accrualError(
                    'AE_UNKNOWN_CALC_TYPE',
                    'Unsupported calculation type: ' + rule.calcType, true);
        }

        result.amount = util.round(result.amount, 2);
        result.quantity = util.round(result.quantity || 0, 4);
        result.rate = util.round(result.rate || 0, 6);
        return result;
    }

    /* ------------------------------------------------------------------ *
     * Individual calc types
     * ------------------------------------------------------------------ */

    function calcFixed(rule) {
        if (util.isBlank(rule.fixedAmount)) {
            throw util.accrualError('AE_MISSING_FIXED',
                'Fixed Amount rule has no amount configured.', true);
        }
        return {
            quantity: 0,
            rate: 0,
            amount: Number(rule.fixedAmount),
            detail: { calcType: rule.calcType, fixedAmount: Number(rule.fixedAmount) }
        };
    }

    function calcQtyRate(rule, ctx, asOf, quantity, qtyOrigin) {
        if (util.isBlank(quantity)) {
            throw util.accrualError('AE_MISSING_QTY',
                'No quantity available for ' + qtyOrigin + ' calculation.', true);
        }
        var rate = resolveRate(rule, ctx, asOf);
        return {
            quantity: Number(quantity),
            rate: rate,
            amount: Number(quantity) * rate,
            detail: { calcType: rule.calcType, quantitySource: qtyOrigin, rate: rate }
        };
    }

    function calcSearchQtyRate(rule, ctx, asOf) {
        if (util.isBlank(rule.savedSearch)) {
            throw util.accrualError('AE_MISSING_SEARCH',
                'Saved-search calculation type requires a saved search id on the rule.', true);
        }
        var searchResult = aeSearch.runQuantitySearch(rule.savedSearch, ctx);
        var rate = resolveRate(rule, ctx, asOf);
        return {
            quantity: searchResult.quantity,
            rate: rate,
            amount: searchResult.quantity * rate,
            detail: {
                calcType: rule.calcType,
                savedSearch: rule.savedSearch,
                searchRows: searchResult.rows,
                quantitySource: 'saved_search',
                rate: rate
            }
        };
    }

    function calcPercentage(rule) {
        if (util.isBlank(rule.percentage) || util.isBlank(rule.percentBasis)) {
            throw util.accrualError('AE_MISSING_PCT',
                'Percentage calculation requires both a percentage and a basis amount.', true);
        }
        var amount = Number(rule.percentBasis) * (Number(rule.percentage) / 100);
        return {
            quantity: Number(rule.percentBasis),
            rate: Number(rule.percentage) / 100,
            amount: amount,
            detail: {
                calcType: rule.calcType,
                percentage: rule.percentage,
                basis: rule.percentBasis
            }
        };
    }

    /**
     * Formula calc. The rule stores a whitelisted arithmetic expression using
     * tokens {qty} {rate} {fixed} {pct} {basis}. We substitute numeric context
     * and evaluate with a guarded parser (no access to globals). Intentionally
     * limited to the four arithmetic operators, parentheses and numbers.
     */
    function calcFormula(rule, ctx) {
        var tokens = {
            qty: Number(ctx.quantity || rule.manualQty || 0),
            rate: Number(rule.rate || 0),
            fixed: Number(rule.fixedAmount || 0),
            pct: Number(rule.percentage || 0),
            basis: Number(rule.percentBasis || 0)
        };
        var expr = String(rule.formula || '').replace(/\{(\w+)\}/g, function (m, k) {
            return tokens[k] !== undefined ? '(' + tokens[k] + ')' : '0';
        });
        if (!/^[\d\s.+\-*/()]*$/.test(expr)) {
            throw util.accrualError('AE_BAD_FORMULA',
                'Formula contains unsupported characters: ' + rule.formula, true);
        }
        var amount = evalArithmetic(expr);
        return {
            quantity: tokens.qty,
            rate: tokens.rate,
            amount: amount,
            detail: { calcType: rule.calcType, formula: rule.formula, evaluated: expr }
        };
    }

    /**
     * Plugin calc. Delegates to a custom module whose path is stored on the
     * rule. The module must export calculate(rule, ctx) -> { quantity, rate,
     * amount, detail }. Loaded dynamically so the platform stays extensible.
     */
    function calcPlugin(rule, ctx) {
        if (util.isBlank(rule.pluginScript)) {
            throw util.accrualError('AE_MISSING_PLUGIN',
                'Plugin calculation type requires a plug-in module path.', true);
        }
        // eslint-disable-next-line
        var plugin = require(rule.pluginScript);
        if (!plugin || typeof plugin.calculate !== 'function') {
            throw util.accrualError('AE_BAD_PLUGIN',
                'Plug-in module ' + rule.pluginScript + ' has no calculate() export.', true);
        }
        var out = plugin.calculate(rule, ctx);
        out.detail = out.detail || {};
        out.detail.calcType = rule.calcType;
        out.detail.plugin = rule.pluginScript;
        return out;
    }

    /* ------------------------------------------------------------------ *
     * Rate resolution: rate table (versioned) if configured, else flat rate.
     * ------------------------------------------------------------------ */
    function resolveRate(rule, ctx, asOf) {
        if (rule.rateSource === C.RATE_SOURCE.RATE_TABLE) {
            var tableRate = records.resolveRate(rule.id, {
                location: ctx.location || rule.location,
                item: ctx.item || rule.item,
                vendor: ctx.vendor || rule.vendor
            }, asOf);
            if (tableRate === null) {
                throw util.accrualError('AE_NO_RATE',
                    'No effective rate found in the rate table for ' + util.formatDate(asOf) + '.', true);
            }
            return tableRate;
        }
        if (util.isBlank(rule.rate) || Number(rule.rate) === 0) {
            throw util.accrualError('AE_MISSING_RATE',
                'Rule has no rate configured.', true);
        }
        return Number(rule.rate);
    }

    /* ------------------------------------------------------------------ *
     * Guards / helpers
     * ------------------------------------------------------------------ */
    function validateForCalc(rule) {
        if (!rule.subsidiary) {
            throw util.accrualError('AE_MISSING_SUBSIDIARY', 'Rule is missing a subsidiary.', true);
        }
        if (!rule.calcType) {
            throw util.accrualError('AE_MISSING_CALC_TYPE', 'Rule is missing a calculation type.', true);
        }
        // A vendor is required for one-vendor-per-accrual integrity except for
        // fixed/percentage accruals that may be internal (e.g. bonus).
        var vendorless = [C.CALC_TYPE.PERCENTAGE];
        if (!rule.vendor && vendorless.indexOf(rule.calcType) === -1 &&
            rule.billBehavior !== C.BILL_BEHAVIOR.MATCH_ONLY) {
            // Not fatal for internal accruals, but flag for review.
            rule._warnNoVendor = true;
        }
    }

    /**
     * Shunting-yard evaluator for the whitelisted formula grammar. Avoids eval
     * entirely (banned in SuiteScript and unsafe). Supports + - * / and parens.
     */
    function evalArithmetic(expr) {
        var out = [];
        var ops = [];
        var prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
        var tokens = expr.match(/\d+\.?\d*|[+\-*/()]/g) || [];
        function applyOp() {
            var op = ops.pop();
            var b = out.pop();
            var a = out.pop();
            if (op === '+') out.push(a + b);
            else if (op === '-') out.push(a - b);
            else if (op === '*') out.push(a * b);
            else if (op === '/') out.push(b === 0 ? 0 : a / b);
        }
        tokens.forEach(function (t) {
            if (/^\d/.test(t)) {
                out.push(parseFloat(t));
            } else if (t === '(') {
                ops.push(t);
            } else if (t === ')') {
                while (ops.length && ops[ops.length - 1] !== '(') applyOp();
                ops.pop();
            } else {
                while (ops.length && prec[ops[ops.length - 1]] >= prec[t]) applyOp();
                ops.push(t);
            }
        });
        while (ops.length) applyOp();
        return out.length ? out[0] : 0;
    }

    /* ------------------------------------------------------------------ *
     * Final posted amount: apply an override if the schedule carries one.
     * ------------------------------------------------------------------ */
    function effectiveAmount(calcResult, schedule) {
        if (!util.isBlank(schedule.overrideAmount)) {
            return util.round(Number(schedule.overrideAmount), 2);
        }
        return calcResult.amount;
    }

    return {
        calculate: calculate,
        effectiveAmount: effectiveAmount,
        _evalArithmetic: evalArithmetic // exported for unit testing
    };
});
