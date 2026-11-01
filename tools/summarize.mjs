// Chinese two-line summary and "这意味着" for each news story, written by Gemini from the outlets' headlines.
// Needs GEMINI_API_KEY (Google AI Studio, free tier; a repository secret, passed in by daily-feed.yml). Stories that already have a summary are left alone, so
// after the first run only the day's new stories are sent.

const API = 'https://generativelanguage.googleapis.com/v1beta';
const BATCH = 10;
const PAUSE_MS = 7000; // Stays under the free tier's requests-per-minute limit.

const INSTRUCTIONS = `你是一位中文 AI 新闻编辑，为一位读者写简报。读者最关心：奥运 AI（最高优先级）、体育 AI、中国 AI、房产 AI、法律 AI，以及不能错过的通用 AI 大事。
每条新闻只给你几家媒体的标题（可能是英文或中文），没有正文。为每条写：
- summary：最多两句中文，说清是谁、做了什么、关键数字。只能使用标题里出现的事实；标题之间有出入时用保守的说法；不要补充标题里没有的数字、日期、人名或细节。
- meaning：一到两句中文，说明“这意味着什么”、为什么值得关注；尽量联系读者关心的方向。可以做判断，但不要编造新事实。
人名、公司名、产品名保留原文（可附常见中文名）。按输入顺序返回每条的 id。`;

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { id: { type: 'INTEGER' }, summary: { type: 'STRING' }, meaning: { type: 'STRING' } },
    required: ['id', 'summary', 'meaning']
  }
};

// The newest generally available Flash model the key can use (GEMINI_MODEL overrides).
const pickModel = async key => {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const response = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!response.ok) throw new Error(`model list HTTP ${response.status}`);
  const names = (await response.json()).models
    .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
    .map(model => model.name.replace(/^models\//, ''))
    .filter(name => /^gemini-[\d.]+-flash$/.test(name));
  const version = name => Number(name.match(/^gemini-([\d.]+)/)[1]);
  const best = names.sort((a, b) => version(b) - version(a))[0];
  if (!best) throw new Error('no Gemini Flash model available');
  return best;
};

const summarizeBatch = async (key, model, stories) => {
  const input = stories.map((story, id) => ({ id, headlines: story.headlines || [story.title], names: story.entities, themes: story.themes }));
  const response = await fetch(`${API}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.3 }
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const text = (await response.json()).candidates?.[0]?.content?.parts?.map(part => part.text).join('') || '[]';
  return JSON.parse(text);
};

export const summarizeNews = async (stories, report = []) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    report.push('news summaries: off (no GEMINI_API_KEY)');
    return;
  }
  const pending = stories.filter(story => !story.summary);
  if (!pending.length) return;
  let model;
  try {
    model = await pickModel(key);
  } catch (error) {
    report.push(`news summaries: FAILED ${error.message}`);
    return;
  }
  let done = 0;
  for (let start = 0; start < pending.length; start += BATCH) {
    const batch = pending.slice(start, start + BATCH);
    try {
      for (const { id, summary, meaning } of await summarizeBatch(key, model, batch)) {
        if (batch[id] && summary) Object.assign(batch[id], { summary: summary.trim(), meaning: (meaning || '').trim() });
      }
      done += batch.filter(story => story.summary).length;
    } catch (error) {
      report.push(`news summaries batch ${start / BATCH + 1}: FAILED ${error.message}`);
      // Out of quota for today: the rest wait for tomorrow's run.
      if (/HTTP 429/.test(error.message)) break;
    }
    if (start + BATCH < pending.length) await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
  }
  report.push(`news summaries (${model}): ${done} of ${pending.length} written`);
};
