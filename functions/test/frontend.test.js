'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

function browser(deferTimers = false) {
    const navigations = [];
    const elements = new Map();
    const storage = new Map();
    const listeners = new Map();
    const documentListeners = new Map();
    const timers = new Map();
    let timerId = 0;
    const context = {
        URL, URLSearchParams, console,
        setTimeout: (callback) => {
            const id = ++timerId;
            if (deferTimers) timers.set(id, callback); else callback();
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        requestAnimationFrame: (callback) => callback(),
        localStorage: {
            getItem: (key) => storage.get(key),
            setItem: (key, value) => storage.set(key, value),
            removeItem: (key) => storage.delete(key),
        },
        document: {
            addEventListener: (type, callback) => documentListeners.set(type, callback),
            querySelectorAll: () => [],
            body: { classList: { add() {} } },
            getElementById: (id) => {
                if (!elements.has(id)) elements.set(id, { hidden: true, scrollIntoView() {}, addEventListener() {}, querySelectorAll: () => [] });
                return elements.get(id);
            },
        },
        window: { location: { assign: (url) => navigations.push(url) }, open() {}, addEventListener: (type, callback) => listeners.set(type, callback) },
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nglobalThis.funnel = LeadFunnel; globalThis.buildUrl = buildCalendlyUrl;`, context);
    return { context, navigations, elements, storage, listeners, documentListeners, timers };
}

const booking = {
    leadId: '919876543210', paymentId: 'pay_1',
    plan: { id: 'mock', name: 'Mock Interview', price: 349 },
    bookingUrl: 'https://calendly.com/x/y?utm_term=opaque-reference',
    prefill: { name: 'Asha & Verma', email: 'asha+career@example.com', contact: '+919876543210' },
};

test('fresh paid transition opens same-tab Calendly; returning stays manual without an embed', () => {
    const { context, navigations, elements } = browser();
    context.funnel.showBooking(booking, { autoNavigate: true });
    assert.equal(navigations.length, 1);
    const url = new URL(navigations[0]);
    assert.equal(url.searchParams.get('utm_term'), 'opaque-reference');
    assert.equal(url.searchParams.get('name'), booking.prefill.name);
    assert.equal(url.searchParams.get('email'), booking.prefill.email);
    context.funnel.showBooking(booking);
    assert.equal(navigations.length, 1);
    assert.equal(elements.get('calendly-direct-link').href, url.toString());
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /calendly-inline-widget|assets\.calendly\.com/);
    assert.doesNotMatch(source, /window\.open|initInlineWidget|onCalendlyMessage|metaEvent\('Schedule'|gaEvent\('schedule'/);
});

test('returning customers see API-confirmed bookings without clearing a newer pending payment', async () => {
    const { context, storage, elements, navigations } = browser();
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    context.fetch = async () => ({ ok: true, json: async () => ({ booked: true }) });
    await context.funnel.resumePendingBooking();
    assert.match(elements.get('booking-status-title')?.textContent || '', /booking is confirmed/i);
    assert.equal(storage.has('dyc.pendingBooking'), false);
    assert.equal(elements.get('calendly-direct-link').hidden, true);
    assert.match(elements.get('booking-next-copy')?.textContent || '', /check your email/i);
    assert.equal(navigations.length, 0);

    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    context.fetch = async () => {
        storage.set('dyc.pendingBooking', JSON.stringify({ ...booking, paymentId: 'pay_newer' }));
        return { ok: true, json: async () => ({ booked: true }) };
    };
    await context.funnel.resumePendingBooking();
    assert.equal(JSON.parse(storage.get('dyc.pendingBooking')).paymentId, 'pay_newer');
});

test('a pending booking becomes confirmed automatically after Calendly sync without a refresh', async () => {
    const { context, storage, elements, navigations, timers } = browser(true);
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    let checks = 0;
    context.fetch = async () => ({
        ok: true,
        json: async () => ++checks === 1 ? { ...booking, booked: false } : { booked: true },
    });

    await context.funnel.resumePendingBooking();
    assert.equal(checks, 1);
    assert.equal(timers.size, 1, 'A pending booking should schedule another status check');
    const [timerId, recheck] = timers.entries().next().value;
    timers.delete(timerId);
    await recheck();

    assert.equal(checks, 2);
    assert.match(elements.get('booking-status-title').textContent, /booking is confirmed/i);
    assert.equal(elements.get('calendly-direct-link').hidden, true);
    assert.equal(storage.has('dyc.pendingBooking'), false);
    assert.equal(timers.size, 0);
    assert.equal(navigations.length, 0);
});

test('background booking checks do not scroll or repeat analytics while waiting', async () => {
    const { context, storage, elements, timers } = browser(true);
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    let views = 0;
    let scrolls = 0;
    context.window.gtag = (command, name) => { if (name === 'booking_view') views++; };
    context.document.getElementById('booking-success').scrollIntoView = () => { scrolls++; };
    context.fetch = async () => ({ ok: true, json: async () => ({ ...booking, booked: false }) });
    await context.funnel.resumePendingBooking();
    const initialViews = views;
    const initialScrolls = scrolls;

    const [timerId, recheck] = timers.entries().next().value;
    timers.delete(timerId);
    await recheck();
    assert.equal(views, initialViews);
    assert.equal(scrolls, initialScrolls);
    assert.equal(elements.get('calendly-direct-link').hidden, false);
    assert.equal(timers.size, 1);
});

test('a returned payment awaiting sync does not tell an already-booked customer to book again', async () => {
    const { context, storage, elements } = browser(true);
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    context.fetch = async () => ({ ok: true, json: async () => ({ ...booking, booked: false }) });
    await context.funnel.resumePendingBooking();
    assert.equal(elements.get('booking-status-title').textContent, 'Your payment is confirmed.');
    assert.match(elements.get('calendly-setup-note').textContent, /already booked\? do not book again/i);
    assert.match(elements.get('calendly-setup-note').textContent, /checks.*automatically/i);
    assert.equal(elements.get('calendly-direct-link').hidden, false);
});

test('an API-confirmed booking remains visible after a page refresh', async () => {
    const initial = browser(true);
    initial.storage.set('dyc.pendingBooking', JSON.stringify(booking));
    initial.context.fetch = async () => ({ ok: true, json: async () => ({ booked: true }) });
    await initial.context.funnel.resumePendingBooking();

    const refreshed = browser(true);
    for (const [key, value] of initial.storage) refreshed.storage.set(key, value);
    await refreshed.context.funnel.resumePendingBooking();

    assert.match(refreshed.elements.get('booking-status-title')?.textContent || '', /booking is confirmed/i);
    assert.equal(refreshed.elements.get('calendly-direct-link').hidden, true);
    assert.equal(refreshed.storage.has('dyc.pendingBooking'), false);
    assert.equal(refreshed.navigations.length, 0);
});

test('a failed confirmed-receipt save retains the paid state for a later recheck', async () => {
    const { context, storage, elements } = browser(true);
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    context.localStorage.setItem = () => { throw new Error('Storage quota reached'); };
    context.fetch = async () => ({ ok: true, json: async () => ({ booked: true }) });
    await context.funnel.resumePendingBooking();
    assert.match(elements.get('booking-status-title').textContent, /booking is confirmed/i);
    assert.equal(storage.has('dyc.pendingBooking'), true, 'Keep the paid state when the receipt cannot be saved');
    assert.equal(JSON.parse(storage.get('dyc.pendingBooking')).paymentId, booking.paymentId);
});

test('a legacy booking under review never offers a duplicate scheduling link', async () => {
    const { context, storage, elements, navigations } = browser();
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    let respond;
    context.fetch = () => new Promise((resolve) => { respond = resolve; });
    const checking = context.funnel.resumePendingBooking();
    const hiddenDuringCheck = elements.get('calendly-direct-link').hidden;
    respond({ ok: true, json: async () => ({ booked: false, review: true }) });
    await checking;
    assert.equal(hiddenDuringCheck, true);
    assert.equal(elements.get('calendly-direct-link').hidden, true);
    assert.match(elements.get('booking-status-title').textContent, /booking needs a quick review/i);
    assert.match(elements.get('booking-next-copy').textContent, /check your email/i);
    assert.match(elements.get('calendly-setup-note').textContent, /whatsapp.*do not pay again/i);
    assert.equal(storage.has('dyc.pendingBooking'), true);
    assert.equal(navigations.length, 0);
});

test('ambiguous booking review explains the issue and updates when the server confirms it', async () => {
    const { context, storage, elements, timers } = browser(true);
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    let checks = 0;
    context.fetch = async () => ({
        ok: true,
        json: async () => ++checks === 1
            ? { booked: false, review: true, reviewReason: 'ambiguous_match' }
            : { booked: true },
    });

    await context.funnel.resumePendingBooking();
    assert.equal(elements.get('calendly-direct-link').hidden, true);
    assert.match(elements.get('calendly-setup-note').textContent, /multiple.*booking/i);
    assert.match(elements.get('calendly-setup-note').textContent, /do not book or pay again/i);
    assert.equal(timers.size, 1);
    const [timerId, recheck] = timers.entries().next().value;
    timers.delete(timerId);
    await recheck();
    assert.match(elements.get('booking-status-title').textContent, /booking is confirmed/i);
    assert.equal(timers.size, 0);
});

test('a failed recheck cannot reopen scheduling after an ambiguous booking review', async () => {
    const { context, storage, elements, timers } = browser(true);
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    context.fetch = async () => ({
        ok: true, json: async () => ({ booked: false, review: true, reviewReason: 'ambiguous_match' }),
    });
    await context.funnel.resumePendingBooking();
    context.fetch = async () => { throw new Error('Network unavailable'); };
    const [timerId, recheck] = timers.entries().next().value;
    timers.delete(timerId);
    await recheck();
    assert.equal(elements.get('calendly-direct-link').hidden, true);
    assert.match(elements.get('booking-status-title').textContent, /review/i);
    assert.match(elements.get('calendly-setup-note').textContent, /could not recheck/i);
    assert.match(elements.get('calendly-setup-note').textContent, /do not book or pay again/i);
});

test('a failed older booking recheck cannot replace a newer payment screen', async () => {
    const { context, storage, elements } = browser();
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    const newer = { ...booking, paymentId: 'pay_newer', bookingUrl: 'https://calendly.com/x/y?utm_term=newer' };
    context.fetch = async () => {
        storage.set('dyc.pendingBooking', JSON.stringify(newer));
        context.funnel.showBooking(newer);
        throw new Error('Network unavailable');
    };
    await context.funnel.resumePendingBooking();
    assert.equal(new URL(elements.get('calendly-direct-link').href).searchParams.get('utm_term'), 'newer');
    assert.equal(JSON.parse(storage.get('dyc.pendingBooking')).paymentId, 'pay_newer');
});

test('booking navigation rejects unsafe destinations without losing the paid confirmation', () => {
    const { context, navigations, elements } = browser();
    for (const bookingUrl of ['https://evil.example/x', 'http://calendly.com/x', 'https://calendly.com:8443/x', 'https://user:pass@calendly.com/x', 'not a URL']) {
        assert.throws(() => context.buildUrl({ ...booking, bookingUrl }));
        context.funnel.showBooking({ ...booking, bookingUrl }, { autoNavigate: true });
        assert.equal(navigations.length, 0);
        assert.equal(elements.get('calendly-direct-link').hidden, true);
        assert.match(elements.get('calendly-setup-note').textContent, /do not pay again/i);
    }
});

test('Google metadata uses supported real tag identifiers and honors explicit opt-outs', () => {
    const { context } = browser();
    assert.equal(vm.runInContext('typeof captureGoogleIds', context), 'function');
    const requests = [];
    context.window.gtag = (command, stream, field, callback) => {
        requests.push([command, stream, field]);
        callback(field === 'client_id' ? '123.456' : '789');
    };
    const metadata = vm.runInContext('captureGoogleIds(); googleMetadata()', context);
    assert.equal(metadata.clientId, '123.456');
    assert.equal(metadata.sessionId, '789');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(([command, stream]) => command === 'get' && stream === 'G-TQDPKWBBW0'));
    context.window['ga-disable-G-TQDPKWBBW0'] = true;
    const denied = vm.runInContext('googleMetadata()', context);
    assert.equal(denied.analyticsStorage, 'DENIED');
    assert.equal(denied.clientId, undefined);
});

test('browser Back cancels a pending redirect and rechecks booking without navigating again', () => {
    const { context, navigations, listeners, timers } = browser(true);
    context.funnel.init();
    context.funnel.showBooking(booking, { autoNavigate: true });
    assert.equal(timers.size, 1);
    assert.equal(typeof listeners.get('pagehide'), 'function');
    listeners.get('pagehide')();
    assert.equal(timers.size, 0);
    let checks = 0;
    context.funnel.resumePendingBooking = () => { checks++; };
    listeners.get('pageshow')({ persisted: true });
    assert.equal(checks, 1);
    assert.equal(navigations.length, 0);
});

test('leaving the page stops booking polling even if an in-flight check finishes later', async () => {
    const { context, storage, listeners, timers } = browser(true);
    context.funnel.init();
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    let respond;
    context.fetch = () => new Promise((resolve) => { respond = resolve; });
    const checking = context.funnel.resumePendingBooking();
    listeners.get('pagehide')();
    respond({ ok: true, json: async () => ({ ...booking, booked: false }) });
    await checking;
    assert.equal(timers.size, 0);
});

test('booking polling pauses in a hidden tab and checks again when the tab becomes visible', async () => {
    const { context, storage, documentListeners, timers } = browser(true);
    context.funnel.init();
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    let checks = 0;
    context.fetch = async () => {
        checks++;
        return { ok: true, json: async () => ({ ...booking, booked: false }) };
    };
    await context.funnel.resumePendingBooking();
    assert.equal(timers.size, 1);
    const visibilityChanged = documentListeners.get('visibilitychange');
    assert.equal(typeof visibilityChanged, 'function');
    context.document.hidden = true;
    await visibilityChanged();
    assert.equal(timers.size, 0);
    context.document.hidden = false;
    await visibilityChanged();
    assert.equal(checks, 2);
    assert.equal(timers.size, 1);
});

test('overlapping booking rechecks share one in-flight request per payment', async () => {
    const { context, storage, timers } = browser(true);
    storage.set('dyc.pendingBooking', JSON.stringify(booking));
    const responses = [];
    context.fetch = () => new Promise((resolve) => responses.push(resolve));
    const first = context.funnel.resumePendingBooking();
    const second = context.funnel.resumePendingBooking();
    const requests = responses.length;
    for (const respond of responses) respond({ ok: true, json: async () => ({ ...booking, booked: false }) });
    await Promise.all([first, second]);
    assert.equal(requests, 1);
    assert.equal(timers.size, 1);
});

test('only server-verified payment opens booking, even when browser storage is unavailable', async () => {
    for (const verified of [true, false]) {
        const { context, navigations } = browser();
        context.funnel.lead = { leadId: booking.leadId, prefill: { email: 'outdated@example.com' } };
        context.funnel.showView = () => {};
        context.funnel.close = () => {};
        let retries = 0;
        context.funnel.showRetry = () => { retries++; };
        context.localStorage.setItem = () => { throw new Error('Storage disabled'); };
        context.fetch = async () => ({
            ok: verified, status: verified ? 200 : 400,
            json: async () => verified ? { ...booking, purchaseEventId: 'purchase_pay_1' } : { error: 'Bad signature' },
        });
        await context.funnel.verify({});
        assert.equal(navigations.length, verified ? 1 : 0);
        assert.equal(retries, verified ? 0 : 1);
        if (verified) assert.equal(new URL(navigations[0]).searchParams.get('email'), booking.prefill.email);
    }
});

test('re-verifying an existing booking shows its state without reopening Calendly', async () => {
    for (const [result, title] of [
        [{ booked: true }, /booking is confirmed/i],
        [{ booked: false, review: true }, /booking needs a quick review/i],
    ]) {
        const { context, storage, navigations, elements } = browser();
        storage.set('dyc.pendingBooking', JSON.stringify(booking));
        context.funnel.lead = { leadId: booking.leadId, prefill: booking.prefill };
        context.funnel.showView = () => {};
        context.funnel.close = () => {};
        context.fetch = async () => ({
            ok: true, json: async () => ({ ...result, plan: booking.plan, paymentId: booking.paymentId }),
        });
        await context.funnel.verify({});
        assert.equal(navigations.length, 0);
        assert.equal(elements.get('calendly-direct-link').hidden, true);
        assert.match(elements.get('booking-status-title').textContent, title);
        assert.equal(storage.has('dyc.pendingBooking'), !result.booked);
    }
});

test('a booking confirmed during payment verification also survives refresh', async () => {
    const initial = browser(true);
    initial.storage.set('dyc.pendingBooking', JSON.stringify(booking));
    initial.context.funnel.lead = { leadId: booking.leadId, prefill: booking.prefill };
    initial.context.funnel.showView = () => {};
    initial.context.funnel.close = () => {};
    initial.context.fetch = async () => ({
        ok: true, json: async () => ({ booked: true, plan: booking.plan, paymentId: booking.paymentId }),
    });
    await initial.context.funnel.verify({});
    const refreshed = browser(true);
    for (const [key, value] of initial.storage) refreshed.storage.set(key, value);
    await refreshed.context.funnel.resumePendingBooking();
    assert.match(refreshed.elements.get('booking-status-title')?.textContent || '', /booking is confirmed/i);
    const receipt = JSON.parse(refreshed.storage.get('dyc.confirmedBooking'));
    assert.equal(receipt.prefill, undefined);
    assert.equal(receipt.bookingUrl, undefined);
});

test('payment verification returning ambiguity keeps automatic review checks active', async () => {
    const { context, storage, timers, elements } = browser(true);
    context.funnel.lead = { leadId: booking.leadId, prefill: booking.prefill };
    context.funnel.showView = () => {};
    context.funnel.close = () => {};
    let checks = 0;
    context.fetch = async () => ({
        ok: true, json: async () => ++checks === 1
            ? { booked: false, review: true, reviewReason: 'ambiguous_match', plan: booking.plan, paymentId: booking.paymentId }
            : { booked: true },
    });
    await context.funnel.verify({});
    assert.equal(JSON.parse(storage.get('dyc.pendingBooking')).review, true);
    assert.equal(timers.size, 1);
    const [timerId, recheck] = timers.entries().next().value;
    timers.delete(timerId);
    await recheck();
    assert.match(elements.get('booking-status-title').textContent, /booking is confirmed/i);
});

test('compact paid confirmation omits redundant step panels above the booking action', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.equal(/class="booking-success__step"/.test(html), false, 'Redundant step panels must be absent');
});

test('the booking-return fix uses a newer script revision than the deployed v6', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const revision = html.match(/src="script\.js\?v=(\d+)"/);
    assert.ok(revision && Number(revision[1]) >= 7, 'Use a new asset revision so browsers do not retain the old return flow');
});
