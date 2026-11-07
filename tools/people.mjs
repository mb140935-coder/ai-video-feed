// 人物访谈 (the second section of the 演讲 & Podcast tab): interviews, conversations and talks (graduation speeches
// included) of the people the user lists on the page, found on YouTube and Bilibili. The list is rows in Supabase
// added_videos whose key is "person:<name>": title holds the names ("王坚 / Wang Jian"), url the identity keywords
// that tell this person apart from namesakes ("阿里云 城市大脑 院士"). A person seen for the first time (or whose
// keywords changed) gets a search of everything, however old; after that each run looks for new videos only.
// No AI filter: they can talk about anything. Clips, compilations, commentary and gossip are left out.
// Also here, since they share the Bilibili and YouTube lookups: followed Bilibili uploaders (bilibiliUp,
// pollBilibiliUp) and the hand-picked 精选 videos (docs/video-picks.json, addVideoPicks).

// Backfill: no date limit (Infinity). Bumping BACKFILL_VERSION searches everyone from scratch once more.
const BACKFILL_DAYS = Infinity;
const BACKFILL_VERSION = 2;
const RECENT_DAYS = 7;
const MAX_NEW_BACKFILL = 25;
const MAX_NEW_DAILY = 5;
const MIN_MINUTES = 15;
const MIN_SPEECH_MINUTES = 8;
const MIN_BILIBILI_PLAYS = 500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// The title has to say it is the person speaking: an interview, conversation, talk or speech.
const INTERVIEW = /访谈|专访|对话|对谈|采访|演讲|致辞|典礼|讲座|论坛|圆桌|峰会|主旨|发言|做客|分享|开讲|十三邀|面对面|鲁豫|杨澜|一席|直播|播客|节目|interview|conversation|in conversation|speech|keynote|commencement|lecture|talk|fireside|panel|podcast|summit|forum|dialogue/i;
const SPEECH = /毕业|致辞|演讲|典礼|开学|speech|commencement|keynote|address/i;
// Second-hand material: clips, compilations, commentary ("XX访谈引热议"), readings, AI voices, and gossip about
// the person. What the title doesn't give away, Gemini catches later (summarize.mjs "firsthand").
const SECONDHAND = /片段|切片|剪辑|合集|混剪|精华|精彩|解说|解读|解析|逐帧|面相|看相|命理|风水|盘点|金句|语录|句话|二创|reaction|反应|点评|揭秘|传奇|发家|身家|豪门|千金|赌王|八卦|绯闻|婚|嫁|分家|争产|遗产|恩怨|起底|曝光|吐槽|鬼畜|AI配音|配音|朗读|书评|有声|小说|励志|热议|引发|如何理解|如何看待|怎么看待|启示|背后|评论|观后感|#|shorts|highlights?|clip|reacts?|explained|breakdown/i;
// Gossip and clickbait from 营销号 ("74岁唐国强终于承认与刘晓庆真实关系…【巨星访谈】"): even when the title says 访谈.
const GOSSIP = /终于|承认|真实关系|真相|前妻|前夫|妻子|丈夫|老公|老婆|儿子|女儿|情史|恋情|旧爱|竟|莫名|万万|没想到|惊人|震惊|晚年|现状|近况|落魄|患病|病逝|去世|离世|泪|哭|挨骂|巨星|娱乐|通透|豁然开朗|浮云|太.{0,3}了[!！:：]|看哭|破防|炸裂|绝了/;

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const decode = s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const day = date => new Date(date).toISOString().slice(0, 10);

// "王坚 / Wang Jian" → ['王坚', 'Wang Jian']; keywords split on spaces, commas and slashes.
export const personFromRow = row => {
  const names = String(row.title || row.key.slice('person:'.length)).split(/\s*[/／,，、]\s*/).map(name => name.trim()).filter(Boolean);
  const keywords = String(row.url || '').split(/[\s,，、/／]+/).map(word => word.trim()).filter(Boolean);
  return { key: row.key, name: names[0], names, keywords };
};

