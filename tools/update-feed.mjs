// Daily feed update, run by .github/workflows/daily-feed.yml (Node 20+, no dependencies).
// 1. Polls the RSS feeds of official YouTube channels and keeps recent, AI-relevant long-form videos (no Shorts).
// 2. Polls the channels the user followed by link on the page, and fills in publish dates and descriptions
//    for videos added by hand there (both from Supabase added_videos).
// 3. News about the watchlist people and labs and the priority themes (news.mjs), for the 简报 tab, with a Chinese
//    summary and "这意味着" from Gemini when GEMINI_API_KEY is set (summarize.mjs), and 今日重点: the day's top
//    stories by score, plus 本周大事 (digest.mjs).
// 4. Shelf life: 演讲 & Podcast videos go once they are older than their content type allows (SHELF_DAYS: product
//    updates 3 months, industry judgment and untyped 1 year, method never). Sports and Olympic videos and 精选 stay.
// 5. 人物访谈: interviews and talks of the people listed on the page, from YouTube and Bilibili (people.mjs). They
//    never expire; the page hides the ones marked 已看.
// With a YOUTUBE_API_KEY (YouTube Data API v3) it also drops videos under MIN_MINUTES and dates hand-added
// YouTube videos; without one those two steps are skipped and the title rules below do the filtering.
// Usage: node update-feed.mjs <path to auto-feed.json>   (read if present, then rewritten)
import fs from 'fs';
import { collectNews } from './news.mjs';
import { summarizeNews, highlightVideos, VIDEO_HIGHLIGHTS_PER_RUN } from './summarize.mjs';
import { buildDigest } from './digest.mjs';
import { personFromRow, searchPeople, PEOPLE_TITLE_OK } from './people.mjs';

const AI = /\bAI\b|A\.I\.|artificial intelligence|machine learning|\bLLMs?\b|\bGPT|agent|chatbot|ChatGPT|Claude|Gemini|Qwen|Kimi|DeepSeek|robot|人工智能|大模型|模型|智能体|机器人|具身/i;
const OLYMPIC = /olympi|paralympi|\bIOC\b|奥运|奥林匹克|冬奥/i;
// Company channels post many short product clips; from them keep only titles that read like a talk.
const TALK = /keynote|interview|podcast|conversation|panel|fireside|livestream|live stream|devday|lecture|talk|session|summit|address|episode|\bEP\s?\d|\bCEO\b|founder|访谈|演讲|对话/i;
const EXCLUDE = /highlight|recap|trailer|teaser|promo|#shorts|giveaway|award/i;
const MAX_AGE_DAYS = 30;
const MAX_PER_SOURCE = 5;
const MAX_ITEMS = 300;
// Days a 演讲 & Podcast video stays, by kind (summarize.mjs); untyped videos count as judgment.
const SHELF_DAYS = { product: 90, judgment: 365 };
const SPORTS_TAG = /奥运|体育/;
const expired = item => item.tab !== 'curated' && item.tab !== 'people' && !item.sports && !OLYMPIC.test(item.title) && !(item.tags || []).some(tag => SPORTS_TAG.test(tag))
  && item.kind !== 'method' && Date.parse(item.published) < Date.now() - SHELF_DAYS[item.kind || 'judgment'] * 86400000;
const MIN_MINUTES = 5;
// Person search (YouTube Data API, 100 quota units per person of the free 10,000 a day).
const PERSON_SEARCH_DAYS = 7;
const MAX_PER_PERSON = 3;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

