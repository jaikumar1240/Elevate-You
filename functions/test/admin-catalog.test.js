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
