// Sidebar: no scrollbar, no sideways scroll, and the reopen button visible when collapsed.
export default async function (page, { log }) {
  const check = () => page.evaluate(() => {
    const sb = document.getElementById('sidebarEl'), t = document.getElementById('navCollapseToggle'), r = t.getBoundingClientRect(), s = sb.getBoundingClientRect();
    return { width: Math.round(s.width), sidewaysScroll: sb.scrollWidth > sb.clientWidth, scrollbarWidth: sb.offsetWidth - sb.clientWidth,
      toggleVisible: r.left >= s.left && r.right <= s.right && r.width > 0 };
  });
  log('open:', JSON.stringify(await check()));
  await page.click('#navCollapseToggle'); await page.waitForTimeout(400);
  log('collapsed:', JSON.stringify(await check()));
  await page.click('#navCollapseToggle'); await page.waitForTimeout(400);
  log('reopened:', JSON.stringify(await check()));
  await page.click('#navCollapseToggle'); await page.waitForTimeout(400);
}
