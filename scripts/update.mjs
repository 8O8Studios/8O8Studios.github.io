// Fetches ALL items for each Roblox group (and your profile) via cursor pagination and writes data.json.
// Run locally: node update.mjs
import { readFile, writeFile } from "node:fs/promises";

const GROUP_IDS = [32663795, 799946898, 33459419, 34114424, 16114977, 564029410];
const USER_IDS = [1303580679]; // 8O8Mph's profile
// Groups shown in the "Worked with" section (name, members and icon are fetched automatically)
const WORKED_WITH_IDS = [5948929, 7498332, 17192115, 11636314, 8108593];
const SORT = { latest: 3, bestSelling: 2, favorited: 1 };
const PAGE_SIZE = 30;         // 30 per page is known to work with this endpoint
const MAX_PAGES = 400;        // safety limit only (400 x 30 = 12,000 items per source)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 1; i <= 8; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429) {
      console.log(`Rate limited (429) on ${url}. Retrying in ${5 * i} seconds...`);
      await sleep(5000 * i);
      continue;
    }
    throw new Error(`${res.status} for ${url}`);
  }
  throw new Error(`Rate limited: ${url}`);
}

function getCategory(thumbUrl) {
  const url = (thumbUrl || "").toLowerCase();
  if (url.includes("/hairaccessory/")) return "Hair";
  if (url.includes("/hat/")) return "Hats";
  if (url.includes("/faceaccessory/")) return "Face Accessories";
  if (url.includes("/backaccessory/")) return "Back Accessories";
  if (url.includes("/frontaccessory/")) return "Front Accessories";
  if (url.includes("/waistaccessory/")) return "Waist Accessories";
  if (url.includes("/neckaccessory/")) return "Neck Accessories";
  if (url.includes("/shoulderaccessory/")) return "Shoulder Accessories";
  if (url.includes("/emoteanimation/")) return "Emotes";
  if (url.includes("/tshirtaccessory/") || url.includes("/shirt/") || url.includes("/pants/")) return "Clothing";
  return "Other Accessories";
}

// type: "Group" or "User". maxPages lets us grab just the first page for the best-selling list.
async function fetchItems(ownerId, type, sort, maxPages = MAX_PAGES) {
  const all = [];
  let cursor = "";
  let page = 0;

  while (page < maxPages) {
    const cursorParam = cursor ? `&cursor=${cursor}` : "";
    const url = `https://catalog.roblox.com/v1/search/items/details?CreatorTargetId=${ownerId}&CreatorType=${type}&SortType=${sort}&Limit=${PAGE_SIZE}${cursorParam}`;
    const json = await get(url);
    await sleep(1000);

    all.push(...(json.data || []).map((i) => ({
      id: i.id,
      name: i.name,
      favorites: i.favoriteCount ?? 0,
      price: i.price ?? i.lowestPrice ?? null,
      priceStatus: i.priceStatus ?? null,
      description: i.description ?? "",
      creator: i.creatorName ?? null,
    })));

    cursor = json.nextPageCursor;
    page++;
    if (!cursor) break; // reached the last page
  }

  return all;
}

async function addSource(list, { id, type, name, memberCount, hasVerifiedBadge }) {
  // Every item is in the "latest" list, so fetch that completely and derive the favorited list from it.
  const latest = await fetchItems(id, type, SORT.latest);
  const bestSelling = await fetchItems(id, type, SORT.bestSelling, 1); // top sellers (first page)
  const favorited = [...latest].sort((a, b) => b.favorites - a.favorites);
  list.push({ id, type, name, memberCount, hasVerifiedBadge: !!hasVerifiedBadge, latest, bestSelling, favorited });
  console.log(`${name}: ${latest.length} items${memberCount != null ? `, ${memberCount} members` : ""}`);
}

const groups = [];

for (const id of GROUP_IDS) {
  const info = await get(`https://groups.roblox.com/v1/groups/${id}`);
  await sleep(1000);
  await addSource(groups, { id, type: "Group", name: info.name, memberCount: info.memberCount ?? null, hasVerifiedBadge: info.hasVerifiedBadge ?? false });
}

for (const id of USER_IDS) {
  const info = await get(`https://users.roblox.com/v1/users/${id}`);
  await sleep(1000);
  await addSource(groups, { id, type: "User", name: info.name, memberCount: null, hasVerifiedBadge: info.hasVerifiedBadge ?? false });
}

// Extract unique asset IDs to fetch thumbnails
const ids = [...new Set(groups.flatMap((g) => [...g.latest, ...g.bestSelling, ...g.favorited].map((i) => i.id)))];
const thumbs = {};
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100).join(",");
  const json = await get(`https://thumbnails.roblox.com/v1/assets?assetIds=${batch}&size=420x420&format=Png&isCircular=false`);
  for (const t of json.data || []) thumbs[t.targetId] = t.imageUrl;
  await sleep(1000);
}

// Upload dates (used for "Latest arrivals"). Dates already saved in the old data.json are reused,
// so only brand-new items need a request and later runs are fast.
const dateCache = new Map();
try {
  const old = JSON.parse(await readFile("data.json", "utf8"));
  for (const g of old.groups || [])
    for (const row of [g.latest, g.bestSelling, g.favorited])
      for (const i of row || []) if (i.created) dateCache.set(i.id, i.created);
} catch { /* no old data.json yet */ }

const missingDates = ids.filter((id) => !dateCache.has(id));
console.log(`Fetching upload dates for ${missingDates.length} items (${dateCache.size} already known)...`);
for (const id of missingDates) {
  try {
    const d = await get(`https://economy.roblox.com/v2/assets/${id}/details`);
    if (d.Created) dateCache.set(id, d.Created);
  } catch (e) {
    console.log(`No date for ${id}: ${e.message}`);
  }
  await sleep(700);
}

// Assign thumbnails and category mappings
for (const g of groups) {
  for (const row of [g.latest, g.bestSelling, g.favorited]) {
    for (const item of row) {
      item.image = thumbs[item.id] || null;
      item.category = getCategory(item.image);
      item.created = dateCache.get(item.id) ?? null;
    }
  }
}

// "Worked with" groups: name, member count and icon
const workedWith = [];
for (const id of WORKED_WITH_IDS) {
  try {
    const info = await get(`https://groups.roblox.com/v1/groups/${id}`);
    workedWith.push({ id, name: info.name, memberCount: info.memberCount ?? null, hasVerifiedBadge: info.hasVerifiedBadge ?? false, icon: null });
  } catch (e) {
    console.log(`Could not load worked-with group ${id}: ${e.message}`);
    workedWith.push({ id, name: null, memberCount: null, hasVerifiedBadge: false, icon: null });
  }
  await sleep(1000);
}
try {
  const icons = await get(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${WORKED_WITH_IDS.join(",")}&size=150x150&format=Png&isCircular=false`);
  for (const t of icons.data || []) {
    const w = workedWith.find((x) => x.id === t.targetId);
    if (w) w.icon = t.imageUrl || null;
  }
} catch (e) {
  console.log(`Could not load worked-with icons: ${e.message}`);
}

await writeFile("data.json", JSON.stringify({ updated: new Date().toISOString(), groups, workedWith }, null, 1));
console.log(`Wrote data.json: ${ids.length} unique items from ${groups.length} sources.`);