const wanted = (person, { title, text, minutes, channel }) => {
  const named = new RegExp(person.names.map(escapeRegExp).join('|'), 'i');
  if (!named.test(title) || SECONDHAND.test(title)) return false;
  if (!INTERVIEW.test(title) && !new RegExp(`(${person.names.map(escapeRegExp).join('|')})\\s*[:：]`, 'i').test(title)) return false;
  if (minutes == null || minutes < (SPEECH.test(title) ? MIN_SPEECH_MINUTES : MIN_MINUTES)) return false;
  const haystack = `${title}\n${text}\n${channel}`.toLowerCase();
  return !person.keywords.length || person.keywords.some(word => haystack.includes(word.toLowerCase()));
};

// Same interview uploaded twice (YouTube and Bilibili, or two channels): compare titles without punctuation.
export const titleKey = title => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 24);

const isoMinutes = duration => {
  const [, h = 0, m = 0, s = 0] = (duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return Math.round(Number(h) * 60 + Number(m) + Number(s) / 60);
};
// Bilibili durations are "m:ss" (minutes can exceed 59) or "h:mm:ss".
const clockMinutes = text => {
  const parts = String(text || '').split(':').map(Number);
  if (parts.some(Number.isNaN) || !parts.length) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round(seconds / 60);
};

const getJson = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const searchYouTube = async (person, sinceDays, key) => {
  const since = Number.isFinite(sinceDays) ? `&publishedAfter=${new Date(Date.now() - sinceDays * 864e5).toISOString()}` : '';
  const query = encodeURIComponent(person.names.join('|'));
  const order = sinceDays > RECENT_DAYS ? 'relevance' : 'date';
  const found = await getJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=${order}&maxResults=50${since}&q=${query}&key=${key}`);
  const ids = (found.items || []).map(item => item.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const details = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${ids.join(',')}&key=${key}`);
  return (details.items || []).map(video => ({
    key: `youtube:${video.id}`,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    title: decode(video.snippet?.title || ''),
    text: video.snippet?.description || '',
    channel: video.snippet?.channelTitle || '',
    channelId: video.snippet?.channelId,
    published: (video.snippet?.publishedAt || '').slice(0, 10),
    minutes: isoMinutes(video.contentDetails?.duration),
    live: video.snippet?.liveBroadcastContent !== 'none'
  })).filter(video => !video.live);
};

// Bilibili's web search wants the cookies its home page sets; one set per run.
let bilibiliCookie = null;
const bilibiliHeaders = async () => {
  if (bilibiliCookie == null) {
    const response = await fetch('https://www.bilibili.com/', { headers: { 'user-agent': UA } });
    bilibiliCookie = (response.headers.getSetCookie?.() || []).map(cookie => cookie.split(';')[0]).join('; ');
  }
  return { 'user-agent': UA, referer: 'https://search.bilibili.com/', cookie: bilibiliCookie };
};

const searchBilibili = async (person, sinceDays) => {
  const backfill = sinceDays > RECENT_DAYS;
  const cutoff = Number.isFinite(sinceDays) ? Date.now() - sinceDays * 864e5 : 0;
  const results = [];
  for (const keyword of backfill ? [person.name, `${person.name} 访谈`, `${person.name} 演讲`] : [person.name]) {
    for (let page = 1; page <= (backfill ? 3 : 1); page++) {
      const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&order=${backfill ? 'totalrank' : 'pubdate'}&page=${page}`;
      const data = await getJson(url, { headers: await bilibiliHeaders() });
      if (data.code !== 0) throw new Error(`code ${data.code} ${data.message || ''}`.trim());
      const rows = (data.data?.result || []).filter(row => !results.some(seen => seen.bvid === row.bvid));
      results.push(...rows);
      await new Promise(resolve => setTimeout(resolve, 800));
      if ((data.data?.result || []).length < 20) break;
    }
  }
  return results.filter(row => row.bvid && row.pubdate * 1000 >= cutoff && (row.play || 0) >= MIN_BILIBILI_PLAYS).map(row => ({
    key: `bilibili:${row.bvid}`,
    url: `https://www.bilibili.com/video/${row.bvid}`,
    title: decode(row.title || ''),
    text: `${decode(row.description || '')}\n${row.tag || ''}`,
    channel: row.author || '',
    published: day(row.pubdate * 1000),
    minutes: clockMinutes(row.duration)
  }));
};

