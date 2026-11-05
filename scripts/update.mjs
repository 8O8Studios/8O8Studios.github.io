// Fetches ALL items for each Roblox group (and your profile) via cursor pagination and writes data.json.
// Run locally: node update.mjs
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// data.json lives in the project root (one folder up from /scripts), so this works from any directory.
const DATA_PATH = fileURLToPath(new URL("../data.json", import.meta.url));

const GROUP_IDS = [32663795, 799946898, 33459419, 34114424, 16114977, 564029410];
const USER_IDS = [1303580679]; // 8O8Mph's profile
// Groups shown in the "Worked with" section (name, members and icon are fetched automatically)
const WORKED_WITH_IDS = [5948929, 7498332, 17192115, 11636314, 8108593];
// The 8O8 Studios group: everyone with the "Partners" rank is shown in the Partners column.
const STUDIO_GROUP_ID = 33198659;
const PARTNER_ROLE_NAME = "Partner";
// Staff column: leave STAFF_ROLE_NAMES empty to show EVERY rank in the studio group except the ones in
// STAFF_EXCLUDE (and the Guest rank). Or list specific rank names (not case-sensitive) to show only those.
const STAFF_ROLE_NAMES = [];
const STAFF_EXCLUDE = ["Guest", "Member", "Partner"];
const SORT = { latest: 3, bestSelling: 2, favorited: 1 };
const PAGE_SIZE = 30;         // 30 per page is known to work with this endpoint
const MAX_PAGES = 400;        // safety limit only (400 x 30 = 12,000 items per source)

