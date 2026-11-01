// Daily feed update, run by .github/workflows/daily-feed.yml (Node 20+, no dependencies).
// 1. Polls the RSS feeds of official YouTube channels and keeps recent, AI-relevant long videos (no Shorts).
// 2. Fills in publish dates and descriptions for videos added by hand on the page (Supabase added_videos).
// Usage: node update-feed.mjs <path to auto-feed.json>   (read if present, then rewritten)
import fs from 'fs';

const AI = /\bAI\b|A\.I\.|artificial intelligence|machine learning|\bLLMs?\b|\bGPT|agent|chatbot|ChatGPT|Claude|Gemini|Qwen|Kimi|DeepSeek|robot|人工智能|大模型|模型|智能体|机器人|具身/i;
const OLYMPIC = /olympi|paralympi|\bIOC\b|奥运|奥林匹克|冬奥/i;
const MAX_AGE_DAYS = 30;
const MAX_PER_SOURCE = 5;
const MAX_ITEMS = 150;
// Promos, event recaps and ads are not talks; videos shorter than this are skipped unless they are Olympic AI.
const EXCLUDE = /highlight|recap|trailer|teaser|promo|#shorts|giveaway|award/i;
const MIN_MINUTES = 5;

const xiaojunAbout = '张小珺长期深度访谈中国与硅谷的 AI、机器人和科技创业者。';
// match: the title must match to be kept (null keeps every long video). onlyCjk skips the channel's separate English uploads.
const SOURCES = [
  { channel: 'UC3Sv1JuKpbOx3csUO8FAo5g', name: '张小珺 Podcast', match: null, onlyCjk: true, tags: ['关注频道'], about: xiaojunAbout },
  { channel: 'UCiq1FIgtEK7LRAOB1JXTPig', name: 'Silicon Valley Girl', match: AI, tags: ['关注频道'], about: 'Marina Mogilko（Silicon Valley Girl）采访 AI 从业者和研究者，话题偏职业与日常使用。' },
  { channel: 'UCXZCJLdBC09xxGZ6gcdrc6A', name: 'OpenAI', match: null, tags: ['前沿实验室'], about: 'OpenAI 官方频道：模型发布、产品演示和研究分享。' },
  { channel: 'UCrDwWp7EBBv4NwvScIpBDOA', name: 'Anthropic', match: null, tags: ['前沿实验室'], about: 'Anthropic 官方频道：Claude 模型、研究和安全相关内容。' },
  { channel: 'UCP7jMXSY2xbc3KCAE0MHQ-A', name: 'Google DeepMind', match: null, tags: ['前沿实验室'], about: 'Google DeepMind 官方频道：Gemini、科学 AI 和研究进展。' },
  { channel: 'UCHuiy8bXnmK5nisYHUd1J5g', name: 'NVIDIA', match: AI, tags: ['算力'], about: 'NVIDIA 官方频道：AI 算力、主题演讲和物理 AI。' },
  { channel: 'UCTl3QQTvqHFjurroKxexy2Q', name: 'Olympics', match: AI, tags: ['奥运'], about: '奥林匹克官方频道。' },
  { channel: 'UCczuDpBlXXdOuheWZClbRCw', name: 'IOC Media', match: AI, tags: ['奥运'], about: '国际奥委会官方媒体频道：发布会、专家会谈和奥运 AI 议程。' },
  { channel: 'UCipPA-ZHX6UYGH_Iyti1-Jw', name: 'Alibaba Cloud', match: AI, tags: ['中国 AI'], about: '阿里云官方频道：通义千问（Qwen）和云上 AI；也是奥运会的 AI 合作方。' },
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
const summarize = text => {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line
    && !/https?:\/\/|www\.|subscribe|follow (me|us)|sponsor|newsletter|patreon|discord|instagram|twitter|tiktok|linkedin|partner|use code|promo/i.test(line)
    && !/^[#@]|^\(?\d{1,2}:\d{2}/.test(line)
    && !/^[\p{Extended_Pictographic}\p{S}*]/u.test(line));
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 220 ? `${joined.slice(0, 220)}…` : joined;
};

const fetchText = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
};

