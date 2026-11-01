// News about the watchlist (docs/watchlist-v1.json) and the priority themes, from Google News search RSS.
// Only headlines from major outlets (or the entity's own site) are kept; the same story from several outlets is
// merged into one item, and the number of outlets is kept as a signal of how big it is. Shown in the 简报 tab.

// Stories leave after a week: 今日重点 only picks from the last 7 days, and the app should not pile up old news.
const MAX_AGE_DAYS = 7;
const MAX_NEWS = 300;

// Outlets whose headlines are kept (matched against the source's domain).
const OUTLETS = [
  'reuters.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'nytimes.com', 'apnews.com', 'cnbc.com', 'economist.com',
  'theverge.com', 'techcrunch.com', 'wired.com', 'theinformation.com', 'axios.com', 'fortune.com', 'businessinsider.com',
  'semafor.com', 'venturebeat.com', 'arstechnica.com', 'technologyreview.com', 'theguardian.com', 'bbc.com', 'bbc.co.uk',
  'cnn.com', 'washingtonpost.com', 'forbes.com', 'geekwire.com', 'tomshardware.com', 'qz.com', 'engadget.com',
  'scmp.com', 'nikkei.com', 'asia.nikkei.com', 'caixinglobal.com', 'thenextweb.com', 'sportspromedia.com', 'sportico.com',
  'artificiallawyer.com', 'law.com', 'abajournal.com', 'inman.com', 'therealdeal.com', 'olympics.com', 'insidethegames.biz',
  '36kr.com', 'caixin.com', 'thepaper.cn', 'latepost.com', 'jiqizhixin.com', 'qbitai.com', 'yicai.com', 'jiemian.com'
];
// A headline must read like news worth pushing: AI, or a big business event.
const AI = /\bAI\b|A\.I\.|artificial intelligence|machine learning|\bLLMs?\b|model|agent|chatbot|ChatGPT|Claude|Gemini|robot|人工智能|大模型|模型|智能体|机器人/i;
const EVENT = /acqui|merger|merge|\bbuys?\b|takeover|funding|raises|valuation|\bIPO\b|launch|unveil|release|announce|partnership|\bdeal\b|lawsuit|\bsues?\b|steps down|resign|appoint|hires|joins|chief scientist|\bCEO\b|收购|合并|并购|融资|估值|上市|发布|推出|合作|加入|辞任|出任/i;
const THEMES = [
  { title: '奥运 AI', query: '(Olympic OR Olympics OR IOC OR Paralympic) ("artificial intelligence" OR AI)', must: /olympi|paralympi|\bIOC\b/i },
  { title: '体育 AI', query: '"artificial intelligence" (sports OR NFL OR NBA OR "Premier League" OR "Formula 1" OR FIFA)', must: /sport|NFL|NBA|league|F1|Formula|FIFA|club|team/i },
  { title: '法律 AI', query: '("legal AI" OR "AI legal" OR "law firm" AI OR Harvey OR Legora)', must: /legal|law|lawyer|Harvey|Legora/i },
  { title: '房产 AI', query: '"real estate" ("artificial intelligence" OR AI)', must: /real estate|property|propert|housing|mortgage|broker/i }
];

const decode = text => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] || '');

// Every run looks back the whole retention window, so a story's later coverage still merges into it.
const searchUrl = (query, zh, days) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${days}d`)}`
  + (zh ? '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans' : '&hl=en-US&gl=US&ceid=US:en');

const search = async (query, zh, days) => {
  const response = await fetch(searchUrl(query, zh, days), { headers: { 'user-agent': 'Mozilla/5.0 (personal feed reader)' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const source = tag(item, 'source');
    const sourceUrl = item.match(/<source url="([^"]+)"/)?.[1] || '';
    // Google appends " - Outlet" to every headline.
    const title = tag(item, 'title').replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    // The description lists other outlets' headlines for the same story: material for the summary.
    const related = [...tag(item, 'description').matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map(([, text]) => decode(text));
    return { title, related, url: tag(item, 'link'), source, domain: sourceUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, ''), published: new Date(tag(item, 'pubDate')).toISOString().slice(0, 10) };
  }).filter(item => item.title && item.published);
};

const outletRank = domain => {
  const index = OUTLETS.findIndex(outlet => domain === outlet || domain.endsWith(`.${outlet}`));
  return index < 0 ? Infinity : index;
};

