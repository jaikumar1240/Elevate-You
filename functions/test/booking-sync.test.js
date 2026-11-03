'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDb, FieldValue } = require('./fake-firestore');

const modulePath = path.join(__dirname, '../lib/booking-sync.js');
const now = Date.parse('2026-11-03T10:00:00Z');
const eventType = 'https://api.calendly.com/event_types/type1';
const eventUri = 'https://api.calendly.com/scheduled_events/event1';
const reference = 'abcdefghijklmnopqrstuvwx';
const event = { uri: eventUri, event_type: eventType, status: 'active' };
const invitee = {
    uri: `${eventUri}/invitees/invitee1`, event: eventUri, email: 'asha@example.com',
    status: 'active', created_at: '2026-11-03T09:30:00Z', tracking: { utm_term: reference },
};

async function seed(db, id = 'pay_old', extra = {}) {
    await db.collection('leads').doc('919876543210').set({ status: 'paid', lastPaymentId: 'pay_newer', history: [] });
    await db.collection('payments').doc(id).set({
        leadId: '919876543210', bookingRef: reference,
        bookingIdentity: { email: 'asha@example.com', name: 'Asha', contact: '+919876543210' },
        createdAt: new Date(now - 3600_000), bookingSyncAt: new Date(now - 60_000),
        bookingSyncState: 'pending', ...extra,
    });
}

function reader(overrides = {}) {
    return {
        remaining: 50,
        identity: async () => ({ userUri: 'https://api.calendly.com/users/user1', eventTypeUri: eventType }),
        events: async () => ({ collection: [event], pagination: {} }),
        invitees: async () => ({ collection: [invitee], pagination: {} }),
        getEvent: async () => event,
        getInvitee: async () => invitee,
        ...overrides,
    };
}

test('API-confirmed payment booking is idempotent and cannot overwrite a later payment status', async () => {
    assert.ok(fs.existsSync(modulePath), 'booking sync worker must exist');
    const { syncBookings } = require(modulePath);
    const db = createDb();
    await seed(db);
    const args = { db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now, createReader: () => reader() };
    await Promise.all([syncBookings(args), syncBookings(args)]);
    await syncBookings(args);
    const payment = db.store.get('payments/pay_old');
    assert.equal(payment.bookedAt.toISOString(), invitee.created_at.replace('Z', '.000Z'));
    assert.equal(payment.calendlyInviteeUri, invitee.uri);
    assert.equal(payment.bookingSyncState, 'confirmed');
    assert.equal(payment.bookingSyncAt, undefined);
    assert.equal(payment.metaDelivery.state, 'pending');
    assert.equal(payment.ga4Delivery.state, 'pending');
    const lead = db.store.get('leads/919876543210');
    assert.equal(lead.status, 'paid');
    assert.equal(lead.history.length, 1);
});

test('pagination resumes within the request budget and confirms only after the complete scan', async () => {
    const { syncBookings } = require(modulePath);
    const db = createDb();
    await seed(db);
    const visited = [];
    let remaining = 3;
    const api = reader({
        get remaining() { return remaining; },
        events: async () => {
            assert.ok(remaining-- > 0, 'request budget exceeded');
            return { collection: [event], pagination: {} };
        },
        invitees: async (uri, { pageToken }) => {
            assert.ok(remaining-- > 0, 'request budget exceeded');
            visited.push(pageToken || 'first');
            return pageToken === 'third'
                ? { collection: [invitee], pagination: {} }
                : { collection: [], pagination: { next_page_token: pageToken ? 'third' : 'second' } };
        },
        getEvent: async () => {
            assert.ok(remaining-- > 0, 'request budget exceeded');
            return event;
        },
        getInvitee: async () => {
            assert.ok(remaining-- > 0, 'request budget exceeded');
            return invitee;
        },
    });

    // Object spread copies getter values; keep the budget observable.
    Object.defineProperty(api, 'remaining', { get: () => remaining });
    const args = { db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now, createReader: () => api };
    await syncBookings(args);
    assert.equal(db.store.get('payments/pay_old').bookedAt, undefined);
    assert.equal(db.store.get('payments/pay_old').bookingSyncState, 'pending');
    assert.ok(db.store.get('payments/pay_old').bookingScan);
    remaining = 3;
    await syncBookings({ ...args, now: () => now + 600_000 });
    assert.equal(db.store.get('payments/pay_old').bookingSyncState, 'confirmed');
    assert.deepEqual(visited, ['first', 'second', 'third']);
});

