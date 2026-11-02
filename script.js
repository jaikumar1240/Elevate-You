/**
 * DebugYourCareer — main client script
 *
 * Lead-first funnel:
 *   1. Any `.book-cta[data-plan-id]` opens the lead modal (name, WhatsApp, email).
 *   2. Submit -> POST /api/lead: lead saved in Firestore, Razorpay order created.
 *      Browser fires Meta `Lead` + GA4 `generate_lead` using the same eventID as
 *      the server-side Conversions API event, so Meta deduplicates.
 *   3. Razorpay Standard Checkout opens prefilled with the same details
 *      (`InitiateCheckout` / `begin_checkout`).
 *   4. Success -> POST /api/verify (signature checked server-side). Only then do
 *      `Purchase` / `purchase` fire and the Calendly embed open, prefilled.
 *   5. Calendly `event_scheduled` -> POST /api/booked (`Schedule` / `schedule`).
 *
 * Every step is recorded on the lead so unpaid leads can be followed up in /admin.
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Display-only copy of functions/lib/config.js PLANS. The server decides the price charged. */
const PLANS = {
    diagnosis: { name: 'Diagnosis Session', price: 89 },
    resume: { name: 'Resume Review', price: 199 },
    social: { name: 'Social Profile Review', price: 199 },
    mock: { name: 'Mock Interview', price: 349 },
    'prep-pack': { name: 'Interview Prep Pack', price: 799 },
    placement: { name: 'Full Placement Prep', price: 1499 },
};

const CONFIG = {
    apiBase: '/api',
    currency: 'INR',
    brandName: 'DebugYourCareer',
    brandColor: '#6366f1',
    metaPixelId: '1145272234680051',
    whatsappNumber: '917827981994',
    storage: {
        lead: 'dyc.lead',
        booking: 'dyc.pendingBooking',
        attribution: 'dyc.attribution',
    },
    attributionTtlMs: 30 * 24 * 60 * 60 * 1000,
    scriptWaitRetries: 50,
    scriptWaitDelayMs: 200,
};

const ATTRIBUTION_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    captureAttribution();
    initSmoothScrollNav();
    initCtaTracking();
    initFaqTracking();
    initContactTracking();
    LeadFunnel.init();
});

// ---------------------------------------------------------------------------
// Storage helpers (never throw — private mode / quota)
// ---------------------------------------------------------------------------

function storeGet(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function storeSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // ignore
    }
}

function storeRemove(key) {
    try {
        localStorage.removeItem(key);
    } catch {
        // ignore
    }
}

function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
}

// ---------------------------------------------------------------------------
// Attribution — first touch kept for 30 days; a new ad click starts a new window
// ---------------------------------------------------------------------------

function readUrlAttribution() {
    const params = new URLSearchParams(window.location.search);
    const data = {};
    ATTRIBUTION_PARAMS.forEach((key) => {
        const v = params.get(key);
        if (v) data[key] = v.slice(0, 500);
    });
    return data;
}

function captureAttribution() {
    const fromUrl = readUrlAttribution();
    const stored = storeGet(CONFIG.storage.attribution);
    const fresh = stored && Date.now() - stored.savedAt < CONFIG.attributionTtlMs;

    if (!fresh || Object.keys(fromUrl).length) {
        storeSet(CONFIG.storage.attribution, {
            savedAt: Date.now(),
            data: {
                ...fromUrl,
                landing_page: window.location.href.slice(0, 500),
                referrer: document.referrer.slice(0, 500),
            },
        });
    }
}

function getAttribution() {
    return storeGet(CONFIG.storage.attribution)?.data || readUrlAttribution();
}

/** Meta browser ids, used by the Conversions API to match server events to the ad click. */
function getMetaIds(attribution) {
    let fbc = getCookie('_fbc');
    if (!fbc && attribution.fbclid) fbc = `fb.1.${Date.now()}.${attribution.fbclid}`;
    return { fbp: getCookie('_fbp'), fbc };
}

