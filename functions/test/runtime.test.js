'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('booking scheduler owns the new secrets without extending HTTP API access', () => {
    const functions = require('../index');
    assert.equal(typeof functions.bookingSync, 'function');
    const apiSecrets = functions.api.__endpoint.secretEnvironmentVariables.map((secret) => secret.key);
    const syncSecrets = functions.bookingSync.__endpoint.secretEnvironmentVariables.map((secret) => secret.key);
    assert.ok(!apiSecrets.includes('CALENDLY_SYNC_TOKEN'));
    assert.ok(!apiSecrets.includes('GA4_API_SECRET'));
    assert.deepEqual(syncSecrets.sort(), ['CALENDLY_SYNC_TOKEN', 'GA4_API_SECRET', 'META_CAPI_TOKEN']);
    assert.equal(functions.bookingSync.__endpoint.scheduleTrigger.schedule, 'every 5 minutes');
    assert.equal(functions.bookingSync.__endpoint.timeoutSeconds, 540);
});
