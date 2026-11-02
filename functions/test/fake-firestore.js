'use strict';

// Minimal in-memory stand-in for the Firestore Admin API used by lib/app.js.
const OPS = Symbol('op');

const FieldValue = {
    serverTimestamp: () => ({ [OPS]: 'ts' }),
    increment: (n) => ({ [OPS]: 'inc', n }),
    arrayUnion: (...items) => ({ [OPS]: 'union', items }),
    delete: () => ({ [OPS]: 'delete' }),
};

const COMPARE = {
    '==': (a, b) => a === b,
    '<=': (a, b) => a !== undefined && a <= b,
};

function apply(existing = {}, patch) {
    const out = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v && v[OPS] === 'delete') delete out[k];
        else if (v && v[OPS] === 'ts') out[k] = new Date();
        else if (v && v[OPS] === 'inc') out[k] = (out[k] || 0) + v.n;
        else if (v && v[OPS] === 'union') out[k] = [...(out[k] || []), ...v.items];
        else out[k] = v;
    }
    return out;
}

function createDb() {
    const store = new Map();
    const docRef = (col, id) => ({
        id,
        path: `${col}/${id}`,
        async get() {
            const data = store.get(`${col}/${id}`);
            return { id, exists: !!data, data: () => data && { ...data } };
        },
        async set(data) { store.set(`${col}/${id}`, apply({}, data)); },
        async update(data) {
            const key = `${col}/${id}`;
            if (!store.has(key)) throw new Error(`NOT_FOUND ${key}`);
            store.set(key, apply(store.get(key), data));
        },
    });
    const queryOf = (col, filters, max) => ({
        where: (field, op, value) => queryOf(col, [...filters, { field, op, value }], max),
        limit: (n) => queryOf(col, filters, n),
        async get() {
            const docs = [...store.entries()]
                .filter(([key]) => key.startsWith(`${col}/`))
                .map(([key, data]) => ({ id: key.slice(col.length + 1), data }))
                .filter(({ data }) => filters.every(({ field, op, value }) => COMPARE[op](data[field], value)))
                .slice(0, max)
                .map(({ id, data }) => ({ id, ref: docRef(col, id), data: () => ({ ...data }) }));
            return { empty: docs.length === 0, size: docs.length, docs };
        },
    });
    return {
        store,
        collection: (col) => ({ doc: (id) => docRef(col, id), ...queryOf(col, [], Infinity) }),
        async runTransaction(fn) {
            const writes = [];
            const tx = {
                get: (ref) => ref.get(),
                set: (ref, data) => writes.push(() => ref.set(data)),
                update: (ref, data) => writes.push(() => ref.update(data)),
            };
            const result = await fn(tx);
            for (const w of writes) await w();
            return result;
        },
    };
}

module.exports = { createDb, FieldValue };
