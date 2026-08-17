const db = require('./db');

const MODEL = 'gemini-3.6-flash'; // current Stable-tier model per https://ai.google.dev/gemini-api/docs/models — see README if this needs updating again
// Gemini's free tier has a 1M-token context window and no per-token cost,
// so there's no reason to keep this small the way it would need to be on
// a paid, token-metered API — 150k characters is roughly 35-40k tokens,
// comfortably inside Gemini's per-minute token limit even with several
// materials attached, while still leaving room to raise it further if a
// course's reading list genuinely needs more.
const MAX_CONTEXT_CHARS = 150000;
const MAX_MESSAGES = 8; // only the most recent turns are sent, so a long chat doesn't balloon token cost
const MAX_MESSAGE_CHARS = 2000;
const RATE_LIMIT_PER_HOUR = 30;
const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','of','to','in','on','for','and','or','with','what','does','do','did','how','why','tell','me','about','this','that','it','its','i','you','your','my','can','could','would','should','explain','describe','summarize','summarise']);

// In-memory only: resets on redeploy/restart, and wouldn't coordinate
// across multiple server instances. Both are fine at this app's scale —
// this exists to blunt runaway API cost from one identity hammering the
// endpoint, not to be a precise or durable limiter.
const rateLimitLog = new Map();

function checkRateLimit(identity) {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const hits = (rateLimitLog.get(identity) || []).filter((t) => t > windowStart);
  if (hits.length >= RATE_LIMIT_PER_HOUR) {
    rateLimitLog.set(identity, hits);
    return false;
  }
  hits.push(now);
  rateLimitLog.set(identity, hits);
  return true;
}

