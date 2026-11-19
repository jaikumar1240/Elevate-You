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
        verifyIdToken: async (token) => {
            if (token === 'expired') throw new Error('Expired token');
            return { email: ['admin', 'unverified'].includes(token) ? cfg.adminEmail : 'visitor@example.com', email_verified: token !== 'unverified' };
        },
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
        createBookingUrl: overrides.createBookingUrl || (async ({ publicUrl }) => `${publicUrl}?single=1`),
    });
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            const post = async (path, body, headers = {}) => {
                const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
                return { status: res.status, body: await res.json().catch(() => null) };
            };
            const get = async (path, headers = {}) => {
                const res = await fetch(base + path, { headers });
                return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
            };
            resolve({ db, calls, post, get, close: () => server.close() });
        });
    });
}

const validLead = {
    name: 'Asha Verma', phone: '+91 98765-43210', email: 'Asha@Example.com', currentStatus: 'final-year',
    consent: true, planId: 'mock', fbp: 'fb.1.1.1', attribution: { utm_source: 'facebook', utm_campaign: 'oct', evil: 'x' },
};

const sign = (orderId, paymentId) => crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

test('public catalog exposes the initial purchasable plans without caching', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const result = await t.get('/api/catalog');
    assert.equal(result.status, 200);
    assert.equal(result.body.revision, 0);
    assert.equal(result.body.checkoutEnabled, true);
    assert.equal(result.body.plans.length, 6);
    assert.equal(result.body.plans.find((p) => p.id === 'mock').price, 349);
    assert.ok(result.body.plans.every((p) => p.description && p.features.length));
    assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('catalogs saved before button labels existed show the default Book now and Continue labels', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const legacy = (await t.get('/api/admin/catalog', { Authorization: 'Bearer admin' })).body;
    delete legacy.buttonLabels;
    t.db.store.set('site/catalog', legacy);
    const expected = { plan: 'Book now', payment: 'Continue' };
    assert.deepEqual((await t.get('/api/catalog')).body.buttonLabels, expected);
    assert.deepEqual((await t.get('/api/admin/catalog', { Authorization: 'Bearer admin' })).body.buttonLabels, expected);
});

test('admin can rename storefront buttons with an audit entry while blank or overlong labels are rejected', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const headers = { Authorization: 'Bearer admin' };
    const initial = (await t.get('/api/admin/catalog', headers)).body;
    for (const buttonLabels of [undefined, { plan: ' ', payment: 'Pay' }, { plan: 'Book', payment: 'x'.repeat(41) }]) {
        const rejected = await t.post('/api/admin/catalog', { ...initial, buttonLabels }, headers);
        assert.equal(rejected.status, 400);
    }
    const buttonLabels = { plan: '  Choose this plan ', payment: 'Pay securely' };
    const saved = await t.post('/api/admin/catalog', { ...initial, buttonLabels }, headers);
    assert.equal(saved.status, 200);
    assert.match(saved.body.history[0].summary, /Button labels updated/);
    assert.deepEqual((await t.get('/api/catalog')).body.buttonLabels, { plan: 'Choose this plan', payment: 'Pay securely' });
});

test('catalog administration requires a verified admin token on reads and writes', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    for (const token of ['', 'visitor', 'expired', 'unverified']) {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const read = await t.get('/api/admin/catalog', headers);
        const write = await t.post('/api/admin/catalog', {}, headers);
        assert.ok([401, 403].includes(read.status), `read rejected for ${token}`);
        assert.ok([401, 403].includes(write.status), `write rejected for ${token}`);
    }
    const allowed = await t.get('/api/admin/catalog', { Authorization: 'Bearer admin' });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body.history, []);
});

test('catalog authorization failures are not cached before the admin signs in', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    for (const token of ['', 'visitor', 'expired']) {
        const result = await t.get('/api/admin/catalog', token ? { Authorization: `Bearer ${token}` } : {});
        assert.ok([401, 403].includes(result.status));
        assert.equal(result.headers.get('cache-control'), 'no-store');
    }
});

