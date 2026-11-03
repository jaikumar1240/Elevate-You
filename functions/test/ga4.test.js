'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '../lib/ga4.js');
const now = Date.parse('2026-11-03T10:00:00Z');
const payment = {
    id: 'pay_test', planId: 'mock', bookedAt: new Date(now - 3600_000),
    analytics: { clientId: '123.456', sessionId: String(now / 1000 - 7200), adUserData: 'GRANTED' },
    bookingIdentity: { email: 'private@example.com', name: 'Private Person', contact: '+919876543210' },
    bookingUrl: 'https://calendly.com/x/y?email=private@example.com',
};

test('GA4 booking uses the real timestamp and identifiers with an explicit privacy-safe payload', async () => {
    assert.ok(fs.existsSync(modulePath), 'GA4 booking sender must exist');
    const { sendGa4Booking } = require(modulePath);
    let request;
    const result = await sendGa4Booking({
        measurementId: 'G-TQDPKWBBW0', apiSecret: 'private-secret', payment, now: () => now,
        fetchImpl: async (url, options) => { request = { url: new URL(url), body: JSON.parse(options.body) }; return { ok: true }; },
    });
    assert.equal(result.state, 'accepted');
    assert.equal(request.url.pathname, '/mp/collect');
    assert.equal(request.body.client_id, '123.456');
    assert.equal(request.body.timestamp_micros, (now - 3600_000) * 1000);
    assert.equal(request.body.events[0].name, 'schedule');
    assert.equal(request.body.events[0].params.session_id, Number(payment.analytics.sessionId));
    assert.equal(request.body.consent.ad_user_data, 'GRANTED');
    assert.doesNotMatch(JSON.stringify(request.body), /private@example|Private Person|9876543210|calendly|user_id/);
});

test('GA4 never fabricates IDs, overrides denied storage, or restamps out-of-window bookings', async () => {
    const { sendGa4Booking } = require(modulePath);
    let requests = 0;
    for (const [extra, reason] of [
        [{ analytics: {} }, 'missing_client_id'],
        [{ analytics: { clientId: '123.456', analyticsStorage: 'DENIED' } }, 'analytics_denied'],
        [{ bookedAt: new Date(now - 73 * 3600_000) }, 'timestamp_out_of_window'],
        [{ bookedAt: new Date(now + 1000) }, 'timestamp_out_of_window'],
    ]) {
        const result = await sendGa4Booking({
            measurementId: 'G-TQDPKWBBW0', apiSecret: 'secret', payment: { ...payment, ...extra }, now: () => now,
            fetchImpl: async () => { requests++; return { ok: true }; },
        });
        assert.equal(result.state, 'skipped');
        assert.equal(result.reason, reason);
    }
    assert.equal(requests, 0);
});

test('GA4 validation uses the non-ingesting endpoint and reports validation errors explicitly', async () => {
    const { sendGa4Booking } = require(modulePath);
    let requestUrl;
    const result = await sendGa4Booking({
        measurementId: 'G-TQDPKWBBW0', apiSecret: 'secret', payment, now: () => now, validateOnly: true,
        fetchImpl: async (url) => {
            requestUrl = new URL(url);
            return { ok: true, json: async () => ({ validationMessages: [{ validationCode: 'VALUE_INVALID' }] }) };
        },
    });
    assert.equal(requestUrl.pathname, '/debug/mp/collect');
    assert.equal(result.state, 'rejected');
    assert.equal(result.reason, 'validation_failed');
});
