'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('CRM shows per-payment booking and independent delivery states with escaped operational errors', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    assert.equal(vm.runInContext('typeof bookingDetails', context), 'function');
    vm.runInContext(`payments = [{
        id: 'pay_old', leadId: 'lead', bookingSyncState: 'confirmed', bookedAt: new Date(),
        metaDelivery: { state: 'accepted' }, ga4Delivery: { state: 'ambiguous', reason: '<script>bad</script>' }
    }];`, context);
    const markup = vm.runInContext("bookingDetails({ id: 'lead' })", context);
    assert.match(markup, /Initial booking confirmed/);
    assert.match(markup, /Meta: accepted/);
    assert.match(markup, /GA4: ambiguous/);
    assert.doesNotMatch(markup, /<script>/);
    assert.match(markup, /&lt;script&gt;/);
});

test('CRM flags conversions held because a booking is not API-confirmed', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    vm.runInContext(`payments = [{
        id: 'pay_old', leadId: 'lead', bookingSyncState: 'pending',
        conversionError: 'unconfirmed_booking'
    }];`, context);
    const markup = vm.runInContext("bookingDetails({ id: 'lead' })", context);
    assert.match(markup, /Conversion review: unconfirmed_booking/);
});

test('CRM shows an escaped retry error alongside an unresolved booking review', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    vm.runInContext(`payments = [{
        id: 'pay_old', leadId: 'lead', bookingSyncState: 'review',
        bookingSyncError: 'ambiguous_match', bookingSyncRetryError: '<script>retry</script>'
    }];`, context);
    const markup = vm.runInContext("bookingDetails({ id: 'lead' })", context);
    assert.match(markup, /Booking sync: review \(ambiguous_match\)/);
    assert.match(markup, /Retry error: &lt;script&gt;retry&lt;\/script&gt;/);
    assert.doesNotMatch(markup, /<script>/);
});

test('CRM timeline presents readable events in chronological order', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    const markup = vm.runInContext(`row({
        id: 'lead', name: 'Test', planName: 'Diagnosis Session',
        history: [
            { type: 'paid', at: '2026-11-03T08:24:26Z', amount: 89 },
            { type: 'form_submitted', at: '2026-11-03T08:22:05Z' },
            { type: 'checkout_opened', at: '2026-11-03T08:23:15Z' }
        ]
    })`, context);

    assert.match(markup, /Activity timeline/);
    assert.match(markup, /newest first/i);
    assert.ok(markup.indexOf('Payment received') < markup.indexOf('Checkout opened'));
    assert.ok(markup.indexOf('Checkout opened') < markup.indexOf('Lead form submitted'));
    assert.match(markup, /₹89/);
});

test('CRM timeline distinguishes events in the same minute with precise accessible timestamps', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    const markup = vm.runInContext(`timelineDetails({ history: [
        { type: 'checkout_opened', at: '2026-11-03T08:24:15Z' },
        { type: 'paid', at: '2026-11-03T08:24:26Z', amount: 89 }
    ] })`, context);

    assert.match(markup, /datetime="2026-11-03T08:24:26\.000Z"/);
    assert.match(markup, /datetime="2026-11-03T08:24:15\.000Z"/);
    assert.match(markup, /2026[^<]*:26/);
    assert.match(markup, /2026[^<]*:15/);
});

test('CRM timeline makes unknown event names readable and escapes their details', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    const markup = vm.runInContext(`timelineDetails({ history: [
        { type: 'manual_follow_up', at: '2026-11-03T08:24:15Z', reason: '<img src=x onerror=alert(1)>' }
    ] })`, context);

    assert.match(markup, /Manual follow up/);
    assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(markup, /<img/);
});

test('CRM timeline distinguishes an order amount from a received payment', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    const markup = vm.runInContext(`timelineDetails({ history: [
        { type: 'order_created', at: '2026-11-03T08:22:05Z', amount: 199 },
        { type: 'paid', at: '2026-11-03T08:24:26Z', amount: 89 }
    ] })`, context);

    assert.match(markup, /class="timeline-entry__amount">₹199/);
    assert.match(markup, /class="timeline-entry__amount timeline-entry__amount--paid">₹89/);
});

test('CRM timeline describes a reminder link click accurately', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);

    const markup = vm.runInContext(`timelineDetails({ history: [
        { type: 'reminder_clicked', at: '2026-11-03T08:24:15Z' }
    ] })`, context);
    assert.match(markup, /Reminder link clicked/);
    assert.doesNotMatch(markup, /reminder opened/i);
});

test('CRM timeline uses a singular count for one event', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);

    const markup = vm.runInContext(`timelineDetails({ history: [
        { type: 'form_submitted', at: '2026-11-03T08:24:15Z' }
    ] })`, context);
    assert.match(markup, /1 event · newest first/);
});