test('admin can publish reordered plans with an audit trail and stale edits cannot overwrite them', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const headers = { Authorization: 'Bearer admin' };
    const initial = (await t.get('/api/admin/catalog', headers)).body;
    const plans = initial.plans.map((plan) => ({ ...plan, active: plan.id !== 'resume' }));
    plans.unshift({ ...plans[plans.length - 1], id: 'career-pack', name: 'Career Pack', price: 250.50 });
    const edit = { revision: 0, plans, announcement: 'Bookings open for December.', checkoutEnabled: true, buttonLabels: initial.buttonLabels };
    const saved = await t.post('/api/admin/catalog', edit, headers);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.plans[0].name, 'Career Pack');
    assert.equal(saved.body.history[0].by, 'admin@example.com');
    assert.ok(saved.body.history[0].at);
    const publicResult = (await t.get('/api/catalog')).body;
    assert.equal(publicResult.announcement, edit.announcement);
    assert.equal(publicResult.plans[0].price, 250.50);
    assert.equal(publicResult.plans.some((p) => p.id === 'resume'), false);
    assert.equal(publicResult.history, undefined);
    const stale = await t.post('/api/admin/catalog', edit, headers);
    assert.equal(stale.status, 409);
    assert.equal(t.db.store.get('site/catalog').revision, 1);
});

test('catalog rejects invalid prices, unsafe IDs and destructive plan removal without saving', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const headers = { Authorization: 'Bearer admin' };
    const catalog = (await t.get('/api/admin/catalog', headers)).body;
    const changes = [
        { revision: -1 }, { revision: '0' }, { plans: [] },
        { announcement: 'x'.repeat(301) }, { checkoutEnabled: 'yes' },
        ...[-1, 0, '199', 1.001, 1000001, null].map((price) => ({ plans: [{ ...catalog.plans[0], price }, ...catalog.plans.slice(1)] })),
        ...[{ id: '../x' }, { name: '' }, { active: 'false' }, { features: [''] }, { features: Array(11).fill('Feature') }, { description: 'x'.repeat(601) }]
            .map((patch) => ({ plans: [{ ...catalog.plans[0], ...patch }, ...catalog.plans.slice(1)] })),
        { plans: [catalog.plans[0], catalog.plans[0], ...catalog.plans.slice(1)] },
        { plans: catalog.plans.slice(1) },
    ];
    for (const change of changes) {
        const result = await t.post('/api/admin/catalog', { ...catalog, ...change }, headers);
        assert.equal(result.status, 400, JSON.stringify(change).slice(0, 100));
        assert.ok(result.body.error);
        assert.equal(t.db.store.has('site/catalog'), false);
    }
});

test('all twenty plans can be published with valid full-length multilingual content', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const headers = { Authorization: 'Bearer admin' };
    const catalog = (await t.get('/api/admin/catalog', headers)).body;
    while (catalog.plans.length < 20) {
        catalog.plans.push({ ...catalog.plans[0], id: `extra-${catalog.plans.length}` });
    }
    catalog.plans = catalog.plans.map((plan) => ({
        ...plan, name: '\u540d'.repeat(80), description: '\u6587'.repeat(600),
        period: '\u671f'.repeat(40), badge: '\u65b0'.repeat(40),
        features: Array(10).fill('\u5b66'.repeat(160)),
    }));

    const result = await t.post('/api/admin/catalog', catalog, headers);

    assert.equal(result.status, 200);
    assert.equal(result.body.plans.length, 20);
    assert.equal(result.body.plans[0].description, catalog.plans[0].description);
});

test('checkout uses managed prices while existing orders keep their purchased identity', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const first = (await t.post('/api/lead', validLead)).body;
    const headers = { Authorization: 'Bearer admin' };
    const catalog = (await t.get('/api/admin/catalog', headers)).body;
    catalog.plans.find((p) => p.id === 'mock').price = 499.99;
    catalog.plans.find((p) => p.id === 'mock').name = 'Updated Mock';
    await t.post('/api/admin/catalog', catalog, headers);
    const next = await t.post('/api/lead', { ...validLead, price: 1 });
    assert.equal(next.body.plan.price, 499.99);
    assert.equal(next.body.order.amount, 49999);
    assert.equal(t.calls.orders[1].amount, 49999);
    const paid = await t.post('/api/verify', {
        leadId: first.leadId, razorpay_order_id: first.order.id, razorpay_payment_id: 'pay_original',
        razorpay_signature: sign(first.order.id, 'pay_original'),
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.plan.price, 349);
    assert.equal(paid.body.plan.name, 'Mock Interview');
});

