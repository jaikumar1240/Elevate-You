'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const Razorpay = require('razorpay');

const { REGION, secrets, params, secretValue } = require('./lib/config');
const { createApp } = require('./lib/app');
const { sendMetaEvent } = require('./lib/meta');
const { sendAlert, sendLeadEmail } = require('./lib/mail');
const { createBookingUrl } = require('./lib/calendly');
const { sendPaymentReminders } = require('./lib/reminders');

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