function extractKeywords(question) {
  return (question.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Simple keyword-overlap scoring — not semantic search, just "how many of
// the question's distinct words show up in this material's title or
// text." A title match counts extra, since a material literally named
// after what's being asked about (e.g. asking about "Partnership Act"
// when a material is titled "Partnership Act, 1890") should win even if
// a longer, less relevant document happens to contain a few of the same
// common words.
function scoreRelevance(section, keywords) {
  if (keywords.length === 0) return 0;
  const labelLower = section.label.toLowerCase();
  const textLower = section.text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (labelLower.includes(kw)) score += 3;
    if (textLower.includes(kw)) score += 1;
  }
  return score;
}

async function buildCourseContext(courseData) {
  const { course, materials } = courseData;
  const coreSections = [];
  const materialSections = [];

  if (course.outlineText && course.outlineText.trim()) {
    coreSections.push({ label: 'Course outline', text: course.outlineText.trim() });
  }
  if (course.outlineFileId) {
    const text = await db.getFileText(course.outlineFileId);
    if (text.trim()) coreSections.push({ label: 'Course outline document (' + (course.outlineFileName || 'file') + ')', text: text.trim() });
  }
  for (const m of materials) {
    let text = '';
    if (m.notes && m.notes.trim()) text += m.notes.trim() + '\n\n';
    if (m.fileId) {
      const fileText = await db.getFileText(m.fileId);
      if (fileText.trim()) text += fileText.trim();
      else text += '[This material has an attached file, but no readable text could be extracted from it — it may be a scanned image, a slide deck, or an unsupported format. Its title and any notes above are all that\'s available.]\n';
    }
    if (m.link && m.link.trim()) {
      text += (text ? '\n' : '') + 'External link (content not directly readable): ' + m.link.trim() + '\n';
    }
    // Even a material with no readable text still gets a section — its
    // title alone lets the assistant tell a student "there's a reading
    // called X, but I can't read its contents, check the link" instead of
    // silently pretending the material doesn't exist at all.
    materialSections.push({ label: 'Material: ' + m.title + (m.type ? ' (' + m.type + ')' : ''), text: text.trim() || '[No readable content available for this material — only its title is known.]' });
  }
  return { coreSections, materialSections };
}

function packContext(sections, budget) {
  let used = 0;
  const included = [];
  for (const s of sections) {
    if (used >= budget) break;
    const remaining = budget - used;
    const text = s.text.length > remaining ? s.text.slice(0, remaining) + '\n[...truncated...]' : s.text;
    included.push({ label: s.label, text });
    used += text.length;
  }
  return included;
}

async function askAssistant(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'The study assistant is not configured yet — GEMINI_API_KEY is missing on the server.' });
  }

  const { courseId, messages } = req.body || {};
  if (!courseId || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Pick a course and ask a question.' });
  }

  const identity = req.auth.role === 'governor' ? 'governor' : 'student:' + req.auth.studentId;
  if (!checkRateLimit(identity)) {
    return res.status(429).json({ error: "You've asked a lot of questions this hour — try again a bit later." });
  }

  try {
    const { data } = await db.getState();
    const course = (data.courses || []).find((c) => c.id === courseId);
    if (!course) return res.status(404).json({ error: 'Course not found.' });
    const materials = (data.materials || []).filter((m) => m.courseId === courseId);

    const { coreSections, materialSections } = await buildCourseContext({ course, materials });
    if (coreSections.length === 0 && materialSections.length === 0) {
      return res.json({
        reply: "There's nothing uploaded for " + course.name + " yet — no outline text or readable material files. Ask your Governor to add some, then try again.",
        sources: [],
      });
    }

    // Rank materials by relevance to the actual question asked, so with a
    // large reading list the ones that matter to *this* question are what
    // survives the budget — not just whichever were added first.
    const latestQuestion = [...messages].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');
    const keywords = latestQuestion ? extractKeywords(latestQuestion.content) : [];
    const rankedMaterials = keywords.length
      ? [...materialSections].sort((a, b) => scoreRelevance(b, keywords) - scoreRelevance(a, keywords))
      : materialSections;

    const included = packContext([...coreSections, ...rankedMaterials], MAX_CONTEXT_CHARS);
    const contextBlock = included.map((s) => '### ' + s.label + '\n' + s.text).join('\n\n');

    const systemPrompt =
      'You are a study assistant for the course "' + course.name + '"' + (course.code ? ' (' + course.code + ')' : '') + '.\n' +
      'Prioritize the course material excerpts below — they reflect what this specific course actually covers, which may ' +
      'differ from general knowledge (different terminology, emphasis, or approach). When the excerpts answer the question, ' +
      'lead with that and say so (e.g. "According to the course outline..." or "Based on <material title>..."). If the ' +
      "excerpts don't cover what's asked, or only partly cover it, you may use your own general knowledge to fill the gap — " +
      'but clearly say when you\'re doing that (e.g. "This isn\'t covered in your course materials, but generally speaking...") ' +
      "so the student knows what came from their course versus general knowledge. Don't blend the two without flagging it. " +
      'Keep answers concise.\n\n' +
      '--- COURSE MATERIALS ---\n' + contextBlock + '\n--- END COURSE MATERIALS ---';

    const trimmedMessages = messages
      .slice(-MAX_MESSAGES)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

    if (trimmedMessages.length === 0 || trimmedMessages[trimmedMessages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Ask a question to get a response.' });
    }

    // Gemini uses "model" instead of "assistant" for the AI's turns, and
    // wraps every turn's text in a `parts` array rather than a plain string.
    const geminiContents = trimmedMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const apiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: geminiContents,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { maxOutputTokens: 800 },
        }),
      }
    );

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error('Gemini API error:', apiRes.status, errBody);
      if (apiRes.status === 429) {
        return res.status(429).json({ error: "Google's free tier has a request limit that's been hit for the moment — wait about a minute and try again. This isn't this app's own rate limit, it's Gemini's free quota." });
      }
      if (apiRes.status === 404) {
        return res.status(500).json({ error: "The AI model this app points at (" + MODEL + ") isn't reachable from this API key right now — Google's model lineup shifts every few weeks. Check https://ai.google.dev/gemini-api/docs/models for a current 'Stable' model name and update the MODEL constant in src/assistant.js." });
      }
      return res.status(502).json({ error: 'The study assistant had trouble answering — try again in a moment.' });
    }

    const json = await apiRes.json();
    const candidate = (json.candidates || [])[0];
    const reply = ((candidate && candidate.content && candidate.content.parts) || [])
      .map((p) => p.text || '')
      .join('\n')
      .trim();

    res.json({ reply: reply || "I couldn't come up with an answer — try rephrasing your question.", sources: included.map((s) => s.label) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reach the study assistant — try again.' });
  }
}

module.exports = { askAssistant };