// Previous data.json (if any): used as a fallback whenever Roblox rate limits a request.
let OLD = null;
try { OLD = JSON.parse(await readFile(DATA_PATH, "utf8")); } catch { /* no data.json yet */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUICK = process.argv.includes("--quick") || process.argv.includes("--partners");
const MAX_TRIES = QUICK ? 3 : 8;   // quick mode gives up sooner when Roblox rate limits

async function get(url) {
  for (let i = 1; i <= MAX_TRIES; i++) {
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

// Fetches the people for the Partners + Staff columns from the studio group (+ their avatar headshots),
// and the studio group's own member count.
async function fetchPeople(known = {}) {
  const info = await get(`https://groups.roblox.com/v1/groups/${STUDIO_GROUP_ID}`);
  console.log(`People source group: ${info.name} (${STUDIO_GROUP_ID})`);
  await sleep(1000);
  const roles = (await get(`https://groups.roblox.com/v1/groups/${STUDIO_GROUP_ID}/roles`)).roles || [];
  await sleep(1000);
  const findRoles = (names) => roles.filter((r) => names.some((n) => n.toLowerCase() === r.name.trim().toLowerCase()));
  const allRanks = roles.map((r) => r.name).join(", ");

  async function usersOf(role) {
    const out = [];
    let cursor = "";
    do {
      const c = cursor ? `&cursor=${cursor}` : "";
      const json = await get(`https://groups.roblox.com/v1/groups/${STUDIO_GROUP_ID}/roles/${role.id}/users?limit=100&sortOrder=Asc${c}`);
      out.push(...(json.data || []).map((u) => ({ ...u, roleName: role.name, roleRank: role.rank })));
      cursor = json.nextPageCursor;
      await sleep(1000);
    } while (cursor);
    return out;
  }

  const partnerRoles = findRoles([PARTNER_ROLE_NAME]);
  if (!partnerRoles.length) console.log(`No "${PARTNER_ROLE_NAME}" rank found. Ranks are: ${allRanks}`);
  const staffRoles = STAFF_ROLE_NAMES.length
    ? findRoles(STAFF_ROLE_NAMES)
    : roles.filter((r) => r.rank > 0 && !STAFF_EXCLUDE.some((n) => n.toLowerCase() === r.name.trim().toLowerCase()));
  console.log(`Staff ranks: ${staffRoles.map((r) => r.name).join(", ") || "(none)"}  |  all ranks: ${allRanks}`);

  const partnerUsers = [];
  for (const r of partnerRoles) partnerUsers.push(...(await usersOf(r)));
  const staffUsers = [];
  for (const r of staffRoles) staffUsers.push(...(await usersOf(r)));
  // highest rank first, then alphabetical
  staffUsers.sort((a, b) => b.roleRank - a.roleRank || (a.displayName || a.username).localeCompare(b.displayName || b.username));

  // Avatar headshots (420x420). Roblox sometimes answers "Pending" while it renders, so retry a few times.
  const everyone = [...new Set([...partnerUsers, ...staffUsers].map((u) => u.userId))];
  const avatars = { ...known };   // avatars we already have are reused, so fewer requests
  const missing = everyone.filter((id) => !avatars[id]);
  for (let i = 0; i < missing.length; i += 100) {
    const ids = missing.slice(i, i + 100);
    let todo = ids;
    for (let attempt = 1; attempt <= 5 && todo.length; attempt++) {
      const json = await get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${todo.join(",")}&size=420x420&format=Png&isCircular=false`);
      for (const t of json.data || []) if (t.state === "Completed" && t.imageUrl) avatars[t.targetId] = t.imageUrl;
      todo = ids.filter((id) => !avatars[id]);
      await sleep(attempt * 1500);
    }
    if (todo.length) console.log(`No avatar image for user(s): ${todo.join(", ")}`);
  }

  const shape = (u) => ({
    id: u.userId,
    name: u.username,
    displayName: u.displayName || u.username,
    hasVerifiedBadge: !!u.hasVerifiedBadge,
    role: u.roleName,
    avatar: avatars[u.userId] || null,
  });
  console.log(`Partners: ${partnerUsers.length} users, Staff: ${staffUsers.length} users`);
  // The studio group's own member count is added to the "Group Members" stat on the page.
  const studio = { id: STUDIO_GROUP_ID, name: info.name, memberCount: info.memberCount ?? null };
  return { partners: partnerUsers.map(shape), staff: staffUsers.map(shape), studio };
}

// Quick mode: `node scripts/update.mjs --quick` (or --partners) refreshes ONLY partners, staff and the studio
// member count in data.json (takes seconds). It leaves the items and the "Updated" time untouched.
if (QUICK) {
  const data = OLD;
  if (!data) { console.log("No data.json yet. Run the full update first: node scripts/update.mjs"); process.exit(0); }
  const known = {};
  for (const p of [...(data.partners || []), ...(data.staff || [])]) if (p.avatar) known[p.id] = p.avatar;
  try {
    const r = await fetchPeople(known);
    data.partners = r.partners;
    data.staff = r.staff;
    data.studio = r.studio;
    await writeFile(DATA_PATH, JSON.stringify(data, null, 1));
    console.log("Updated partners, staff and studio members in data.json.");
  } catch (e) {
    // Rate limited or Roblox hiccup: keep the old data and try again next run (no failed workflow).
    console.log(`Quick update skipped: ${e.message}`);
  }
  process.exit(0);
}

const groups = [];

// If one source fails (e.g. rate limited), keep its previous data instead of losing it.
function keepOld(id, e) {
  const prev = (OLD?.groups || []).find((g) => g.id === id);
  console.log(`Could not refresh ${id}: ${e.message}${prev ? " - keeping previous data" : ""}`);
  if (prev) groups.push(prev);
}

for (const id of GROUP_IDS) {
  try {
    const info = await get(`https://groups.roblox.com/v1/groups/${id}`);
    await sleep(1000);
    await addSource(groups, { id, type: "Group", name: info.name, memberCount: info.memberCount ?? null, hasVerifiedBadge: info.hasVerifiedBadge ?? false });
  } catch (e) { keepOld(id, e); }
}

for (const id of USER_IDS) {
  try {
    const info = await get(`https://users.roblox.com/v1/users/${id}`);
    await sleep(1000);
    await addSource(groups, { id, type: "User", name: info.name, memberCount: null, hasVerifiedBadge: info.hasVerifiedBadge ?? false });
  } catch (e) { keepOld(id, e); }
}

if (!groups.length) { console.log("Nothing could be loaded. Keeping data.json as it is."); process.exit(0); }

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
for (const g of OLD?.groups || [])
  for (const row of [g.latest, g.bestSelling, g.favorited])
    for (const i of row || []) if (i.created) dateCache.set(i.id, i.created);

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

// Partners / staff / studio: keep the previous values if Roblox rate limits this part.
let partners = OLD?.partners || [];
let staff = OLD?.staff || [];
let studio = OLD?.studio || null;
try {
  const r = await fetchPeople();
  partners = r.partners;
  staff = r.staff;
  studio = r.studio;
} catch (e) {
  console.log(`Could not load partners/staff, keeping previous: ${e.message}`);
}

await writeFile(DATA_PATH, JSON.stringify({ updated: new Date().toISOString(), groups, workedWith, partners, staff, studio }, null, 1));
console.log(`Wrote data.json: ${ids.length} unique items from ${groups.length} sources.`);
