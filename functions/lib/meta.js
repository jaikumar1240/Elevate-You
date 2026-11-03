'use strict';

const crypto = require('crypto');
const logger = require('firebase-functions/logger');

const GRAPH_VERSION = 'v21.0';

const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

/**
 * Builds Meta CAPI user_data. PII is SHA-256 hashed as Meta requires;
 * fbp/fbc/IP/UA are sent raw.
 */
function buildUserData(lead) {
    const [fn, ...rest] = (lead.name || '').trim().split(/\s+/);
    const userData = {
        em: lead.email ? [sha256(lead.email)] : undefined,
        ph: lead.phone ? [sha256(`91${lead.phone}`)] : undefined,
        fn: fn ? [sha256(fn)] : undefined,
        ln: rest.length ? [sha256(rest.join(' '))] : undefined,
        country: [sha256('in')],
        external_id: lead.id ? [sha256(lead.id)] : undefined,
        client_ip_address: lead.client?.ip || undefined,
        client_user_agent: lead.client?.userAgent || undefined,
        fbp: lead.client?.fbp || undefined,
        fbc: lead.client?.fbc || undefined,
    };
    Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);
    return userData;
}

/**
 * Sends one server event to Meta. Never throws: analytics must not break the funnel.
 * `eventId` must equal the browser Pixel eventID so Meta deduplicates.
 */
async function sendMetaEvent({ pixelId, token, testEventCode, eventName, eventId, lead, customData, sourceUrl, eventTime }) {
    if (!pixelId || !token) return { skipped: true };
    const body = {
        data: [{
            event_name: eventName,
            event_time: eventTime ?? Math.floor(Date.now() / 1000),
            event_id: eventId,
            action_source: 'website',
            event_source_url: sourceUrl,
            user_data: buildUserData(lead),
            custom_data: customData,
        }],
    };
    if (testEventCode) body.test_event_code = testEventCode;

    try {
        const res = await fetch(
            `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) {
            logger.warn('Meta CAPI error', { eventName, status: res.status, body: await res.text() });
            return { ok: false };
        }
        return { ok: true };
    } catch (err) {
        logger.warn('Meta CAPI request failed', { eventName, error: err.message });
        return { ok: false };
    }
}

module.exports = { sendMetaEvent, buildUserData, sha256 };