// Story identity: overlap of the headline's meaningful words (or characters, for Chinese).
const STOP = new Set('the a an of to in on for and with as at by from is are its it that this after over into new says say will be has have how why what'.split(' '));
const words = title => /[一-鿿]/.test(title)
  ? new Set([...title.replace(/[^一-鿿\w]/g, '')].map((char, index, chars) => char + (chars[index + 1] || '')))
  : new Set(title.toLowerCase().replace(/[’']s\b/g, '').split(/[^\p{L}\p{N}.$-]+/u).filter(word => word.length > 2 && !STOP.has(word)));
const sameStory = (a, b) => {
  const [x, y] = [words(a), words(b)];
  const shared = [...x].filter(word => y.has(word)).length;
  return shared >= 3 && shared / Math.min(x.size, y.size) >= 0.5;
};

const entityPattern = aliases => new RegExp(aliases.map(alias => {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /[一-鿿]/.test(alias) ? escaped : `(?<![\\w])${escaped}(?![\\w])`;
}).join('|'));

// Stable story id (the first headline's URL, hashed): the shown headline and URL can switch to a higher-ranked
// outlet later, but the id that 今日重点 and its read marks use stays the same.
const storyId = url => {
  let hash = 2166136261;
  for (const char of url) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
};

// stats (optional) gets { scanned, events }: the headlines this run kept and how many stories they merged into.
export const collectNews = async (watchlist, previous = [], report = [], stats = {}) => {
  const people = watchlist.groups.find(group => group.people)?.items || [];
  const labs = watchlist.groups.find(group => group.title.startsWith('前沿实验室'))?.items || [];
  const entities = [...people, ...labs].map(entity => ({ ...entity, pattern: entityPattern(entity.aliases) }));
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);

  // Every query: [label, query, zh, keep(headline)]. People need AI or a big event; labs need a big event.
  const queries = [
    ...people.flatMap(person => {
      const chinese = person.aliases.find(alias => /[一-鿿]/.test(alias));
      const keep = title => AI.test(title) || EVENT.test(title);
      return [[person.name, `"${person.name}"`, false, keep], ...(chinese ? [[person.name, `"${chinese}"`, true, keep]] : [])];
    }),
    ...labs.map(lab => [lab.name, `"${lab.aliases[0]}"`, false, title => EVENT.test(title)]),
    ...THEMES.map(theme => [theme.title, theme.query, false, title => theme.must.test(title) && AI.test(title)])
  ];

  const days = MAX_AGE_DAYS;
  const found = [];
  for (const [label, query, zh, keep] of queries) {
    try {
      const results = (await search(query, zh, days)).filter(item => outletRank(item.domain) < Infinity && keep(item.title));
      results.forEach(item => found.push({ ...item, theme: THEMES.find(theme => theme.title === label)?.title }));
      report.push(`news ${label}${zh ? ' (中文)' : ''}: ${results.length}`);
    } catch (error) {
      report.push(`news ${label}: FAILED ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  // Merge into stories: earlier stories first (so their ids stay), then today's headlines.
  const stories = previous.filter(story => story.published >= cutoff)
    .map(story => ({ ...story, id: story.id || storyId(story.url), outlets: [...story.outlets], headlines: [...(story.headlines || [story.title])] }));
  const today = new Date().toISOString().slice(0, 10);
  const touched = new Set();
  const addHeadlines = (story, item) => {
    for (const headline of [item.title, ...item.related]) {
      if (story.headlines.length < 8 && !story.headlines.includes(headline)) story.headlines.push(headline);
    }
  };
  for (const item of found) {
    if (item.published < cutoff) continue;
    const story = stories.find(other => other.url === item.url || sameStory(other.title, item.title));
    if (!story) {
      const created = { id: storyId(item.url), lastSeen: today, title: item.title, url: item.url, source: item.source, domain: item.domain, published: item.published, outlets: [item.source], themes: item.theme ? [item.theme] : [], headlines: [] };
      addHeadlines(created, item);
      stories.push(created);
      touched.add(created);
      continue;
    }
    touched.add(story);
    // lastSeen: the day a new outlet last picked the story up, so 今日重点 can tell a story that is still growing.
    if (!story.outlets.includes(item.source)) Object.assign(story, { lastSeen: today }).outlets.push(item.source);
    addHeadlines(story, item);
    if (item.theme && !story.themes.includes(item.theme)) story.themes.push(item.theme);
    // The headline shown comes from the highest-ranked outlet.
    if (outletRank(item.domain) < outletRank(story.domain || '')) {
      Object.assign(story, { title: item.title, url: item.url, source: item.source, domain: item.domain });
    }
    if (item.published < story.published) story.published = item.published;
  }
  Object.assign(stats, { scanned: found.filter(item => item.published >= cutoff).length, events: touched.size });
  stories.forEach(story => {
    story.entities = entities.filter(entity => entity.pattern.test(story.title)).map(entity => entity.name);
  });
  // Bigger stories (more outlets, more watched names) first among the same day; newest days first.
  return stories
    .filter(story => story.entities.length || story.themes.length)
    .sort((a, b) => b.published.localeCompare(a.published) || (b.outlets.length + b.entities.length) - (a.outlets.length + a.entities.length))
    .slice(0, MAX_NEWS);
};
