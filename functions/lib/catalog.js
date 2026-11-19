'use strict';

const { PLANS } = require('./config');

const DETAILS = {
    diagnosis: {
        description: 'A focused 15-minute call to find your #1 career blocker. Walk away knowing exactly what to fix.',
        period: '/ session', badge: 'Start here',
        features: ['15-min 1:1 call (video or phone)', 'Identify your exact blocker', 'One actionable fix to start today', 'Session notes sent after the call'],
    },
    resume: {
        description: 'Send your resume. Get a detailed Loom video walking through structure, clarity and positioning.',
        period: '/ review', badge: '',
        features: ['Async - no call needed', 'Detailed Loom video feedback', 'Fix structure, clarity & impact', 'Delivered within 24 hours'],
    },
    social: {
        description: 'Send your LinkedIn and Naukri profile links. Get specific feedback to improve your visibility to recruiters.',
        period: '/ review', badge: '',
        features: ['Async - no call needed', 'LinkedIn + Naukri profile audit', 'Tips to improve recruiter reach', 'Delivered within 24 hours'],
    },
    mock: {
        description: 'A 45-minute simulated interview for your target role, with feedback on your answers, confidence and body language.',
        period: '/ session', badge: 'Most popular',
        features: ['45-min role-specific mock interview', 'Feedback on content + delivery', 'Body language & confidence tips', 'Detailed written debrief'],
    },
    'prep-pack': {
        description: 'Resume feedback, mock interviews and an action plan to help you prepare for placement season.',
        period: '/ pack', badge: 'Best value',
        features: ['Full resume review', '2 mock interview sessions', 'Written action plan', 'WhatsApp follow-up support'],
    },
    placement: {
        description: 'A 4-week intensive program for students preparing for placement season.',
        period: '/ 4 weeks', badge: '',
        features: ['3 x 1:1 coaching sessions', 'Resume + LinkedIn review', '2 full mock interviews', 'Week 4 check-in & final prep'],
    },
};

function defaultCatalog() {
    return {
        revision: 0, checkoutEnabled: true, announcement: '', history: [],
        plans: Object.entries(PLANS).map(([id, plan]) => ({ id, ...plan, ...DETAILS[id], active: true })),
    };
}

async function readCatalog(db) {
    const snapshot = await db.collection('site').doc('catalog').get();
    return snapshot.exists ? snapshot.data() : defaultCatalog();
}

function publicCatalog(catalog) {
    const { revision, checkoutEnabled, announcement } = catalog;
    return { revision, checkoutEnabled, announcement, plans: catalog.plans.filter((plan) => plan.active) };
}

function validateCatalog(input) {
    const text = (value, max, required = false) => typeof value === 'string'
        && value.length <= max && (!required || value.trim().length > 0);
    if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0
        || typeof input.checkoutEnabled !== 'boolean' || !text(input.announcement, 300)
        || !Array.isArray(input.plans) || input.plans.length < 1 || input.plans.length > 20) {
        return 'Provide a revision, 1-20 plans, checkout availability and an announcement of up to 300 characters.';
    }
    const ids = new Set();
    for (const plan of input.plans) {
        if (!plan || typeof plan.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(plan.id) || ids.has(plan.id)) {
            return 'Plan IDs must be unique lowercase letters, numbers or hyphens (up to 40 characters).';
        }
        ids.add(plan.id);
        if (!text(plan.name, 80, true) || !text(plan.description, 600, true)
            || !text(plan.period, 40, true) || !text(plan.badge, 40)
            || typeof plan.active !== 'boolean'
            || !Array.isArray(plan.features) || plan.features.length < 1 || plan.features.length > 10
            || !plan.features.every((feature) => text(feature, 160, true))) {
            return `Check the name, description, period, badge and 1-10 features for ${plan.id}.`;
        }
        if (typeof plan.price !== 'number' || !Number.isFinite(plan.price) || plan.price < 1 || plan.price > 1000000
            || Math.abs(plan.price * 100 - Math.round(plan.price * 100)) > 0.000001) {
            return `Price for ${plan.id} must be between INR 1 and 1,000,000 with at most two decimal places.`;
        }
    }
    return '';
}

function catalogChanges(previous, next) {
    const changes = [];
    for (const plan of next.plans) {
        const old = previous.plans.find((item) => item.id === plan.id);
        if (!old) {
            changes.push(`${plan.id}: added at INR ${plan.price} (${plan.active ? 'active' : 'archived'})`);
            continue;
        }
        if (old.price !== plan.price) changes.push(`${plan.id}: INR ${old.price} -> INR ${plan.price}`);
        if (old.active !== plan.active) changes.push(`${plan.id}: ${plan.active ? 'restored' : 'archived'}`);
        const fields = ['name', 'description', 'period', 'badge', 'features'];
        if (fields.some((key) => JSON.stringify(old[key]) !== JSON.stringify(plan[key]))) changes.push(`${plan.id}: details updated`);
    }
    if (previous.plans.map((p) => p.id).join(',') !== next.plans.map((p) => p.id).join(',')) changes.push('Display order updated');
    if (previous.checkoutEnabled !== next.checkoutEnabled) changes.push(`Checkout ${next.checkoutEnabled ? 'enabled' : 'paused'}`);
    if (previous.announcement !== next.announcement) changes.push('Announcement updated');
    return changes.join('; ') || 'Published without changes';
}

module.exports = { defaultCatalog, readCatalog, publicCatalog, validateCatalog, catalogChanges };
