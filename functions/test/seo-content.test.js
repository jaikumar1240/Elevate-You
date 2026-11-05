'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('fresher resume guide includes an adaptable no-experience template', () => {
    const article = fs.readFileSync(path.join(__dirname, '../../blog/how-to-write-a-fresher-resume.html'), 'utf8');
    const template = article.match(/<section id="resume-template"[\s\S]*?<\/section>/i);

    assert.ok(template, 'The guide should include a resume template');
    assert.match(template[0], /education/i);
    assert.match(template[0], /projects/i);
    assert.match(template[0], /skills/i);
    assert.match(template[0], /your own experience/i);
});

test('resume template does not inherit landing-page section padding', () => {
    const styles = fs.readFileSync(path.join(__dirname, '../../blog/blog.css'), 'utf8');

    assert.match(styles, /\.blog-body\s+#resume-template\s*\{[^}]*padding:\s*0\s*;/);
});

test('resume guide requests a versioned blog stylesheet', () => {
    const article = fs.readFileSync(path.join(__dirname, '../../blog/how-to-write-a-fresher-resume.html'), 'utf8');

    assert.match(article, /href="\/blog\/blog\.css\?v=\d+"/);
});

test('resume article structured data matches its visible heading', () => {
    const article = fs.readFileSync(path.join(__dirname, '../../blog/how-to-write-a-fresher-resume.html'), 'utf8');
    const structuredData = Array.from(article.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
        (match) => JSON.parse(match[1]));
    const articleData = structuredData.find((item) => item['@type'] === 'Article');
    const heading = article.match(/<h1[^>]*>([^<]+)<\/h1>/);

    assert.ok(articleData, 'Article structured data should be present');
    assert.ok(heading, 'The article should have a visible heading');
    assert.equal(articleData.headline, heading[1]);
});

test('resume revision dates are consistent across the article and sitemap', () => {
    const article = fs.readFileSync(path.join(__dirname, '../../blog/how-to-write-a-fresher-resume.html'), 'utf8');
    const sitemap = fs.readFileSync(path.join(__dirname, '../../sitemap.xml'), 'utf8');
    const modifiedDate = article.match(/"dateModified":\s*"(\d{4}-\d{2}-\d{2})"/)?.[1];
    const articleSitemapDate = sitemap.match(/<loc>https:\/\/elevate-personality\.web\.app\/blog\/how-to-write-a-fresher-resume<\/loc><lastmod>([^<]+)<\/lastmod>/)?.[1];
    const blogSitemapDate = sitemap.match(/<loc>https:\/\/elevate-personality\.web\.app\/blog\/<\/loc><lastmod>([^<]+)<\/lastmod>/)?.[1];

    assert.ok(modifiedDate, 'The article should have a modification date');
    assert.ok(modifiedDate >= '2026-11-06', 'The date should reflect the resume guide update');
    assert.equal(articleSitemapDate, modifiedDate);
    assert.ok(blogSitemapDate >= '2026-11-06', 'The blog sitemap date should reflect its updated article card');
    const readableDate = new Intl.DateTimeFormat('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    }).format(new Date(`${modifiedDate}T00:00:00Z`));
    assert.ok(article.includes(`Updated ${readableDate}`));
});
