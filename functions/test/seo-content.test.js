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
    const articleSitemapDate = sitemap.match(/<loc>https:\/\/debugyourcareer\.in\/blog\/how-to-write-a-fresher-resume<\/loc><lastmod>([^<]+)<\/lastmod>/)?.[1];
    const blogSitemapDate = sitemap.match(/<loc>https:\/\/debugyourcareer\.in\/blog\/<\/loc><lastmod>([^<]+)<\/lastmod>/)?.[1];

    assert.ok(modifiedDate, 'The article should have a modification date');
    assert.ok(modifiedDate >= '2026-11-06', 'The date should reflect the resume guide update');
    assert.equal(articleSitemapDate, modifiedDate);
    assert.ok(blogSitemapDate >= '2026-11-06', 'The blog sitemap date should reflect its updated article card');
    const readableDate = new Intl.DateTimeFormat('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    }).format(new Date(`${modifiedDate}T00:00:00Z`));
    assert.ok(article.includes(`Updated ${readableDate}`));
});

test('About section displays Jai Rajput’s supplied portrait', () => {
    const homepage = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
    const about = homepage.match(/<section id="about-me"[\s\S]*?<\/section>/i)?.[0];

    assert.ok(about, 'The About section should be present');
    assert.match(about, /src="assets\/jai-rajput-about\.jpg"/);
    assert.ok(fs.existsSync(path.join(__dirname, '../../assets/jai-rajput-about.jpg')));
});

test('public URLs, SEO metadata, and site configuration use the new domain', () => {
    const root = path.join(__dirname, '../..');
    const oldDomain = `${'elevate-personality'}.${'web.app'}`;
    const newOrigin = 'https://debugyourcareer.in';
    const blogPages = fs.readdirSync(path.join(root, 'blog')).filter((name) => name.endsWith('.html'));
    const files = [
        'README.md',
        'index.html',
        'robots.txt',
        'sitemap.xml',
        'functions/lib/config.js',
        'functions/.env.elevate-personality',
        ...blogPages.map((name) => path.join('blog', name)),
    ];

    for (const file of files) {
        const content = fs.readFileSync(path.join(root, file), 'utf8');
        assert.ok(!content.includes(oldDomain), `${file} should not reference the previous domain`);
    }

    const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
    const sitemapUrls = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => new URL(match[1]));
    assert.ok(sitemapUrls.length > 0, 'The sitemap should include public pages');
    assert.ok(sitemapUrls.every((url) => url.origin === newOrigin), 'Sitemap URLs should use the new domain');
    assert.match(fs.readFileSync(path.join(root, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/debugyourcareer\.in\/sitemap\.xml/);
});

const ROOT = path.join(__dirname, '../..');
const ORIGIN = 'https://debugyourcareer.in';
const blogArticles = () => fs.readdirSync(path.join(ROOT, 'blog'))
    .filter((name) => name.endsWith('.html') && name !== 'index.html')
    .map((name) => name.replace(/\.html$/, ''));

test('every blog article is self-canonical, in the sitemap, and linked from the blog index', () => {
    const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
    const blogIndex = fs.readFileSync(path.join(ROOT, 'blog/index.html'), 'utf8');

    for (const slug of blogArticles()) {
        const url = `${ORIGIN}/blog/${slug}`;
        const html = fs.readFileSync(path.join(ROOT, 'blog', `${slug}.html`), 'utf8');
        assert.ok(html.includes(`<link rel="canonical" href="${url}">`), `${slug} canonical`);
        assert.ok(sitemap.includes(`<loc>${url}</loc>`), `${slug} in sitemap`);
        assert.ok(blogIndex.includes(`href="/blog/${slug}"`), `${slug} linked from blog index`);
        const article = Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
            (m) => JSON.parse(m[1])).find((d) => d['@type'] === 'Article');
        assert.equal(article?.headline, html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1], `${slug} headline`);
    }
});

test('blog covers the highest-demand fresher interview and profile topics', () => {
    const slugs = blogArticles();
    for (const slug of [
        'tell-me-about-yourself-answer-for-freshers',
        'why-should-we-hire-you-answer-for-freshers',
        'linkedin-profile-tips-for-freshers',
    ]) {
        assert.ok(slugs.includes(slug), `missing article: ${slug}`);
    }
});

test('public pages redirect legacy Firebase hosts to the canonical domain', () => {
    const vm = require('node:vm');
    const pages = ['index.html', 'blog/index.html', ...blogArticles().map((s) => `blog/${s}.html`)];
    for (const page of pages) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        const script = html.match(/<script>\s*(\/\*\s*canonical-host\s*\*\/[\s\S]*?)<\/script>/)?.[1];
        assert.ok(script, `${page} should include the canonical-host redirect`);
        const run = (hostname) => {
            let target = null;
            vm.runInNewContext(script, { location: { hostname, pathname: '/blog/x', search: '?utm_source=a', hash: '#h', replace: (u) => { target = u; } } });
            return target;
        };
        assert.equal(run('elevate-personality.web.app'), 'https://debugyourcareer.in/blog/x?utm_source=a#h');
        assert.equal(run('elevate-personality.firebaseapp.com'), 'https://debugyourcareer.in/blog/x?utm_source=a#h');
        assert.equal(run('debugyourcareer.in'), null);
        assert.equal(run('localhost'), null);
    }
});

test('an IndexNow key file is published at the site root', () => {
    const keys = fs.readdirSync(ROOT).filter((n) => /^[a-f0-9]{32}\.txt$/.test(n));
    assert.equal(keys.length, 1, 'exactly one IndexNow key file');
    assert.equal(fs.readFileSync(path.join(ROOT, keys[0]), 'utf8').trim(), keys[0].replace('.txt', ''));
});

test('homepage links to every blog article', () => {
    const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    for (const slug of blogArticles()) {
        assert.ok(homepage.includes(`href="/blog/${slug}"`), `homepage should link to ${slug}`);
    }
});

test('homepage connects the business social profiles for visitors and search engines', () => {
    const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const profiles = [
        'https://www.instagram.com/debugyour.career/',
        'https://www.linkedin.com/company/debugyourcareer',
        'https://www.youtube.com/@DebugYour.Career',
    ];
    const graph = Array.from(homepage.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
        (match) => JSON.parse(match[1])).flatMap((data) => data['@graph'] || [data]);
    const business = graph.find((item) => item['@id'] === `${ORIGIN}/#business`);
    assert.ok(business, 'The business structured data should exist');
    for (const profile of profiles) {
        assert.ok(homepage.includes(`href="${profile}"`), `Homepage should link to ${profile}`);
        assert.ok(business.sameAs?.includes(profile), `Business sameAs should include ${profile}`);
    }
});
