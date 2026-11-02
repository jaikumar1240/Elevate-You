'use strict';

const { defineSecret, defineString } = require('firebase-functions/params');

/**
 * Server-side source of truth for prices. The client only sends a planId;
 * the amount charged always comes from here.
 * Keep in sync with PLANS in /script.js (display only).
 */
const PLANS = {
    diagnosis: { name: 'Diagnosis Session', price: 89 },
    resume: { name: 'Resume Review', price: 199 },
    social: { name: 'Social Profile Review', price: 199 },
    mock: { name: 'Mock Interview', price: 349 },
    'prep-pack': { name: 'Interview Prep Pack', price: 799 },
    placement: { name: 'Full Placement Prep', price: 1499 },
};

const CURRENCY = 'INR';
const REGION = 'asia-south1';

// Secrets: `firebase functions:secrets:set NAME`. Set a value of "none" to disable an optional integration.
const secrets = {
    RAZORPAY_KEY_ID: defineSecret('RAZORPAY_KEY_ID'),
    RAZORPAY_KEY_SECRET: defineSecret('RAZORPAY_KEY_SECRET'),
    RAZORPAY_WEBHOOK_SECRET: defineSecret('RAZORPAY_WEBHOOK_SECRET'),
    META_CAPI_TOKEN: defineSecret('META_CAPI_TOKEN'),
    GMAIL_APP_PASSWORD: defineSecret('GMAIL_APP_PASSWORD'),
    CALENDLY_TOKEN: defineSecret('CALENDLY_TOKEN'),
};

// Non-secret params (functions/.env). Defaults keep deploys zero-config.
const params = {
    ADMIN_EMAIL: defineString('ADMIN_EMAIL', { default: 'jaikumar1240@gmail.com' }),
    META_PIXEL_ID: defineString('META_PIXEL_ID', { default: '1145272234680051' }),
    META_TEST_EVENT_CODE: defineString('META_TEST_EVENT_CODE', { default: '' }),
    CALENDLY_URL: defineString('CALENDLY_URL', { default: 'https://calendly.com/jaikumar1240/debugyourcareer' }),
    SITE_URL: defineString('SITE_URL', { default: 'https://elevate-personality.web.app' }),
    WHATSAPP_NUMBER: defineString('WHATSAPP_NUMBER', { default: '917827981994' }),
};

/** Reads a secret, treating unset / "none" as disabled. */
function secretValue(secret) {
    try {
        const v = (secret.value() || '').trim();
        return v && v.toLowerCase() !== 'none' ? v : '';
    } catch {
        return '';
    }
}

module.exports = { PLANS, CURRENCY, REGION, secrets, params, secretValue };
