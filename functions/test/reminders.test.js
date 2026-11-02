'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../lib/app');
const { sendPaymentReminders } = require('../lib/reminders');
const { createDb, FieldValue } = require('./fake-firestore');

const MIN = 60 * 1000;
const cfg = {
    razorpayKeyId: 'k', razorpayKeySecret: 's', adminEmail: 'admin@example.com', gmailAppPassword: 'pw',
    siteUrl: 'https://site', whatsappNumber: '911234567890', calendlyUrl: 'https://calendly.com/x',
};

async function setup() {
    const db = createDb();
    let n = 0;
    const app = createApp({
        db, FieldValue,
        getConfig: () => cfg,
        createRazorpay: () => ({ orders: { create: async (o) => ({ id: `order_${++n}`, amount: o.amount, currency: o.currency }) } }),
        sendMetaEvent: async () => ({ ok: true }),
        sendAlert: async () => ({ ok: true }),
        createBookingUrl: async ({ publicUrl }) => publicUrl,
    });
    const emails = [];
    const sendLeadEmail = async (e) => { emails.push(e); return { ok: true }; };
    const run = (now) => sendPaymentReminders({ db, FieldValue, cfg, sendLeadEmail, now });
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            const post = async (path, body) => {
                const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                return { status: res.status, body: await res.json().catch(() => null) };
            };
            resolve({ db, emails, run, post, close: () => server.close() });
        });
    });
}

const lead = { name: 'Asha Verma', phone: '9876543210', email: 'asha@example.com', consent: true, planId: 'diagnosis', attribution: {} };
const later = (mins) => new Date(Date.now() + mins * MIN);

test('reminder: sent once, ~30 min after an unpaid lead, with a working resume link', async () => {
    const t = await setup();
    await t.post('/api/lead', lead);
    const stored = t.db.store.get('leads/919876543210');
    assert.ok(stored.resumeToken.length >= 20);

    assert.equal((await t.run(later(5))).sent, 0, 'not before 30 min');
    assert.equal((await t.run(later(31))).sent, 1);
    assert.equal(t.emails.length, 1);
    const email = t.emails[0];
    assert.equal(email.to, 'asha@example.com');
    assert.match(email.subject, /Asha, your Diagnosis Session/);
    assert.ok(email.html.includes(`https://site/?resume=${stored.resumeToken}`));
    assert.ok(email.text.includes('https://wa.me/911234567890'));

    const after = t.db.store.get('leads/919876543210');
    assert.ok(after.reminderSentAt);
    assert.equal(after.reminderDueAt, undefined);
    assert.ok(after.history.some((h) => h.type === 'reminder_sent'));

    assert.equal((await t.run(later(90))).sent, 0, 'never twice');
    await t.post('/api/lead', lead);
    assert.equal(t.db.store.get('leads/919876543210').reminderDueAt, undefined, 'resubmission does not re-arm');

    const resume = await t.post('/api/resume', { token: stored.resumeToken });
    assert.equal(resume.status, 200);
    assert.equal(resume.body.paid, false);
    assert.equal(resume.body.planId, 'diagnosis');
    assert.deepEqual(resume.body.values, { name: 'Asha Verma', phone: '9876543210', email: 'asha@example.com', currentStatus: '' });
    assert.ok(t.db.store.get('leads/919876543210').history.some((h) => h.type === 'reminder_clicked'));
    t.close();
});

test('reminder: not sent if the lead paid', async () => {
    const t = await setup();
    const { body } = await t.post('/api/lead', lead);
    const crypto = require('crypto');
    const sig = crypto.createHmac('sha256', 's').update(`${body.order.id}|pay_1`).digest('hex');
    await t.post('/api/verify', { leadId: body.leadId, razorpay_order_id: body.order.id, razorpay_payment_id: 'pay_1', razorpay_signature: sig });
    assert.equal(t.db.store.get('leads/919876543210').reminderDueAt, undefined);
    assert.equal((await t.run(later(31))).sent, 0);
    assert.equal(t.emails.length, 0);
    t.close();
});

test('reminder: stale leads are dropped, failed sends are retried', async () => {
    const t = await setup();
    await t.post('/api/lead', lead);
    assert.equal((await t.run(later(60 * 25))).skipped, 1, 'older than 24h');
    assert.equal(t.emails.length, 0);

    const t2 = await setup();
    await t2.post('/api/lead', lead);
    const failing = await sendPaymentReminders({ db: t2.db, FieldValue, cfg, sendLeadEmail: async () => ({ ok: false }), now: later(31) });
    assert.equal(failing.failed, 1);
    assert.equal((await t2.run(later(41))).sent, 1, 'retried next run');
    t.close();
    t2.close();
});

test('reminder: claimed before sending, so a crash or a payment never causes a second/late email', async () => {
    // Crash after claim: email may be lost, but it is never sent twice.
    const t = await setup();
    await t.post('/api/lead', lead);
    await assert.rejects(sendPaymentReminders({ db: t.db, FieldValue, cfg, sendLeadEmail: async () => { throw new Error('crash'); }, now: later(31) }));
    const claimed = t.db.store.get('leads/919876543210');
    assert.ok(claimed.reminderClaimedAt);
    assert.equal(claimed.reminderDueAt, undefined);
    assert.equal((await t.run(later(45))).sent, 0, 'not re-sent after a crash');
    await t.post('/api/lead', lead);
    assert.equal(t.db.store.get('leads/919876543210').reminderDueAt, undefined, 'claimed reminder is not re-armed');

    // Lead paid after the job's query but before its claim: the claim re-reads and drops it.
    const t2 = await setup();
    await t2.post('/api/lead', lead);
    const realRun = t2.db.runTransaction.bind(t2.db);
    let first = true;
    t2.db.runTransaction = async (fn) => {
        if (first) {
            first = false;
            const ref = t2.db.collection('leads').doc('919876543210');
            await ref.update({ status: 'paid' });
        }
        return realRun(fn);
    };
    const counts = await t2.run(later(31));
    assert.equal(counts.sent, 0);
    assert.equal(counts.skipped, 1);
    assert.equal(t2.emails.length, 0);
    t.close();
    t2.close();
});

test('resume: rejects bad and unknown tokens', async () => {
    const t = await setup();
    assert.equal((await t.post('/api/resume', { token: 'x' })).status, 400);
    assert.equal((await t.post('/api/resume', { token: 'a'.repeat(24) })).status, 404);
    t.close();
});
