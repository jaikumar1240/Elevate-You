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

function loadCrm(document = { getElementById: () => ({ addEventListener() {} }) }) {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+;$/gm, '').replace(/\s*initFilters\(\);\s*boot\(\);\s*$/, '');
    const context = vm.createContext({ document });
    vm.runInContext(source, context);
    return context;
}

test('CRM priority sort puts fresh uncontacted leads and paid-unbooked buyers ahead of closed leads', () => {
    const context = loadCrm();
    const order = vm.runInContext(`(() => {
        const now = new Date('2026-11-17T10:00:00Z');
        const ago = (min) => new Date(now.getTime() - min * 60000);
        return sortLeads([
            { id: 'closed', status: 'new', crmStatus: 'not_interested', createdAt: ago(1) },
            { id: 'later', status: 'new', crmStatus: 'contacted', contactAttempts: 1, nextFollowUp: '2026-11-30', createdAt: ago(2) },
            { id: 'booked', status: 'booked', crmStatus: 'converted', createdAt: ago(3) },
            { id: 'paid', status: 'paid', crmStatus: 'new', contactAttempts: 1, createdAt: ago(600) },
            { id: 'fresh', status: 'new', crmStatus: 'new', createdAt: ago(10) },
        ], 'priority', now).map((l) => l.id).join(',');
    })()`, context);
    assert.equal(order, 'fresh,paid,later,closed,booked');
});

test('CRM first contact attempt records response time, marks the lead contacted, and schedules a retry after no answer', () => {
    const context = loadCrm();
    const update = JSON.parse(vm.runInContext(`JSON.stringify(contactUpdate(
        { crmStatus: 'new' }, 'no_answer', new Date('2026-11-17T10:00:00Z')))`, context));
    assert.deepEqual(update, {
        contactAttempts: 1,
        lastContactOutcome: 'no_answer',
        lastContactedAt: '2026-11-17T10:00:00.000Z',
        firstContactedAt: '2026-11-17T10:00:00.000Z',
        crmStatus: 'contacted',
        nextFollowUp: '2026-11-18',
        contactLog: [{ type: 'contact_attempt', outcome: 'no_answer', at: '2026-11-17T10:00:00.000Z' }],
    });
});

test('CRM repeat contact attempt preserves first response, progressed status, and a later follow-up', () => {
    const context = loadCrm();
    const update = JSON.parse(vm.runInContext(`JSON.stringify(contactUpdate({
        crmStatus: 'interested', contactAttempts: 2, firstContactedAt: '2026-11-15T09:00:00.000Z', nextFollowUp: '2026-11-20',
        contactLog: [{ type: 'contact_attempt', outcome: 'no_answer', at: '2026-11-15T09:00:00.000Z' }],
    }, 'connected', new Date('2026-11-17T10:00:00Z')))`, context));
    assert.equal(update.contactAttempts, 3);
    assert.equal('firstContactedAt' in update, false);
    assert.equal('crmStatus' in update, false);
    assert.equal('nextFollowUp' in update, false);
    assert.equal(update.contactLog.length, 2);
    assert.equal(update.contactLog[1].outcome, 'connected');
});

test('CRM row flags an uncontacted lead with its waiting time and offers contact logging', () => {
    const context = loadCrm();
    const markup = vm.runInContext(`row({ id: 'lead', name: 'A', status: 'new', crmStatus: 'new',
        createdAt: new Date(Date.now() - 12 * 60000) })`, context);
    assert.match(markup, /class="speed speed--hot"[^>]*>Not contacted · waiting 12m</);
    for (const outcome of ['connected', 'no_answer', 'whatsapp']) assert.match(markup, new RegExp(`data-log="${outcome}"`));

    const contacted = vm.runInContext(`row({ id: 'lead', name: 'A', status: 'new', crmStatus: 'contacted',
        contactAttempts: 3, lastContactOutcome: 'no_answer', createdAt: new Date() })`, context);
    assert.match(contacted, /3 attempts · last: No answer/);
    assert.doesNotMatch(contacted, /Not contacted/);
});

test('CRM offers quick follow-up dates that roll over month boundaries', () => {
    const context = loadCrm();
    assert.equal(vm.runInContext(`addDays('2026-11-29', 3)`, context), '2026-12-02');
    const markup = vm.runInContext(`row({ id: 'lead', name: 'A', status: 'new' })`, context);
    for (const days of [1, 3, 7]) assert.match(markup, new RegExp(`data-followup="${days}"`));
});