const xiaojunAbout = '张小珺长期深度访谈中国与硅谷的 AI、机器人和科技创业者。';
// match: the title must match (null keeps every long video). talksOnly: the title must also read like a talk.
// onlyCjk: skips the channel's separate English uploads of the same episodes.
// followKey: polled only while that channel is in the followed list on the page (menu → 添加视频 / 频道), so it can be unfollowed there.
const SOURCES = [
  { channel: 'UC3Sv1JuKpbOx3csUO8FAo5g', name: '张小珺 Podcast', match: null, onlyCjk: true, followKey: 'channel:@xiaojunpodcast', tags: ['关注频道'], about: xiaojunAbout },
  { channel: 'UCiq1FIgtEK7LRAOB1JXTPig', name: 'Silicon Valley Girl', match: AI, followKey: 'channel:@siliconvalleygirl', tags: ['关注频道'], about: 'Marina Mogilko（Silicon Valley Girl）采访 AI 从业者和研究者，话题偏职业与日常使用。' },
  { channel: 'UCXZCJLdBC09xxGZ6gcdrc6A', name: 'OpenAI', match: null, talksOnly: true, tags: ['前沿实验室'], about: 'OpenAI 官方频道：模型发布、产品演示和研究分享。' },
  { channel: 'UCrDwWp7EBBv4NwvScIpBDOA', name: 'Anthropic', match: null, talksOnly: true, tags: ['前沿实验室'], about: 'Anthropic 官方频道：Claude 模型、研究和安全相关内容。' },
  { channel: 'UCP7jMXSY2xbc3KCAE0MHQ-A', name: 'Google DeepMind', match: null, talksOnly: true, tags: ['前沿实验室'], about: 'Google DeepMind 官方频道：Gemini、科学 AI 和研究进展。' },
  { channel: 'UCHuiy8bXnmK5nisYHUd1J5g', name: 'NVIDIA', match: AI, talksOnly: true, tags: ['算力'], about: 'NVIDIA 官方频道：AI 算力、主题演讲和物理 AI。' },
  { channel: 'UCTl3QQTvqHFjurroKxexy2Q', name: 'Olympics', match: AI, tags: ['奥运'], about: '奥林匹克官方频道。' },
  { channel: 'UCczuDpBlXXdOuheWZClbRCw', name: 'IOC Media', match: AI, tags: ['奥运'], about: '国际奥委会官方媒体频道：发布会、专家会谈和奥运 AI 议程。' },
  { channel: 'UCipPA-ZHX6UYGH_Iyti1-Jw', name: 'Alibaba Cloud', match: AI, talksOnly: true, tags: ['中国 AI'], about: '阿里云官方频道：通义千问（Qwen）和云上 AI；也是奥运会的 AI 合作方。' },
  { channel: 'UCXl4i9dYBrFOabk0xGmbkRA', name: 'Dwarkesh Podcast', match: AI, tags: ['Podcast'], about: 'Dwarkesh Patel 的深度访谈播客，常请前沿实验室研究者和 AI 领域思想者。' },
  { channel: 'UCSHZKyawb77ixDdsGog4iWA', name: 'Lex Fridman', match: AI, tags: ['Podcast'], about: 'Lex Fridman 的长访谈播客，嘉宾覆盖 AI、科技与科学。' },
  { channel: 'UCSI7h9hydQ40K5MJHnCrQvw', name: 'No Priors', match: null, tags: ['Podcast'], about: 'No Priors：投资人 Sarah Guo 与 Elad Gil 访谈 AI 创业者和研究者。' },
  { channel: 'UCxBcwypKK-W3GHd_RZ9FZrQ', name: 'Latent Space', match: null, tags: ['Podcast'], about: 'Latent Space：面向 AI 工程师的播客，聊模型、智能体和工程实践。' },
  { channel: 'UC60lr26YqvcSrl1eDoB2U6A', name: 'Artificial Lawyer', match: null, tags: ['法律 AI'], about: 'Artificial Lawyer：法律科技媒体，访谈法律 AI 公司和律所。' },
  { channel: 'UCN3m0mRwiE3eGfJTvbWFwrg', name: 'SportsPro', match: AI, tags: ['体育 AI'], about: 'SportsPro：体育产业媒体，涉及转播、球迷和体育科技。' },
  { channel: 'UCroeMSea_O-xfgDvgbJGVQA', name: 'MicroConf', match: AI, tags: ['SaaS'], about: 'MicroConf：面向自筹资金 SaaS 创业者的大会与频道。' },
  { channel: 'UCHoBKQDRkJcOY2BO47q5Ruw', name: 'Rob Walling', match: AI, tags: ['SaaS'], about: 'Rob Walling：MicroConf 与 TinySeed 创始人之一，讲 SaaS 创业。' }
];

const SUPABASE_URL = 'https://dsqpkdksnsdiiaawikga.supabase.co';
// Publishable key, same as in the page; RLS limits it to the public tables' policies.
const SUPABASE_ANON_KEY = 'sb_publishable_QVHY1GNIxibOtw0xuYszUg_LmBE6spD';

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => decode((xml.match(new RegExp(`<${name}>([^]*?)</${name}>`)) || [])[1] || '');

