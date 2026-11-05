'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const hostingUrl = process.env.FIREBASE_HOSTING_TEST_URL;

test('missing pages return a 404 with links back to the site', {
    skip: !hostingUrl && 'Run against the Firebase Hosting emulator',
}, async () => {
    const response = await fetch(new URL('/seo-missing-page-test', hostingUrl));
    assert.equal(response.status, 404);

    const html = await response.text();
    assert.match(html, /href="\/"/);
    assert.match(html, /href="\/blog\/"/);
});

test('every sitemap URL serves its canonical page', {
    skip: !hostingUrl && 'Run against the Firebase Hosting emulator',
}, async () => {
    const sitemapResponse = await fetch(new URL('/sitemap.xml', hostingUrl));
    assert.equal(sitemapResponse.status, 200);
    assert.match(sitemapResponse.headers.get('content-type'), /(?:application|text)\/xml/);

    const sitemap = await sitemapResponse.text();
    const urls = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => new URL(match[1]));
    assert.ok(urls.length > 0, 'The sitemap should contain at least one URL');

    for (const url of urls) {
        const response = await fetch(new URL(url.pathname, hostingUrl));
        assert.equal(response.status, 200, `${url.pathname} should be available`);
        assert.match(response.headers.get('content-type'), /text\/html/);
        const html = await response.text();
        assert.ok(html.includes(`<link rel="canonical" href="${url.href}">`), `${url.pathname} should have its own canonical URL`);
    }
});

test('the admin page remains available with a noindex header', {
    skip: !hostingUrl && 'Run against the Firebase Hosting emulator',
}, async () => {
    const response = await fetch(new URL('/admin', hostingUrl));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-robots-tag') || '', /noindex/i);
});