function leadSource(attribution) {
    if (attribution.utm_source) return attribution.utm_source;
    if (attribution.fbclid) return 'facebook';
    if (attribution.gclid) return 'google';
    return 'direct';
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** GA4 event. No-ops if gtag is blocked. */
function gaEvent(name, params = {}) {
    try {
        if (typeof window.gtag === 'function') window.gtag('event', name, params);
    } catch {
        // Never let analytics break the page.
    }
}

/** Meta Pixel standard event. `eventID` must equal the server CAPI event_id for dedup. */
function metaEvent(name, data = {}, eventID) {
    try {
        if (typeof window.fbq !== 'function') return;
        if (eventID) window.fbq('track', name, data, { eventID });
        else window.fbq('track', name, data);
    } catch {
        // Never let analytics break the page.
    }
}

/** Advanced matching for Pixel + GA4 user-provided data (the tags hash it). */
function setAnalyticsUser(leadId, prefill) {
    const [fn, ...rest] = (prefill.name || '').trim().toLowerCase().split(/\s+/);
    const phone = (prefill.contact || '').replace(/\D/g, '');
    try {
        if (typeof window.fbq === 'function') {
            const match = { em: (prefill.email || '').toLowerCase(), ph: phone, country: 'in', external_id: leadId };
            if (fn) match.fn = fn;
            if (rest.length) match.ln = rest.join(' ');
            window.fbq('init', CONFIG.metaPixelId, match);
        }
        if (typeof window.gtag === 'function') {
            window.gtag('set', 'user_data', { email: prefill.email, phone_number: `+${phone}` });
        }
    } catch {
        // ignore
    }
}

function planItem(plan) {
    return { item_id: plan.id, item_name: plan.name, price: plan.price, quantity: 1 };
}

// ---------------------------------------------------------------------------
// Navigation / CTA / FAQ / contact tracking
// ---------------------------------------------------------------------------

function initSmoothScrollNav() {
    document.querySelectorAll('a.nav-link, a.mobile-link').forEach((link) => {
        link.addEventListener('click', (e) => {
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

function initCtaTracking() {
    document.querySelectorAll('a.nav-link, a.mobile-link, .cta-button.secondary').forEach((el) => {
        el.addEventListener('click', () => {
            gaEvent('cta_click', {
                label: el.textContent.trim(),
                location: el.closest('section, nav')?.id || 'unknown',
            });
        });
    });
}

function initFaqTracking() {
    document.querySelectorAll('.faq-question').forEach((question) => {
        question.addEventListener('click', () => {
            const label = question.querySelector('span')?.textContent.trim() || 'unknown';
            gaEvent('faq_open', { question: label });
        });
    });
}

function initContactTracking() {
    document.querySelectorAll('.contact-card a, a[href^="https://wa.me"]').forEach((link) => {
        link.addEventListener('click', () => {
            const href = link.getAttribute('href') || '';
            const channel = href.startsWith('mailto:') ? 'email' : href.includes('wa.me') ? 'whatsapp' : 'phone';
            gaEvent('contact_click', { channel });
            metaEvent('Contact', { content_name: channel });
        });
    });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, body) {
    const res = await fetch(`${CONFIG.apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let json = {};
    try {
        json = await res.json();
    } catch {
        // non-JSON error page
    }
    if (!res.ok) {
        const err = new Error(json.error || 'Something went wrong. Please try again.');
        err.fields = json.fields;
        err.status = res.status;
        throw err;
    }
    return json;
}

/** Fire-and-forget funnel tracking; never blocks the user. */
function apiQuiet(path, body) {
    api(path, body).catch(() => {});
}

function waitFor(check, retries = CONFIG.scriptWaitRetries) {
    return new Promise((resolve, reject) => {
        const tick = (n) => {
            if (check()) return resolve();
            if (n <= 0) return reject(new Error('Script did not load'));
            setTimeout(() => tick(n - 1), CONFIG.scriptWaitDelayMs);
        };
        tick(retries);
    });
}

// ---------------------------------------------------------------------------
// Validation (mirrors functions/lib/validate.js)
// ---------------------------------------------------------------------------

function normalizePhone(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return /^[6-9]\d{9}$/.test(digits) ? digits : '';
}

function validateLeadForm(values) {
    const errors = {};
    if (values.name.trim().length < 2) errors.name = 'Please enter your name';
    if (!normalizePhone(values.phone)) errors.phone = 'Enter a valid 10-digit mobile number';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email.trim())) errors.email = 'Enter a valid email address';
    return errors;
}

// ---------------------------------------------------------------------------
// Lead funnel: modal -> lead -> Razorpay -> verify -> Calendly
// ---------------------------------------------------------------------------

const LeadFunnel = {
    els: null,
    planId: 'diagnosis',
    lead: null, // response of /api/lead
    lastFocus: null,
    paying: false,
    verifying: false,

    init() {
        const modal = document.getElementById('leadModal');
        const form = document.getElementById('leadForm');
        if (!modal || !form) return;

        this.els = {
            modal,
            form,
            planName: document.getElementById('leadPlanName'),
            planPrice: document.getElementById('leadPlanPrice'),
            formError: document.getElementById('leadFormError'),
            submit: document.getElementById('leadSubmit'),
            retry: document.getElementById('leadRetry'),
            retryMessage: document.getElementById('leadRetryMessage'),
            edit: document.getElementById('leadEdit'),
            whatsapp: document.getElementById('leadWhatsappHelp'),
            views: modal.querySelectorAll('[data-view]'),
        };

        document.querySelectorAll('.book-cta').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const location = btn.closest('section')?.id || (btn.closest('#stickyCTA') ? 'sticky' : 'unknown');
                this.open(btn.dataset.planId, location);
            });
        });

        modal.querySelectorAll('[data-close-modal]').forEach((el) => el.addEventListener('click', () => this.close()));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modal.hidden && !this.paying && !this.verifying) this.close();
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.submit();
        });
        form.querySelectorAll('input, select').forEach((input) => {
            input.addEventListener('input', () => this.setFieldError(input.name, ''));
        });

        this.els.retry?.addEventListener('click', () => this.openCheckout());
        this.els.edit?.addEventListener('click', () => this.showView('form'));

        window.addEventListener('message', (e) => this.onCalendlyMessage(e));
        this.resumePendingBooking();
        this.resumeFromReminder();
    },

    /** `?resume=<token>` from the payment-reminder email: reopen the form prefilled. */
    async resumeFromReminder() {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('resume');
        if (!token) return;
        params.delete('resume');
        const qs = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);

        try {
            const res = await api('/resume', { token });
            gaEvent('reminder_click', { plan_id: res.planId, already_paid: res.paid });
            if (res.paid) return;
            storeSet(CONFIG.storage.lead, { leadId: `91${res.values.phone}`, values: res.values });
            this.els.form.reset();
            this.open(res.planId, 'reminder_email');
        } catch {
            // Expired or invalid link: just show the page.
        }
    },

    // ----- modal --------------------------------------------------------------

    open(planId, location) {
        // Switching plans needs a new order; keep the saved details though.
        if (this.lead && this.lead.plan?.id !== planId) this.lead = null;
        this.planId = PLANS[planId] ? planId : 'diagnosis';
        const plan = { id: this.planId, ...PLANS[this.planId] };

        this.els.planName.textContent = plan.name;
        this.els.planPrice.textContent = `₹${plan.price}`;
        this.prefillForm();
        this.setFormError('');
        this.showView('form');

        this.lastFocus = document.activeElement;
        this.els.modal.hidden = false;
        this.els.modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('lead-modal-open');

        const firstEmpty = [...this.els.form.querySelectorAll('input[required]')].find((i) => !i.value);
        (firstEmpty || this.els.submit).focus({ preventScroll: true });

        // Interest signal only — deliberately NOT a Meta conversion.
        gaEvent('select_item', { item_list_id: location, items: [planItem(plan)] });
        gaEvent('lead_form_open', { plan_id: plan.id, location });
    },

    close() {
        this.els.modal.hidden = true;
        this.els.modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('lead-modal-open');
        this.lastFocus?.focus?.({ preventScroll: true });
    },

    showView(name) {
        this.els.views.forEach((v) => {
            v.hidden = v.dataset.view !== name;
        });
    },

    prefillForm() {
        const saved = storeGet(CONFIG.storage.lead);
        if (!saved?.values) return;
        const { form } = this.els;
        ['name', 'phone', 'email', 'currentStatus'].forEach((key) => {
            const field = form.elements[key];
            if (field && !field.value && saved.values[key]) field.value = saved.values[key];
        });
    },

    formValues() {
        const f = this.els.form.elements;
        return {
            name: f.name.value,
            phone: f.phone.value,
            email: f.email.value,
            currentStatus: f.currentStatus ? f.currentStatus.value : '',
            website: f.website ? f.website.value : '',
        };
    },

    setFieldError(name, message) {
        const field = this.els.form.elements[name];
        field?.closest?.('.lead-field')?.classList.toggle('is-invalid', Boolean(message));
        const slot = this.els.form.querySelector(`[data-error-for="${name}"]`);
        if (slot) slot.textContent = message || '';
    },

    setFormError(message) {
        this.els.formError.textContent = message;
        this.els.formError.hidden = !message;
    },

    setSubmitting(on) {
        this.els.submit.disabled = on;
        const label = this.els.submit.querySelector('.lead-form__submit-label');
        if (label) label.textContent = on ? 'Saving your details…' : 'Continue to secure payment';
    },

    // ----- step 1: lead ---------------------------------------------------------

    async submit() {
        const values = this.formValues();
        const errors = validateLeadForm(values);
        ['name', 'phone', 'email'].forEach((k) => this.setFieldError(k, errors[k]));
        this.setFormError('');
        if (Object.keys(errors).length) {
            this.els.form.elements[Object.keys(errors)[0]].focus();
            gaEvent('lead_form_error', { fields: Object.keys(errors).join(',') });
            return;
        }

        const attribution = getAttribution();
        const phone = normalizePhone(values.phone);
        this.setSubmitting(true);
        try {
            const res = await api('/lead', {
                ...values,
                phone,
                planId: this.planId,
                consent: true,
                attribution: { ...attribution, ...readUrlAttribution() },
                ...getMetaIds(attribution),
            });

            this.lead = res;
            storeSet(CONFIG.storage.lead, {
                leadId: res.leadId,
                values: { name: values.name, phone, email: values.email, currentStatus: values.currentStatus },
            });
            setAnalyticsUser(res.leadId, res.prefill);

            // Count each person once: repeat submissions are not new leads.
            if (res.isNew) {
                metaEvent('Lead', {
                    value: res.plan.price,
                    currency: CONFIG.currency,
                    content_name: res.plan.name,
                    content_ids: [res.plan.id],
                }, res.leadEventId);
                gaEvent('generate_lead', {
                    value: res.plan.price,
                    currency: CONFIG.currency,
                    lead_source: leadSource(attribution),
                    plan_id: res.plan.id,
                });
            } else {
                gaEvent('lead_resubmitted', { plan_id: res.plan.id });
            }

            if (!res.order) {
                this.showRetry(
                    "Payment is temporarily unavailable. Your details are saved — we'll WhatsApp you shortly to confirm your slot.",
                    false,
                );
                gaEvent('checkout_unavailable', { plan_id: res.plan.id });
                return;
            }
            await this.openCheckout();
        } catch (err) {
            if (err.fields) Object.entries(err.fields).forEach(([k, msg]) => this.setFieldError(k, msg));
            this.setFormError(err.message || 'Could not save your details. Please try again.');
            gaEvent('lead_submit_failed', { status: err.status || 0 });
        } finally {
            this.setSubmitting(false);
        }
    },

    // ----- step 2: payment ------------------------------------------------------

    async openCheckout() {
        const { lead } = this;
        if (!lead?.order) {
            this.showView('form');
            return;
        }

        this.showView('processing');
        try {
            await waitFor(() => typeof window.Razorpay === 'function');
        } catch {
            this.showRetry('Could not load the payment window. Check your connection and try again.');
            return;
        }

        const { order, plan, prefill, leadId } = lead;
        const rzp = new window.Razorpay({
            key: order.keyId,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            name: CONFIG.brandName,
            description: plan.name,
            image: `${window.location.origin}/assets/dyc-logo-transparent.png`,
            prefill,
            notes: { leadId, planId: plan.id },
            theme: { color: CONFIG.brandColor },
            retry: { enabled: true },
            handler: (response) => this.verify(response),
            modal: {
                confirm_close: true,
                ondismiss: () => {
                    if (this.verifying) return;
                    apiQuiet('/checkout-event', { leadId, orderId: order.id, type: 'checkout_closed' });
                    gaEvent('checkout_abandoned', { plan_id: plan.id, value: plan.price, currency: CONFIG.currency });
                    this.showRetry('No money was deducted. You can try again — UPI usually works best.');
                },
            },
        });

        rzp.on('payment.failed', (resp) => {
            const reason = resp?.error?.description || resp?.error?.reason || 'unknown';
            apiQuiet('/checkout-event', { leadId, orderId: order.id, type: 'payment_failed', reason: String(reason).slice(0, 200) });
            gaEvent('payment_failed', { plan_id: plan.id, reason: String(reason).slice(0, 100) });
        });

        this.paying = true;
        rzp.open();

        apiQuiet('/checkout-event', { leadId, orderId: order.id, type: 'checkout_opened' });
        metaEvent('InitiateCheckout', {
            value: plan.price,
            currency: CONFIG.currency,
            content_name: plan.name,
            content_ids: [plan.id],
            num_items: 1,
        }, `checkout_${order.id}`);
        gaEvent('begin_checkout', { value: plan.price, currency: CONFIG.currency, items: [planItem(plan)] });
    },

    showRetry(message, canRetry = true) {
        this.paying = false;
        if (this.els.retryMessage) this.els.retryMessage.textContent = message;
        if (this.els.retry) this.els.retry.hidden = !canRetry;
        if (this.els.whatsapp && this.lead?.prefill) {
            const text = `Hi, I'm ${this.lead.prefill.name}. I tried to book the ${this.lead.plan?.name || 'session'} on DebugYourCareer and need help with the payment.`;
            this.els.whatsapp.href = `https://wa.me/${CONFIG.whatsappNumber}?text=${encodeURIComponent(text)}`;
        }
        this.showView('retry');
    },

    // ----- step 3: verify -------------------------------------------------------

    async verify(response) {
        const { lead } = this;
        this.verifying = true;
        this.showView('verifying');
        try {
            const res = await api('/verify', {
                leadId: lead.leadId,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
            });

            metaEvent('Purchase', {
                value: res.plan.price,
                currency: CONFIG.currency,
                content_name: res.plan.name,
                content_ids: [res.plan.id],
                content_type: 'product',
                num_items: 1,
            }, res.purchaseEventId);
            gaEvent('purchase', {
                transaction_id: res.paymentId,
                value: res.plan.price,
                currency: CONFIG.currency,
                items: [planItem(res.plan)],
            });

            const booking = {
                leadId: lead.leadId,
                paymentId: res.paymentId,
                plan: res.plan,
                bookingUrl: res.bookingUrl,
                prefill: lead.prefill,
                savedAt: Date.now(),
            };
            storeSet(CONFIG.storage.booking, booking);
            this.lead = null;

            this.verifying = false;
            this.paying = false;
            this.close();
            this.showBooking(booking);
        } catch (err) {
            // The Razorpay webhook still marks the payment paid; give the user a human path.
            gaEvent('payment_verify_failed', { status: err.status || 0 });
            this.verifying = false;
            this.showRetry(
                "We received your payment but couldn't confirm it automatically. Please don't pay again — message us on WhatsApp and we'll book your slot right away.",
                false,
            );
        }
    },

    // ----- step 4: Calendly -----------------------------------------------------

    showBooking(booking) {
        const section = document.getElementById('booking-success');
        const widget = document.getElementById('calendly-inline-widget');
        const planCopy = document.getElementById('booking-plan-copy');
        const directLink = document.getElementById('calendly-direct-link');
        const setupNote = document.getElementById('calendly-setup-note');
        const url = buildCalendlyUrl(booking);

        if (!section || !widget) {
            window.open(url, '_blank', 'noopener');
            return;
        }

        if (planCopy) planCopy.textContent = `Your ${booking.plan.name} (₹${booking.plan.price}) payment is confirmed. Pick a time below.`;
        if (directLink) {
            directLink.href = url;
            directLink.hidden = false;
        }
        if (setupNote) setupNote.hidden = true;

        section.hidden = false;
        document.body.classList.add('payment-success-active');
        requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));

        waitFor(() => typeof window.Calendly?.initInlineWidget === 'function')
            .then(() => {
                widget.innerHTML = '';
                window.Calendly.initInlineWidget({
                    url: booking.bookingUrl,
                    parentElement: widget,
                    prefill: calendlyPrefill(booking.prefill, booking.plan),
                    utm: calendlyUtm(),
                });
            })
            .catch(() => {
                if (setupNote) {
                    setupNote.textContent = 'The scheduler did not load. Use the button below to pick your slot.';
                    setupNote.hidden = false;
                }
            });

        gaEvent('booking_view', { plan_id: booking.plan.id });
    },

    async resumePendingBooking() {
        const pending = storeGet(CONFIG.storage.booking);
        if (!pending?.leadId || !pending?.paymentId) return;
        try {
            const res = await api('/booking-link', { leadId: pending.leadId, paymentId: pending.paymentId });
            if (res.booked) {
                storeRemove(CONFIG.storage.booking);
                return;
            }
            const booking = { ...pending, bookingUrl: res.bookingUrl, plan: res.plan || pending.plan };
            storeSet(CONFIG.storage.booking, booking);
            this.showBooking(booking);
        } catch (err) {
            if (err.status === 404 || err.status === 400) storeRemove(CONFIG.storage.booking);
        }
    },

    onCalendlyMessage(e) {
        if (e.origin !== 'https://calendly.com' || e.data?.event !== 'calendly.event_scheduled') return;
        const pending = storeGet(CONFIG.storage.booking);
        if (!pending) return;

        apiQuiet('/booked', {
            leadId: pending.leadId,
            paymentId: pending.paymentId,
            eventUri: e.data.payload?.event?.uri || '',
        });
        metaEvent('Schedule', { content_name: pending.plan?.name }, `schedule_${pending.paymentId}`);
        gaEvent('schedule', { plan_id: pending.plan?.id, transaction_id: pending.paymentId });
        storeRemove(CONFIG.storage.booking);
    },
};

// ---------------------------------------------------------------------------
// Calendly helpers
// ---------------------------------------------------------------------------

/**
 * a1 = first custom question on the Calendly event (set it to "WhatsApp number").
 * a2 = second custom question (optional, "Plan").
 */
function calendlyPrefill(prefill, plan) {
    return {
        name: prefill?.name || '',
        email: prefill?.email || '',
        customAnswers: { a1: prefill?.contact || '', a2: plan?.name || '' },
    };
}

function calendlyUtm() {
    const a = getAttribution();
    return {
        utmSource: a.utm_source || '',
        utmMedium: a.utm_medium || '',
        utmCampaign: a.utm_campaign || '',
        utmContent: a.utm_content || '',
        utmTerm: a.utm_term || '',
    };
}

/** Same prefill as the embed, for the "open in new tab" fallback. */
function buildCalendlyUrl(booking) {
    const url = new URL(booking.bookingUrl);
    const p = calendlyPrefill(booking.prefill, booking.plan);
    if (p.name) url.searchParams.set('name', p.name);
    if (p.email) url.searchParams.set('email', p.email);
    if (p.customAnswers.a1) url.searchParams.set('a1', p.customAnswers.a1);
    if (p.customAnswers.a2) url.searchParams.set('a2', p.customAnswers.a2);
    return url.toString();
}
