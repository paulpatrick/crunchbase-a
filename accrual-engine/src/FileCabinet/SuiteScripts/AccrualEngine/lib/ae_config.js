/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * ae_config.js
 * ------------
 * Runtime resolution of things that vary per account and therefore cannot be
 * hard-coded in ae_constants: the internal ids of the two custom transaction
 * types, and a small cache so we resolve them once per execution.
 *
 * The custom transaction *type* internal id (e.g. "customtransaction123") is
 * what N/record.create expects. We look it up from the script-id stored in
 * ae_constants.TXN_TYPE so the codebase stays portable: change nothing but the
 * script id if the customer renamed the type.
 */
define(['N/query', './ae_constants', './ae_util'], function (query, C, util) {
    'use strict';

    var _cache = {};

    /**
     * Resolve a custom transaction type script id -> the internal type string
     * that record.create() needs. In SuiteScript the create type for a custom
     * transaction is the record's script id itself (lower-cased), so this
     * primarily validates existence and caches it.
     */
    function txnType(scriptId) {
        if (_cache[scriptId]) return _cache[scriptId];
        var rows = query.runSuiteQL({
            query: 'SELECT id, scriptid FROM customtransactiontype WHERE UPPER(scriptid) = UPPER(?)',
            params: [scriptId]
        }).asMappedResults();
        if (!rows.length) {
            throw util.accrualError('AE_NO_TXN_TYPE',
                'Custom transaction type not found: ' + scriptId +
                '. Verify the script id in ae_constants.TXN_TYPE matches the account.', false);
        }
        _cache[scriptId] = scriptId; // record.create uses the script id
        return scriptId;
    }

    function accrualType() { return txnType(C.TXN_TYPE.ACCRUAL); }
    function reversalType() { return txnType(C.TXN_TYPE.REVERSAL); }

    return {
        txnType: txnType,
        accrualType: accrualType,
        reversalType: reversalType
    };
});
