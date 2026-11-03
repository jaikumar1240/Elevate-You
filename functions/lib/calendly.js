'use strict';

const logger = require('firebase-functions/logger');

const API = 'https://api.calendly.com';
let cachedEventType = null;

async function calendlyGet(path, token, fetchImpl = fetch) {
    const res = await fetchImpl(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
    });
    if (!res.ok) {
        const retry = res.headers?.get('retry-after');
        const retryAfterMs = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
        throw Object.assign(new Error('Calendly read failed'), { code: `calendly_${res.status}`, retryAfterMs });
    }
    return res.json();
}

function createCalendlyReader({ token, publicUrl, maxRequests = 50, fetchImpl = fetch }) {
    let remaining = Math.min(50, maxRequests);
    let identity;
    const pageToken = (value) => {
        if (value != null && (typeof value !== 'string' || value.length > 2000 || /[\x00-\x20\x7f]/.test(value))) {
            throw Object.assign(new Error('Invalid pagination'), { code: 'invalid_pagination' });
        }
        return value || '';
    };
    const uriPath = (uri, pattern) => {
        const url = new URL(uri);
        if (url.origin !== API || url.username || url.password || url.search || url.hash || !pattern.test(url.pathname)) {
            throw Object.assign(new Error('Invalid Calendly URI'), { code: 'invalid_response' });
        }
        return url.pathname;
    };
    const get = async (path, query) => {
        if (remaining <= 0) throw Object.assign(new Error('Request budget exhausted'), { code: 'request_budget' });
        remaining--;
        const params = new URLSearchParams(Object.entries(query || {}).filter(([, value]) => value != null && value !== ''));
        return calendlyGet(`${path}${params.size ? `?${params}` : ''}`, token, fetchImpl);
    };
    const list = async (path, query) => {
        const result = await get(path, { ...query, count: 100 });
        if (!Array.isArray(result.collection) || result.collection.length > 100) {
            throw Object.assign(new Error('Invalid Calendly page'), { code: 'invalid_response' });
        }
        pageToken(result.pagination?.next_page_token);
        return result;
    };
    const resource = async (path) => {
        const result = await get(path);
        if (!result.resource || typeof result.resource !== 'object' || Array.isArray(result.resource)) {
            throw Object.assign(new Error('Invalid Calendly resource'), { code: 'invalid_response' });
        }
        return result.resource;
    };
    return {
        get remaining() { return remaining; },
        async identity() {
            if (identity) return identity;
            const me = await get('/users/me');
            uriPath(me.resource?.uri, /^\/users\/[A-Za-z0-9-]+$/);
            let next;
            do {
                const types = await list('/event_types', { user: me.resource.uri, page_token: next });
                const norm = (url) => new URL(url).href.replace(/\/+$/, '').toLowerCase();
                const found = types.collection.find((type) => norm(type.scheduling_url) === norm(publicUrl));
                if (found) {
                    uriPath(found.uri, /^\/event_types\/[A-Za-z0-9-]+$/);
                    identity = { userUri: me.resource.uri, eventTypeUri: found.uri };
                    return identity;
                }
                next = pageToken(types.pagination?.next_page_token);
            } while (next);
            throw Object.assign(new Error('Configured event type not found'), { code: 'event_type_missing' });
        },
        async events({ user, email, minStart, pageToken: next }) {
            return list('/scheduled_events', {
                user, invitee_email: email, min_start_time: minStart, status: 'active', sort: 'start_time:asc', page_token: pageToken(next),
            });
        },
        async invitees(eventUri, { email, pageToken: next }) {
            const path = uriPath(eventUri, /^\/scheduled_events\/[A-Za-z0-9-]+$/);
            return list(`${path}/invitees`, { email, status: 'active', sort: 'created_at:asc', page_token: pageToken(next) });
        },
        async getEvent(eventUri) {
            return resource(uriPath(eventUri, /^\/scheduled_events\/[A-Za-z0-9-]+$/));
        },
        async getInvitee(inviteeUri) {
            return resource(uriPath(inviteeUri, /^\/scheduled_events\/[A-Za-z0-9-]+\/invitees\/[A-Za-z0-9-]+$/));
        },
    };
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

module.exports = { createBookingUrl, createCalendlyReader };
