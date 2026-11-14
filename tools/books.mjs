// 📚 我的书单 (阅读 tab): for each book the user types on the page, find a high-quality audiobook (完整朗读) and
// 15–60 minute explanations (讲解 / 精讲 / book summary) on Bilibili and YouTube, and write them to books.json on the
// auto-feed branch, where the page reads them. Run hourly by .github/workflows/books.yml:
//   node tools/books.mjs <path to books.json>
// The list is rows in Supabase added_videos whose key is "book:<书名>" (title = the name as typed).
// Quality: rules first (the title names the book, length, plays, no AI voices or 3-minute speed reads, known channels
// ranked up), then Gemini judges the best candidates (is it really about this book, and is it good) when
// GEMINI_API_KEY is set. Videos deleted with 🗑 on the page ("junk:<key>" rows in watched_items) are never suggested.
// Searched once per book; a book with nothing good is searched again after RETRY_DAYS, and found videos are checked
// every CHECK_DAYS so a removed upload gets replaced.
import fs from 'node:fs';

const SUPABASE_URL = 'https://dsqpkdksnsdiiaawikga.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_QVHY1GNIxibOtw0xuYszUg_LmBE6spD';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const MAX_AUDIO = 2;
const MAX_EXPLAIN = 3;
const EXPLAIN_MINUTES = [12, 60];
const AUDIO_MINUTES = 40;
const MIN_PLAYS = 3000;
const MIN_QUALITY = 7; // Gemini's 1–10.
const RETRY_DAYS = 14;
const CHECK_DAYS = 7;
const MAX_BOOKS_PER_RUN = 6; // An hourly run stays short; the rest wait for the next hour.

// Speed reads, AI voices, clips and reactions are not what "高质量" means here.
const LOW = /AI\s*配音|AI\s*朗读|AI\s*生成|AI\s*讲|机器朗读|切片|片段|速读|速览|[一二三四五1-5]\s*分钟|秒懂|秒读|shorts|#|reaction|react|meme|trailer|预告|广告|带货|课程试听|免费领|领取/i;
const AUDIO_WORD = /有声书|有声|朗读|全本|全书|完整版|全集|播讲|audiobook|unabridged|full book|read by/i;
// Channels known for careful book talks: ranked up, still judged like the rest.
const GOOD_CHANNELS = /帆书|樊登|得到|罗辑思维|罗振宇|薛兆丰|十点读书|有书|看理想|梁文道|一席|理想国|中信出版|读客|新经典|三联|人民文学|喜马拉雅|蜻蜓FM|凯叔|混知|Productivity Game|Better Than Yesterday|FightMediocrity|The Swedish Investor|Practical Psychology|Einzelgänger|Pursuit of Wonder|Escaping Ordinary|Ali Abdaal|Thomas Frank|Penguin|HarperAudio|Macmillan|Simon & Schuster|LibriVox/i;

const today = () => new Date().toISOString().slice(0, 10);
const daysSince = date => date ? (Date.now() - Date.parse(date)) / 864e5 : Infinity;
const decode = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const norm = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const hasCjk = text => /[一-鿿]/.test(text);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const getJson = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};
const isoMinutes = duration => {
  const [, h = 0, m = 0, s = 0] = (duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return Math.round(Number(h) * 60 + Number(m) + Number(s) / 60);
};
const clockMinutes = text => {
  const parts = String(text || '').split(':').map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return null;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) / 60);
};
// "《置身事内》" → "置身事内"; what a matching title has to contain.
export const bookName = text => String(text || '').replace(/[《》<>「」『』"“”]/g, '').trim();

let bilibiliCookie = null;
const bilibiliHeaders = async () => {
  if (bilibiliCookie == null) {
    const response = await fetch('https://www.bilibili.com/', { headers: { 'user-agent': UA } });
    bilibiliCookie = (response.headers.getSetCookie?.() || []).map(cookie => cookie.split(';')[0]).join('; ');
  }
  return { 'user-agent': UA, referer: 'https://search.bilibili.com/', cookie: bilibiliCookie };
};

const searchBilibili = async name => {
  const found = new Map();
  for (const keyword of [`${name} 有声书`, `${name} 精讲`, `${name} 解读`, `${name} 讲书`]) {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&order=totalrank&page=1`;
    const data = await getJson(url, { headers: await bilibiliHeaders() });
    if (data.code !== 0) throw new Error(`Bilibili code ${data.code} ${data.message || ''}`.trim());
    (data.data?.result || []).forEach(row => {
      if (!row.bvid || found.has(row.bvid)) return;
      found.set(row.bvid, {
        key: `bilibili:${row.bvid}`,
        url: `https://www.bilibili.com/video/${row.bvid}`,
        title: decode(row.title),
        text: decode(row.description).slice(0, 600),
        channel: row.author || '',
        published: row.pubdate ? new Date(row.pubdate * 1000).toISOString().slice(0, 10) : '',
        minutes: clockMinutes(row.duration),
        plays: row.play || 0,
        saves: row.favorites || 0
      });
    });
    await pause(800);
  }
  return [...found.values()];
};

