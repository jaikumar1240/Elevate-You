'use strict';

(() => {
    const $ = (id) => document.getElementById(id);
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let user;
    let catalog;
    let dirty = false;

    function render() {
        $('catalogAnnouncement').value = catalog.announcement;
        $('catalogEnabled').checked = catalog.checkoutEnabled;
        $('catalogPlans').innerHTML = catalog.plans.map((plan, index) => `
            <fieldset class="catalog-plan" data-index="${index}">
                <legend>${escape(plan.name)}${plan.active ? '' : ' (archived)'}</legend>
                <div class="catalog-fields">
                    <label>Plan ID <input name="id" value="${escape(plan.id)}" ${plan.isNew ? '' : 'readonly'}
                        required pattern="[a-z][a-z0-9-]{0,39}" maxlength="40"></label>
                    <label>Name <input name="name" value="${escape(plan.name)}" required maxlength="80"></label>
                    <label>Price (INR) <input name="price" type="number" value="${plan.price}" required min="1" max="1000000" step="0.01"></label>
                    <label>Price suffix <input name="period" value="${escape(plan.period)}" required maxlength="40"></label>
                    <label>Badge <input name="badge" value="${escape(plan.badge)}" maxlength="40" placeholder="e.g. Most popular"></label>
                    <label class="catalog-check"><input name="active" type="checkbox" ${plan.active ? 'checked' : ''}> Available to buy (uncheck to archive)</label>
                </div>
                <label>Description <textarea name="description" rows="2" required maxlength="600">${escape(plan.description)}</textarea></label>
                <label>Features (one per line, up to 10, 160 characters each)
                    <textarea name="features" rows="4" required>${escape(plan.features.join('\n'))}</textarea></label>
                <div class="actions">
                    <button class="btn btn--sm" type="button" data-move="-1" ${index === 0 ? 'disabled' : ''}>Move up</button>
                    <button class="btn btn--sm" type="button" data-move="1" ${index === catalog.plans.length - 1 ? 'disabled' : ''}>Move down</button>
                </div>
            </fieldset>`).join('');
        $('catalogHistory').innerHTML = catalog.history.length
            ? catalog.history.map((entry) => `<li>Version ${entry.revision} &middot; ${escape(entry.at)}
                &middot; ${escape(entry.by)}<br>${escape(entry.summary)}</li>`).join('')
            : '<li>No published changes yet.</li>';
    }

    async function request(method, body) {
        const token = await user.getIdToken();
        const response = await fetch('/api/admin/catalog', {
            method, cache: 'no-store',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (response.status === 404) {
            throw new Error('The catalog API is not deployed. Deploy functions:api before Hosting, then reload this page.');
        }
        let result;
        try {
            result = await response.json();
        } catch {
            throw new Error(`Catalog service returned an invalid response (HTTP ${response.status}). Your draft is unchanged. Check the latest saved version before you retry publishing.`);
        }
        if (!response.ok) throw new Error(result.error || 'Could not load or save the catalog.');
        return result;
    }

    function readForm() {
        return {
            revision: catalog.revision,
            announcement: $('catalogAnnouncement').value,
            checkoutEnabled: $('catalogEnabled').checked,
            plans: [...$('catalogPlans').querySelectorAll('fieldset')].map((fieldset) => {
                const field = (name) => fieldset.querySelector(`[name="${name}"]`);
                return {
                    id: field('id').value, name: field('name').value, price: Number(field('price').value),
                    description: field('description').value, period: field('period').value,
                    badge: field('badge').value, active: field('active').checked,
                    features: field('features').value.split('\n').map((line) => line.trim()).filter(Boolean),
                    isNew: !catalog.plans.some((plan) => !plan.isNew && plan.id === field('id').value),
                };
            }),
        };
    }

    $('catalogForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!catalog || $('catalogSave').disabled) return;
        const draft = readForm();
        const savingUser = user;
        $('catalogSave').disabled = true;
        $('catalogFields').disabled = true;
        $('catalogStatus').textContent = 'Publishing...';
        try {
            const saved = await request('POST', draft);
            if (user !== savingUser) return;
            catalog = saved;
            dirty = false;
            render();
            $('catalogStatus').textContent = `Published version ${catalog.revision}. Reload the website to see your changes.`;
        } catch (error) {
            if (user === savingUser) $('catalogStatus').textContent = error.message;
        } finally {
            if (user === savingUser) {
                $('catalogSave').disabled = false;
                $('catalogFields').disabled = false;
            }
        }
    });

    $('catalogAdd').addEventListener('click', () => {
        if (!catalog || $('catalogSave').disabled) return;
        if (catalog.plans.length >= 20) {
            $('catalogStatus').textContent = 'Up to 20 plans are supported, including archived plans.';
            return;
        }
        catalog = { ...catalog, ...readForm() };
        let id = 'new-plan';
        let suffix = 1;
        while (catalog.plans.some((plan) => plan.id === id)) id = `new-plan-${suffix++}`;
        catalog.plans.push({
            id, name: 'New plan', price: 99, period: '/ session', description: '',
            features: [''], badge: '', active: false, isNew: true,
        });
        dirty = true;
        render();
        $('catalogStatus').textContent = 'New plan added as archived. Fill in the details and enable it when ready.';
    });

    $('catalogPlans').addEventListener('click', (event) => {
        const button = event.target.closest('[data-move]');
        if (!button || button.disabled || !catalog || $('catalogSave').disabled) return;
        const index = Number(button.closest('[data-index]').dataset.index);
        const next = index + Number(button.dataset.move);
        if (next < 0 || next >= catalog.plans.length) return;
        catalog = { ...catalog, ...readForm() };
        [catalog.plans[index], catalog.plans[next]] = [catalog.plans[next], catalog.plans[index]];
        dirty = true;
        render();
    });

    $('catalogReload').addEventListener('click', () => {
        if (user && (!$('catalogSave').disabled || !catalog)) window.initCatalogAdmin(user);
    });
    $('catalogForm').addEventListener('input', () => {
        dirty = true;
        $('catalogStatus').textContent = 'Unsaved edits. Publish changes when ready.';
    });
    window.addEventListener('beforeunload', (event) => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = '';
    });

    window.initCatalogAdmin = async (identity) => {
        user = identity;
        catalog = null;
        dirty = false;
        $('catalogSave').disabled = true;
        $('catalogFields').disabled = true;
        $('catalogPlans').innerHTML = '';
        $('catalogHistory').innerHTML = '';
        $('catalogAnnouncement').value = '';
        $('catalogEnabled').checked = false;
        $('catalogStatus').textContent = '';
        if (!identity) return;
        $('catalogStatus').textContent = 'Loading plans...';
        try {
            const loaded = await request('GET');
            if (user !== identity) return;
            catalog = loaded;
            dirty = false;
            render();
            $('catalogSave').disabled = false;
            $('catalogFields').disabled = false;
            $('catalogStatus').textContent = `Version ${catalog.revision}. Changes go live only when you publish.`;
        } catch (error) {
            if (user === identity) {
                $('catalogStatus').textContent = error.message;
                $('catalogFields').disabled = false;
            }
        }
    };
})();
