'use strict';

const crypto = require('node:crypto');
const logger = require('firebase-functions/logger');

const millis = (value) => value?.toMillis ? value.toMillis() : new Date(value).getTime();

async function scanBooking(api, payment, scan, time) {
    const { userUri, eventTypeUri } = await api.identity();
    if (scan.match && scan.match.eventTypeUri !== eventTypeUri) scan.match = null;
    let requests = 0;
    while (api.remaining > 0 && requests < 6) {
        if (!scan.events.length) {
            if (scan.loaded && !scan.eventPage) break;
            const page = await api.events({
                user: userUri, email: payment.bookingIdentity.email,
                minStart: new Date(millis(payment.createdAt)).toISOString(), pageToken: scan.eventPage,
            });
            requests++;
            scan.loaded = true;
            scan.eventPage = page.pagination?.next_page_token || null;
            scan.events = page.collection.filter((event) => event.status === 'active' && event.event_type === eventTypeUri)
                .map(({ uri, status, event_type }) => ({ uri, status, event_type }));
            continue;
        }
        const event = scan.events[0];
        if (event.status !== 'active' || event.event_type !== eventTypeUri) {
            scan.events.shift();
            scan.inviteePage = null;
            continue;
        }
        const page = await api.invitees(event.uri, { email: payment.bookingIdentity.email, pageToken: scan.inviteePage });
        requests++;
        for (const invitee of page.collection) {
            if (invitee.status !== 'active' || invitee.event !== event.uri ||
                invitee.tracking?.utm_term !== payment.bookingRef ||
                invitee.email?.trim().toLowerCase() !== payment.bookingIdentity.email.trim().toLowerCase() ||
                !Number.isFinite(millis(invitee.created_at)) || millis(invitee.created_at) < millis(payment.createdAt) ||
                millis(invitee.created_at) > time + 300_000) continue;
            if (typeof invitee.uri !== 'string' || !invitee.uri.startsWith(`${event.uri}/invitees/`) ||
                !/^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9-]+\/invitees\/[A-Za-z0-9-]+$/.test(invitee.uri)) {
                throw Object.assign(new Error('Invalid invitee identity'), { code: 'invalid_response' });
            }
            if (scan.match && scan.match.inviteeUri !== invitee.uri) throw Object.assign(new Error('Ambiguous booking'), { code: 'ambiguous_match' });
            scan.match = { eventUri: event.uri, inviteeUri: invitee.uri, createdAt: invitee.created_at, eventTypeUri };
        }
        scan.inviteePage = page.pagination?.next_page_token || null;
        if (!scan.inviteePage) scan.events.shift();
    }
    const complete = scan.loaded && !scan.events.length && !scan.eventPage;
    if (!complete || !scan.match) return complete;
    if (api.remaining < 2) return false;

    const currentEvent = await api.getEvent(scan.match.eventUri);
    if (currentEvent.uri !== scan.match.eventUri || currentEvent.status !== 'active' || currentEvent.event_type !== eventTypeUri) {
        scan.match = null;
        return true;
    }
    const currentInvitee = await api.getInvitee(scan.match.inviteeUri);
    if (currentInvitee.uri !== scan.match.inviteeUri || currentInvitee.status !== 'active' ||
        currentInvitee.event !== currentEvent.uri || currentInvitee.tracking?.utm_term !== payment.bookingRef ||
        typeof currentInvitee.email !== 'string' ||
        currentInvitee.email.trim().toLowerCase() !== payment.bookingIdentity.email.trim().toLowerCase() ||
        millis(currentInvitee.created_at) !== millis(scan.match.createdAt)) {
        scan.match = null;
    }
    return true;
}

