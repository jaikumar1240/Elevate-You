'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../lib/app');
const { createDb, FieldValue } = require('./fake-firestore');

const SECRET = 'rzp_secret';
const WEBHOOK_SECRET = 'whsec';

function setup(overrides = {}) {
    const db = createDb();
    const calls = { meta: [], alerts: [], orders: [] };
    const cfg = {
        razorpayKeyId: 'rzp_test_key', razorpayKeySecret: SECRET, razorpayWebhookSecret: WEBHOOK_SECRET,
        metaToken: 'tok', metaPixelId: 'px', metaTestEventCode: '', gmailAppPassword: 'pw',
        adminEmail: 'admin@example.com', calendlyToken: '', calendlyUrl: 'https://calendly.com/x/y', siteUrl: 'https://site',
        ...overrides.cfg,
    };
    let n = 0;
    const app = createApp({
        db, FieldValue,
        getConfig: () => cfg,
        createRazorpay: () => ({
            orders: {
                create: async (o) => {
                    if (overrides.orderFails) throw new Error('rzp down');
                    calls.orders.push(o);
                    return { id: `order_${++n}`, amount: o.amount, currency: o.currency };
                },
            },
        }),
        sendMetaEvent: async (e) => { calls.meta.push(e); return { ok: true }; },
        sendAlert: async (a) => { calls.alerts.push(a); return { ok: true }; },
        createBookingUrl: async ({ publicUrl }) => `${publicUrl}?single=1`,
    });
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            const post = async (path, body, headers = {}) => {
                const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
                return { status: res.status, body: await res.json().catch(() => null) };
            };
            resolve({ db, calls, post, close: () => server.close() });
        });
    });
}

const validLead = {
    name: 'Asha Verma', phone: '+91 98765-43210', email: 'Asha@Example.com', currentStatus: 'final-year',
    consent: true, planId: 'mock', fbp: 'fb.1.1.1', attribution: { utm_source: 'facebook', utm_campaign: 'oct', evil: 'x' },
};

const sign = (orderId, paymentId) => crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

test('lead: validates input', async () => {
    const t = await setup();
    const r = await t.post('/api/lead', { name: 'A', phone: '123', email: 'bad', consent: false });
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body.fields).sort(), ['consent', 'email', 'name', 'phone']);
    t.close();
});

test('lead: honeypot rejected', async () => {
    const t = await setup();
    const r = await t.post('/api/lead', { ...validLead, website: 'spam' });
    assert.equal(r.status, 400);
    assert.equal(t.db.store.size, 0);
    t.close();
});

test('lead: creates lead, fires Lead CAPI + alert once, creates order with server price', async () => {
    const t = await setup();
    const r = await t.post('/api/lead', { ...validLead, price: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.leadId, '919876543210');
    assert.equal(r.body.isNew, true);
    assert.equal(r.body.order.amount, 34900);
    assert.equal(r.body.order.keyId, 'rzp_test_key');
    assert.deepEqual(r.body.prefill, { name: 'Asha Verma', email: 'asha@example.com', contact: '+919876543210' });
    assert.equal(t.calls.meta.length, 1);
    assert.equal(t.calls.meta[0].eventName, 'Lead');
    assert.equal(t.calls.meta[0].eventId, 'lead_919876543210');
    assert.equal(t.calls.alerts.length, 1);

    const lead = t.db.store.get('leads/919876543210');
    assert.equal(lead.status, 'checkout_started');
    assert.equal(lead.crmStatus, 'new');
    assert.deepEqual(lead.attribution, { utm_source: 'facebook', utm_campaign: 'oct' });
    assert.equal(lead.client.fbp, 'fb.1.1.1');
    assert.equal(t.db.store.get(`orders/${r.body.order.id}`).leadId, '919876543210');

    const again = await t.post('/api/lead', { ...validLead, planId: 'diagnosis' });
    assert.equal(again.body.isNew, false);
    assert.equal(again.body.order.amount, 8900);
    assert.equal(t.calls.meta.length, 1, 'Lead not re-fired for returning lead');
    assert.equal(t.calls.alerts.length, 1);
    assert.equal(t.db.store.get('leads/919876543210').submissions, 2);
    t.close();
});

test('lead: still captured when Razorpay order fails', async () => {
    const t = await setup({ orderFails: true });
    const r = await t.post('/api/lead', validLead);
    assert.equal(r.status, 200);
    assert.equal(r.body.order, null);
    assert.equal(t.db.store.get('leads/919876543210').status, 'new');
    t.close();
});

test('verify: rejects bad signature, accepts good one idempotently', async () => {
    const t = await setup();
    const { body } = await t.post('/api/lead', validLead);
    const orderId = body.order.id;

    const bad = await t.post('/api/verify', { leadId: body.leadId, razorpay_order_id: orderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'nope' });
    assert.equal(bad.status, 400);

    const payload = { leadId: body.leadId, razorpay_order_id: orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(orderId, 'pay_1') };
    const ok = await t.post('/api/verify', payload);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.purchaseEventId, 'purchase_pay_1');
    assert.equal(ok.body.plan.price, 349);
    assert.equal(ok.body.bookingUrl, 'https://calendly.com/x/y?single=1');

    const lead = t.db.store.get('leads/919876543210');
    assert.equal(lead.status, 'paid');
    assert.equal(lead.totalPaid, 349);
    const purchases = t.calls.meta.filter((m) => m.eventName === 'Purchase');
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].eventId, 'purchase_pay_1');
    assert.equal(purchases[0].customData.value, 349);

    const repeat = await t.post('/api/verify', payload);
    assert.equal(repeat.status, 200);
    assert.equal(t.calls.meta.filter((m) => m.eventName === 'Purchase').length, 1, 'no double Purchase');
    assert.equal(t.db.store.get('leads/919876543210').totalPaid, 349);
    t.close();
});

