'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('CRM shows per-payment booking and independent delivery states with escaped operational errors', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    assert.equal(vm.runInContext('typeof bookingDetails', context), 'function');
    vm.runInContext(`payments = [{
        id: 'pay_old', leadId: 'lead', bookingSyncState: 'confirmed', bookedAt: new Date(),
        metaDelivery: { state: 'accepted' }, ga4Delivery: { state: 'ambiguous', reason: '<script>bad</script>' }
    }];`, context);
    const markup = vm.runInContext("bookingDetails({ id: 'lead' })", context);
    assert.match(markup, /Initial booking confirmed/);
    assert.match(markup, /Meta: accepted/);
    assert.match(markup, /GA4: ambiguous/);
    assert.doesNotMatch(markup, /<script>/);
    assert.match(markup, /&lt;script&gt;/);
});

test('CRM flags conversions held because a booking is not API-confirmed', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    vm.runInContext(`payments = [{
        id: 'pay_old', leadId: 'lead', bookingSyncState: 'pending',
        conversionError: 'unconfirmed_booking'
    }];`, context);
    const markup = vm.runInContext("bookingDetails({ id: 'lead' })", context);
    assert.match(markup, /Conversion review: unconfirmed_booking/);
});