async function syncBookings({ db, FieldValue, cfg, createReader, now = Date.now }) {
    const time = now();
    const counts = { confirmed: 0, pending: 0, failed: 0 };
    const control = db.collection('bookingSyncControl').doc('calendly');
    if (millis((await control.get()).data()?.retryAt) > time) return counts;
    const due = await db.collection('payments').where('bookingSyncAt', '<=', new Date(time)).orderBy('bookingSyncAt').limit(20).get();
    const api = createReader({ token: cfg.calendlySyncToken, publicUrl: cfg.calendlyUrl, maxRequests: 50 });
    for (const doc of due.docs) {
        if (api.remaining <= 0) break;
        const lease = crypto.randomUUID();
        const payment = await db.runTransaction(async (tx) => {
            const current = (await tx.get(doc.ref)).data();
            if (current.bookedAt) {
                const patch = { bookingSyncAt: FieldValue.delete() };
                if (current.bookingSyncState !== 'confirmed') {
                    Object.assign(patch, { bookingSyncState: 'review', bookingSyncError: 'legacy_booking_unverified' });
                }
                tx.update(doc.ref, patch);
                return null;
            }
            if (millis(current.bookingLeaseUntil) > time || millis(current.bookingSyncAt) > time) return null;
            tx.update(doc.ref, { bookingLeaseId: lease, bookingLeaseUntil: new Date(time + 600_000) });
            return current;
        });
        if (!payment) continue;
        const scan = payment.bookingScan || { events: [], eventPage: null, inviteePage: null, loaded: false, match: null };
        try {
            if (!cfg.calendlySyncToken) throw Object.assign(new Error('Missing read token'), { code: 'missing_token' });
            if (!/^[A-Za-z0-9_-]{24}$/.test(payment.bookingRef || '') || !payment.bookingIdentity?.email ||
                !Number.isFinite(millis(payment.createdAt))) {
                throw Object.assign(new Error('Missing payment booking identity'), { code: 'missing_booking_identity' });
            }
            const complete = await scanBooking(api, payment, scan, time);
            const match = complete ? scan.match : null;
            await db.runTransaction(async (tx) => {
                const current = (await tx.get(doc.ref)).data();
                if (current.bookedAt || current.bookingLeaseId !== lease) return;
                const leadRef = db.collection('leads').doc(current.leadId);
                const lead = match ? (await tx.get(leadRef)).data() : null;
                const patch = {
                    bookingLeaseId: FieldValue.delete(), bookingLeaseUntil: FieldValue.delete(),
                    bookingSyncState: match ? 'confirmed' : 'pending',
                    bookingSyncAt: match ? FieldValue.delete() : new Date(time + 600_000),
                    bookingSyncError: FieldValue.delete(),
                    bookingScan: complete ? FieldValue.delete() : scan,
                };
                if (match) {
                    Object.assign(patch, {
                        bookedAt: new Date(match.createdAt), bookingConfirmedAt: new Date(time),
                        calendlyEventUri: match.eventUri, calendlyInviteeUri: match.inviteeUri,
                        conversionAt: new Date(time), conversionError: FieldValue.delete(),
                        metaDelivery: { state: 'pending', attempts: 0 },
                        ga4Delivery: { state: 'pending', attempts: 0 },
                    });
                    const leadPatch = {
                        history: FieldValue.arrayUnion({ type: 'booked', paymentId: doc.id, eventUri: match.eventUri, at: match.createdAt }),
                        updatedAt: new Date(time),
                    };
                    if (lead.lastPaymentId === doc.id) Object.assign(leadPatch, { status: 'booked', bookedAt: new Date(match.createdAt) });
                    tx.update(leadRef, leadPatch);
                }
                tx.update(doc.ref, patch);
            });
            counts[match ? 'confirmed' : 'pending']++;
        } catch (error) {
            const code = error.code || 'calendly_unavailable';
            const delay = Math.max(1800_000, Math.min(Number(error.retryAfterMs) || 0, 86400_000));
            logger.warn('Booking sync could not confirm payment', { paymentId: doc.id, code });
            await db.runTransaction(async (tx) => {
                const current = (await tx.get(doc.ref)).data();
                if (current.bookingLeaseId !== lease || current.bookedAt) return;
                tx.update(doc.ref, {
                    bookingLeaseId: FieldValue.delete(), bookingLeaseUntil: FieldValue.delete(),
                    bookingSyncState: ['missing_booking_identity', 'ambiguous_match'].includes(code) ? 'review' : 'error',
                    bookingSyncError: code, bookingSyncAt: new Date(time + delay),
                    bookingScan: ['calendly_400', 'calendly_404'].includes(code) ? FieldValue.delete() : scan,
                });
            });
            counts.failed++;
            if (['calendly_401', 'calendly_403', 'calendly_429'].includes(code)) {
                await control.set({ retryAt: new Date(time + delay), errorCode: code, updatedAt: new Date(time) });
                break;
            }
        }
    }
    return counts;
}