test('uncorrelated historical bookings are review-only, never email-only matches', async () => {
    const { syncBookings } = require(modulePath);
    const db = createDb();
    await seed(db, 'pay_old', { bookingRef: undefined });
    await syncBookings({
        db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now,
        createReader: () => reader({ invitees: async () => ({ collection: [{ ...invitee, tracking: {} }], pagination: {} }) }),
    });
    const payment = db.store.get('payments/pay_old');
    assert.equal(payment.bookedAt, undefined);
    assert.equal(payment.bookingSyncState, 'review');
    assert.equal(payment.bookingSyncError, 'missing_booking_identity');
});

test('Calendly rate limits pause the shared poller until Retry-After, including later invocations', async () => {
    const { syncBookings } = require(modulePath);
    const db = createDb();
    await seed(db);
    await seed(db, 'pay_second');
    let attempts = 0;
    const args = {
        db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now,
        createReader: () => reader({ identity: async () => {
            attempts++;
            throw Object.assign(new Error('Rate limited'), { code: 'calendly_429', retryAfterMs: 3600_000 });
        } }),
    };
    await syncBookings(args);
    await syncBookings({ ...args, now: () => now + 300_000 });
    assert.equal(attempts, 1);
    const failed = db.store.get('payments/pay_old');
    assert.equal(failed.bookingSyncError, 'calendly_429');
    assert.ok(failed.bookingSyncAt.getTime() >= now + 3600_000);
    assert.equal(failed.bookedAt, undefined);
});

test('booking destinations deliver independently: Meta retries safely while ambiguous GA4 is not resent', async () => {
    const { deliverBookingConversions } = require(modulePath);
    assert.equal(typeof deliverBookingConversions, 'function');
    const db = createDb();
    await seed(db, 'pay_old', {
        bookedAt: new Date(invitee.created_at), bookingSyncState: 'confirmed', conversionAt: new Date(now),
        metaDelivery: { state: 'pending', attempts: 0 }, ga4Delivery: { state: 'pending', attempts: 0 },
    });
    const calls = { meta: [], google: [] };
    const args = {
        db, FieldValue, now: () => now,
        cfg: { metaToken: 'meta', metaPixelId: 'pixel', ga4ApiSecret: 'google', ga4MeasurementId: 'G-TQDPKWBBW0', siteUrl: 'https://site' },
        sendMetaEvent: async (event) => { calls.meta.push(event); return { ok: calls.meta.length > 1 }; },
        sendGa4Booking: async (event) => { calls.google.push(event); return { state: 'ambiguous', reason: 'network_error' }; },
    };
    await deliverBookingConversions(args);
    assert.equal(db.store.get('payments/pay_old').metaDelivery.state, 'retry');
    assert.equal(db.store.get('payments/pay_old').ga4Delivery.state, 'ambiguous');
    await Promise.all([
        deliverBookingConversions({ ...args, now: () => now + 600_000 }),
        deliverBookingConversions({ ...args, now: () => now + 600_000 }),
    ]);
    assert.equal(calls.meta.length, 2);
    assert.equal(calls.google.length, 1);
    assert.equal(calls.meta[0].eventId, 'schedule_pay_old');
    assert.equal(calls.meta[0].eventTime, Date.parse(invitee.created_at) / 1000);
    assert.equal(calls.meta[0].lead.email, 'asha@example.com');
    assert.equal(db.store.get('payments/pay_old').conversionAt, undefined);
    assert.ok(db.store.get('payments/pay_old').bookedAt);
});

