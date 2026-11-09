// local-store.js — a small stand-in for the Firestore compat API, backed by localStorage.
// Covers only what App.js uses: collection/doc/get/set(merge)/add/update/delete,
// where(==, array-contains), orderBy, limit, FieldValue.arrayUnion.
// Also: PrefixedStore wraps a real Firestore so every top-level collection gets a
// prefix (e.g. "imjax_users"), keeping this app's data apart from MyPaceZone's.

(function (root) {
  "use strict";

  function autoId() {
    const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = ""; for (let i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const isArrayUnion = v => v && typeof v === "object" && v.__imOp === "arrayUnion";

  function applyOps(existing, incoming) {
    const out = Object.assign({}, existing || {});
    for (const [k, v] of Object.entries(incoming)) {
      if (v === undefined) continue;
      if (isArrayUnion(v)) {
        const arr = Array.isArray(out[k]) ? out[k].slice() : [];
        v.values.forEach(x => { if (!arr.some(y => JSON.stringify(y) === JSON.stringify(x))) arr.push(x); });
        out[k] = arr;
      } else out[k] = clone(v);
    }
    return out;
  }

  function create(ns) {
    const KEY = `${ns}:db:v1`;
    let mem = null;
    function load() {
      if (mem) return mem;
      try { mem = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { mem = {}; }
      return mem;
    }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) { console.warn("local store save failed", e); } }
    function coll(path) { const m = load(); return (m[path] = m[path] || {}); }

    function docSnap(collPath, id) {
      const data = load()[collPath] && load()[collPath][id];
      return { id, exists: data !== undefined, data: () => clone(data), ref: docRef(collPath, id) };
    }
    function docRef(collPath, id) {
      return {
        id, path: `${collPath}/${id}`,
        collection: sub => collRef(`${collPath}/${id}/${sub}`),
        get: async () => docSnap(collPath, id),
        set: async (data, opts) => {
          const c = coll(collPath);
          c[id] = opts && opts.merge ? applyOps(c[id], data) : applyOps({}, data);
          save();
        },
        update: async data => {
          const c = coll(collPath);
          if (c[id] === undefined) throw new Error(`No document to update: ${collPath}/${id}`);
          c[id] = applyOps(c[id], data); save();
        },
        delete: async () => { const c = coll(collPath); delete c[id]; save(); }
      };
    }
    function query(collPath, filters, order, lim) {
      const q = {
        where: (f, op, v) => query(collPath, filters.concat([[f, op, v]]), order, lim),
        orderBy: (f, dir) => query(collPath, filters, [f, dir || "asc"], lim),
        limit: n => query(collPath, filters, order, n),
        get: async () => {
          let rows = Object.entries(coll(collPath)).map(([id, data]) => ({ id, data }));
          for (const [f, op, v] of filters) {
            rows = rows.filter(r => {
              const x = r.data[f];
              if (op === "==") return x === v;
              if (op === "array-contains") return Array.isArray(x) && x.includes(v);
              throw new Error("local store: unsupported operator " + op);
            });
          }
          if (order) {
            const [f, dir] = order, s = dir === "desc" ? -1 : 1;
            rows.sort((a, b) => (a.data[f] > b.data[f] ? 1 : a.data[f] < b.data[f] ? -1 : 0) * s);
          }
          if (lim != null) rows = rows.slice(0, lim);
          const docs = rows.map(r => docSnap(collPath, r.id));
          return { docs, size: docs.length, empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
        }
      };
      return q;
    }
    function collRef(path) {
      const q = query(path, [], null, null);
      return Object.assign(q, {
        path,
        doc: id => docRef(path, id || autoId()),
        add: async data => { const id = autoId(); await docRef(path, id).set(data); return docRef(path, id); }
      });
    }
    return {
      isLocal: true,
      collection: path => collRef(path),
      exportJSON: () => JSON.stringify(load(), null, 2),
      importJSON: str => { mem = JSON.parse(str); save(); },
      wipe: () => { mem = {}; save(); }
    };
  }

  function wrapPrefixed(realDb, prefix) {
    return { isLocal: false, collection: name => realDb.collection((prefix || "") + name) };
  }

  // Minimal firebase global for local mode (App.js calls firebase.firestore.FieldValue.arrayUnion)
  if (typeof root.firebase === "undefined") {
    root.firebase = { firestore: { FieldValue: { arrayUnion: (...values) => ({ __imOp: "arrayUnion", values }) } } };
  }

  root.LocalStore = { create };
  root.PrefixedStore = { wrap: wrapPrefixed };
})(typeof window !== "undefined" ? window : globalThis);