test('CRM asks for a lost reason only when a lead is marked not interested', () => {
    const context = loadCrm();
    const lost = vm.runInContext(`row({ id: 'lead', name: 'A', status: 'new', crmStatus: 'not_interested', lostReason: 'price' })`, context);
    assert.match(lost, /<select data-field="lostReason"/);
    assert.match(lost, /<option value="price" selected>Price too high<\/option>/);

    const open = vm.runInContext(`row({ id: 'lead', name: 'A', status: 'new', crmStatus: 'interested' })`, context);
    assert.doesNotMatch(open, /data-field="lostReason"/);
});

test('CRM source report shows leads, buyers, conversion, and revenue per source and campaign', () => {
    const context = loadCrm();
    const report = JSON.parse(vm.runInContext(`JSON.stringify(sourceReport([
        { status: 'paid', totalPaid: 199, attribution: { utm_source: 'facebook', utm_campaign: 'resume' } },
        { status: 'new', attribution: { utm_source: 'facebook', utm_campaign: 'resume' } },
        { status: 'booked', totalPaid: 89, attribution: { utm_source: 'instagram', utm_campaign: 'content' } },
        { status: 'new' },
    ]))`, context));
    assert.deepEqual(report, [
        { source: 'facebook', campaign: 'resume', leads: 2, paid: 1, revenue: 199, rate: 50 },
        { source: 'instagram', campaign: 'content', leads: 1, paid: 1, revenue: 89, rate: 100 },
        { source: 'direct', campaign: '—', leads: 1, paid: 0, revenue: 0, rate: 0 },
    ]);
});

test('CRM source report table escapes attacker-controlled campaign names', () => {
    const context = loadCrm();
    const markup = vm.runInContext(`sourceReportMarkup([
        { status: 'paid', totalPaid: 199, attribution: { utm_source: 'facebook', utm_campaign: '<img src=x onerror=alert(1)>' } },
    ])`, context);
    assert.match(markup, /<td>facebook<\/td>/);
    assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, /₹199/);
    assert.match(markup, /100%/);
});

test('CRM response stats count uncontacted open leads and median first response time', () => {
    const context = loadCrm();
    const stats = JSON.parse(vm.runInContext(`JSON.stringify(responseStats([
        { status: 'new', createdAt: '2025-01-01T10:00:00Z', firstContactedAt: '2025-01-01T10:04:00Z' },
        { status: 'new', createdAt: '2025-01-01T10:00:00Z', firstContactedAt: '2025-01-01T11:00:00Z' },
        { status: 'paid', createdAt: '2025-01-01T10:00:00Z', firstContactedAt: '2025-01-01T10:10:00Z' },
        { status: 'new', createdAt: '2025-01-01T10:00:00Z' },
        { status: 'new', crmStatus: 'not_interested', createdAt: '2025-01-01T10:00:00Z' },
    ]))`, context));
    assert.deepEqual(stats, { waiting: 1, medianMinutes: 10, within5: 1, responded: 3 });
});

test('CRM KPI cards show leads waiting for first contact and median first response', () => {
    const kpis = {};
    const context = loadCrm({ getElementById: (id) => (id === 'kpis' ? kpis : { addEventListener() {} }) });
    vm.runInContext(`renderKpis([
        { status: 'new', createdAt: '2025-01-01T10:00:00Z', firstContactedAt: '2025-01-01T10:04:00Z', contactAttempts: 1 },
        { status: 'new', createdAt: '2025-01-01T10:00:00Z' },
    ])`, context);
    assert.match(kpis.innerHTML, /Not contacted yet<\/div><div class="kpi__value">1</);
    assert.match(kpis.innerHTML, /Median first response<\/div><div class="kpi__value">4m</);
    assert.match(kpis.innerHTML, /1 of 1 within 5 min/);
});

test('CRM timeline includes logged contact attempts alongside system history', () => {
    const context = loadCrm();
    const markup = vm.runInContext(`timelineDetails({
        id: 'lead',
        history: [{ type: 'lead_created', at: '2025-01-01T10:00:00Z' }],
        contactLog: [{ type: 'contact_attempt', outcome: 'no_answer', at: '2025-01-01T10:05:00Z' }],
    })`, context);
    assert.match(markup, /2 events/);
    assert.match(markup, /Contact attempt: No answer/);
});

test('CRM CSV export includes contact activity and lost reason', () => {
    const context = loadCrm();
    const csv = vm.runInContext(`toCsv([{ name: 'A', status: 'new', crmStatus: 'not_interested', lostReason: 'price',
        contactAttempts: 2, lastContactOutcome: 'no_answer', firstContactedAt: '2025-01-01T10:04:00.000Z', lastContactedAt: '2025-01-02T10:00:00.000Z' }])`, context);
    const [header, row] = csv.split('\n');
    assert.match(header, /"Contact attempts","First contacted","Last contacted","Last outcome","Lost reason"/);
    assert.match(row, /"2","2025-01-01T10:04:00.000Z","2025-01-02T10:00:00.000Z","No answer","Price too high"/);
});