async function deliverBookingConversions({ db, FieldValue, cfg, sendMetaEvent, sendGa4Booking, now = Date.now }) {
    const time = now();
    const due = await db.collection('payments').where('conversionAt', '<=', new Date(time)).orderBy('conversionAt').limit(20).get();
    const retryable = new Set(['pending', 'retry', 'blocked', 'sending']);
    const counts = { accepted: 0, attention: 0 };
    for (const doc of due.docs) {
        const lease = crypto.randomUUID();
        const payment = await db.runTransaction(async (tx) => {
            const current = (await tx.get(doc.ref)).data();
            if (millis(current.deliveryLeaseUntil) > time || millis(current.conversionAt) > time) return null;
            if (!current.bookedAt || current.bookingSyncState !== 'confirmed') {
                tx.update(doc.ref, { conversionAt: FieldValue.delete(), conversionError: 'unconfirmed_booking' });
                return { unconfirmedBooking: true };
            }
            tx.update(doc.ref, { deliveryLeaseId: lease, deliveryLeaseUntil: new Date(time + 600_000) });
            return { ...current, id: doc.id };
        });
        if (!payment) continue;
        if (payment.unconfirmedBooking) {
            logger.warn('Booking conversion needs attention', { paymentId: doc.id, reason: 'unconfirmed_booking' });
            counts.attention++;
            continue;
        }
        for (const destination of ['meta', 'ga4']) {
            const field = `${destination}Delivery`;
            const previous = payment[field] || { state: 'pending', attempts: 0 };
            if (!retryable.has(previous.state)) continue;
            let result;
            if (destination === 'ga4' && previous.state === 'sending') {
                result = { ...previous, state: 'ambiguous', reason: 'interrupted_send' };
            } else {
                const attempt = { state: 'sending', attempts: previous.attempts + 1, attemptedAt: new Date(time) };
                const claimed = await db.runTransaction(async (tx) => {
                    if ((await tx.get(doc.ref)).data().deliveryLeaseId !== lease) return false;
                    tx.update(doc.ref, { [field]: attempt });
                    return true;
                });
                if (!claimed) break;
                try {
                    if (destination === 'meta') {
                        const bookedAt = millis(payment.bookedAt);
                        if (payment.analytics?.adUserData === 'DENIED') {
                            result = { state: 'skipped', reason: 'ads_denied' };
                        } else if (bookedAt > time || time - bookedAt > 7 * 86400_000) {
                            result = { state: 'skipped', reason: 'timestamp_out_of_window' };
                        } else {
                            const identity = payment.bookingIdentity;
                            const response = await sendMetaEvent({
                                pixelId: cfg.metaPixelId, token: cfg.metaToken, testEventCode: cfg.metaTestEventCode,
                                eventName: 'Schedule', eventId: `schedule_${doc.id}`, eventTime: Math.floor(bookedAt / 1000),
                                sourceUrl: cfg.siteUrl,
                                lead: { id: payment.leadId, name: identity.name, email: identity.email, phone: (identity.contact || '').replace(/\D/g, '').slice(-10), client: payment.client },
                                customData: { content_name: payment.planName, content_ids: [payment.planId] },
                            });
                            result = response.ok ? { state: 'accepted' } : response.skipped
                                ? { state: 'blocked', reason: 'missing_credentials' } : { state: 'retry', reason: 'request_failed' };
                        }
                    } else {
                        result = await sendGa4Booking({
                            measurementId: cfg.ga4MeasurementId, apiSecret: cfg.ga4ApiSecret, payment, now,
                            debugMode: cfg.ga4BookingDebug,
                        });
                    }
                } catch {
                    result = { state: destination === 'ga4' ? 'ambiguous' : 'retry', reason: 'request_failed' };
                }
                result = { ...attempt, ...result, completedAt: new Date(time) };
            }
            if (result.state !== 'accepted') {
                logger.warn('Booking conversion needs attention', { paymentId: doc.id, destination, state: result.state, reason: result.reason });
                counts.attention++;
            } else counts.accepted++;
            await db.runTransaction(async (tx) => {
                if ((await tx.get(doc.ref)).data().deliveryLeaseId === lease) tx.update(doc.ref, { [field]: result });
            });
        }
        await db.runTransaction(async (tx) => {
            const current = (await tx.get(doc.ref)).data();
            if (current.deliveryLeaseId !== lease) return;
            const retry = ['metaDelivery', 'ga4Delivery'].some((field) => retryable.has(current[field]?.state));
            tx.update(doc.ref, {
                deliveryLeaseId: FieldValue.delete(), deliveryLeaseUntil: FieldValue.delete(),
                conversionAt: retry ? new Date(time + 600_000) : FieldValue.delete(),
            });
        });
    }
    return counts;
}

module.exports = { syncBookings, deliverBookingConversions };
