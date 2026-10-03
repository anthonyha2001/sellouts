/* ============================================================
   SupabaseAdapter — the real data layer for the store map.
   Same methods as LocalAdapter. Needs the tables in schema.sql.

     const adapter = StoreMapSupabaseAdapter(sb, {
       userName: currentProfile.display_name,   // shown in layout history
       bucket: 'store-maps'                     // Storage bucket for tracing images
     });

   Wired into the app on 2026-09-29 (supabase/migrations/012_store_map.sql).
   saveContract writes only the columns below, so monthly_sales and the
   legacy_* columns of migrated contracts are never overwritten.
   ============================================================ */
(function (global) {
  'use strict';

  function SupabaseAdapter(sb, opts = {}) {
    const bucket = opts.bucket || 'store-maps';
    const must = ({ data, error }) => { if (error) throw error; return data; };

    const objToRow = (floorId, o, i) => ({
      id: o.id, floor_id: floorId, type: o.type,
      x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0,
      label: o.label || null, occupant: o.occupant || null,
      sections_a: o.sectionsA || null, sections_b: o.sectionsB || null,
      props: o.props || null, sort: i, updated_at: new Date().toISOString()
    });
    const rowToObj = (r) => {
      const o = { id: r.id, type: r.type, x: +r.x, y: +r.y, w: +r.w, h: +r.h, rot: +r.rot || 0, label: r.label || '', occupant: r.occupant || '' };
      if (r.sections_a) o.sectionsA = r.sections_a;
      if (r.sections_b) o.sectionsB = r.sections_b;
      if (r.props) o.props = r.props;
      return o;
    };
    const cToRow = (c) => ({
      id: c.id, spot_id: c.spotId || null, supplier: c.supplier, term: c.term,
      start_date: c.start, end_date: c.end, amount: Number(c.amount) || 0,
      billed: !!c.billed, billed_at: c.billedAt || null, paid: !!c.paid, paid_at: c.paidAt || null,
      note: c.note || null, updated_at: new Date().toISOString()
    });
    const rowToC = (r) => ({
      id: r.id, spotId: r.spot_id, supplier: r.supplier, term: r.term, start: r.start_date, end: r.end_date,
      amount: Number(r.amount) || 0, billed: !!r.billed, billedAt: r.billed_at, paid: !!r.paid, paidAt: r.paid_at,
      note: r.note || '', legacyLabel: r.legacy_label || '',
      legacyRentalId: r.legacy_rental_id || null, sales: r.monthly_sales || null   // sales: kept, never written by the map
    });

    // Tracing images live in Storage (private bucket); the floor row keeps only the path.
    async function traceToStorage(floor) {
      const t = floor.trace;
      if (!t || !t.src || !t.src.startsWith('data:')) return t ? Object.assign({}, t, { src: undefined }) : null;
      const blob = await (await fetch(t.src)).blob();
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const path = `${floor.id}/trace-${Date.now()}.${ext}`;
      must(await sb.storage.from(bucket).upload(path, blob, { contentType: blob.type, upsert: true }));
      return { path, x: t.x, y: t.y, w: t.w, h: t.h, opacity: t.opacity, visible: t.visible };
    }
    async function signTrace(trace) {
      if (!trace || !trace.path) return trace || undefined;
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(trace.path, 60 * 60 * 12);
      if (error) { console.warn('Tracing image unavailable', error); return Object.assign({}, trace, { visible: false }); }
      return Object.assign({}, trace, { src: data.signedUrl });
    }

    return {
      async loadConfig() {
        const r = must(await sb.from('store_map_config').select('*').eq('id', 'singleton').maybeSingle());
        return r ? { types: r.types || null, cats: r.cats || null } : null;
      },
      async saveConfig(cfg) {
        must(await sb.from('store_map_config').upsert({ id: 'singleton', types: cfg.types, cats: cfg.cats, updated_at: new Date().toISOString() }));
        return cfg;
      },

      async listFloors() {
        const rows = must(await sb.from('store_floors').select('*').order('sort'));
        return Promise.all(rows.map(async r => ({ id: r.id, name: r.name, width: r.width, height: r.height, sort: r.sort, trace: await signTrace(r.trace) })));
      },
      async saveFloor(f) {
        const trace = await traceToStorage(f);
        must(await sb.from('store_floors').upsert({ id: f.id, name: f.name, width: Math.round(f.width), height: Math.round(f.height), sort: f.sort || 0, trace, updated_at: new Date().toISOString() }));
        if (trace && trace.path && f.trace && f.trace.src && f.trace.src.startsWith('data:')) {
          // keep the in-memory copy displayable without re-downloading
          f.trace.path = trace.path;
        }
        return f;
      },

      async listObjects(floorId) {
        let out = [];
        for (let from = 0; ; from += 1000) {
          const rows = must(await sb.from('store_map_objects').select('*').eq('floor_id', floorId).order('sort').range(from, from + 999));
          out = out.concat(rows);
          if (rows.length < 1000) break;
        }
        return out.map(rowToObj);
      },
      // Replaces the floor's layout: upsert every object, delete the ones that were removed,
      // then keep a snapshot in store_layout_versions so it can be restored later.
      async saveLayout(floorId, objects, meta = {}) {
        const rows = objects.map((o, i) => objToRow(floorId, o, i));
        for (let i = 0; i < rows.length; i += 500) must(await sb.from('store_map_objects').upsert(rows.slice(i, i + 500)));
        const existing = must(await sb.from('store_map_objects').select('id').eq('floor_id', floorId));
        const keep = new Set(objects.map(o => o.id));
        const gone = existing.map(r => r.id).filter(id => !keep.has(id));
        for (let i = 0; i < gone.length; i += 200) must(await sb.from('store_map_objects').delete().in('id', gone.slice(i, i + 200)));
        must(await sb.from('store_layout_versions').insert({ floor_id: floorId, objects, note: meta.note || null, created_by_name: opts.userName || null }));
        return true;
      },
      async listLayoutVersions(floorId) {
        const rows = must(await sb.from('store_layout_versions').select('id, created_at, note, created_by_name').eq('floor_id', floorId).order('created_at', { ascending: false }).limit(50));
        return rows.map(r => ({ id: String(r.id), createdAt: r.created_at, note: r.note, by: r.created_by_name }));
      },
      async restoreLayoutVersion(id) {
        const r = must(await sb.from('store_layout_versions').select('objects').eq('id', id).single());
        return r.objects || [];
      },

      async listContracts() {
        // Map only (rentals.map, migration 037): supplier, spot, term and dates — no amounts, billing or payments.
        if (opts.mapOnly) return must(await sb.rpc('rental_map_contracts')).map(r => Object.assign(rowToC(r), { amount: null, billed: true, paid: true, note: '' }));
        let out = [];
        for (let from = 0; ; from += 1000) {
          const rows = must(await sb.from('rental_contracts').select('*').order('start_date').range(from, from + 999));
          out = out.concat(rows);
          if (rows.length < 1000) break;
        }
        return out.map(rowToC);
      },
      async saveContract(c) {
        const r = must(await sb.from('rental_contracts').upsert(cToRow(c)).select().single());
        return rowToC(r);
      },
      async deleteContract(id) { must(await sb.from('rental_contracts').delete().eq('id', id)); return true; },

      // One-time: fill an empty database from seed-ground-floor.js (and any other seed files).
      // Does nothing if any floor already exists, so it is safe to call on every load.
      async seedIfEmpty(seeds = global.STORE_MAP_SEED || {}, extraFloors = []) {
        const existing = must(await sb.from('store_floors').select('id').limit(1));
        if (existing.length) return false;
        for (const { floor, objects } of Object.values(seeds)) {
          await this.saveFloor(floor);
          await this.saveLayout(floor.id, objects, { note: 'Imported from the PDF plan' });
        }
        for (const f of extraFloors) await this.saveFloor(f);
        return true;
      }
    };
  }

  global.StoreMapSupabaseAdapter = SupabaseAdapter;
})(window);