const searchYouTube = async name => {
  if (!YOUTUBE_API_KEY) return [];
  const queries = hasCjk(name) ? [`${name} 有声书`, `${name} 解读 讲书`] : [`"${name}" audiobook`, `"${name}" book summary`];
  const ids = new Set();
  for (const query of queries) {
    const found = await getJson(`https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=25&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`);
    (found.items || []).forEach(item => item.id?.videoId && ids.add(item.id.videoId));
  }
  if (!ids.size) return [];
  const details = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${[...ids].slice(0, 50).join(',')}&key=${YOUTUBE_API_KEY}`);
  return (details.items || []).filter(video => video.snippet?.liveBroadcastContent === 'none').map(video => ({
    key: `youtube:${video.id}`,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    title: decode(video.snippet.title),
    text: (video.snippet.description || '').slice(0, 600),
    channel: video.snippet.channelTitle || '',
    published: (video.snippet.publishedAt || '').slice(0, 10),
    minutes: isoMinutes(video.contentDetails?.duration),
    plays: Number(video.statistics?.viewCount || 0),
    saves: Number(video.statistics?.likeCount || 0)
  }));
};

// Rules: names the book, long enough, watched enough, not a speed read or AI voice. Best first.
const candidates = (name, videos, junk) => {
  const wanted = norm(name);
  return videos
    .filter(video => !junk.has(video.key) && norm(video.title).includes(wanted) && !LOW.test(video.title))
    .filter(video => video.minutes != null && video.minutes >= EXPLAIN_MINUTES[0] && video.plays >= MIN_PLAYS)
    .map(video => {
      const ratio = video.plays ? Math.min(video.saves / video.plays, 0.1) * 10 : 0;
      const score = Math.log10(video.plays + 1) + ratio + (GOOD_CHANNELS.test(video.channel) ? 2 : 0) + (video.key.startsWith('bilibili:') ? 0.3 : 0);
      return { ...video, score: Math.round(score * 100) / 100, guess: AUDIO_WORD.test(video.title) && video.minutes >= AUDIO_MINUTES || video.minutes >= 120 ? 'audiobook' : 'explain' };
    })
    .sort((a, b) => b.score - a.score);
};

// Gemini: newest Flash (judging needs some care), Flash-Lite as a fallback.
let geminiModel = null;
const pickModel = async () => {
  if (geminiModel) return geminiModel;
  if (process.env.GEMINI_MODEL) return (geminiModel = process.env.GEMINI_MODEL);
  const list = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': GEMINI_API_KEY } });
  const names = list.models.filter(model => model.supportedGenerationMethods?.includes('generateContent')).map(model => model.name.replace(/^models\//, ''));
  const version = text => Number(text.match(/^gemini-([\d.]+)/)[1]);
  const newest = pattern => names.filter(text => pattern.test(text)).sort((a, b) => version(b) - version(a))[0];
  geminiModel = newest(/^gemini-[\d.]+-flash$/) || newest(/^gemini-[\d.]+-flash-lite$/);
  if (!geminiModel) throw new Error('no Gemini Flash model');
  return geminiModel;
};
const JUDGE = `你帮一位读者挑有声书和讲书视频。给你一本书的书名和若干候选视频（标题、频道、时长分钟、播放量、简介）。逐条判断：
- about：这个视频是不是真的在讲这本书（不是同名的电影、电视剧、歌曲、别的书，也不是只顺带提一句）。
- kind：audiobook = 这本书的完整朗读或分章朗读（真人播讲）；explain = 对这本书的讲解、精讲、解读、导读、书评、book summary；other = 都不是（课程广告、读书方法、清单类、闲聊、带货等）。
- quality：1 到 10。看频道是否专业可信、讲解是否认真有内容、是否像 AI 配音或营销号、标题党。8 以上 = 推荐给认真读书的人也不丢人；5 = 一般；AI 合成语音、机器朗读、拼凑、搬运剪辑、标题党给 3 以下。
- reason：一句中文（不超过 30 字），说为什么值得看或为什么不行，例如“帆书樊登的完整精讲，结构清楚”。
按输入顺序返回每条的 id。`;
const JUDGE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { id: { type: 'INTEGER' }, about: { type: 'BOOLEAN' }, kind: { type: 'STRING', enum: ['audiobook', 'explain', 'other'] }, quality: { type: 'INTEGER' }, reason: { type: 'STRING' } },
    required: ['id', 'about', 'kind', 'quality', 'reason']
  }
};
const judge = async (name, list) => {
  const model = await pickModel();
  const input = { book: name, videos: list.map((video, id) => ({ id, title: video.title, channel: video.channel, minutes: video.minutes, plays: video.plays, description: video.text })) };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: JUDGE }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: JUDGE_SCHEMA, temperature: 0.2 }
    })
  });
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status} ${(await response.text()).slice(0, 160)}`);
  const text = (await response.json()).candidates?.[0]?.content?.parts?.map(part => part.text).join('') || '[]';
  return JSON.parse(text);
};