const summarize = text => {
  const joined = text.split('\n').map(line => line.trim()).filter(line => line && !/https?:\/\/|www\.|关注|订阅|subscribe|^[#@]/i.test(line)).join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 220 ? `${joined.slice(0, 220)}…` : joined;
};

// people: from personFromRow; items: the feed's Map of all items (new ones are added to it); previous: last
// run's people state. Returns the new state: { [name]: { keywords, searched, youtube, bilibili, count } }.
// rejected: keys Gemini judged not first-hand earlier; they are not added again.
export const searchPeople = async (people, items, previous, report, youtubeKey, rejected = new Set()) => {
  const state = {};
  const seenTitles = new Set([...items.values()].filter(item => item.via === 'people').map(item => titleKey(item.title)));
  for (const person of people) {
    const before = previous[person.name];
    const backfill = !before?.searched || before.keywords !== person.keywords.join(' ') || before.backfill !== BACKFILL_VERSION;
    const sinceDays = backfill ? BACKFILL_DAYS : RECENT_DAYS;
    const entry = { keywords: person.keywords.join(' '), searched: before?.searched || '', backfill: backfill ? undefined : before.backfill, youtube: '', bilibili: '' };
    const candidates = [];
    if (youtubeKey) {
      try { candidates.push(...await searchYouTube(person, sinceDays, youtubeKey)); entry.youtube = 'ok'; }
      catch (error) { entry.youtube = error.message; report.push(`people ${person.name} YouTube: FAILED ${error.message}`); }
    } else entry.youtube = 'no key';
    try { candidates.push(...await searchBilibili(person, sinceDays)); entry.bilibili = 'ok'; }
    catch (error) { entry.bilibili = error.message; report.push(`people ${person.name} Bilibili: FAILED ${error.message}`); }

    const fresh = candidates.filter(video => !items.has(video.key) && !rejected.has(video.key) && wanted(person, video))
      .sort((a, b) => b.published.localeCompare(a.published));
    let added = 0;
    for (const video of fresh) {
      if (added >= (backfill ? MAX_NEW_BACKFILL : MAX_NEW_DAILY)) break;
      const sameTitle = titleKey(video.title);
      if (seenTitles.has(sameTitle)) continue;
      seenTitles.add(sameTitle);
      items.set(video.key, {
        key: video.key,
        url: video.url,
        title: video.title,
        channel: video.channel,
        ...(video.channelId ? { channelId: video.channelId } : {}),
        published: video.published,
        summary: summarize(video.text.split('\n')[0] || ''),
        tab: 'people',
        person: person.name,
        tags: ['人物访谈', person.name],
        minutes: video.minutes,
        found: day(Date.now()),
        via: 'people'
      });
      added++;
    }
    // A failed search is retried in full next run.
    if (entry.youtube !== 'ok' && youtubeKey || entry.bilibili !== 'ok') { if (backfill) entry.searched = ''; }
    else {
      entry.searched = day(Date.now());
      entry.backfill = BACKFILL_VERSION;
    }
    state[person.name] = entry;
    report.push(`people ${person.name}: ${backfill ? 'backfill' : 'daily'}, ${candidates.length} results, ${added} new`);
  }
  return state;
};

// The same interview uploaded by several channels shows once. Titles are compared without the person's names,
// digits and stock words (对话, 演讲, 人工智能…). Two videos of one person count as the same when their lengths are
// the same (2 characters in a row in common, e.g. the host "鲁健"), within a minute (3, e.g. the other guest
// "章泽天"), or within 3%
// and 5 characters. Hand-picked videos are kept first, then Bilibili over YouTube (no ads), then the longer upload.
const STOCK = /对话|对谈|访谈|专访|采访|演讲|发言|致辞|分享|院士|最新|独家|完整版?|全集|全程|人工智能|世界|大会|论坛|峰会|中国|节目|播客|podcast|interview|主任|创始人|董事长|cctv|ep|\d+/g;
const longestCommon = (a, b) => {
  let best = 0;
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = b.length; j >= 1; j--) {
      row[j] = a[i - 1] === b[j - 1] && a[i - 1] !== '|' ? row[j - 1] + 1 : 0;
      if (row[j] > best) best = row[j];
    }
  }
  return best;
};
export const dedupePeople = (items, people, report) => {
  const groups = {};
  for (const item of items.values()) if (item.via === 'people') (groups[item.person] ||= []).push(item);
  let removed = 0;
  for (const [name, list] of Object.entries(groups)) {
    const person = people?.find(entry => entry.name === name);
    // Names, identity keywords (in most of their titles) and stock words become "|", so no match runs across them.
    const words = [...(person?.names || [name]), ...(person?.keywords || [])].map(word => word.toLowerCase());
    const bare = title => words.reduce((text, word) => text.split(word).join('|'), title.toLowerCase())
      .replace(STOCK, '|').replace(/[^\p{L}|]/gu, '');
    // The 2-character rule counts Chinese only ("ai" is in half the titles).
    const cjk = title => bare(title).replace(/[^一-鿿|]/g, '|');
    const kept = [];
    list.sort((a, b) => Number(Boolean(b.picked)) - Number(Boolean(a.picked)) || Number(b.key.startsWith('bilibili:')) - Number(a.key.startsWith('bilibili:')) || (b.minutes || 0) - (a.minutes || 0));
    for (const item of list) {
      const same = kept.find(other => {
        const gap = Math.abs((other.minutes || 0) - (item.minutes || 0));
        const common = longestCommon(bare(other.title), bare(item.title));
        return gap === 0 && longestCommon(cjk(other.title), cjk(item.title)) >= 2 || gap <= 1 && common >= 3 || gap <= (other.minutes || 0) * 0.03 && common >= 5;
      });
      if (same) { items.delete(item.key); removed++; } else kept.push(item);
    }
  }
  report.push(`people: ${removed} duplicate uploads dropped`);
};