test('checkout rejects unavailable plans, paused sales and changed displayed prices before creating orders', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const headers = { Authorization: 'Bearer admin' };
    const catalog = (await t.get('/api/admin/catalog', headers)).body;
    catalog.plans.find((p) => p.id === 'mock').active = false;
    await t.post('/api/admin/catalog', catalog, headers);
    for (const planId of ['mock', 'unknown', '__proto__']) {
        const result = await t.post('/api/lead', { ...validLead, planId });
        assert.equal(result.status, 409);
        assert.ok(result.body.error);
    }
    const stale = await t.post('/api/lead', { ...validLead, planId: 'resume', expectedPrice: 89 });
    assert.equal(stale.status, 409);
    const latest = (await t.get('/api/admin/catalog', headers)).body;
    latest.checkoutEnabled = false;
    await t.post('/api/admin/catalog', latest, headers);
    const paused = await t.post('/api/lead', { ...validLead, planId: 'resume' });
    assert.equal(paused.status, 409);
    assert.match(paused.body.error, /paused/i);
    assert.equal(t.calls.orders.length, 0);
    assert.equal(t.db.store.has('leads/919876543210'), false);
});

test('catalog history describes price and availability changes instead of accepting a forged audit trail', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const headers = { Authorization: 'Bearer admin' };
    const catalog = (await t.get('/api/admin/catalog', headers)).body;
    catalog.plans.find((plan) => plan.id === 'mock').price = 500;
    catalog.plans.find((plan) => plan.id === 'resume').active = false;
    catalog.checkoutEnabled = false;
    catalog.history = [{ by: 'forged', summary: 'hidden' }];
    const saved = await t.post('/api/admin/catalog', catalog, headers);
    assert.equal(saved.status, 200);
    assert.match(saved.body.history[0].summary, /mock.*349.*500/);
    assert.match(saved.body.history[0].summary, /resume.*archived/);
    assert.match(saved.body.history[0].summary, /checkout paused/i);
    assert.equal(saved.body.history.length, 1);
    assert.equal(saved.body.history[0].by, 'admin@example.com');
});

test('booking reference preserves the paid order identity and analytics across later submissions', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const { body } = await t.post('/api/lead', {
        ...validLead,
        analytics: { clientId: '123.456', sessionId: '789', adUserData: 'GRANTED' },
        attribution: { utm_source: 'facebook', utm_term: 'career help' },
    });
    const payload = {
        leadId: body.leadId, razorpay_order_id: body.order.id, razorpay_payment_id: 'pay_snapshot',
        razorpay_signature: sign(body.order.id, 'pay_snapshot'),
    };
    const paid = await t.post('/api/verify', payload);
    const payment = t.db.store.get('payments/pay_snapshot');
    assert.match(payment.bookingRef || '', /^[A-Za-z0-9_-]{24}$/);
    assert.equal(new URL(paid.body.bookingUrl).searchParams.get('utm_term'), payment.bookingRef);
    assert.equal(payment.bookingIdentity.email, 'asha@example.com');
    assert.equal(payment.analytics.clientId, '123.456');
    assert.equal(payment.attribution.utm_term, 'career help');

    await t.post('/api/lead', { ...validLead, email: 'different@example.com' });
    const resumed = await t.post('/api/booking-link', { leadId: body.leadId, paymentId: 'pay_snapshot' });
    assert.equal(resumed.body.bookingUrl, paid.body.bookingUrl);
    assert.equal(resumed.body.prefill.email, 'asha@example.com');
    assert.equal(t.db.store.get('payments/pay_snapshot').bookingRef, payment.bookingRef);
});

test('lead: validates input', async () => {
    const t = await setup();
    const r = await t.post('/api/lead', { name: 'A', phone: '123', email: 'bad', consent: false });
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body.fields).sort(), ['consent', 'email', 'name', 'phone']);
    t.close();
});