test('matching rejects incomplete, canceled, mismatched and ambiguous Calendly identities', async () => {
    const { syncBookings } = require(modulePath);
    for (const [invitees, expected] of [
        [[{ ...invitee, uri: undefined }], 'error'],
        [[{ ...invitee, status: 'canceled' }], 'pending'],
        [[{ ...invitee, email: 'different@example.com' }], 'pending'],
        [[{ ...invitee, tracking: { utm_term: 'wrong-reference' } }], 'pending'],
        [[{ ...invitee, created_at: '2026-11-02T09:00:00Z' }], 'pending'],
        [[invitee, { ...invitee, uri: `${eventUri}/invitees/invitee2` }], 'review'],
    ]) {
        const db = createDb();
        await seed(db);
        await syncBookings({
            db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now,
            createReader: () => reader({ invitees: async () => ({ collection: invitees, pagination: {} }) }),
        });
        const payment = db.store.get('payments/pay_old');
        assert.equal(payment.bookedAt, undefined);
        assert.equal(payment.bookingSyncState, expected);
    }
});

test('real reader integration stays within 50 requests and leaves older untouched payments due', async () => {
    const { syncBookings } = require(modulePath);
    const { createCalendlyReader } = require('../lib/calendly');
    const db = createDb();
    for (let index = 0; index < 25; index++) {
        await seed(db, `pay_${index}`, { bookingSyncAt: new Date(now - 60_000 + index) });
    }
    let requests = 0;
    const fetchImpl = async (url) => {
        requests++;
        const path = new URL(url).pathname;
        const body = path === '/users/me'
            ? { resource: { uri: 'https://api.calendly.com/users/user1' } }
            : path === '/event_types'
                ? { collection: [{ scheduling_url: 'https://calendly.com/x/y', uri: eventType }] }
                : path === '/scheduled_events'
                    ? { collection: [event, event, event, event] }
                    : { collection: [] };
        return { ok: true, json: async () => body };
    };
    await syncBookings({
        db, FieldValue, cfg: { calendlySyncToken: 'read', calendlyUrl: 'https://calendly.com/x/y' }, now: () => now,
        createReader: (options) => createCalendlyReader({ ...options, fetchImpl }),
    });
    assert.equal(requests, 50);
    assert.ok(db.store.get('payments/pay_9').bookingScan);
    assert.equal(db.store.get('payments/pay_10').bookingSyncAt.getTime(), now - 60_000 + 10);
    assert.ok([...db.store.values()].filter((value) => value.bookingSyncAt?.getTime() > now).length <= 20);
});

test('polling selects only the 20 oldest due payments and leaves the rest ahead for the next run', async () => {
    const { syncBookings } = require(modulePath);
    const db = createDb();
    for (let index = 24; index >= 0; index--) {
        await seed(db, `pay_${index}`, { bookingSyncAt: new Date(now - 60_000 + index) });
    }
    let queries = 0;
    await syncBookings({
        db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now,
        createReader: () => reader({ events: async () => { queries++; return { collection: [] }; } }),
    });
    assert.equal(queries, 20);
    assert.ok(db.store.get('payments/pay_19').bookingSyncAt.getTime() > now);
    assert.equal(db.store.get('payments/pay_20').bookingSyncAt.getTime(), now - 60_000 + 20);
});

test('stale booked payments are removed from the due queue without starving later payments', async () => {
    const { syncBookings } = require(modulePath);
    const db = createDb();
    for (let i = 0; i < 20; i++) {
        await seed(db, `pay_stale_${i}`, {
            bookedAt: new Date(now - 3600_000), bookingSyncAt: new Date(now - 60_000),
            bookingSyncState: i === 0 ? 'confirmed' : 'pending',
        });
    }
    await seed(db, 'pay_waiting', { bookingSyncAt: new Date(now - 1000) });
    const args = { db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now, createReader: () => reader() };
    await syncBookings(args);
    assert.equal(db.store.get('payments/pay_stale_0').bookingSyncAt, undefined);
    assert.equal(db.store.get('payments/pay_stale_0').bookingSyncState, 'confirmed');
    assert.equal(db.store.get('payments/pay_stale_1').bookingSyncState, 'review');
    assert.equal(db.store.get('payments/pay_stale_1').bookingSyncError, 'legacy_booking_unverified');
    await syncBookings(args);
    assert.equal(db.store.get('payments/pay_waiting').bookingSyncState, 'confirmed');
});

