'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../..');

function workspace() {
    const make = (id) => ({
        id, hidden: false, tabIndex: -1, attributes: {}, listeners: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        focus() { this.focused = true; },
    });
    const tabs = ['leads', 'catalog', 'reports'].map((name) => {
        const tab = make(`tab-${name}`);
        tab.setAttribute('aria-controls', `panel-${name}`);
        return tab;
    });
    const panels = tabs.map((tab) => make(tab.getAttribute('aria-controls')));
    const shared = make('shared');
    shared.dataset = { adminShared: 'leads reports' };
    const document = {
        querySelectorAll: (selector) => selector === '[role="tab"]' ? tabs : selector === '[role="tabpanel"]' ? panels : [shared],
        getElementById: (id) => panels.find((p) => p.id === id),
    };
    const file = path.join(root, 'admin-tabs.js');
    if (fs.existsSync(file)) vm.runInNewContext(fs.readFileSync(file, 'utf8'), { document });
    return { tabs, panels, shared };
}

test('admin separates tasks into labelled panels without duplicating live controls', () => {
    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    assert.match(html, /role="tablist"[^>]*aria-label="Admin sections"/);
    for (const name of ['leads', 'catalog', 'reports']) {
        assert.match(html, new RegExp(`id="tab-${name}"[^>]*role="tab"[^>]*aria-controls="panel-${name}"`));
        assert.match(html, new RegExp(`id="panel-${name}"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-${name}"`));
    }
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'Controls must keep unique IDs');
    assert.match(html, /<script src="\/admin-tabs\.js\?v=/);
});

test('switching tasks keeps drafts in place and shows filters only for leads and reports', () => {
    const { tabs, panels, shared } = workspace();
    assert.equal(typeof tabs[1].listeners.click, 'function');
    assert.deepEqual(panels.map((p) => p.hidden), [false, true, true]);
    panels[1].draft = 'Unsaved price 299';
    tabs[1].listeners.click();
    assert.deepEqual(panels.map((p) => p.hidden), [true, false, true]);
    assert.equal(shared.hidden, true);
    assert.deepEqual(tabs.map((t) => t.attributes['aria-selected']), ['false', 'true', 'false']);
    assert.deepEqual(tabs.map((t) => t.tabIndex), [-1, 0, -1]);
    tabs[2].listeners.click();
    assert.equal(shared.hidden, false);
    assert.deepEqual(panels.map((p) => p.hidden), [true, true, false]);
    tabs[1].listeners.click();
    assert.equal(panels[1].draft, 'Unsaved price 299');
});

test('tab navigation supports arrow wrapping, Home and End without intercepting normal typing', () => {
    const { tabs, panels } = workspace();
    assert.equal(typeof tabs[0].listeners.keydown, 'function');
    let prevented = 0;
    const key = (index, value) => tabs[index].listeners.keydown({ key: value, preventDefault() { prevented++; } });
    key(0, 'ArrowLeft');
    assert.equal(panels[2].hidden, false);
    assert.equal(tabs[2].focused, true);
    key(2, 'ArrowRight');
    assert.equal(panels[0].hidden, false);
    key(0, 'End');
    assert.equal(panels[2].hidden, false);
    key(2, 'Home');
    assert.equal(panels[0].hidden, false);
    key(0, 'Tab');
    assert.equal(prevented, 4);
});
