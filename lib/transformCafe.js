// Transforms a raw MongoDB cafe document (scraped Zomato/Swiggy fields) into
// the exact shape the frontend's CAFES array already expects (see js/data.js).
// Kept separate from the raw stored documents on purpose: Mongo keeps the
// authentic scraped data, this is a read-time presentation layer.

function classifyFood(name) {
  const t = (name || '').toLowerCase();
  if (/coffee|cappuccino|latte|espresso|mocha|cold brew/.test(t)) return 'coffee';
  if (/\bchai\b|\btea\b/.test(t)) return 'chai';
  if (/pizza/.test(t)) return 'pizza';
  if (/pasta|noodle|spaghetti|macaroni/.test(t)) return 'pasta';
  if (/burger|sandwich|\bsub\b/.test(t)) return 'burgers';
  if (/cake|dessert|ice cream|kulfi|sweet|pastry|brownie|halwa/.test(t)) return 'desserts';
  if (/juice|shake|mocktail|lassi|soda|\bdrink\b|beverage|cocktail/.test(t)) return 'drinks';
  if (/\bbread\b|\bbun\b|croissant|bakery/.test(t)) return 'bakery';
  if (/salad|soup|grilled|healthy|steamed/.test(t)) return 'healthy';
  return 'indian';
}

function inferCafeType(name, category) {
  const text = `${name || ''} ${category || ''}`.toLowerCase();
  const types = [];
  if (/cafe|café|coffee|chai|tea house/.test(text)) types.push('Cafe');
  if (/bakery|patisserie|\bbake\b/.test(text)) types.push('Bakery');
  if (/rooftop|sky|terrace|skyline/.test(text)) types.push('Rooftop');
  if (/fine dining|lounge|luxury|bar\s*&\s*kitchen|brewery/.test(text)) types.push('Fine Dining');
  if (!types.length) types.push('Restaurant');
  return types;
}

// The source dataset has no mood/ambience or occasion tags at all, but the
// frontend's mood filters ("Find your vibe") depend on this field. Rather
// than ship it broken (empty for all 250 places), infer a small, honest set
// of tags from name/category/type/rating signals — clearly a heuristic, not
// scraped fact, but it makes mood discovery actually work.
function inferAmbience(name, category, cafeType, rating, reviewCount) {
  const text = `${name || ''} ${category || ''}`.toLowerCase();
  const tags = new Set();
  if (/rooftop|sky|terrace|skyline/.test(text)) tags.add('Rooftop');
  if (/fine dining|lounge|luxury|premium/.test(text)) tags.add('Luxury');
  if (/24 hour|24x7|late night/.test(text)) tags.add('Late Night');
  if (/garden|lawn|outdoor|open air/.test(text)) tags.add('Outdoor');
  if (/bakery|dessert|pastry/.test(text)) tags.add('Cozy');
  if (cafeType.includes('Cafe')) tags.add('Cozy');
  if (cafeType.includes('Fine Dining')) tags.add('Luxury');
  if (cafeType.includes('Rooftop')) { tags.add('Rooftop'); tags.add('Date Night'); }
  if (cafeType.includes('Cafe') && !tags.has('Rooftop')) tags.add('Quiet Work');
  if (rating && rating >= 4.4) tags.add('Date Night');
  if (reviewCount && reviewCount >= 1000) tags.add('Friends');
  if (reviewCount != null && reviewCount < 200) tags.add('Solo');
  if (!tags.size) tags.add('Cozy'); // fallback stays within the app's actual VIBE_TAGS set
  return [...tags].slice(0, 4);
}