test('CRM timeline discloses when older events are not shown', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);

    const markup = vm.runInContext(`timelineDetails({ history: Array.from({ length: 14 }, (_, i) => ({
        type: 'event_' + i, at: new Date(Date.UTC(2026, 10, 3, 8, 24, i)).toISOString()
    })) })`, context);
    assert.match(markup, /12 of 14 events · newest first/);
    assert.equal((markup.match(/class="timeline-entry timeline-entry--/g) || []).length, 12);
    assert.doesNotMatch(markup, />Event 0</);
    assert.match(markup, />Event 13</);
});

test('CRM keeps expanded activity and booking panels open across live updates', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const rows = {
        details: [],
        addEventListener() {},
        set innerHTML(markup) {
            this.details = [];
            for (const [, id, content] of markup.matchAll(/<tr class="row" data-id="([^"]+)">([\s\S]*?)<\/tr>/g)) {
                for (const [, attrs] of content.matchAll(/<details([^>]*)>/g)) {
                    const section = attrs.match(/data-section="([^"]+)"/)?.[1];
                    this.details.push({
                        id,
                        kind: attrs.includes('timeline-details') ? 'timeline' : 'booking',
                        dataset: section ? { section } : {},
                        open: false,
                        closest: () => ({ dataset: { id } }),
                    });
                }
            }
        },
        querySelectorAll(selector) {
            return this.details.filter((detail) =>
                (!selector.includes('[data-section]') || detail.dataset.section) &&
                (!selector.includes('[open]') || detail.open));
        },
    };
    const elements = new Map([['rows', rows]]);
    const document = {
        activeElement: null,
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, { value: '', checked: false, classList: { toggle() {} } });
            return elements.get(id);
        },
    };
    const context = vm.createContext({ document });
    vm.runInContext(source, context);
    vm.runInContext(`leads = [
        { id: 'one', history: [{ type: 'form_submitted', at: '2026-11-03T08:24:15Z' }] },
        { id: 'two', history: [{ type: 'paid', at: '2026-11-03T08:24:26Z' }] }
    ];
    payments = [{ id: 'p1', leadId: 'one' }, { id: 'p2', leadId: 'two' }];
    render();`, context);
    const panel = (id, kind) => rows.details.find((detail) => detail.id === id && detail.kind === kind);
    panel('one', 'timeline').open = true;
    panel('two', 'booking').open = true;

    vm.runInContext('render()', context);
    assert.equal(panel('one', 'timeline').open, true);
    assert.equal(panel('one', 'booking').open, false);
    assert.equal(panel('two', 'timeline').open, false);
    assert.equal(panel('two', 'booking').open, true);
});

test('CRM timeline keeps a lead readable when history entries lack valid data', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);

    let markup;
    assert.doesNotThrow(() => {
        markup = vm.runInContext(`(() => {
            const lead = { id: 'one', history: [
                null,
                { type: 'paid', at: 'invalid timestamp', amount: 89 },
                { type: 'checkout_opened', at: '2026-11-03T08:24:15Z' }
            ] };
            renderKpis([lead]);
            return row(lead);
        })()`, context);
    });
    assert.match(markup, /Checkout opened/);
    assert.match(markup, /Payment received/);
    assert.match(markup, />Activity</);
    assert.equal((markup.match(/Time unavailable/g) || []).length, 2);
    assert.ok(markup.indexOf('Checkout opened') < markup.indexOf('Payment received'));
});

test('CRM timeline does not present legacy bookings as API-confirmed', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
    vm.runInContext(source, context);
    vm.runInContext(`payments = [
        { id: 'legacy', leadId: 'lead', bookedAt: new Date(), bookingSyncState: 'review' },
        { id: 'verified', leadId: 'lead', bookingSyncState: 'confirmed' }
    ];`, context);

    const markup = vm.runInContext(`timelineDetails({ id: 'lead', history: [
        { type: 'booked', paymentId: 'legacy', at: '2026-11-03T08:24:15Z' },
        { type: 'booked', paymentId: 'verified', at: '2026-11-03T08:25:15Z' },
        { type: 'booked', paymentId: 'missing', at: '2026-11-03T08:26:15Z' }
    ] })`, context);
    const items = markup.match(/<li class="timeline-entry[\s\S]*?<\/li>/g);
    assert.match(items.find((item) => item.includes('Initial booking confirmed')) || '', /timeline-entry--success/);
    assert.match(items.find((item) => item.includes('Booking recorded (not API-verified)')) || '', /timeline-entry--default/);
    assert.match(items.find((item) => item.includes('Booking recorded (verification unavailable)')) || '', /timeline-entry--default/);
});
