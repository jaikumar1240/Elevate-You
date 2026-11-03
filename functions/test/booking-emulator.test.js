'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { syncBookings, deliverBookingConversions } = require('../lib/booking-sync');

test('real Firestore transactions prevent concurrent duplicate bookings and conversion producers', {
    skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async (ctx) => {
    assert.match(process.env.FIRESTORE_EMULATOR_HOST, /^(127\.0\.0\.1|localhost):\d+$/);
    const { initializeApp, deleteApp } = require('firebase-admin/app');
    const { getFirestore, FieldValue } = require('firebase-admin/firestore');
    const app = initializeApp({ projectId: 'demo-dyc-booking' }, 'booking-test');
    const db = getFirestore(app);
    const id = `test-${crypto.randomUUID()}`;
    const lead = db.collection('leads').doc(id);
    const payment = db.collection('payments').doc(id);
    ctx.after(async () => {
        await Promise.all([lead.delete(), payment.delete()]);
        await db.terminate();
        await deleteApp(app);
    });
    const reference = crypto.randomBytes(18).toString('base64url');
    const time = Date.now();
    const createdAt = new Date(time - 30_000).toISOString();
    const eventUri = 'https://api.calendly.com/scheduled_events/event1';
    const eventType = 'https://api.calendly.com/event_types/type1';
    const scheduledEvent = { uri: eventUri, event_type: eventType, status: 'active' };
    const scheduledInvitee = {
        uri: `${eventUri}/invitees/invitee1`, event: eventUri, email: 'test@example.invalid',
        created_at: createdAt, status: 'active', tracking: { utm_term: reference },
    };
    await lead.set({ status: 'paid', lastPaymentId: id, history: [] });
    await payment.set({
        leadId: id, planId: 'mock', planName: 'Mock Interview', bookingRef: reference,
        bookingIdentity: { email: 'test@example.invalid', name: 'Test', contact: '+919876543210' },
        createdAt: new Date(time - 60_000), bookingSyncAt: new Date(time - 1000),
    });
    const args = {
        db, FieldValue, cfg: { calendlySyncToken: 'test' }, now: () => time,
        createReader: () => ({
            remaining: 50,
            identity: async () => ({ userUri: 'https://api.calendly.com/users/user1', eventTypeUri: eventType }),
            events: async () => ({ collection: [scheduledEvent] }),
            invitees: async () => ({ collection: [scheduledInvitee] }),
            getEvent: async () => scheduledEvent,
            getInvitee: async () => scheduledInvitee,
        }),
    };
    await Promise.all([syncBookings(args), syncBookings(args), syncBookings(args)]);
    const saved = (await payment.get()).data();
    assert.equal(saved.bookedAt.toDate().toISOString(), createdAt);
    assert.equal((await lead.get()).data().history.length, 1);
    assert.equal((await lead.get()).data().status, 'booked');
    let meta = 0;
    let google = 0;
    const deliveries = {
        db, FieldValue, cfg: {}, now: () => time,
        sendMetaEvent: async () => { meta++; return { ok: true }; },
        sendGa4Booking: async () => { google++; return { state: 'accepted' }; },
    };
    await Promise.all([deliverBookingConversions(deliveries), deliverBookingConversions(deliveries)]);
    assert.equal(meta, 1);
    assert.equal(google, 1);
    assert.equal((await payment.get()).data().conversionAt, undefined);
});