test('legacy paid links gain one resumable reference without creating another order', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    await t.db.collection('leads').doc('919876543210').set({ name: 'Asha', email: 'asha@example.com', phone: '9876543210', status: 'paid' });
    await t.db.collection('payments').doc('pay_legacy').set({
        leadId: '919876543210', planId: 'mock', planName: 'Mock Interview', amount: 349,
        createdAt: new Date(), bookingUrl: 'https://calendly.com/x/y',
    });
    const request = { leadId: '919876543210', paymentId: 'pay_legacy' };
    const first = await t.post('/api/booking-link', request);
    const reference = new URL(first.body.bookingUrl).searchParams.get('utm_term');
    assert.match(reference || '', /^[A-Za-z0-9_-]{24}$/);
    assert.equal(first.body.prefill.email, 'asha@example.com');
    const payment = t.db.store.get('payments/pay_legacy');
    assert.equal(payment.bookingSyncState, 'pending');
    assert.ok(payment.bookingSyncAt instanceof Date);
    const second = await t.post('/api/booking-link', request);
    assert.equal(second.body.bookingUrl, first.body.bookingUrl);
    assert.equal(t.calls.orders.length, 0);
});

test('legacy browser-only booking timestamps require review instead of API confirmation', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    await t.db.collection('payments').doc('pay_legacy').set({
        leadId: '919876543210', bookedAt: new Date('2026-01-01T10:00:00Z'),
    });
    const result = await t.post('/api/booking-link', { leadId: '919876543210', paymentId: 'pay_legacy' });
    assert.equal(result.status, 200);
    assert.equal(result.body.booked, false);
    assert.equal(result.body.review, true);
    assert.equal(result.body.bookingUrl, undefined);
});

test('ambiguous API booking matches return review without offering another booking link', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    await t.db.collection('payments').doc('pay_ambiguous').set({
        leadId: '919876543210', planId: 'mock', planName: 'Mock Interview', amount: 349,
        bookingRef: 'abcdefghijklmnopqrstuvwx', bookingIdentity: { email: 'asha@example.com' },
        bookingSyncState: 'review', bookingSyncError: 'ambiguous_match',
    });

    const result = await t.post('/api/booking-link', { leadId: '919876543210', paymentId: 'pay_ambiguous' });
    assert.equal(result.status, 200);
    assert.equal(result.body.booked, false);
    assert.equal(result.body.review, true);
    assert.equal(result.body.reviewReason, 'ambiguous_match');
    assert.equal(result.body.bookingUrl, undefined);
    assert.equal(t.db.store.get('payments/pay_ambiguous').bookedAt, undefined);
});

test('legacy booking rechecks remain pending until API confirmation', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    await t.db.collection('payments').doc('pay_legacy').set({
        leadId: '919876543210', bookedAt: new Date('2026-01-01T10:00:00Z'),
    });
    const result = await t.post('/api/booked', { leadId: '919876543210', paymentId: 'pay_legacy' });
    assert.equal(result.status, 202);
    assert.equal(result.body.pending, true);
});

