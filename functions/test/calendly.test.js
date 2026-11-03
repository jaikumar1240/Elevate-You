'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCalendlyReader } = require('../lib/calendly');

test('Calendly reader enforces fixed-origin paginated reads and a shared request ceiling', async () => {
    assert.equal(typeof createCalendlyReader, 'function');
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url: new URL(url), options });
        const pathname = new URL(url).pathname;
        const body = pathname === '/users/me'
            ? { resource: { uri: 'https://api.calendly.com/users/user1' } }
            : pathname === '/event_types'
                ? { collection: [{ scheduling_url: 'https://calendly.com/x/y', uri: 'https://api.calendly.com/event_types/type1' }], pagination: {} }
                : { collection: [], pagination: { next_page_token: 'next-page' } };
        return { ok: true, json: async () => body };
    };
    const api = createCalendlyReader({ token: 'private', publicUrl: 'https://calendly.com/x/y', maxRequests: 4, fetchImpl });
    const identity = await api.identity();
    assert.equal(identity.eventTypeUri, 'https://api.calendly.com/event_types/type1');
    const page = await api.events({ user: identity.userUri, email: 'asha+career@example.com', minStart: '2026-11-03T09:00:00Z', pageToken: 'next+page' });
    assert.equal(page.pagination.next_page_token, 'next-page');
    await api.invitees('https://api.calendly.com/scheduled_events/event1', { email: 'asha+career@example.com' });
    assert.equal(calls[2].url.searchParams.get('invitee_email'), 'asha+career@example.com');
    assert.equal(calls[2].url.searchParams.get('page_token'), 'next+page');
    assert.ok(calls.every(({ url, options }) => url.origin === 'https://api.calendly.com' && options.redirect === 'error'));
    await assert.rejects(api.invitees('https://evil.example/scheduled_events/event1', {}));
    await assert.rejects(api.events({ pageToken: 'bad\n' }));
    await assert.rejects(api.events({}), { code: 'request_budget' });
    assert.equal(calls.length, 4);
});

test('Calendly HTTP rate-limit errors expose only sanitized status and retry timing', async () => {
    const api = createCalendlyReader({
        token: 'private-token', publicUrl: 'https://calendly.com/x/y',
        fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '3600' } }),
    });
    await assert.rejects(api.identity(), (error) => {
        assert.equal(error.code, 'calendly_429');
        assert.equal(error.retryAfterMs, 3600_000);
        assert.doesNotMatch(error.message, /private-token|asha/);
        return true;
    });
});