// First plain sentences of a description, without links, hashtags, sponsor lines, chapters or emoji bullets.
const plainDescription = text => text.split('\n').map(line => line.trim()).filter(line => line
  && !/https?:\/\/|www\.|subscribe|follow (me|us)|sponsor|newsletter|patreon|discord|instagram|twitter|tiktok|linkedin|partner|use code|promo/i.test(line)
  && !/^[#@]|^\(?\d{1,2}:\d{2}/.test(line)
  && !/^[\p{Extended_Pictographic}\p{S}*]/u.test(line)).join(' ').replace(/\s+/g, ' ').trim();
const summarize = text => {
  const joined = plainDescription(text);
  return joined.length > 220 ? `${joined.slice(0, 220)}…` : joined;
};

const fetchText = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.replace(/key=[^&]+/, 'key=…')}`);
  return response.text();
};

// The title rules for a source; also re-applied to items kept from earlier runs.
const titleWanted = (source, title) => !EXCLUDE.test(title)
  && (!source.onlyCjk || /[一-鿿]/.test(title))
  && (!source.match || source.match.test(title))
  && (!source.talksOnly || TALK.test(title));

const pollSource = async source => {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${source.channel}`);
  // A channel the user followed by link gets its name from the feed (the first <title> is the channel's).
  if (!source.name) {
    source.name = tag(xml, 'title');
    source.about = `你手动关注的频道：${source.name}。`;
  }
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  return xml.split('<entry>').slice(1).map(entry => {
    const id = tag(entry, 'yt:videoId');
    const link = (entry.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || '';
    return { id, link, title: tag(entry, 'title'), published: tag(entry, 'published').slice(0, 10), description: tag(entry, 'media:description') };
  }).filter(video => video.id
    && !video.link.includes('/shorts/')
    && Date.parse(video.published) >= cutoff
    && titleWanted(source, video.title))
    .map(video => {
      const text = `${video.title}\n${video.description}`;
      const olympicAi = OLYMPIC.test(text) && AI.test(text);
      return {
        key: `youtube:${video.id}`,
        url: `https://www.youtube.com/watch?v=${video.id}`,
        title: video.title,
        channel: source.name,
        channelId: source.channel,
        published: video.published,
        summary: summarize(video.description),
        about: source.about,
        // Olympic AI is the top priority, so it goes to 精选视频; everything else to 演讲 & Podcast.
        tab: olympicAi ? 'curated' : 'appearances',
        tags: olympicAi ? ['奥运 AI · 最高优先级', ...source.tags] : source.tags,
        minutes: null,
        found: new Date().toISOString().slice(0, 10)
      };
    });
};

