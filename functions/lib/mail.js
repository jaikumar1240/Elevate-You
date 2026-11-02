'use strict';

const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let transporter;
let transporterKey;

function getTransport(user, pass) {
    const key = `${user}:${pass}`;
    if (!transporter || transporterKey !== key) {
        transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
        transporterKey = key;
    }
    return transporter;
}

/** Sends an alert to the admin. Never throws. */
async function sendAlert({ adminEmail, appPassword, subject, rows, siteUrl }) {
    if (!adminEmail || !appPassword) return { skipped: true };
    const table = rows
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`)
        .join('');
    const phone = rows.find(([k]) => k === 'Phone')?.[1];
    const actions = phone
        ? `<p><a href="tel:+91${esc(phone)}">Call</a> · <a href="https://wa.me/91${esc(phone)}">WhatsApp</a> · <a href="${esc(siteUrl)}/admin">Open CRM</a></p>`
        : '';
    try {
        await getTransport(adminEmail, appPassword).sendMail({
            from: `DebugYourCareer Leads <${adminEmail}>`,
            to: adminEmail,
            subject,
            html: `<table>${table}</table>${actions}`,
        });
        return { ok: true };
    } catch (err) {
        logger.warn('Alert email failed', { subject, error: err.message });
        return { ok: false };
    }
}

/** Emails a lead (customer-facing). Never throws. */
async function sendLeadEmail({ fromEmail, appPassword, to, subject, text, html }) {
    if (!fromEmail || !appPassword || !to) return { skipped: true };
    try {
        await getTransport(fromEmail, appPassword).sendMail({
            from: `Jai from DebugYourCareer <${fromEmail}>`,
            replyTo: fromEmail,
            to,
            subject,
            text,
            html,
        });
        return { ok: true };
    } catch (err) {
        logger.warn('Lead email failed', { subject, error: err.message });
        return { ok: false };
    }
}

module.exports = { sendAlert, sendLeadEmail, esc };
