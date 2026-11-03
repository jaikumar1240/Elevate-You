'use strict';

const LEAD_STATUSES = ['1st-2nd-year', '3rd-year', 'final-year', 'graduate', 'working', ''];
const ATTRIBUTION_KEYS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'fbclid', 'gclid', 'landing_page', 'referrer',
];

function clean(value, max = 200) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Normalises Indian mobile numbers to 10 digits; returns '' if invalid. */
function normalizePhone(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return /^[6-9]\d{9}$/.test(digits) ? digits : '';
}

function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

/** Validates the lead form payload. Returns { errors, lead }. */
function validateLead(body = {}) {
    const errors = {};
    const name = clean(body.name, 80);
    const phone = normalizePhone(body.phone);
    const email = clean(body.email, 254).toLowerCase();
    const currentStatus = LEAD_STATUSES.includes(body.currentStatus) ? body.currentStatus : '';

    if (name.length < 2) errors.name = 'Please enter your name';
    if (!phone) errors.phone = 'Enter a valid 10-digit mobile number';
    if (!isEmail(email)) errors.email = 'Enter a valid email address';
    if (body.consent !== true) errors.consent = 'Please accept to continue';

    const attribution = {};
    const src = body.attribution && typeof body.attribution === 'object' ? body.attribution : {};
    for (const key of ATTRIBUTION_KEYS) {
        const v = clean(src[key], 500);
        if (v) attribution[key] = v;
    }
    const analytics = {};
    const ids = body.analytics || {};
    if (typeof ids.clientId === 'string' && /^\d{1,20}\.\d{1,20}$/.test(ids.clientId)) analytics.clientId = ids.clientId;
    if (typeof ids.sessionId === 'string' && /^\d{1,20}$/.test(ids.sessionId)) analytics.sessionId = ids.sessionId;
    for (const key of ['analyticsStorage', 'adUserData', 'adPersonalization']) {
        if (['GRANTED', 'DENIED'].includes(ids[key])) analytics[key] = ids[key];
    }

    return {
        errors,
        lead: { name, phone, email, currentStatus, attribution, analytics },
    };
}

/** Lead ids are derived from the phone number: "91XXXXXXXXXX". */
function isLeadId(id) {
    return typeof id === 'string' && /^91[6-9]\d{9}$/.test(id);
}

module.exports = { validateLead, normalizePhone, isEmail, isLeadId, clean, LEAD_STATUSES };
