'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const Razorpay = require('razorpay');

const { REGION, secrets, bookingSecrets, params, secretValue } = require('./lib/config');
const { createApp } = require('./lib/app');
const { sendMetaEvent } = require('./lib/meta');
const { sendAlert, sendLeadEmail } = require('./lib/mail');
const { createBookingUrl, createCalendlyReader } = require('./lib/calendly');
const { sendPaymentReminders } = require('./lib/reminders');
const { syncBookings, deliverBookingConversions } = require('./lib/booking-sync');
const { sendGa4Booking } = require('./lib/ga4');

setGlobalOptions({ region: REGION, maxInstances: 10 });
initializeApp();

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

const getConfig = () => ({
    razorpayKeyId: secretValue(secrets.RAZORPAY_KEY_ID),
    razorpayKeySecret: secretValue(secrets.RAZORPAY_KEY_SECRET),
    razorpayWebhookSecret: secretValue(secrets.RAZORPAY_WEBHOOK_SECRET),
    metaToken: secretValue(secrets.META_CAPI_TOKEN),
    metaPixelId: params.META_PIXEL_ID.value(),
    metaTestEventCode: params.META_TEST_EVENT_CODE.value(),
    gmailAppPassword: secretValue(secrets.GMAIL_APP_PASSWORD),
    adminEmail: params.ADMIN_EMAIL.value(),
    calendlyToken: secretValue(secrets.CALENDLY_TOKEN),
    calendlyUrl: params.CALENDLY_URL.value(),
    siteUrl: params.SITE_URL.value(),
});

const app = createApp({
    db,
    FieldValue,
    getConfig,
    createRazorpay: (keyId, keySecret) => new Razorpay({ key_id: keyId, key_secret: keySecret }),
    sendMetaEvent,
    sendAlert,
    createBookingUrl,
});

exports.api = onRequest(
    { secrets: Object.values(secrets), memory: '256MiB', timeoutSeconds: 30, minInstances: 0 },
    app,
);

// Emails unpaid leads once, ~30 min after they filled the form.
exports.paymentReminders = onSchedule(
    { schedule: 'every 10 minutes', timeZone: 'Asia/Kolkata', secrets: [secrets.GMAIL_APP_PASSWORD], memory: '256MiB', timeoutSeconds: 120, maxInstances: 1 },
    async () => {
        const cfg = {
            adminEmail: params.ADMIN_EMAIL.value(),
            gmailAppPassword: secretValue(secrets.GMAIL_APP_PASSWORD),
            siteUrl: params.SITE_URL.value(),
            whatsappNumber: params.WHATSAPP_NUMBER.value(),
        };
        const counts = await sendPaymentReminders({ db, FieldValue, cfg, sendLeadEmail });
        if (counts.sent || counts.failed) logger.info('Payment reminders', counts);
    },
);

exports.bookingSync = onSchedule(
    {
        schedule: 'every 5 minutes', timeZone: 'Asia/Kolkata',
        secrets: [...Object.values(bookingSecrets), secrets.META_CAPI_TOKEN],
        memory: '256MiB', timeoutSeconds: 540, maxInstances: 1,
    },
    async () => {
        const cfg = {
            calendlySyncToken: secretValue(bookingSecrets.CALENDLY_SYNC_TOKEN),
            calendlyUrl: params.CALENDLY_URL.value(),
            ga4ApiSecret: secretValue(bookingSecrets.GA4_API_SECRET),
            ga4MeasurementId: params.GA4_MEASUREMENT_ID.value(),
            ga4BookingDebug: params.GA4_BOOKING_DEBUG.value() === 'true',
            metaToken: secretValue(secrets.META_CAPI_TOKEN),
            metaPixelId: params.META_PIXEL_ID.value(),
            metaTestEventCode: params.META_TEST_EVENT_CODE.value(),
            siteUrl: params.SITE_URL.value(),
        };
        const results = await Promise.allSettled([
            syncBookings({ db, FieldValue, cfg, createReader: createCalendlyReader }),
            deliverBookingConversions({ db, FieldValue, cfg, sendMetaEvent, sendGa4Booking }),
        ]);
        if (results.some((result) => result.status === 'rejected')) {
            logger.error('Booking worker failed; inspect payment delivery and sync states');
            throw new Error('Booking worker failed');
        }
        logger.info('Booking worker', { sync: results[0].value, conversions: results[1].value });
    },
);
