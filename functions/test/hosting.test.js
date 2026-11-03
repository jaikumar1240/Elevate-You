'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { hosting } = require('../../firebase.json');

function isIgnored(file) {
    return hosting.ignore.some((pattern) => path.matchesGlob(file, pattern));
}

test('hosting excludes files inside hidden directories', () => {
    for (const file of [
        '.git/fsmonitor--daemon.ipc',
        '.git/worktrees/example/fsmonitor--daemon.ipc',
        '.github/workflows/deploy.yml',
        '.firebase/hosting.cache',
    ]) {
        assert.ok(isIgnored(file), `${file} must not be deployed`);
    }
});

test('hosting excludes deployment and emulator logs', () => {
    for (const file of ['firebase-debug.log', 'firestore-debug.log', 'logs/emulator.log']) {
        assert.ok(isIgnored(file), `${file} must not be deployed`);
    }
});
