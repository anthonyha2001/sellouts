/* ============================================================
   LocalAdapter — keeps everything in this browser (localStorage),
   falling back to memory when storage is blocked.
   Used by demo.html. The real app uses SupabaseAdapter instead;
   both have exactly the same methods (see WIRING.md).
   ============================================================ */
(function (global) {
  'use strict';
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function LocalAdapter(opts = {}) {
    const key = opts.storageKey || 'store-map-demo-v1';
    let mem = null;
    const read = () => {
      if (mem) return mem;
      try { const raw = localStorage.getItem(key); if (raw) mem = JSON.parse(raw); } catch (e) { /* storage blocked */ }
      if (!mem) mem = seed(opts);
      return mem;
    };
    const write = () => { try { localStorage.setItem(key, JSON.stringify(mem)); } catch (e) { /* storage blocked or full: keep in memory */ } };
    const delay = (v) => new Promise(r => setTimeout(() => r(clone(v)), 60));

    return {
      async sharePdf(blob) { return URL.createObjectURL(blob); },   // demo: a link on this device only
      async loadConfig() { return delay(read().config || null); },
      async saveConfig(cfg) { read().config = clone(cfg); write(); return delay(cfg); },

      async listFloors() { return delay(read().floors); },
      async saveFloor(f) {
        const d = read(), i = d.floors.findIndex(x => x.id === f.id);
        if (i > -1) d.floors[i] = clone(f); else { d.floors.push(clone(f)); d.objects[f.id] = d.objects[f.id] || []; }
        write(); return delay(f);
      },

      async listObjects(floorId) { return delay(read().objects[floorId] || []); },
      async saveLayout(floorId, objects, meta = {}) {
        const d = read();
        d.objects[floorId] = clone(objects);
        d.versions.unshift({ id: 'v-' + Date.now(), floorId, createdAt: new Date().toISOString(), note: meta.note || '', by: opts.userName || 'You', objects: clone(objects) });
        d.versions = d.versions.slice(0, 30);
        write(); return delay(true);
      },
      async listLayoutVersions(floorId) { return delay(read().versions.filter(v => v.floorId === floorId).map(({ objects, ...v }) => v)); },
      async restoreLayoutVersion(id) { const v = read().versions.find(x => x.id === id); if (!v) throw new Error('Version not found'); return delay(v.objects); },

      async listContracts() { return delay(read().contracts); },
      async saveContract(c) {
        const d = read(), i = d.contracts.findIndex(x => x.id === c.id);
        if (i > -1) d.contracts[i] = clone(c); else d.contracts.push(clone(c));
        write(); return delay(c);
      },
      async deleteContract(id) { const d = read(); d.contracts = d.contracts.filter(x => x.id !== id); write(); return delay(true); },

      /* demo helper: start over from the traced plan */
      reset() { try { localStorage.removeItem(key); } catch (e) { } mem = null; }
    };
  }

  function seed(opts) {
    const S = global.STORE_MAP_SEED || {};
    const floors = [], objects = {};
    Object.values(S).forEach(({ floor, objects: objs }) => { floors.push(clone(floor)); objects[floor.id] = clone(objs); });
    (opts.extraFloors || []).forEach(f => { if (!objects[f.id]) { floors.push(clone(f)); objects[f.id] = []; } });
    return { config: null, floors, objects, versions: [], contracts: clone(opts.sampleContracts || []) };
  }

  global.StoreMapLocalAdapter = LocalAdapter;
})(window);