test('verify: order of another lead is rejected', async () => {
    const t = await setup();
    const { body } = await t.post('/api/lead', validLead);
    const r = await t.post('/api/verify', { leadId: '919999999999', razorpay_order_id: body.order.id, razorpay_payment_id: 'pay_2', razorpay_signature: sign(body.order.id, 'pay_2') });
    assert.equal(r.status, 403);
    t.close();
});

test('checkout-event: tracks abandon but never downgrades a paid order', async () => {
    const t = await setup();
    const { body } = await t.post('/api/lead', validLead);
    const ev = { leadId: body.leadId, orderId: body.order.id, type: 'checkout_closed' };
    await t.post('/api/checkout-event', ev);
    assert.equal(t.db.store.get('leads/919876543210').status, 'checkout_abandoned');

    await t.post('/api/verify', { leadId: body.leadId, razorpay_order_id: body.order.id, razorpay_payment_id: 'pay_3', razorpay_signature: sign(body.order.id, 'pay_3') });
    await t.post('/api/checkout-event', ev);
    assert.equal(t.db.store.get('leads/919876543210').status, 'paid');
    t.close();
});

test('webhook: marks paid when browser never verified; booked + booking-link flow', async () => {
    const t = await setup();
    const { body } = await t.post('/api/lead', validLead);
    const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_9', order_id: body.order.id } } } };
    const raw = JSON.stringify(event);
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

    const bad = await t.post('/api/razorpay-webhook', event, { 'x-razorpay-signature': 'x' });
    assert.equal(bad.status, 400);
    const ok = await t.post('/api/razorpay-webhook', event, { 'x-razorpay-signature': sig });
    assert.equal(ok.status, 200);
    assert.equal(t.db.store.get('leads/919876543210').status, 'paid');
    assert.equal(t.db.store.get('payments/pay_9').source, 'webhook');

    const link = await t.post('/api/booking-link', { leadId: body.leadId, paymentId: 'pay_9' });
    assert.equal(link.body.booked, false);
    assert.ok(link.body.bookingUrl);

    const wrong = await t.post('/api/booking-link', { leadId: '919999999999', paymentId: 'pay_9' });
    assert.equal(wrong.status, 404);

    await t.post('/api/booked', { leadId: body.leadId, paymentId: 'pay_9', eventUri: 'https://api.calendly.com/scheduled_events/abc' });
    assert.equal(t.db.store.get('leads/919876543210').status, 'booked');
    const after = await t.post('/api/booking-link', { leadId: body.leadId, paymentId: 'pay_9' });
    assert.equal(after.body.booked, true);
    t.close();
});