const shown = video => ({ key: video.key, url: video.url, title: video.title, channel: video.channel, published: video.published, minutes: video.minutes, plays: video.plays, ...(video.reason ? { reason: video.reason } : {}), ...(video.quality ? { quality: video.quality } : {}) });

const searchBook = async (name, junk, report) => {
  const errors = [];
  const videos = [];
  for (const [label, search] of [['Bilibili', searchBilibili], ['YouTube', searchYouTube]]) {
    try { videos.push(...await search(name)); } catch (error) { errors.push(`${label}: ${error.message}`); }
  }
  if (!videos.length && errors.length) throw new Error(errors.join('; '));
  let pool = candidates(name, videos, junk).slice(0, 12);
  let judged = false;
  if (GEMINI_API_KEY && pool.length) {
    try {
      const verdicts = await judge(name, pool);
      pool = pool.map((video, id) => ({ video, verdict: verdicts.find(entry => entry.id === id) }))
        .filter(({ video, verdict }) => verdict?.about && verdict.quality >= MIN_QUALITY && verdict.kind !== 'other'
          && (verdict.kind === 'audiobook' ? video.minutes >= AUDIO_MINUTES : video.minutes <= EXPLAIN_MINUTES[1]))
        .map(({ video, verdict }) => ({ ...video, guess: verdict.kind, quality: verdict.quality, reason: verdict.reason }))
        .sort((a, b) => b.quality - a.quality || b.score - a.score);
      judged = true;
    } catch (error) {
      errors.push(`Gemini: ${error.message}`);
    }
  }
  if (!judged) {
    // Rules alone: stricter, so what shows is still worth it.
    pool = pool.filter(video => video.plays >= MIN_PLAYS * 3 && (video.guess === 'audiobook' || video.minutes <= EXPLAIN_MINUTES[1]));
  }
  const audio = pool.filter(video => video.guess === 'audiobook').slice(0, MAX_AUDIO).map(shown);
  const explain = pool.filter(video => video.guess === 'explain').slice(0, MAX_EXPLAIN).map(shown);
  report.push(`${name}: ${videos.length} found, ${audio.length} audiobook, ${explain.length} explain${judged ? ' (Gemini)' : ' (rules only)'}${errors.length ? ` — ${errors.join('; ')}` : ''}`);
  return { audio, explain, judged };
};

