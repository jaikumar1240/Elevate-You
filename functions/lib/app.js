'use strict';

const crypto = require('crypto');
const express = require('express');
const { validateLead, isLeadId, clean } = require('./validate');
const { PLANS, CURRENCY } = require('./config');
const { REMINDER_DELAY_MS } = require('./reminders');

const CHECKOUT_EVENTS = new Set(['checkout_opened', 'checkout_closed', 'payment_failed']);
const newResumeToken = () => crypto.randomBytes(18).toString('base64url');

/** Small per-instance rate limiter (best effort; instances are short-lived). */
function rateLimiter({ windowMs, max }) {
    const hits = new Map();
    return (req, res, next) => {
        const key = `${req.path}:${clientIp(req)}`;
        const now = Date.now();
        const entry = hits.get(key);
        if (!entry || entry.reset < now) {
            hits.set(key, { count: 1, reset: now + windowMs });
        } else if (++entry.count > max) {
            return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
        }
        if (hits.size > 5000) hits.clear();
        next();
    };
}

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || req.ip || '';
}

function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Builds the Express app. All side-effecting dependencies are injected so the
 * funnel can be unit-tested without Firebase, Razorpay, Meta or Gmail.
 */
function createApp(deps) {
    const { db, FieldValue, getConfig, createRazorpay, sendMetaEvent, sendAlert, createBookingUrl } = deps;
    const leads = () => db.collection('leads');
    const orders = () => db.collection('orders');
    const payments = () => db.collection('payments');

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', true);
    app.use(express.json({ limit: '20kb' }));

    const router = express.Router();
    // Express 4 doesn't forward rejected promises to the error handler.
    for (const method of ['get', 'post']) {
        const original = router[method].bind(router);
        router[method] = (path, ...handlers) => original(path, ...handlers.map(
            (h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next),
        ));
    }

    const historyEntry = (type, extra = {}) => ({ type, at: new Date().toISOString(), ...extra });

    function metaArgs(cfg) {
        return { pixelId: cfg.metaPixelId, token: cfg.metaToken, testEventCode: cfg.metaTestEventCode };
    }

    async function createOrder(cfg, leadId, planId) {
        if (!cfg.razorpayKeyId || !cfg.razorpayKeySecret) return null;
        const plan = PLANS[planId];
        const rzp = createRazorpay(cfg.razorpayKeyId, cfg.razorpayKeySecret);
        const order = await rzp.orders.create({
            amount: plan.price * 100,
            currency: CURRENCY,
            receipt: `${leadId}-${Date.now()}`.slice(0, 40),
            notes: { leadId, planId, planName: plan.name },
        });
        await orders().doc(order.id).set({
            leadId, planId, planName: plan.name, amount: plan.price, currency: CURRENCY,
            status: 'created', createdAt: FieldValue.serverTimestamp(),
        });
        return { id: order.id, amount: order.amount, currency: order.currency, keyId: cfg.razorpayKeyId };
    }

    /**
     * Idempotently records a captured payment. Safe to call from both the
     * browser verify step and the Razorpay webhook.
     */
    async function markPaid(cfg, { orderId, paymentId, source }) {
        const orderRef = orders().doc(orderId);
        const paymentRef = payments().doc(paymentId);

        const result = await db.runTransaction(async (tx) => {
            const [orderSnap, paymentSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef)]);
            if (!orderSnap.exists) return { error: 'Unknown order' };
            const order = orderSnap.data();
            if (paymentSnap.exists) return { order, payment: paymentSnap.data(), isNew: false };

            const leadRef = leads().doc(order.leadId);
            const payment = {
                leadId: order.leadId, orderId, planId: order.planId, planName: order.planName,
                amount: order.amount, currency: order.currency, source,
                createdAt: FieldValue.serverTimestamp(),
            };
            tx.set(paymentRef, payment);
            tx.update(orderRef, { status: 'paid', paymentId, paidAt: FieldValue.serverTimestamp() });
            tx.update(leadRef, {
                status: 'paid',
                planId: order.planId,
                planName: order.planName,
                paidCount: FieldValue.increment(1),
                totalPaid: FieldValue.increment(order.amount),
                lastPaymentId: paymentId,
                paidAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
                reminderDueAt: FieldValue.delete(),
                history: FieldValue.arrayUnion(historyEntry('paid', { paymentId, amount: order.amount, source })),
            });
            return { order, payment, isNew: true };
        });
        if (result.error) return result;

        if (result.isNew) {
            const leadSnap = await leads().doc(result.order.leadId).get();
            const lead = { id: leadSnap.id, ...leadSnap.data() };
            await Promise.allSettled([
                sendMetaEvent({
                    ...metaArgs(cfg),
                    eventName: 'Purchase',
                    eventId: `purchase_${paymentId}`,
                    lead,
                    sourceUrl: cfg.siteUrl,
                    customData: { value: result.order.amount, currency: CURRENCY, content_name: result.order.planName, content_ids: [result.order.planId], content_type: 'product', order_id: orderId },
                }),
                sendAlert({
                    adminEmail: cfg.adminEmail, appPassword: cfg.gmailAppPassword, siteUrl: cfg.siteUrl,
                    subject: `💰 Paid ₹${result.order.amount} — ${lead.name} (${result.order.planName})`,
                    rows: [['Name', lead.name], ['Phone', lead.phone], ['Email', lead.email], ['Plan', result.order.planName], ['Amount', `₹${result.order.amount}`], ['Payment ID', paymentId], ['Source', lead.attribution?.utm_source || 'direct']],
                }),
            ]);
        }
        return result;
    }

    async function bookingUrlFor(cfg, paymentId, payment) {
        if (payment.bookingUrl) return payment.bookingUrl;
        const url = await createBookingUrl({ publicUrl: cfg.calendlyUrl, token: cfg.calendlyToken });
        await payments().doc(paymentId).update({ bookingUrl: url });
        return url;
    }

    // ---------------------------------------------------------------------
    // POST /lead — capture lead, fire Lead (CAPI), alert, create Razorpay order
    // ---------------------------------------------------------------------
    router.post('/lead', rateLimiter({ windowMs: 60_000, max: 10 }), async (req, res) => {
        const body = req.body || {};
        if (body.website) return res.status(400).json({ error: 'Invalid submission' }); // honeypot

        const planId = PLANS[body.planId] ? body.planId : 'diagnosis';
        const plan = PLANS[planId];
        const { errors, lead: input } = validateLead(body);
        if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields', fields: errors });

        const cfg = getConfig();
        const leadId = `91${input.phone}`;
        const ref = leads().doc(leadId);
        const client = {
            ip: clientIp(req),
            userAgent: clean(req.headers['user-agent'], 400),
            fbp: clean(body.fbp, 200),
            fbc: clean(body.fbc, 400),
        };

        const isNew = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const common = {
                name: input.name, email: input.email, phone: input.phone,
                planId, planName: plan.name, price: plan.price,
                client, lastAttribution: input.attribution,
                updatedAt: FieldValue.serverTimestamp(),
                submissions: FieldValue.increment(1),
                history: FieldValue.arrayUnion(historyEntry('form_submitted', { planId })),
            };
            if (input.currentStatus) common.currentStatus = input.currentStatus;
            const reminderDueAt = new Date(Date.now() + REMINDER_DELAY_MS);
            if (snap.exists) {
                const prev = snap.data();
                const alreadyPaid = prev.status === 'booked' || prev.status === 'paid';
                tx.update(ref, {
                    ...common,
                    status: alreadyPaid ? prev.status : 'new',
                    resumeToken: prev.resumeToken || newResumeToken(),
                    // One reminder per lead; a fresh attempt pushes it back.
                    ...(!alreadyPaid && !prev.reminderSentAt && !prev.reminderClaimedAt ? { reminderDueAt } : {}),
                });
                return false;
            }
            tx.set(ref, {
                ...common,
                currentStatus: input.currentStatus,
                attribution: input.attribution,
                status: 'new',
                crmStatus: 'new',
                notes: '',
                paidCount: 0,
                totalPaid: 0,
                resumeToken: newResumeToken(),
                reminderDueAt,
                createdAt: FieldValue.serverTimestamp(),
            });
            return true;
        });

        const lead = { id: leadId, ...input, client };
        const sourceUrl = input.attribution.landing_page || cfg.siteUrl;
        const side = [];
        if (isNew) {
            side.push(sendMetaEvent({
                ...metaArgs(cfg), eventName: 'Lead', eventId: `lead_${leadId}`, lead, sourceUrl,
                customData: { value: plan.price, currency: CURRENCY, content_name: plan.name, content_ids: [planId] },
            }));
            side.push(sendAlert({
                adminEmail: cfg.adminEmail, appPassword: cfg.gmailAppPassword, siteUrl: cfg.siteUrl,
                subject: `🆕 New lead — ${input.name} (${plan.name})`,
                rows: [['Name', input.name], ['Phone', input.phone], ['Email', input.email], ['Status', input.currentStatus], ['Plan', `${plan.name} · ₹${plan.price}`],
                    ['Source', input.attribution.utm_source || (input.attribution.fbclid ? 'facebook' : input.attribution.gclid ? 'google' : 'direct')],
                    ['Campaign', input.attribution.utm_campaign], ['Ad', input.attribution.utm_content]],
            }));
        }

        let order = null;
        let orderError = null;
        const orderPromise = createOrder(cfg, leadId, planId).then((o) => { order = o; }, (err) => { orderError = err; });
        await Promise.allSettled([...side, orderPromise]);
        if (orderError) console.error('Razorpay order failed', orderError);

        if (order) {
            await ref.update({
                status: 'checkout_started',
                lastOrderId: order.id,
                history: FieldValue.arrayUnion(historyEntry('order_created', { orderId: order.id, amount: plan.price })),
            }).catch(() => {});
        }

        res.json({
            leadId,
            isNew,
            leadEventId: `lead_${leadId}`,
            plan: { id: planId, name: plan.name, price: plan.price },
            order,
            prefill: { name: input.name, email: input.email, contact: `+91${input.phone}` },
        });
    });

    // ---------------------------------------------------------------------
    // POST /resume — reminder-email link: return saved details to prefill
    // ---------------------------------------------------------------------
    router.post('/resume', rateLimiter({ windowMs: 60_000, max: 20 }), async (req, res) => {
        const token = req.body?.token;
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,40}$/.test(token)) return res.status(400).json({ error: 'Bad request' });
        const snap = await leads().where('resumeToken', '==', token).limit(1).get();
        if (snap.empty) return res.status(404).json({ error: 'Link expired' });

        const doc = snap.docs[0];
        const lead = doc.data();
        await doc.ref.update({
            updatedAt: FieldValue.serverTimestamp(),
            history: FieldValue.arrayUnion(historyEntry('reminder_clicked')),
        });
        res.json({
            paid: lead.status === 'paid' || lead.status === 'booked',
            planId: lead.planId,
            values: { name: lead.name, phone: lead.phone, email: lead.email, currentStatus: lead.currentStatus || '' },
        });
    });

    // ---------------------------------------------------------------------
    // POST /checkout-event — popup opened / closed / failed (for follow-up)
    // ---------------------------------------------------------------------
    router.post('/checkout-event', rateLimiter({ windowMs: 60_000, max: 30 }), async (req, res) => {
        const { leadId, orderId, type } = req.body || {};
        if (!isLeadId(leadId) || !CHECKOUT_EVENTS.has(type) || typeof orderId !== 'string') return res.status(400).json({ error: 'Bad request' });

        const orderSnap = await orders().doc(orderId).get();
        if (!orderSnap.exists || orderSnap.data().leadId !== leadId) return res.status(404).json({ error: 'Unknown order' });
        if (orderSnap.data().status === 'paid') return res.json({ ok: true });

        const statusMap = { checkout_opened: 'checkout_started', checkout_closed: 'checkout_abandoned', payment_failed: 'payment_failed' };
        await leads().doc(leadId).update({
            status: statusMap[type],
            updatedAt: FieldValue.serverTimestamp(),
            history: FieldValue.arrayUnion(historyEntry(type, { orderId, reason: clean(req.body.reason, 200) || undefined })),
        });
        res.json({ ok: true });
    });

    // ---------------------------------------------------------------------
    // POST /verify — verify Razorpay signature, mark paid, return booking URL
    // ---------------------------------------------------------------------
    router.post('/verify', rateLimiter({ windowMs: 60_000, max: 20 }), async (req, res) => {
        const { leadId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
        if (!isLeadId(leadId) || ![orderId, paymentId, signature].every((v) => typeof v === 'string' && v.length < 100)) {
            return res.status(400).json({ error: 'Bad request' });
        }
        const cfg = getConfig();
        const expected = crypto.createHmac('sha256', cfg.razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
        if (!safeEqual(expected, signature)) return res.status(400).json({ error: 'Payment verification failed' });

        const result = await markPaid(cfg, { orderId, paymentId, source: 'checkout' });
        if (result.error) return res.status(404).json({ error: result.error });
        if (result.order.leadId !== leadId) return res.status(403).json({ error: 'Order does not match lead' });

        const bookingUrl = await bookingUrlFor(cfg, paymentId, result.payment);
        res.json({
            ok: true,
            paymentId,
            purchaseEventId: `purchase_${paymentId}`,
            plan: { id: result.order.planId, name: result.order.planName, price: result.order.amount },
            bookingUrl,
        });
    });

    // ---------------------------------------------------------------------
    // POST /booking-link — resume scheduling after a refresh / new tab
    // ---------------------------------------------------------------------
    router.post('/booking-link', rateLimiter({ windowMs: 60_000, max: 20 }), async (req, res) => {
        const { leadId, paymentId } = req.body || {};
        if (!isLeadId(leadId) || typeof paymentId !== 'string') return res.status(400).json({ error: 'Bad request' });
        const snap = await payments().doc(paymentId).get();
        if (!snap.exists || snap.data().leadId !== leadId) return res.status(404).json({ error: 'Payment not found' });
        const payment = snap.data();
        if (payment.bookedAt) return res.json({ booked: true });
        const bookingUrl = await bookingUrlFor(getConfig(), paymentId, payment);
        res.json({ booked: false, bookingUrl, plan: { id: payment.planId, name: payment.planName, price: payment.amount } });
    });

    // ---------------------------------------------------------------------
    // POST /booked — Calendly event_scheduled (from the embed postMessage)
    // ---------------------------------------------------------------------
    router.post('/booked', rateLimiter({ windowMs: 60_000, max: 20 }), async (req, res) => {
        const { leadId, paymentId } = req.body || {};
        if (!isLeadId(leadId) || typeof paymentId !== 'string') return res.status(400).json({ error: 'Bad request' });
        const ref = payments().doc(paymentId);
        const snap = await ref.get();
        if (!snap.exists || snap.data().leadId !== leadId) return res.status(404).json({ error: 'Payment not found' });

        const eventUri = clean(req.body.eventUri, 300);
        await ref.update({ bookedAt: FieldValue.serverTimestamp(), calendlyEventUri: eventUri });
        await leads().doc(leadId).update({
            status: 'booked',
            bookedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            history: FieldValue.arrayUnion(historyEntry('booked', { paymentId, eventUri })),
        });
        res.json({ ok: true });
    });

    // ---------------------------------------------------------------------
    // POST /razorpay-webhook — backup in case the browser closed after paying
    // ---------------------------------------------------------------------
    router.post('/razorpay-webhook', async (req, res) => {
        const cfg = getConfig();
        const signature = req.headers['x-razorpay-signature'];
        const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
        if (!cfg.razorpayWebhookSecret || typeof signature !== 'string') return res.status(400).send('not configured');
        const expected = crypto.createHmac('sha256', cfg.razorpayWebhookSecret).update(raw).digest('hex');
        if (!safeEqual(expected, signature)) return res.status(400).send('bad signature');

        const event = req.body?.event;
        const payment = req.body?.payload?.payment?.entity;
        if ((event === 'payment.captured' || event === 'order.paid') && payment?.order_id) {
            const result = await markPaid(cfg, { orderId: payment.order_id, paymentId: payment.id, source: 'webhook' });
            if (result.error) console.warn('Webhook for unknown order', payment.order_id);
        }
        res.json({ ok: true });
    });

    router.get('/health', (req, res) => res.json({ ok: true }));

    app.use('/api', router);
    app.use('/', router);

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        console.error('API error', err);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    });

    return app;
}

module.exports = { createApp };