test('verification of a legacy order returns its recovered booking prefill', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    await t.db.collection('leads').doc('919876543210').set({
        name: 'Asha', phone: '9876543210', email: 'asha@example.com', status: 'checkout_started',
    });
    await t.db.collection('orders').doc('order_legacy').set({
        leadId: '919876543210', planId: 'mock', planName: 'Mock Interview', amount: 349, currency: 'INR', status: 'created',
    });
    const response = await t.post('/api/verify', {
        leadId: '919876543210', razorpay_order_id: 'order_legacy', razorpay_payment_id: 'pay_legacy',
        razorpay_signature: sign('order_legacy', 'pay_legacy'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.prefill, { name: 'Asha', email: 'asha@example.com', contact: '+919876543210' });
    assert.deepEqual(response.body.prefill, t.db.store.get('payments/pay_legacy').bookingIdentity);
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
    assert.equal(new URL(ok.body.bookingUrl).searchParams.get('single'), '1');

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

test('re-verifying a booked payment returns its existing booking state without a new link', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
    const { body } = await t.post('/api/lead', validLead);
    const payload = {
        leadId: body.leadId, razorpay_order_id: body.order.id, razorpay_payment_id: 'pay_booked',
        razorpay_signature: sign(body.order.id, 'pay_booked'),
    };
    assert.equal((await t.post('/api/verify', payload)).status, 200);
    const payment = t.db.collection('payments').doc('pay_booked');
    for (const [state, expected] of [['confirmed', { booked: true }], ['legacy', { booked: false, review: true }]]) {
        await payment.update({
            bookedAt: new Date('2026-01-01T10:00:00Z'),
            bookingSyncState: state === 'confirmed' ? state : FieldValue.delete(),
        });
        const result = await t.post('/api/verify', payload);
        assert.equal(result.status, 200);
        assert.equal(result.body.booked, expected.booked);
        assert.equal(result.body.review, expected.review);
        assert.equal(result.body.bookingUrl, undefined);
    }
});

test('booking links honor confirmations committed during payment rechecks', async (ctx) => {
    for (const route of ['/api/booking-link', '/api/verify']) {
        const t = await setup();
        ctx.after(t.close);
        const { body } = await t.post('/api/lead', validLead);
        const verify = {
            leadId: body.leadId, razorpay_order_id: body.order.id, razorpay_payment_id: 'pay_race',
            razorpay_signature: sign(body.order.id, 'pay_race'),
        };
        assert.equal((await t.post('/api/verify', verify)).status, 200);
        const payment = t.db.collection('payments').doc('pay_race');
        const original = t.db.runTransaction.bind(t.db);
        let transactions = 0;
        t.db.runTransaction = async (callback) => {
            transactions++;
            if (transactions === (route === '/api/verify' ? 2 : 1)) {
                await payment.update({ bookedAt: new Date(), bookingSyncState: 'confirmed' });
            }
            return original(callback);
        };
        const request = route === '/api/verify' ? verify : { leadId: body.leadId, paymentId: 'pay_race' };
        const result = await t.post(route, request);
        assert.equal(result.status, 200);
        assert.equal(result.body.booked, true);
        assert.equal(result.body.bookingUrl, undefined);
    }
});

test('a booking confirmed while its scheduling URL is created does not reopen Calendly', async (ctx) => {
    let confirmBooking;
    const t = await setup({
        createBookingUrl: async ({ publicUrl }) => {
            await confirmBooking();
            return publicUrl;
        },
    });
    ctx.after(t.close);
    const { body } = await t.post('/api/lead', validLead);
    confirmBooking = () => t.db.collection('payments').doc('pay_url_race').update({
        bookedAt: new Date(), bookingSyncState: 'confirmed',
    });
    const result = await t.post('/api/verify', {
        leadId: body.leadId, razorpay_order_id: body.order.id, razorpay_payment_id: 'pay_url_race',
        razorpay_signature: sign(body.order.id, 'pay_url_race'),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.booked, true);
    assert.equal(result.body.bookingUrl, undefined);
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

test('webhook: marks paid but browser booking assertions cannot confirm a booking', async (ctx) => {
    const t = await setup();
    ctx.after(t.close);
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

    const asserted = await t.post('/api/booked', { leadId: body.leadId, paymentId: 'pay_9', eventUri: 'https://api.calendly.com/scheduled_events/abc' });
    assert.equal(asserted.status, 202);
    assert.equal(t.db.store.get('leads/919876543210').status, 'paid');
    assert.equal(t.db.store.get('payments/pay_9').bookedAt, undefined);
    await t.db.collection('payments').doc('pay_9').update({ bookedAt: new Date(), bookingSyncState: 'confirmed' });
    const after = await t.post('/api/booking-link', { leadId: body.leadId, paymentId: 'pay_9' });
    assert.equal(after.body.booked, true);
    t.close();
});

test('unsafe booking destinations are rejected without undoing a verified payment', async (ctx) => {
    const t = await setup({ createBookingUrl: async () => 'https://calendly.com:8443/x/y' });
    ctx.after(t.close);
    const { body } = await t.post('/api/lead', validLead);
    const verified = await t.post('/api/verify', {
        leadId: body.leadId, razorpay_order_id: body.order.id, razorpay_payment_id: 'pay_unsafe',
        razorpay_signature: sign(body.order.id, 'pay_unsafe'),
    });
    assert.equal(verified.status, 500);
    assert.equal(t.db.store.get('leads/919876543210').status, 'paid');
    assert.equal(t.db.store.get('payments/pay_unsafe').bookingUrl, undefined);
});
