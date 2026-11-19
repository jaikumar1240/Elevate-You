'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { defaultCatalog } = require('../lib/catalog');

function editor() {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, {
            innerHTML: '', textContent: '', disabled: false, value: '', checked: false,
            addEventListener(type, callback) { this[type] = callback; },
            querySelectorAll: () => [],
        });
        return elements.get(id);
    };
    const requests = [];
    const context = vm.createContext({
        document: { getElementById: element }, window: { addEventListener() {} }, console,
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => defaultCatalog() };
        },
    });
    const file = path.join(__dirname, '../../admin-catalog.js');
    if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
    return { context, elements, element, requests };
}

test('admin catalog loads with an ID token and renders editable fields as escaped text', async () => {
    const t = editor();
    assert.equal(typeof t.context.window.initCatalogAdmin, 'function');
    await t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });
    assert.equal(t.requests[0].url, '/api/admin/catalog');
    assert.equal(t.requests[0].options.headers.Authorization, 'Bearer admin-token');
    assert.match(t.element('catalogPlans').innerHTML, /name="price"/);
    assert.match(t.element('catalogPlans').innerHTML, /name="features"/);
    assert.match(t.element('catalogPlans').innerHTML, /archive/i);
    assert.equal(t.element('catalogSave').disabled, false);
    t.context.fetch = async () => ({
        ok: true, json: async () => ({
            ...defaultCatalog(),
            plans: [{ ...defaultCatalog().plans[0], name: '<img src=x onerror=alert(1)>' }],
        }),
    });

    await t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });
    assert.doesNotMatch(t.element('catalogPlans').innerHTML, /<img src=x/);
    assert.match(t.element('catalogPlans').innerHTML, /&lt;img/);
});

test('admin can review and publish the website plan and payment button labels', async () => {
    const t = editor();
    await t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });
    assert.equal(t.element('catalogPlanButton').value, 'Book now');
    assert.equal(t.element('catalogPaymentButton').value, 'Continue');
    t.element('catalogPlanButton').value = 'Choose this plan';
    t.element('catalogPaymentButton').value = 'Pay securely';
    let payload;
    t.context.fetch = async (_url, options) => {
        payload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ ...defaultCatalog(), ...payload, revision: 1 }) };
    };
    await t.element('catalogForm').submit({ preventDefault() {} });
    assert.deepEqual(payload.buttonLabels, { plan: 'Choose this plan', payment: 'Pay securely' });
    assert.equal(t.element('catalogPlanButton').value, 'Choose this plan');
});

test('admin publishing sends edited fields and keeps unsaved edits after a conflict', async () => {
    const t = editor();
    await t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });
    t.element('catalogPlans').querySelectorAll = () => defaultCatalog().plans.map((plan) => ({
        querySelector: (selector) => {
            const key = selector.match(/name="([^"]+)"/)[1];
            return { value: key === 'price' ? '249.50' : key === 'features' ? plan.features.join('\n') : plan[key], checked: plan.active };
        },
    }));
    t.element('catalogAnnouncement').value = 'New plans available';
    t.element('catalogEnabled').checked = false;
    let payload;
    t.context.fetch = async (_url, options) => {
        payload = JSON.parse(options.body);
        return { ok: false, json: async () => ({ error: 'Someone changed the catalog. Reload the latest version before saving.' }) };
    };
    assert.equal(typeof t.element('catalogForm').submit, 'function');
    await t.element('catalogForm').submit({ preventDefault() {} });
    assert.equal(payload.revision, 0);
    assert.equal(payload.plans[0].price, 249.5);
    assert.equal(payload.checkoutEnabled, false);
    assert.match(t.element('catalogStatus').textContent, /Reload/);
    assert.equal(t.element('catalogAnnouncement').value, 'New plans available');
    assert.equal(t.element('catalogSave').disabled, false);
});

