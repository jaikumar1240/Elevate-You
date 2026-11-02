'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, validateLead } = require('../lib/validate');
const { buildUserData, sha256 } = require('../lib/meta');

test('normalizePhone handles common Indian formats', () => {
    assert.equal(normalizePhone('9876543210'), '9876543210');
    assert.equal(normalizePhone('+91 98765 43210'), '9876543210');
    assert.equal(normalizePhone('09876543210'), '9876543210');
    assert.equal(normalizePhone('919876543210'), '9876543210');
    assert.equal(normalizePhone('1234567890'), '');
    assert.equal(normalizePhone('98765'), '');
});

test('validateLead drops unknown status and attribution keys', () => {
    const { errors, lead } = validateLead({ name: ' Ravi ', phone: '9876543210', email: 'R@X.IN', consent: true, currentStatus: 'hacker', attribution: { gclid: 'g', foo: 'bar' } });
    assert.deepEqual(errors, {});
    assert.equal(lead.name, 'Ravi');
    assert.equal(lead.email, 'r@x.in');
    assert.equal(lead.currentStatus, '');
    assert.deepEqual(lead.attribution, { gclid: 'g' });
});

test('Meta user_data is hashed and normalised', () => {
    const ud = buildUserData({ id: '919876543210', name: 'Asha Verma', email: 'asha@example.com', phone: '9876543210', client: { ip: '1.2.3.4', userAgent: 'UA', fbp: 'fb.1', fbc: '' } });
    assert.deepEqual(ud.em, [sha256('asha@example.com')]);
    assert.deepEqual(ud.ph, [sha256('919876543210')]);
    assert.deepEqual(ud.fn, [sha256('asha')]);
    assert.deepEqual(ud.ln, [sha256('verma')]);
    assert.equal(ud.client_ip_address, '1.2.3.4');
    assert.equal(ud.fbp, 'fb.1');
    assert.equal('fbc' in ud, false);
});
