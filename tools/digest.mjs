// 今日重点: each day the top DAILY stories by score, so the 简报 tab has an end ("看完了") instead of 300 headlines.
// A story is picked at most once. One that missed the cut stays a candidate for a week, and gains score while new
// outlets keep picking it up, so a story that really matters comes back the next day. 本周大事 is the top WEEKLY
// of the last 7 days' picks.

// Odd: the lead, then the rest in two columns on iPad and computer, so no column ends a story short.
const DAILY = 9;
const WEEKLY = 5;
const CANDIDATE_DAYS = 7;
const KEEP_DIGESTS = 7; // Same week as the news itself (news.mjs MAX_AGE_DAYS).

// Reader priority (docs/reader-profile-v1.json): 奥运 AI first, then 体育, then 房产 / 法律.
const THEME_WEIGHT = { '奥运 AI': 4, '体育 AI': 3, '房产 AI': 2, '法律 AI': 2 };

// The job runs at 06:17 Beijing time, so days are Beijing days.
const beijingDate = (time = Date.now()) => new Date(time + 8 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);

export const scoreStory = (story, today) => {
  const theme = Math.max(0, ...(story.themes || []).map(name => THEME_WEIGHT[name] || 0));
  // Gemini's 1–10 from summarize.mjs; stories summarized before it existed count as average.
  const importance = story.importance ?? 5;
  const age = Math.max(0, daysBetween(story.published, today));
  const growing = story.lastSeen && daysBetween(story.lastSeen, today) <= 1 ? 2 : 0;
  return 3 * Math.log2(1 + story.outlets.length) + 1.5 * (story.entities || []).length + theme + 0.6 * importance + growing - 0.5 * age;
};

// Returns { digests, weekly } for auto-feed.json. stats is { scanned, events } from collectNews.
export const buildDigest = (news, previousDigests = [], stats = {}, report = []) => {
  const today = beijingDate();
  const digests = previousDigests.filter(digest => daysBetween(digest.date, today) < KEEP_DIGESTS);
  const picked = new Set(digests.flatMap(digest => digest.ids));
  const byId = new Map(news.map(story => [story.id, story]));
  const score = new Map(news.map(story => [story.id, scoreStory(story, today)]));

  const candidates = () => news
    .filter(story => !picked.has(story.id) && daysBetween(story.published, today) < CANDIDATE_DAYS)
    .sort((a, b) => score.get(b.id) - score.get(a.id))
    .map(story => story.id);
  // A rerun on the same day (a push to the workflow, a manual run) keeps the day's picks, so read marks still match;
  // it only tops them up to DAILY (a day picked when DAILY was smaller).
  let digest = digests.find(entry => entry.date === today);
  if (!digest) {
    digest = { date: today, ids: candidates().slice(0, DAILY), scanned: stats.scanned || 0, events: stats.events || 0 };
    digests.unshift(digest);
  } else if (digest.ids.length < DAILY) {
    digest.ids = [...digest.ids, ...candidates().slice(0, DAILY - digest.ids.length)];
  }
  const weekly = digests
    .filter(entry => daysBetween(entry.date, today) < 7)
    .flatMap(entry => entry.ids)
    .filter(id => byId.has(id))
    .sort((a, b) => score.get(b) - score.get(a))
    .slice(0, WEEKLY);
  report.push(`今日重点 ${today}: ${digest.ids.length} picked from ${digest.events} stories (${digest.scanned} headlines); 本周大事: ${weekly.length}`);
  return { digests, weekly };
};
