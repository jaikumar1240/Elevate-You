'use strict';

/**
 * Payment reminder: one friendly email to leads who filled the form but didn't
 * pay. /lead sets `reminderDueAt`; markPaid clears it; the scheduled job below
 * claims it in a transaction (re-checking the lead is still unpaid), then sends.
 * Delivery is at most once: a crash after the claim drops the email rather than
 * duplicating it, and a failed send releases the claim for a retry.
 */

const UNPAID_STATUSES = new Set(['new', 'checkout_started', 'checkout_abandoned', 'payment_failed']);
const REMINDER_DELAY_MS = 30 * 60 * 1000;
const REMINDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toDate = (v) => (v?.toDate ? v.toDate() : new Date(v));

function reminderEmail({ name, planName, price, resumeUrl, whatsappUrl }) {
    const first = String(name || '').trim().split(/\s+/)[0] || 'there';
    const subject = `${first}, your ${planName} is one step away`;
    const text = [
        `Hi ${first},`,
        '',
        `You started booking the ${planName} (₹${price}) on DebugYourCareer but the payment didn't go through.`,
        '',
        `Your details are saved — finish in one click: ${resumeUrl}`,
        '',
        `Payment trouble or a question? WhatsApp me: ${whatsappUrl}`,
        '',
        'Jai',
        'DebugYourCareer',
    ].join('\n');
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#14162b;max-width:520px">
<p>Hi ${esc(first)},</p>
<p>You started booking the <b>${esc(planName)}</b> (₹${esc(price)}) on DebugYourCareer but the payment didn't go through.</p>
<p>Your details are saved — you can finish in one click:</p>
<p><a href="${esc(resumeUrl)}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Complete my booking</a></p>
<p>Payment trouble or a question? <a href="${esc(whatsappUrl)}">WhatsApp me</a> and I'll help you get a slot.</p>
<p>Jai<br>DebugYourCareer</p>
</div>`;
    return { subject, text, html };
}

/** Sends due reminders. Returns counts for logging. */
async function sendPaymentReminders({ db, FieldValue, cfg, sendLeadEmail, now = new Date() }) {
    const snap = await db.collection('leads').where('reminderDueAt', '<=', now).limit(BATCH_SIZE).get();
    const counts = { sent: 0, skipped: 0, failed: 0 };

    for (const doc of snap.docs) {
        // Claim in a transaction so the latest state is re-checked (e.g. a payment that just
        // landed) and the reminder is removed from the queue *before* sending. If the function
        // dies after this point the email is simply not sent, rather than sent twice.
        const claim = await db.runTransaction(async (tx) => {
            const fresh = await tx.get(doc.ref);
            const lead = fresh.exists ? fresh.data() : null;
            if (!lead || !lead.reminderDueAt || toDate(lead.reminderDueAt) > now) return { lead: null, drop: false };
            const stale = now - toDate(lead.reminderDueAt) > REMINDER_MAX_AGE_MS;
            const eligible = UNPAID_STATUSES.has(lead.status) && !lead.reminderSentAt && !lead.reminderClaimedAt
                && !stale && lead.email && lead.resumeToken;
            tx.update(doc.ref, eligible
                ? { reminderDueAt: FieldValue.delete(), reminderClaimedAt: now }
                : { reminderDueAt: FieldValue.delete() });
            return { lead: eligible ? lead : null, drop: !eligible, dueAt: lead.reminderDueAt };
        });
        if (!claim.lead) {
            if (claim.drop) counts.skipped++;
            continue;
        }
        const lead = claim.lead;

        const whatsappText = `Hi, I was booking the ${lead.planName} and had trouble with the payment.`;
        const result = await sendLeadEmail({
            fromEmail: cfg.adminEmail,
            appPassword: cfg.gmailAppPassword,
            to: lead.email,
            ...reminderEmail({
                name: lead.name,
                planName: lead.planName,
                price: lead.price,
                resumeUrl: `${cfg.siteUrl}/?resume=${encodeURIComponent(lead.resumeToken)}`,
                whatsappUrl: `https://wa.me/${cfg.whatsappNumber}?text=${encodeURIComponent(whatsappText)}`,
            }),
        });

        if (result.ok) {
            await doc.ref.update({
                reminderSentAt: FieldValue.serverTimestamp(),
                history: FieldValue.arrayUnion({ type: 'reminder_sent', at: now.toISOString() }),
            });
            counts.sent++;
        } else {
            // Release the claim so the next run retries, unless the lead paid meanwhile.
            await db.runTransaction(async (tx) => {
                const fresh = (await tx.get(doc.ref)).data() || {};
                tx.update(doc.ref, UNPAID_STATUSES.has(fresh.status)
                    ? { reminderClaimedAt: FieldValue.delete(), reminderDueAt: claim.dueAt }
                    : { reminderClaimedAt: FieldValue.delete() });
            });
            counts.failed++;
        }
    }
    return counts;
}

module.exports = { sendPaymentReminders, reminderEmail, UNPAID_STATUSES, REMINDER_DELAY_MS };
