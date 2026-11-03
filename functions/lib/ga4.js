'use strict';

async function sendGa4Booking({ measurementId, apiSecret, payment, now = Date.now, fetchImpl = fetch, validateOnly = false, debugMode = false }) {
    const analytics = payment.analytics || {};
    const bookedAt = payment.bookedAt?.toMillis ? payment.bookedAt.toMillis() : new Date(payment.bookedAt).getTime();
    if (analytics.analyticsStorage === 'DENIED') return { state: 'skipped', reason: 'analytics_denied' };
    if (!/^\d{1,20}\.\d{1,20}$/.test(analytics.clientId || '')) return { state: 'skipped', reason: 'missing_client_id' };
    if (!Number.isFinite(bookedAt) || bookedAt > now() || now() - bookedAt > 72 * 3600_000) {
        return { state: 'skipped', reason: 'timestamp_out_of_window' };
    }
    if (!measurementId || !apiSecret) return { state: 'blocked', reason: 'missing_credentials' };
    const params = { event_id: `schedule_${payment.id}`, plan_id: payment.planId, engagement_time_msec: 1 };
    if (debugMode) params.debug_mode = true;
    const session = Number(analytics.sessionId);
    if (Number.isSafeInteger(session) && session > 0 && now() - session * 1000 < 86400_000 && bookedAt >= session * 1000) {
        params.session_id = session;
    }
    const body = {
        client_id: analytics.clientId,
        timestamp_micros: bookedAt * 1000,
        events: [{ name: 'schedule', params }],
    };
    const consent = {};
    for (const [source, target] of [['adUserData', 'ad_user_data'], ['adPersonalization', 'ad_personalization']]) {
        if (['GRANTED', 'DENIED'].includes(analytics[source])) consent[target] = analytics[source];
    }
    if (Object.keys(consent).length) body.consent = consent;
    if (validateOnly) body.validation_behavior = 'ENFORCE_RECOMMENDATIONS';
    try {
        const url = new URL(validateOnly ? 'https://www.google-analytics.com/debug/mp/collect' : 'https://www.google-analytics.com/mp/collect');
        url.searchParams.set('measurement_id', measurementId);
        url.searchParams.set('api_secret', apiSecret);
        const res = await fetchImpl(url.toString(), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error',
        });
        if (!res.ok) return { state: res.status >= 500 ? 'ambiguous' : 'rejected', reason: `http_${res.status}` };
        if (validateOnly) {
            const validation = await res.json();
            return Array.isArray(validation.validationMessages) && validation.validationMessages.length === 0
                ? { state: 'validated' } : { state: 'rejected', reason: 'validation_failed' };
        }
        return { state: 'accepted' };
    } catch {
        // The request may have been accepted before the connection failed.
        return { state: 'ambiguous', reason: 'network_error' };
    }
}

module.exports = { sendGa4Booking };