export const PEOPLE_TITLE_OK =(person, title) => new RegExp(person.names.map(escapeRegExp).join('|'), 'i').test(title) && !SECONDHAND.test(title) && !GOSSIP.test(title);

// Hand-picked 人物访谈 (docs/people-picks.json: [{ person, url, note?, title?, channel?, published?, minutes? }]; the last four only for links that are not Bilibili or YouTube), for interviews the search misses or its
// title rules would skip. They are added once with the platform's own title, date and length, marked picked (kept
// whatever the title says, never judged second-hand, and preferred when another upload of the same video exists).
// A Bilibili or YouTube link → its feed key; '' for anything else.
export const pickKey = url => {
  const bvid = url.match(/bilibili\.com\/video\/(BV\w+)/)?.[1];
  const youtubeId = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1];
  return bvid ? `bilibili:${bvid}` : youtubeId ? `youtube:${youtubeId}` : '';
};
// Title, channel, date, length and description of one video, from the platform.
const fetchVideo = async (key, youtubeKey) => {
  const id = key.slice(key.indexOf(':') + 1);
  if (key.startsWith('bilibili:')) {
    const data = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${id}`, { headers: await bilibiliHeaders() });
    if (data.code !== 0) throw new Error(`code ${data.code}`);
    const info = data.data;
    return { url: `https://www.bilibili.com/video/${id}`, title: info.title, channel: info.owner?.name || '', published: day(info.pubdate * 1000), minutes: Math.round(info.duration / 60), text: info.desc || '' };
  }
  if (!youtubeKey) throw new Error('no YouTube key');
  const info = (await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${id}&key=${youtubeKey}`)).items?.[0];
  if (!info) throw new Error('not found');
  return { url: `https://www.youtube.com/watch?v=${id}`, title: decode(info.snippet.title), channel: info.snippet.channelTitle, channelId: info.snippet.channelId, published: info.snippet.publishedAt.slice(0, 10), minutes: isoMinutes(info.contentDetails.duration), text: info.snippet.description || '' };
};

export const addPicks = async (picks, items, report, youtubeKey) => {
  let added = 0;
  for (const pick of picks) {
    const key = pickKey(pick.url);
    // Elsewhere (Tencent / iflix and the like, not embeddable): the pick gives title, channel, published and minutes,
    // and the card links out. Key as the page's canonicalMediaKey has it, so 已看 matches.
    if (!key && pick.title) {
      const url = new URL(pick.url);
      const otherKey = `url:${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`;
      if (!items.has(otherKey)) {
        items.set(otherKey, {
          key: otherKey, url: pick.url, title: pick.title, channel: pick.channel || url.hostname, published: pick.published || '',
          summary: '', tab: 'people', person: pick.person, tags: ['人物访谈', pick.person], minutes: pick.minutes ?? null,
          found: day(Date.now()), via: 'people', picked: true, firsthand: true, ...(pick.note ? { note: pick.note } : {})
        });
        added++;
      }
      continue;
    }
    if (!key) { report.push(`pick ${pick.url}: not a Bilibili or YouTube link, and no title given`); continue; }
    if (items.has(key)) { Object.assign(items.get(key), { picked: true, firsthand: true }); continue; }
    try {
      const video = await fetchVideo(key, youtubeKey);
      items.set(key, {
        key, url: video.url, title: video.title, channel: video.channel, ...(video.channelId ? { channelId: video.channelId } : {}),
        published: video.published, summary: summarize(video.text.split('\n')[0] || ''), tab: 'people', person: pick.person,
        tags: ['人物访谈', pick.person], minutes: video.minutes, found: day(Date.now()), via: 'people', picked: true, firsthand: true,
        ...(pick.note ? { note: pick.note } : {})
      });
      added++;
    } catch (error) {
      report.push(`pick ${key}: FAILED ${error.message}`);
    }
  }
  report.push(`people picks: ${added} added`);
};

// Hand-picked 精选 videos (docs/video-picks.json: [{ url, field, note? }], field "health" or "medical" as in
// summarize.mjs), for good ones the channel polls missed (older than their window, or a channel not followed).
// Added once with the platform's details; update-feed.mjs keeps them while they are listed (no shelf life) and
// places them by field: 个人健康 AI in 精选, the rest in 演讲 & Podcast.
export const addVideoPicks = async (picks, items, report, youtubeKey) => {
  let added = 0;
  for (const pick of picks) {
    const key = pickKey(pick.url);
    if (!key) { report.push(`video pick ${pick.url}: not a Bilibili or YouTube link`); continue; }
    const existing = items.get(key);
    if (existing) { Object.assign(existing, { picked: true, field: pick.field || existing.field }); continue; }
    try {
      const video = await fetchVideo(key, youtubeKey);
      items.set(key, {
        key, url: video.url, title: video.title, channel: video.channel, ...(video.channelId ? { channelId: video.channelId } : {}),
        published: video.published, summary: summarize(video.text.split('\n')[0] || ''), about: pick.note || `${video.channel} 的视频。`,
        tab: pick.field === 'health' ? 'curated' : 'appearances', tags: [], minutes: video.minutes, found: day(Date.now()), via: 'pick', picked: true, field: pick.field || 'none'
      });
      added++;
    } catch (error) {
      report.push(`video pick ${key}: FAILED ${error.message}`);
    }
  }
  report.push(`video picks: ${added} added`);
};

// Followed Bilibili uploaders ("channel:bilibili/<mid>" rows): the name from the uploader card, then their new
// videos from the video search (by name, newest first), kept when the uploader id matches.
export const bilibiliUp = async mid => {
  const data = await getJson(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, { headers: await bilibiliHeaders() });
  if (data.code !== 0 || !data.data?.card?.name) return { error: 'B 站没有这个 UP 主' };
  return { id: `bilibili:${mid}`, name: data.data.card.name };
};
export const pollBilibiliUp = async (source, maxAgeDays, minMinutes) => {
  const mid = Number(source.channel.slice('bilibili:'.length));
  const cutoff = Date.now() - maxAgeDays * 864e5;
  const results = [];
  for (let page = 1; page <= 2; page++) {
    const data = await getJson(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(source.name)}&order=pubdate&page=${page}`, { headers: await bilibiliHeaders() });
    if (data.code !== 0) throw new Error(`code ${data.code} ${data.message || ''}`.trim());
    const rows = (data.data?.result || []).filter(row => row.mid === mid);
    results.push(...rows);
    if (!rows.length || rows.some(row => row.pubdate * 1000 < cutoff)) break;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  return results.filter(row => row.bvid && row.pubdate * 1000 >= cutoff && clockMinutes(row.duration) >= minMinutes).map(row => ({
    key: `bilibili:${row.bvid}`,
    url: `https://www.bilibili.com/video/${row.bvid}`,
    title: decode(row.title || ''),
    channel: source.name,
    channelId: source.channel,
    published: day(row.pubdate * 1000),
    summary: summarize(decode(row.description || '')),
    about: source.about,
    tab: 'appearances',
    tags: source.tags,
    minutes: clockMinutes(row.duration),
    found: day(Date.now())
  }));
};
