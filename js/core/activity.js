/* ============================================================
   Activity log. Who/when are stamped by the database (trigger on
   activity_log), so the client only says what happened.
   Never blocks or breaks the action being logged.
   ============================================================ */
// entity: { type: 'order', id: 'abc' } or null.
function logActivity(module, action, entity, summary, details) {
  const row = {
    module, action,
    entity_type: entity?.type ?? null,
    entity_id: entity?.id != null ? String(entity.id) : null,
    summary: summary ?? null,
    details: details ?? null,
  };
  return sb.from('activity_log').insert(row).then(({ error }) => {
    if (error) console.warn('Activity log not written:', friendlyError(error), row);
  }, err => console.warn('Activity log not written:', err, row));
}
