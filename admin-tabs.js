'use strict';

(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    const shared = [...document.querySelectorAll('[data-admin-shared]')];

    function activate(tab) {
        const panelId = tab.getAttribute('aria-controls');
        tabs.forEach((item) => {
            item.setAttribute('aria-selected', String(item === tab));
            item.tabIndex = item === tab ? 0 : -1;
        });
        panels.forEach((panel) => { panel.hidden = panel.id !== panelId; });
        shared.forEach((element) => {
            element.hidden = !element.dataset.adminShared.split(' ').includes(panelId.replace('panel-', ''));
        });
    }

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => activate(tab));
        tab.addEventListener('keydown', (event) => {
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabs.length - 1;
            else return;
            event.preventDefault();
            activate(tabs[next]);
            tabs[next].focus();
        });
    });
    activate(tabs[0]);
})();
