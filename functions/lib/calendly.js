'use strict';

const logger = require('firebase-functions/logger');

const API = 'https://api.calendly.com';
let cachedEventType = null;

async function calendlyGet(path, token) {
    const res = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Calendly ${path} -> ${res.status}`);
    return res.json();
}

/** Finds the event type whose public scheduling URL matches `publicUrl`. */
async function findEventType(publicUrl, token) {
    if (cachedEventType?.publicUrl === publicUrl) return cachedEventType.uri;
    const me = await calendlyGet('/users/me', token);
    const list = await calendlyGet(`/event_types?user=${encodeURIComponent(me.resource.uri)}&count=100`, token);
    const norm = (u) => u.replace(/\/+$/, '').toLowerCase();
    const match = list.collection.find((et) => norm(et.scheduling_url) === norm(publicUrl));
    if (!match) throw new Error(`No Calendly event type matches ${publicUrl}`);
    cachedEventType = { publicUrl, uri: match.uri };
    return match.uri;
}

/**
 * Returns a booking URL for a paid lead. Uses a single-use Calendly link when a
 * token is configured (so the link can't be shared), otherwise the public URL.
 */
async function createBookingUrl({ publicUrl, token }) {
    if (!token) return publicUrl;
    try {
        const owner = await findEventType(publicUrl, token);
        const res = await fetch(`${API}/scheduling_links`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ max_event_count: 1, owner, owner_type: 'EventType' }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`scheduling_links -> ${res.status}`);
        const json = await res.json();
        return json.resource.booking_url;
    } catch (err) {
        logger.warn('Falling back to public Calendly URL', { error: err.message });
        return publicUrl;
    }
}

module.exports = { createBookingUrl };
