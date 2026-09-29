// Checks that inserting rows mid-list marks every row below as needing a save (ordering bug fix).
export default async function (page, { log }) {
  const r = await page.evaluate(() => {
    const before = currentRows.length;
    const idx = 5;
    const fresh = [blankPromoRow(), blankPromoRow(), blankPromoRow()];
    currentRows.splice(idx + 1, 0, ...fresh);
    const moved = renumberRows();
    const toSave = withMoved(fresh, moved);
    const below = currentRows.slice(idx + 4);        // rows pushed down by the insert
    const out = {
      rows: before,
      toSave: toSave.length,
      allBelowSaved: below.every(x => toSave.includes(x)),
      aboveUntouched: currentRows.slice(0, idx + 1).every(x => !moved.includes(x)),
    };
    currentRows.splice(idx + 1, 3); renumberRows();  // undo (nothing was saved)
    return out;
  });
  log('promotion rows:', r.rows, '| rows to save after inserting 3 at #6:', r.toSave,
      '| every row below saved:', r.allBelowSaved, '| rows above untouched:', r.aboveUntouched);
  if (!r.allBelowSaved || !r.aboveUntouched) throw new Error('ordering fix check failed');
}
