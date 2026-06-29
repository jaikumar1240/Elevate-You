/**
 * DebugYourCareer — main client script
 *
 * Flow after payment:
 *   1. User clicks a Razorpay payment-button link.
 *   2. Before navigating, we persist the chosen plan to localStorage.
 *   3. Razorpay redirects back to this page with ?payment_id=<id> (or
 *      ?razorpay_payment_id=<id>, or ?payment=success if you set a custom
 *      success URL in the Razorpay dashboard).
 *   4. On load we detect those query params, reveal the #booking-success
 *      section, and embed the correct Calendly event URL inline.
 *
 * NOTE: Make sure the Razorpay payment-button success redirect URL is set to
 *   https://<your-domain>/?payment=success
 * in the Razorpay dashboard — NOT a Calendly URL.
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PRICING_CONFIG = {
    amount: 89,
    currency: 'INR',
    symbol: '₹',
};

const BOOKING_CONFIG = {
    /** Calendly event URL — must match your published event slug. */
    url: 'https://calendly.com/jaikumar1240/debugyourcareer',

    /**
     * Query-param Razorpay adds when it redirects back to your site after a
     * successful payment (configure this in the Razorpay dashboard).
     * We also detect the raw payment_id / razorpay_payment_id params as a
     * fallback in case the dashboard redirect wasn't customised yet.
     */
    successQueryParam: 'payment',
    successQueryValue: 'success',

    /** localStorage key used to persist the selected plan across the redirect. */
    storageKey: 'debugYourCareer.pendingPlan',

    /** How many times to retry waiting for the Calendly JS bundle to load. */
    calendlyLoadRetries: 30,
    calendlyRetryDelayMs: 200,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    initSmoothScrollNav();
    initPaymentLinkTracking();
    handlePaymentReturn();
});

// ---------------------------------------------------------------------------
// Navigation — smooth scroll for in-page anchor links
// ---------------------------------------------------------------------------

function initSmoothScrollNav() {
    document.querySelectorAll('a.nav-link, a.mobile-link').forEach(link => {
        link.addEventListener('click', e => {
            const href = link.getAttribute('href');
            if (!href || !href.startsWith('#')) return;

            const target = document.querySelector(href);
            if (!target) return;

            e.preventDefault();
            const offset = target.getBoundingClientRect().top + window.pageYOffset - 80;
            window.scrollTo({ top: offset, behavior: 'smooth' });
        });
    });
}

// ---------------------------------------------------------------------------
// Payment link tracking — persist plan selection before Razorpay redirect
// ---------------------------------------------------------------------------

function initPaymentLinkTracking() {
    document.querySelectorAll('.payment-link').forEach(link => {
        link.addEventListener('click', () => {
            const plan = {
                name: link.dataset.planName || 'Session',
                price: link.dataset.planPrice || '',
            };
            persistSelectedPlan(plan);
        });
    });
}

// ---------------------------------------------------------------------------
// Post-payment return handling
// ---------------------------------------------------------------------------

/**
 * Called on every page load.  If the URL contains Razorpay's success params
 * we reveal the booking section and embed the Calendly widget.
 */
function handlePaymentReturn() {
    const params = new URLSearchParams(window.location.search);

    if (!isPaymentSuccessUrl(params)) return;

    const plan = readPersistedPlan();
    // const els  = resolveBookingElements();

    // if (!els) {
        // Fallback: open Calendly in a new tab if the section markup is absent.
        console.log('Opening Calendly in a new tab:', buildCalendlyUrl(plan));
        window.open(buildCalendlyUrl(plan), '_blank', 'noopener');
        return;
    // }

    // populateBookingSection(els, plan);
    // revealBookingSection(els.section);
    // embedCalendlyWidget(els.widget, buildCalendlyUrl(plan));
}

/** Returns true for any URL shape Razorpay uses on payment success. */
function isPaymentSuccessUrl(params) {
    return (
        params.get(BOOKING_CONFIG.successQueryParam) === BOOKING_CONFIG.successQueryValue ||
        params.has('razorpay_payment_id') ||
        params.has('payment_id')
    );
}

// ---------------------------------------------------------------------------
// Booking section helpers
// ---------------------------------------------------------------------------

// function resolveBookingElements() {
//     const section   = document.getElementById('booking-success');
//     const planCopy  = document.getElementById('booking-plan-copy');
//     const widget    = document.getElementById('calendly-inline-widget');
//     const directUrl = document.getElementById('calendly-direct-link');
//     const setupNote = document.getElementById('calendly-setup-note');

//     if (!section || !planCopy || !widget || !directUrl || !setupNote) return null;

//     return { section, planCopy, widget, directUrl, setupNote };
// }

function populateBookingSection(els, plan) {
    if (plan?.name) {
        const priceLabel = plan.price ? ` (₹${plan.price})` : '';
        els.planCopy.textContent =
            `Your ${plan.name}${priceLabel} payment is confirmed. Pick a time below.`;
    }

    const url = buildCalendlyUrl(plan);
    els.directUrl.href   = url;
    els.directUrl.hidden = false;
    els.setupNote.hidden = true;
}

function revealBookingSection(section) {
    section.hidden = false;
    document.body.classList.add('payment-success-active');

    // Wait one frame so the browser has painted the section before scrolling.
    requestAnimationFrame(() => {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

// ---------------------------------------------------------------------------
// Calendly widget
// ---------------------------------------------------------------------------

/**
 * Builds the Calendly embed URL with UTM / cosmetic params.
 * Always uses BOOKING_CONFIG.url as the base — never trusts any external URL.
 */
function buildCalendlyUrl(plan) {
    const base = BOOKING_CONFIG.url;
    if (!base) return '';

    const url = new URL(base);
    // Pre-fill Calendly's first custom question with the plan name so Jai
    // knows which session the student booked before the call.
    if (plan?.name) {
        url.searchParams.set('plan', plan.name);
    }

    return url.toString();
}

/**
 * Embeds the Calendly inline widget inside `container`.
 * Retries until the Calendly JS bundle has loaded.
 */
function embedCalendlyWidget(container, url, attempt = 0) {
    if (typeof window.Calendly?.initInlineWidget !== 'function') {
        if (attempt >= BOOKING_CONFIG.calendlyLoadRetries) {
            console.warn(
                '[DebugYourCareer] Calendly JS did not load in time. ' +
                'Check that the <script> tag for widget.js is present in index.html.'
            );
            return;
        }
        setTimeout(
            () => embedCalendlyWidget(container, url, attempt + 1),
            BOOKING_CONFIG.calendlyRetryDelayMs
        );
        return;
    }

    // Clear any previous render before initialising.
    container.innerHTML = '';
    container.hidden    = false;
    container.dataset.url = url;

    window.Calendly.initInlineWidget({ url, parentElement: container });
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function persistSelectedPlan(plan) {
    console.log('Persisting plan:', plan);
    try {
        localStorage.setItem(BOOKING_CONFIG.storageKey, JSON.stringify(plan));
    } catch {
        // Private-browsing mode or storage quota exceeded — silently ignore.
    }
}

function readPersistedPlan() {
    try {
        const raw = localStorage.getItem(BOOKING_CONFIG.storageKey);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}