// ISO 8601 duration (PT1H2M3S) → minutes.
const isoMinutes = duration => {
  const [, h = 0, m = 0, s = 0] = (duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return Math.round(Number(h) * 60 + Number(m) + Number(s) / 60);
};

// Official YouTube Data API v3, up to 50 videos per request; empty without a key.
const youtubeDetails = async ids => {
  const details = {};
  if (!YOUTUBE_API_KEY) return details;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = JSON.parse(await fetchText(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${batch.join(',')}&key=${YOUTUBE_API_KEY}`));
    for (const video of data.items || []) {
      details[video.id] = {
        published: (video.snippet?.publishedAt || '').slice(0, 10),
        title: video.snippet?.title || '',
        author: video.snippet?.channelTitle || '',
        minutes: isoMinutes(video.contentDetails?.duration),
        summary: summarize(video.snippet?.description || ''),
        description: plainDescription(video.snippet?.description || '')
      };
    }
  }
  return details;
};

// Long videos (over 20 minutes) from the last week whose title reads like the person speaking: an interview,
// a talk, "Name: ...", "Name on ...", "with Name". Commentary, biographies, book summaries and re-uploads with
// added subtitles are left out, and so are channels under MIN_SUBSCRIBERS (mostly re-upload channels).
const CLICKBAIT = /\b(just|shocking|stunning|insane|reacts?|reaction|explained|breakdown|leaked|exposed|warning|revealed?|reveals|stupid|scumbag|hated?|disaster|scheme|lessons?|life|book|audiobook|summary|story|history|documentary|deposition|uncut|biography|the man who|price of|wrong|fight)\b|!|#/i;
const REPOST = /字幕|字卡|重點|重点|整理|解说|解說|翻译|翻譯|講演|対談|一句英文|[぀-ヿ]/;
const MIN_SUBSCRIBERS = 20000;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const speaking = (title, person) => {
  const names = person.aliases.map(escapeRegExp).join('|');
  const speaker = new RegExp(`(${names})\\s*(:|：|,|\\son\\s|\\sand\\s|\\s&\\s|\\s(speaks?|says|talks?|joins|sits down))|(with|&|and|ft\\.?|feat\\.?)\\s+(${names})`, 'i');
  const chinese = person.aliases.some(alias => /[一-鿿]/.test(alias));
  return new RegExp(names, 'i').test(title) && !new RegExp(`\\bby\\s+(${names})`, 'i').test(title) && !EXCLUDE.test(title) && !CLICKBAIT.test(title)
    && (chinese || !REPOST.test(title) && !/[一-鿿]/.test(title))
    && (speaker.test(title) || TALK.test(title));
};
const subscriberCounts = async channelIds => {
  if (!channelIds.length) return {};
  const data = JSON.parse(await fetchText(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds.join(',')}&key=${YOUTUBE_API_KEY}`));
  return Object.fromEntries((data.items || []).map(channel => [channel.id, Number(channel.statistics?.subscriberCount || 0)]));
};
const searchPerson = async (person, since) => {
  const query = encodeURIComponent(`"${person.name}"`);
  const data = JSON.parse(await fetchText(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=long&order=relevance&maxResults=10&publishedAfter=${since}&q=${query}&key=${YOUTUBE_API_KEY}`));
  const candidates = (data.items || []).map(result => ({ id: result.id?.videoId, ...result.snippet }))
    .filter(video => video.id && speaking(decode(video.title || ''), person));
  const subscribers = await subscriberCounts([...new Set(candidates.map(video => video.channelId))]);
  return candidates.filter(video => subscribers[video.channelId] >= MIN_SUBSCRIBERS).map(video => {
    const title = decode(video.title);
    const text = `${title}\n${video.description || ''}`;
    const olympicAi = OLYMPIC.test(text) && AI.test(text);
    return {
      key: `youtube:${video.id}`,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      title,
      channel: decode(video.channelTitle || ''),
      channelId: video.channelId,
      published: (video.publishedAt || '').slice(0, 10),
      summary: summarize(decode(video.description || '')),
      about: `${person.name}：${person.note}。`,
      tab: olympicAi ? 'curated' : 'appearances',
      tags: olympicAi ? ['奥运 AI · 最高优先级', person.name] : ['人物新视频', person.name],
      minutes: null,
      found: new Date().toISOString().slice(0, 10),
      via: 'person'
    };
  });
};

const vimeoDetails = async url => {
  const data = JSON.parse(await fetchText(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`));
  if (!data.upload_date) throw new Error(`no upload date for ${url}`);
  return { published: data.upload_date.slice(0, 10), title: data.title, author: data.author_name, minutes: Math.round((data.duration || 0) / 60), summary: summarize(data.description || '') };
};

// Channel ID for a followed channel link (/@handle, /channel/UC…, /c/…, /user/…), from its page or the Data API.
const resolveChannel = async row => {
  const path = row.url.replace(/^https:\/\/www\.youtube\.com\//, '');
  const direct = path.match(/^channel\/(UC[\w-]{22})$/)?.[1];
  if (direct) return { id: direct };
  const response = await fetch(`https://www.youtube.com/${path}`, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' } });
  if (response.status === 404) return { error: '这个频道地址不存在' };
  const html = response.ok ? await response.text() : '';
  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1]
    || html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
  if (id) return { id };
  if (YOUTUBE_API_KEY && path.startsWith('@')) {
    const data = JSON.parse(await fetchText(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(path)}&key=${YOUTUBE_API_KEY}`));
    if (data.items?.[0]?.id) return { id: data.items[0].id };
    return { error: '这个频道地址不存在' };
  }
  throw new Error(`channel page gave no ID (HTTP ${response.status})`);
};

const outPath = process.argv[2];
if (!outPath) throw new Error('usage: node update-feed.mjs <auto-feed.json>');
let previous = { items: [], videos: {}, channels: {} };
try { previous = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* First run. */ }

const report = [YOUTUBE_API_KEY ? 'YouTube Data API: on' : 'YouTube Data API: off (no YOUTUBE_API_KEY); length check and hand-added YouTube dates skipped'];

// Hand-added videos and followed channels (keys starting with "channel:") from the page.
let addedRows = null;
try {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/added_videos?select=key,url`, { headers: { apikey: SUPABASE_ANON_KEY } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  addedRows = await response.json();
} catch (error) {
  report.push(`added_videos: not read (${error.message})`);
}

// Followed channels become sources with no title filter: the user picked them. When the table can't be read,
// keep the previous channel list so their videos don't vanish for one run.
const channels = {};
const followedRows = addedRows ? addedRows.filter(row => row.key.startsWith('channel:'))
  : Object.entries(previous.channels || {}).map(([key, info]) => ({ key, url: info.url }));
const userSources = [];
for (const row of followedRows) {
  const known = previous.channels?.[row.key];
  const builtIn = SOURCES.find(source => source.followKey === row.key);
  let info = builtIn ? { id: builtIn.channel } : known?.id ? known : null;
  if (!info) {
    try { info = await resolveChannel(row); } catch (error) { report.push(`channel ${row.key}: not resolved yet (${error.message})`); }
  }
  channels[row.key] = { url: row.url, ...(info || {}) };
  if (channels[row.key].id && !SOURCES.some(source => source.channel === channels[row.key].id)) {
    userSources.push({ channel: channels[row.key].id, name: known?.name || '', match: null, tags: ['你关注的频道'], about: known?.name ? `你手动关注的频道：${known.name}。` : '', key: row.key });
  }
}
const followedKeys = new Set(followedRows.map(row => row.key));
const allSources = [...SOURCES.filter(source => !source.followKey || followedKeys.has(source.followKey)), ...userSources];

let watchlist = null;
try {
  watchlist = JSON.parse(fs.readFileSync(new URL('../docs/watchlist-v1.json', import.meta.url), 'utf8'));
} catch (error) {
  report.push(`watchlist: not read (${error.message})`);
}
const people = watchlist?.groups.find(group => group.people)?.items || [];
// 人物访谈 list from the page; null when the table can't be read (their videos are then kept as they are).
const interviewPeople = addedRows ? addedRows.filter(row => row.key.startsWith('person:')).map(personFromRow) : null;
const sourceFor = item => allSources.find(source => source.channel === item.channelId || (!source.key && source.name === item.channel));
// Earlier items stay only while they still pass the current rules (and their channel is still followed).
const items = new Map((previous.items || [])
  .filter(item => {
    // Found by the person search: kept (until its shelf life ends), whatever channel it is on, while its title passes.
    // 人物访谈: kept while the person is still on the list and the title still passes.
    if (item.via === 'people') {
      if (!interviewPeople) return true;
      const person = interviewPeople.find(entry => entry.name === item.person);
      return person && PEOPLE_TITLE_OK(person, item.title);
    }
    if (item.via === 'person') {
      const person = people.find(entry => entry.name === item.tags?.[1]);
      return person && speaking(item.title, person);
    }
    const source = sourceFor(item);
    return source && titleWanted(source, item.title);
  })
  // Items saved before channelId existed get it here, so followed-channel counts include them.
  .map(item => [item.key, { ...item, channelId: item.channelId || sourceFor(item)?.channel }]));

for (const source of allSources) {
  try {
    const found = (await pollSource(source)).filter(item => !items.has(item.key)).slice(0, MAX_PER_SOURCE);
    found.forEach(item => items.set(item.key, item));
    const followKey = source.key || source.followKey;
    if (followKey) channels[followKey].name = source.name;
    report.push(`${source.name}: ${found.length} new`);
  } catch (error) {
    report.push(`${source.name || source.channel}: FAILED ${error.message}`);
  }
}

// 人物访谈 first: the watchlist search below can use up the day's YouTube quota.
let peopleState = previous.people || {};
if (interviewPeople) {
  try {
    peopleState = await searchPeople(interviewPeople, items, previous.people || {}, report, YOUTUBE_API_KEY);
  } catch (error) {
    report.push(`people: FAILED ${error.message}`);
  }
}

// Watchlist people on any channel (their talks and podcast guest spots), via YouTube search; needs the API key.
if (YOUTUBE_API_KEY && watchlist) {
  const since = new Date(Date.now() - PERSON_SEARCH_DAYS * 86400000).toISOString();
  for (const person of people) {
    try {
      const found = (await searchPerson(person, since)).filter(item => !items.has(item.key)).slice(0, MAX_PER_PERSON);
      found.forEach(item => items.set(item.key, item));
      if (found.length) report.push(`person ${person.name}: ${found.length} new`);
    } catch (error) {
      report.push(`person ${person.name}: FAILED ${error.message}`);
      if (/HTTP 403/.test(error.message)) break; // Out of quota for today.
    }
  }
}

try {
  const unmeasured = [...items.values()].filter(item => item.minutes == null).map(item => item.key.slice('youtube:'.length));
  const details = await youtubeDetails(unmeasured);
  for (const [id, info] of Object.entries(details)) {
    const item = items.get(`youtube:${id}`);
    item.minutes = info.minutes;
    if (info.minutes < MIN_MINUTES && item.tab !== 'curated') items.delete(item.key);
  }
} catch (error) {
  report.push(`length check: FAILED ${error.message}`);
}

const videos = { ...(previous.videos || {}) };
if (addedRows) {
  try {
    const rows = addedRows.filter(row => !/^(channel|person):/.test(row.key) && !videos[row.key]?.published);
    const youtubeRows = rows.filter(row => row.key.startsWith('youtube:'));
    const details = await youtubeDetails(youtubeRows.map(row => row.key.slice('youtube:'.length)));
    youtubeRows.forEach(row => { if (details[row.key.slice('youtube:'.length)]) videos[row.key] = details[row.key.slice('youtube:'.length)]; });
    for (const row of rows.filter(row => /vimeo\.com/.test(row.url))) {
      try { videos[row.key] = await vimeoDetails(row.url); } catch (error) { report.push(`added video ${row.key}: ${error.message}`); }
    }
    report.push(`added videos: ${rows.length} needed details, ${rows.filter(row => videos[row.key]?.published).length} filled`);
  } catch (error) {
    report.push(`added video details: FAILED ${error.message}`);
  }
}

// 人物访谈 items don't count toward MAX_ITEMS: they stay until marked 已看 or the person is removed.
const newestFirst = (a, b) => b.published.localeCompare(a.published);
let kept = [
  ...[...items.values()].filter(item => item.via !== 'people').sort(newestFirst).slice(0, MAX_ITEMS),
  ...[...items.values()].filter(item => item.via === 'people').sort(newestFirst)
];
// Keep the old timestamp when nothing changed, so the job doesn't commit an identical file.
let news = previous.news || [];
const newsStats = {};
try {
  if (!watchlist) throw new Error('watchlist not read');
  news = await collectNews(watchlist, news, report, newsStats);
  await summarizeNews(news, report);
} catch (error) {
  report.push(`news: FAILED ${error.message}`);
}
let digest = { digests: previous.digests || [], weekly: previous.weekly || [] };
try {
  digest = buildDigest(news, digest.digests, newsStats, report);
} catch (error) {
  report.push(`今日重点: FAILED ${error.message}`);
}
// 内容重点 and content type for YouTube cards without them yet, from the full description (newest first; the rest
// on later runs).
try {
  const pending = [
    ...kept.filter(item => /^(youtube|bilibili):/.test(item.key)).map(item => ({ key: item.key, title: item.title, channel: item.channel, published: item.published, target: item })),
    ...Object.entries(videos).filter(([key]) => key.startsWith('youtube:')).map(([key, info]) => ({ key, title: info.title, channel: info.author, published: info.published, target: info }))
  ].filter(entry => !entry.target.highlight || !entry.target.kind)
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .slice(0, VIDEO_HIGHLIGHTS_PER_RUN);
  const details = await youtubeDetails(pending.filter(entry => entry.key.startsWith('youtube:')).map(entry => entry.key.slice('youtube:'.length)));
  // Bilibili has no details call here; its search snippet is the description.
  pending.forEach(entry => { entry.description = details[entry.key.slice('youtube:'.length)]?.description || entry.target.summary || ''; });
  await highlightVideos(pending, report);
} catch (error) {
  report.push(`video highlights: FAILED ${error.message}`);
}
const expiredCount = kept.filter(expired).length;
kept = kept.filter(item => !expired(item));
report.push(`shelf life: ${expiredCount} expired, ${kept.filter(item => !item.kind).length} of ${kept.length} not typed yet`);
Object.values(channels).forEach(info => { if (info.id) info.count = kept.filter(item => item.channelId === info.id).length; });
// The full description only feeds the highlight; it is not kept in the feed.
Object.values(videos).forEach(info => { delete info.description; });

const content = { items: kept, videos, channels, people: peopleState, news, ...digest };
const { updated: previousUpdated, ...previousContent } = previous;
const unchanged = JSON.stringify(previousContent) === JSON.stringify(content);
fs.writeFileSync(outPath, `${JSON.stringify({ updated: unchanged ? previousUpdated : new Date().toISOString(), ...content }, null, 1)}\n`);
console.log(report.join('\n'));
console.log(`${unchanged ? 'unchanged' : 'wrote'}: ${kept.length} items, ${Object.keys(videos).length} video infos, ${Object.keys(channels).length} followed channels`);
