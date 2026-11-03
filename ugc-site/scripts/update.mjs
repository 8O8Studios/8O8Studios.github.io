// Fetches items for each Roblox group and writes data.json.
// Run by GitHub Actions every 6 hours, or locally: node scripts/update.mjs
import { writeFile } from "node:fs/promises";

const GROUP_IDS = [32663795, 799946898, 33459419, 34114424, 16114977, 564029410];
const PER_ROW = 12;
// Roblox catalog sort values. If a row looks wrong, change the number here.
const SORT = { latest: 3, bestSelling: 2, favorited: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 1; i <= 6; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429) { await sleep(3000 * i); continue; }
    throw new Error(`${res.status} for ${url}`);
  }
  throw new Error(`Rate limited: ${url}`);
}

async function fetchItems(groupId, sort) {
  const url = `https://catalog.roblox.com/v1/search/items/details?CreatorTargetId=${groupId}&CreatorType=Group&SortType=${sort}&Limit=30`;
  const json = await get(url);
  await sleep(600);
  return (json.data || []).slice(0, PER_ROW).map((i) => ({
    id: i.id,
    name: i.name,
    favorites: i.favoriteCount ?? 0,
  }));
}

const groups = [];
for (const id of GROUP_IDS) {
  const info = await get(`https://groups.roblox.com/v1/groups/${id}`);
  await sleep(600);
  const latest = await fetchItems(id, SORT.latest);
  const bestSelling = await fetchItems(id, SORT.bestSelling);
  const favorited = (await fetchItems(id, SORT.favorited)).sort((a, b) => b.favorites - a.favorites);
  groups.push({ id, name: info.name, latest, bestSelling, favorited });
  console.log(`${info.name}: ${latest.length}/${bestSelling.length}/${favorited.length} items`);
}

// Thumbnails, 100 ids per request
const ids = [...new Set(groups.flatMap((g) => [...g.latest, ...g.bestSelling, ...g.favorited].map((i) => i.id)))];
const thumbs = {};
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100).join(",");
  const json = await get(`https://thumbnails.roblox.com/v1/assets?assetIds=${batch}&size=420x420&format=Png&isCircular=false`);
  for (const t of json.data || []) thumbs[t.targetId] = t.imageUrl;
  await sleep(600);
}
for (const g of groups) for (const row of [g.latest, g.bestSelling, g.favorited]) for (const item of row) item.image = thumbs[item.id] || null;

await writeFile("data.json", JSON.stringify({ updated: new Date().toISOString(), groups }, null, 1));
console.log("Wrote data.json");