// The scraped export double-encoded some UTF-8 text as Latin-1 ("CafÃ©" for
// "Café"), and the en dash in opening hours lost its trailing bytes entirely
// ("11am â 11pm"). Repair both at read time; the stored data stays untouched.
function fixText(s) {
  if (!s || typeof s !== 'string' || !/[ÂÃâ]/.test(s)) return s;
  if (![...s].some((c) => c.charCodeAt(0) > 0xff)) {
    const decoded = Buffer.from(s, 'latin1').toString('utf8');
    if (!decoded.includes('�')) return decoded;
  }
  return s.replace(/\s*â\s*/g, ' – ').replace(/Â\s?/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function cleanHours(s) {
  return fixText(s || '').replace(/\s*\(Today\)\s*/i, '').trim() || null;
}

function parseCuisines(category) {
  return fixText(category || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^beverages?$/i.test(s));
}

// Dataset paths contain apostrophes, brackets and spaces; encode each segment
// so the URL is safe inside src="" and CSS url('') alike.
function encodeUrlPath(url) {
  if (!url) return url;
  return url.split('/').map((seg) => encodeURIComponent(decodeURIComponentSafe(seg))).join('/');
}
function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function stripDishDescription(raw) {
  return fixText(raw)
    .replace(/\(\(.*$/, '')
    .replace(/\(.*$/, '')
    .replace(/[.:,]+$/, '')
    .trim();
}

// Parses the "Category\n  - Dish\n  - Dish\n..." full_menu text into a flat
// [name, price] list (no prices exist in this dataset, so price is "").
function parseFullMenu(fullMenu) {
  if (!fullMenu || typeof fullMenu !== 'string') return [];
  const items = [];
  const seen = new Set();
  for (const line of fullMenu.split('\n')) {
    const m = line.match(/^\s*-\s+(.+)$/);
    if (!m) continue;
    const name = stripDishDescription(m[1]);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      items.push([name, '']);
    }
  }
  return items;
}

// Same source text, but keeping the category headers — powers the
// sticky-tabbed menu view (Overview > Menu) instead of one flat list.
function parseMenuCategories(fullMenu) {
  if (!fullMenu || typeof fullMenu !== 'string') return [];
  const categories = [];
  let current = null;
  const seen = new Set();
  for (const rawLine of fullMenu.split('\n')) {
    const itemMatch = rawLine.match(/^\s*-\s+(.+)$/);
    if (itemMatch) {
      const name = stripDishDescription(itemMatch[1]);
      const key = (current ? current.category : '') + '|' + name.toLowerCase();
      if (name && current && !seen.has(key)) {
        seen.add(key);
        current.items.push(name);
      }
      continue;
    }
    const header = fixText(rawLine.trim());
    if (header) {
      current = { category: header, items: [] };
      categories.push(current);
    }
  }
  return categories.filter((c) => c.items.length);
}

function parseTopFoods(topFoodsStr) {
  if (!topFoodsStr || typeof topFoodsStr !== 'string') return [];
  return fixText(topFoodsStr)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((name) => ({ name, category: classifyFood(name), isSpeciality: true }));
}

function areaFromLocality(locality, city) {
  if (!locality) return city || 'Jaipur';
  const cityPattern = new RegExp(`,\\s*${(city || 'Jaipur').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const stripped = locality.replace(cityPattern, '').trim();
  return stripped || locality;
}

function slugify(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// `menuImages` ([{ src, thumb }]) is resolved by the server from the files on
// disk (see backend/server.js), since only it knows which copies exist.
function transformCafeDoc(doc, { menuImages = [] } = {}) {
  const name = fixText(doc.cafe_name || doc.name);
  const cafeType = (Array.isArray(doc.cafeType) && doc.cafeType.length) ? doc.cafeType : inferCafeType(name, doc.category);
  const topFoods = (Array.isArray(doc.topFoods) && doc.topFoods.length) ? doc.topFoods : parseTopFoods(doc.top_5_dishes);
  const menu = (Array.isArray(doc.menu) && doc.menu.length) ? doc.menu : parseFullMenu(doc.full_menu);
  const menuCategories = (Array.isArray(doc.menuCategories) && doc.menuCategories.length) ? doc.menuCategories : parseMenuCategories(doc.full_menu);
  const images = (Array.isArray(doc.images) ? doc.images.filter(Boolean) : (Array.isArray(doc.gallery) ? doc.gallery.filter(Boolean) : [])).map(encodeUrlPath);
  const rating = typeof doc.rating === 'number' ? doc.rating : null;
  const reviews = typeof doc.review_count === 'number' ? doc.review_count : (typeof doc.reviews === 'number' ? doc.reviews : null);
  const hours = cleanHours(doc.weekly_hours || doc.hours) || (doc.opening_time && doc.closing_time ? `${doc.opening_time} – ${doc.closing_time}` : null);
  const ambience = (Array.isArray(doc.ambience) && doc.ambience.length) ? doc.ambience : inferAmbience(name, doc.category, cafeType, rating, reviews);
  const address = fixText(doc.full_address || doc.locality || (doc.location && doc.location.address) || '');

  return {
    id: doc.id,
    name,
    slug: slugify(name) || doc.id,
    description: fixText(doc.overview || doc.description || doc.about || ''),
    location: {
      area: areaFromLocality(fixText(doc.locality || (doc.location && doc.location.area)), doc.city || (doc.location && doc.location.city)),
      city: doc.city || (doc.location && doc.location.city) || 'Jaipur',
      address,
    },
    cuisines: parseCuisines(doc.category),
    links: {
      zomato: doc.zomato_url || null,
      swiggy: doc.swiggy_url || null,
      maps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${address || doc.city || 'Jaipur'}`)}`,
    },
    menuImages,
    priceRange: '₹₹', // not present in the source dataset — no price data was scraped
    cafeType,
    ambience,
    topFoods,
    image: images[0] || null,
    gallery: images,
    rating,
    reviews,
    priceForTwo: null,
    budget: null,
    hours,
    about: fixText(doc.overview || ''),
    features: ambience,
    menu,
    menuCategories,
    featured: !!(rating && rating >= 4.4),
    trending: !!(rating && rating >= 4.4 && reviews && reviews >= 500),
    verificationNote:
      doc.menu_verification_status && doc.menu_verification_status !== 'VERIFIED_MENU_URL'
        ? 'Menu details are still being verified'
        : undefined,
  };
}

module.exports = { transformCafeDoc, encodeUrlPath };