test('adding a plan and moving cards preserve draft edits before publishing', async () => {
    const t = editor();
    await t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });
    t.element('catalogPlans').querySelectorAll = () => defaultCatalog().plans.map((plan) => ({
        querySelector: (selector) => {
            const key = selector.match(/name="([^"]+)"/)[1];
            return { value: key === 'price' ? '123' : key === 'features' ? plan.features.join('\n') : plan[key], checked: plan.active };
        },
    }));
    assert.equal(typeof t.element('catalogAdd').click, 'function');
    t.element('catalogAdd').click();
    assert.match(t.element('catalogPlans').innerHTML, /New plan/);
    assert.match(t.element('catalogPlans').innerHTML, /value="123"/);
    assert.equal(t.requests.length, 1, 'Adding is local until published');
    assert.equal(typeof t.element('catalogPlans').click, 'function');
    t.element('catalogPlans').click({
        target: { closest: () => ({ disabled: false, dataset: { move: '1' }, closest: () => ({ dataset: { index: '0' } }) }) },
    });
    const markup = t.element('catalogPlans').innerHTML;
    assert.ok(markup.indexOf('Resume Review') < markup.indexOf('Diagnosis Session'));
});

test('signing out clears catalog data and ignores an in-flight admin response', async () => {
    const t = editor();
    let resolve;
    t.context.fetch = async () => new Promise((done) => { resolve = done; });
    const loading = t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });
    await new Promise((done) => setImmediate(done));
    await t.context.window.initCatalogAdmin(null);
    resolve({ ok: true, json: async () => defaultCatalog() });
    await loading;
    assert.equal(t.element('catalogPlans').innerHTML, '');
    assert.equal(t.element('catalogSave').disabled, true);
});

test('a missing catalog backend shows deployment instructions instead of a JSON parser error', async () => {
    const t = editor();
    t.context.fetch = async () => ({
        ok: false, status: 404,
        json: async () => { throw new SyntaxError('Unexpected token <'); },
    });

    await t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });

    assert.match(t.element('catalogStatus').textContent, /catalog API.*not deployed/i);
    assert.match(t.element('catalogStatus').textContent, /functions:api/i);
    assert.equal(t.element('catalogSave').disabled, true);
});

test('publishing locks editable controls so later typing cannot be silently overwritten', async () => {
    const t = editor();
    await t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });
    t.element('catalogPlans').querySelectorAll = () => defaultCatalog().plans.map((plan) => ({
        querySelector: (selector) => {
            const key = selector.match(/name="([^"]+)"/)[1];
            return { value: key === 'features' ? plan.features.join('\n') : plan[key], checked: plan.active };
        },
    }));
    let finish;
    t.context.fetch = async () => new Promise((resolve) => { finish = resolve; });
    const saving = t.element('catalogForm').submit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(t.element('catalogFields').disabled, true);
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const fields = html.match(/<fieldset\b[^>]*id="catalogFields"[^>]*>([\s\S]*?)<\/fieldset>/)?.[1];
    for (const id of ['catalogAnnouncement', 'catalogEnabled', 'catalogPlans', 'catalogAdd', 'catalogReload', 'catalogSave']) {
        assert.ok(fields?.includes(`id="${id}"`), `${id} must be inside the locked fieldset`);
    }

    finish({ ok: true, json: async () => ({ ...defaultCatalog(), revision: 1 }) });
    await saving;
    assert.equal(t.element('catalogFields').disabled, false);
    assert.match(t.element('catalogStatus').textContent, /Published version 1/);
});

test('a non-JSON service failure leaves the draft intact and provides a retryable error', async () => {
    const t = editor();
    await t.context.window.initCatalogAdmin({ getIdToken: async () => 'admin-token' });
    t.element('catalogAnnouncement').value = 'Keep this draft';
    t.context.fetch = async () => ({
        ok: false, status: 503,
        json: async () => { throw new SyntaxError('Unexpected token <'); },
    });

    await t.element('catalogForm').submit({ preventDefault() {} });

    assert.match(t.element('catalogStatus').textContent, /HTTP 503/);
    assert.match(t.element('catalogStatus').textContent, /retry/i);
    assert.doesNotMatch(t.element('catalogStatus').textContent, /Unexpected token/);
    assert.equal(t.element('catalogAnnouncement').value, 'Keep this draft');
    assert.equal(t.element('catalogFields').disabled, false);
    assert.equal(t.element('catalogSave').disabled, false);
});

test('full-length plan names can wrap in admin legends without widening the editor', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const legendStyle = html.match(/\.catalog-plan legend\s*\{([^}]+)\}/)?.[1] || '';
    assert.match(legendStyle, /max-width:\s*100%/);
    assert.match(legendStyle, /overflow-wrap:\s*anywhere/);
});