const pollSource = async source => {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${source.channel}`);
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  return xml.split('<entry>').slice(1).map(entry => {
    const id = tag(entry, 'yt:videoId');
    const link = (entry.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || '';
    return { id, link, title: tag(entry, 'title'), published: tag(entry, 'published').slice(0, 10), description: tag(entry, 'media:description') };
  }).filter(video => video.id
    && !video.link.includes('/shorts/')
    && Date.parse(video.published) >= cutoff
    && (!source.onlyCjk || /[一-鿿]/.test(video.title))
    && !EXCLUDE.test(video.title)
    && (!source.match || source.match.test(video.title)))
    .map(video => {
      const olympicAi = OLYMPIC.test(`${video.title}\n${video.description}`) && AI.test(`${video.title}\n${video.description}`);
      return {
        key: `youtube:${video.id}`,
        url: `https://www.youtube.com/watch?v=${video.id}`,
        title: video.title,
        channel: source.name,
        published: video.published,
        summary: summarize(video.description),
        about: source.about,
        // Olympic AI is the top priority, so it goes to 精选视频; everything else to 演讲 & Podcast.
        tab: olympicAi ? 'curated' : 'appearances',
        tags: olympicAi ? ['奥运 AI · 最高优先级', ...source.tags] : source.tags,
        found: new Date().toISOString().slice(0, 10)
      };
    });
};

// Length in minutes from the watch page; null when YouTube does not serve it (e.g. bot checks on CI runners).
const videoMinutes = async id => {
  try {
    const html = await fetchText(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' } });
    const seconds = Number(html.match(/"lengthSeconds":"(\d+)"/)?.[1]);
    return seconds ? Math.round(seconds / 60) : null;
  } catch { return null; }
};

// Publish date, length and description of one video, for videos added by hand.
const videoInfo = async row => {
  if (row.key.startsWith('youtube:')) {
    const id = row.key.slice('youtube:'.length);
    const html = await fetchText(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' } });
    const json = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var|<\/script>)/)?.[1];
    if (!json) throw new Error(`no player data for ${id}`);
    const player = JSON.parse(json);
    const details = player.videoDetails || {};
    const published = player.microformat?.playerMicroformatRenderer?.uploadDate?.slice(0, 10);
    if (!published) throw new Error(`no upload date for ${id}`);
    return { published, title: details.title, author: details.author, minutes: Math.round(Number(details.lengthSeconds || 0) / 60), summary: summarize(details.shortDescription || '') };
  }
  if (/vimeo\.com/.test(row.url)) {
    const data = JSON.parse(await fetchText(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(row.url)}`));
    if (!data.upload_date) throw new Error(`no upload date for ${row.url}`);
    return { published: data.upload_date.slice(0, 10), title: data.title, author: data.author_name, minutes: Math.round((data.duration || 0) / 60), summary: summarize(data.description || '') };
  }
  throw new Error(`unsupported ${row.url}`);
};

const outPath = process.argv[2];
if (!outPath) throw new Error('usage: node update-feed.mjs <auto-feed.json>');
let previous = { items: [], videos: {} };
try { previous = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* First run. */ }

const items = new Map((previous.items || []).map(item => [item.key, item]));
const report = [];
for (const source of SOURCES) {
  try {
    const found = await pollSource(source);
    let added = 0;
    for (const item of found) {
      if (added >= MAX_PER_SOURCE) break;
      if (items.has(item.key)) continue;
      item.minutes = await videoMinutes(item.key.slice('youtube:'.length));
      if (item.minutes !== null && item.minutes < MIN_MINUTES && item.tab !== 'curated') continue;
      items.set(item.key, item);
      added++;
    }
    report.push(`${source.name}: ${found.length} recent, ${added} new`);
  } catch (error) {
    report.push(`${source.name}: FAILED ${error.message}`);
  }
}

const videos = { ...(previous.videos || {}) };
try {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/added_videos?select=key,url`, { headers: { apikey: SUPABASE_ANON_KEY } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rows = await response.json();
  for (const row of rows) {
    if (videos[row.key]?.published) continue;
    try {
      videos[row.key] = await videoInfo(row);
      report.push(`added video ${row.key}: ${videos[row.key].published}`);
    } catch (error) {
      report.push(`added video ${row.key}: FAILED ${error.message}`);
    }
  }
} catch (error) {
  report.push(`added_videos: not read (${error.message})`);
}

const kept = [...items.values()]
  .sort((a, b) => b.published.localeCompare(a.published))
  .slice(0, MAX_ITEMS);
fs.writeFileSync(outPath, `${JSON.stringify({ updated: new Date().toISOString(), items: kept, videos }, null, 1)}\n`);
console.log(report.join('\n'));
console.log(`wrote ${kept.length} items, ${Object.keys(videos).length} video infos`);