// A found video still there? (Uploads of whole audiobooks get taken down.)
const stillThere = async video => {
  try {
    if (video.key.startsWith('bilibili:')) {
      const data = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${video.key.slice('bilibili:'.length)}`, { headers: await bilibiliHeaders() });
      return data.code === 0;
    }
    if (!YOUTUBE_API_KEY) return true;
    const data = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${video.key.slice('youtube:'.length)}&key=${YOUTUBE_API_KEY}`);
    return (data.items || []).some(item => item.status?.privacyStatus !== 'private');
  } catch { return true; } // Can't tell: keep it.
};

const main = async () => {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('usage: node tools/books.mjs <books.json>');
  let previous = { books: {} };
  try { previous = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* First run. */ }
  const report = [];
  const headers = { apikey: SUPABASE_ANON_KEY };
  // BOOKS_TEST="书名|书名" tries the search on those books instead of the page's list (for a local run).
  const rows = process.env.BOOKS_TEST
    ? process.env.BOOKS_TEST.split('|').map(title => ({ key: `book:${title}`, title }))
    : await getJson(`${SUPABASE_URL}/rest/v1/added_videos?select=key,title,created_at&key=like.book:*`, { headers });
  let junk = new Set();
  try {
    junk = new Set((await getJson(`${SUPABASE_URL}/rest/v1/watched_items?select=key&key=like.junk:*`, { headers })).map(row => row.key.slice('junk:'.length)));
  } catch (error) { report.push(`deleted videos not read: ${error.message}`); }

  const books = {};
  let searchedThisRun = 0;
  for (const row of rows.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))) {
    const name = bookName(row.title || row.key.slice('book:'.length));
    const before = previous.books?.[row.key];
    const entry = before ? { ...before, title: name, audio: (before.audio || []).filter(video => !junk.has(video.key)), explain: (before.explain || []).filter(video => !junk.has(video.key)) } : { title: name, audio: [], explain: [] };
    if (before?.status === 'ok' && daysSince(before.checked) >= CHECK_DAYS) {
      for (const list of [entry.audio, entry.explain]) {
        for (const video of [...list]) if (!await stillThere(video)) list.splice(list.indexOf(video), 1);
      }
      entry.checked = today();
    }
    const lostSome = before && (entry.audio.length < (before.audio || []).length || entry.explain.length < (before.explain || []).length);
    const due = !before || before.status === 'failed' || before.status === 'none' && daysSince(before.searched) >= RETRY_DAYS || lostSome && !entry.audio.length && !entry.explain.length
      || before.status === 'ok' && !before.judged && GEMINI_API_KEY && daysSince(before.searched) >= 1;
    if (due && searchedThisRun < MAX_BOOKS_PER_RUN) {
      searchedThisRun++;
      try {
        const found = await searchBook(name, junk, report);
        Object.assign(entry, found, { status: found.audio.length || found.explain.length ? 'ok' : 'none', searched: today(), checked: today() });
        delete entry.error;
      } catch (error) {
        Object.assign(entry, { status: 'failed', error: error.message.slice(0, 200), searched: today() });
        report.push(`${name}: FAILED ${error.message}`);
      }
    } else if (!before) {
      entry.status = 'waiting';
    }
    books[row.key] = entry;
  }

  const content = { books };
  const same = JSON.stringify(content) === JSON.stringify({ books: previous.books || {} });
  report.push(`${rows.length} books, ${searchedThisRun} searched${same ? ', no change' : ''}`);
  console.log(report.join('\n'));
  if (!same) fs.writeFileSync(outPath, `${JSON.stringify({ updated: new Date().toISOString(), ...content }, null, 2)}\n`);
};

await main();
