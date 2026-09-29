// Column detection on the real sell-outs (read-only): old price, new price from the file, LBP-looking prices.
export default async function (page, { log }) {
  const rows = await page.evaluate(() => sellouts.map(s => {
    const m = detectColumns(s.items); const p = pricedRowsOf(s);
    return `${s.name}: old=${m.price} new=${m.newPrice} | ${p.filter(x => x.newPrice !== null).length}/${p.length} have a new price`
      + ` (${[...new Set(p.map(x => x.mode).filter(Boolean))].join(',') || 'none'})`
      + ` | LBP-looking old prices: ${p.filter(x => x.oldPrice >= 1000).length} | row 1: ${p[0]?.oldPrice} -> ${p[0]?.newPrice}`;
  }));
  rows.forEach(r => log(r));
}