test('conversion recovery never sends an unconfirmed booking or replays interrupted GA4', async () => {
    const { deliverBookingConversions } = require(modulePath);
    const db = createDb();
    await seed(db, 'pay_old', {
        conversionAt: new Date(now), analytics: { adUserData: 'DENIED' },
        metaDelivery: { state: 'pending', attempts: 0 }, ga4Delivery: { state: 'sending', attempts: 1 },
    });
    let requests = 0;
    const args = {
        db, FieldValue, cfg: {}, now: () => now,
        sendMetaEvent: async () => { requests++; return { ok: true }; },
        sendGa4Booking: async () => { requests++; return { state: 'accepted' }; },
    };
    await deliverBookingConversions(args);
    assert.equal(requests, 0);
    await db.collection('payments').doc('pay_old').update({
        bookedAt: new Date(invitee.created_at), bookingSyncState: 'confirmed', conversionAt: new Date(now),
    });
    await deliverBookingConversions(args);
    const payment = db.store.get('payments/pay_old');
    assert.equal(requests, 0);
    assert.equal(payment.metaDelivery.state, 'skipped');
    assert.equal(payment.ga4Delivery.state, 'ambiguous');
    assert.equal(payment.ga4Delivery.reason, 'interrupted_send');
    assert.equal(payment.ga4Delivery.attempts, 1);
});

test('expired Calendly pagination restarts a fresh scan after visible backoff', async () => {
    const { syncBookings } = require(modulePath);
    const db = createDb();
    await seed(db, 'pay_old', { bookingScan: { events: [], eventPage: 'expired', inviteePage: null, loaded: true, match: null } });
    const args = {
        db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now,
        createReader: () => reader({ events: async ({ pageToken }) => {
            if (pageToken) throw Object.assign(new Error('Expired pagination'), { code: 'calendly_400' });
            return { collection: [event], pagination: {} };
        } }),
    };
    await syncBookings(args);
    assert.equal(db.store.get('payments/pay_old').bookingSyncState, 'error');
    assert.equal(db.store.get('payments/pay_old').bookingScan, undefined);
    await syncBookings({ ...args, now: () => now + 1800_000 });
    assert.equal(db.store.get('payments/pay_old').bookingSyncState, 'confirmed');
});

test('resumed event pages still enforce the expected active event type', async () => {
    const { syncBookings } = require(modulePath);
    const db = createDb();
    await seed(db, 'pay_old', {
        bookingScan: {
            events: [{ ...event, event_type: 'https://api.calendly.com/event_types/wrong' }],
            eventPage: null, inviteePage: null, loaded: true,
            match: { eventUri, inviteeUri: invitee.uri, createdAt: invitee.created_at, eventTypeUri: 'https://api.calendly.com/event_types/wrong' },
        },
    });
    await syncBookings({
        db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now, createReader: () => reader(),
    });
    assert.equal(db.store.get('payments/pay_old').bookedAt, undefined);
    assert.equal(db.store.get('payments/pay_old').bookingSyncState, 'pending');
});

test('a resumed match is revalidated against current Calendly event and invitee data', async () => {
    const { syncBookings } = require(modulePath);
    const { createCalendlyReader } = require('../lib/calendly');
    for (const [currentEvent, currentInvitee] of [
        [{ ...event, status: 'canceled' }, invitee],
        [event, { ...invitee, status: 'canceled' }],
        [{ ...event, event_type: 'https://api.calendly.com/event_types/other' }, invitee],
        [event, { ...invitee, email: 'different@example.com' }],
        [event, { ...invitee, tracking: { utm_term: 'different' } }],
    ]) {
        const db = createDb();
        await seed(db);
        const paths = [];
        let run = 0;
        const fetchImpl = async (url) => {
            const parsed = new URL(url);
            paths.push(parsed.pathname);
            let body;
            if (parsed.pathname === '/users/me') body = { resource: { uri: 'https://api.calendly.com/users/user1' } };
            else if (parsed.pathname === '/event_types') body = { collection: [{ scheduling_url: 'https://calendly.com/x/y', uri: eventType }] };
            else if (parsed.pathname === '/scheduled_events') body = { collection: [event] };
            else if (parsed.pathname === '/scheduled_events/event1/invitees') {
                body = parsed.searchParams.has('page_token')
                    ? { collection: [] }
                    : { collection: [invitee], pagination: { next_page_token: 'second' } };
            } else if (parsed.pathname === '/scheduled_events/event1') body = { resource: currentEvent };
            else if (parsed.pathname === '/scheduled_events/event1/invitees/invitee1') body = { resource: currentInvitee };
            else throw new Error('Unexpected Calendly request');
            return { ok: true, json: async () => body };
        };
        const args = {
            db, FieldValue, cfg: { calendlySyncToken: 'read', calendlyUrl: 'https://calendly.com/x/y' }, now: () => now,
            createReader: (options) => createCalendlyReader({ ...options, maxRequests: ++run === 1 ? 4 : 6, fetchImpl }),
        };
        await syncBookings(args);
        assert.ok(db.store.get('payments/pay_old').bookingScan?.match);
        await syncBookings({ ...args, now: () => now + 600_000 });
        const payment = db.store.get('payments/pay_old');
        assert.equal(payment.bookedAt, undefined);
        assert.equal(payment.bookingSyncState, 'pending');
        assert.ok(paths.includes('/scheduled_events/event1'));
    }
});

test('a removed Calendly candidate is discarded so a later valid booking can be found', async () => {
    const { syncBookings } = require(modulePath);
    const db = createDb();
    await seed(db, 'pay_old', {
        bookingScan: {
            events: [], eventPage: null, inviteePage: null, loaded: true,
            match: { eventUri, inviteeUri: invitee.uri, createdAt: invitee.created_at, eventTypeUri: eventType },
        },
    });
    let removed = true;
    const args = {
        db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now,
        createReader: () => reader({
            getEvent: async () => {
                if (removed) throw Object.assign(new Error('Removed event'), { code: 'calendly_404' });
                return event;
            },
        }),
    };
    await syncBookings(args);
    assert.equal(db.store.get('payments/pay_old').bookingSyncState, 'error');
    assert.equal(db.store.get('payments/pay_old').bookingScan, undefined);
    removed = false;
    await syncBookings({ ...args, now: () => now + 1800_000 });
    assert.equal(db.store.get('payments/pay_old').bookingSyncState, 'confirmed');
});

test('a legacy booked timestamp cannot trigger conversions before API confirmation', async () => {
    const { deliverBookingConversions, syncBookings } = require(modulePath);
    const db = createDb();
    await seed(db, 'pay_old', {
        bookedAt: new Date(invitee.created_at), bookingSyncState: 'pending', conversionAt: new Date(now),
        metaDelivery: { state: 'pending', attempts: 0 }, ga4Delivery: { state: 'pending', attempts: 0 },
    });
    let deliveries = 0;
    const delivery = {
        db, FieldValue, cfg: {}, now: () => now,
        sendMetaEvent: async () => { deliveries++; return { ok: true }; },
        sendGa4Booking: async () => { deliveries++; return { state: 'accepted' }; },
    };
    await deliverBookingConversions(delivery);
    assert.equal(deliveries, 0);
    assert.equal(db.store.get('payments/pay_old').conversionAt, undefined);
    assert.equal(db.store.get('payments/pay_old').conversionError, 'unconfirmed_booking');

    await db.collection('payments').doc('pay_old').update({ bookedAt: FieldValue.delete() });
    await syncBookings({
        db, FieldValue, cfg: { calendlySyncToken: 'read' }, now: () => now, createReader: () => reader(),
    });
    assert.equal(db.store.get('payments/pay_old').conversionError, undefined);
    await deliverBookingConversions(delivery);
    assert.equal(deliveries, 2);
});
