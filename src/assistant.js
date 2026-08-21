const db = require('./db');

const MODEL = 'openai/gpt-oss-120b'; // Groq's current recommended general-purpose model — see README if this needs updating
// Groq's free tier caps at 6,000 tokens/minute (TPM), shared across every
// request the whole app makes — far tighter than a typical LLM API's
// context window. This budget is kept small on purpose: ~9,000 characters
// is roughly 2,200 tokens, leaving room for the system prompt overhead,
// a few chat turns, and Groq's own output tokens without blowing the
// per-minute cap on a single request — important since with many
// students using this, several requests can land in the same minute and
// all draw from the same shared 6,000 TPM pool.
const MAX_CONTEXT_CHARS = 9000;
const MAX_MESSAGES = 6; // trimmed further than a larger-context provider would need, for the same TPM reason
const MAX_MESSAGE_CHARS = 1200;
const RATE_LIMIT_PER_HOUR = 30;
const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','of','to','in','on','for','and','or','with','what','does','do','did','how','why','tell','me','about','this','that','it','its','i','you','your','my','can','could','would','should','explain','describe','summarize','summarise']);

// In-memory only: resets on redeploy/restart, and wouldn't coordinate
// across multiple server instances. Both are fine at this app's scale —
// this exists to blunt runaway API cost from one identity hammering the
// endpoint, not to be a precise or durable limiter. It also does NOT
// protect against Groq's own shared rate limits being hit by many
// different students at once — see the README's note on scaling.
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
// common words. This matters even more now that the context budget is
// small — only a couple of materials fit per request, so picking the
// right ones is most of the job.
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
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'The study assistant is not configured yet — GROQ_API_KEY is missing on the server.' });
  }

  const { courseId, conversationId, question } = req.body || {};
  if (!courseId || typeof question !== 'string' || !question.trim()) {
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

    // A brand-new question with no conversationId starts a new thread;
    // one with a conversationId continues an existing saved conversation
    // (ownership is checked by getConversation — identity must match).
    let convId = conversationId;
    let savedMessages = [];
    if (convId) {
      const existing = await db.getConversation(identity, convId);
      if (!existing) return res.status(404).json({ error: 'That conversation was not found.' });
      savedMessages = existing.messages || [];
    } else {
      convId = await db.createConversation(identity, courseId);
    }

    const userMessage = { role: 'user', content: question.trim().slice(0, MAX_MESSAGE_CHARS) };
    const historyWithQuestion = [...savedMessages, userMessage];

    const { coreSections, materialSections } = await buildCourseContext({ course, materials });
    if (coreSections.length === 0 && materialSections.length === 0) {
      const reply = "There's nothing uploaded for " + course.name + " yet — no outline text or readable material files. Ask your Governor to add some, then try again.";
      const saved = await db.appendToConversation(identity, convId, [...historyWithQuestion, { role: 'assistant', content: reply, sources: [] }], question.trim());
      return res.json({ reply, sources: [], history: saved.messages, conversationId: convId, title: saved.title });
    }

    // Rank materials by relevance to the actual question asked, so with a
    // large reading list — or, on this provider, a small context budget —
    // the ones that matter to *this* question are what survives, not just
    // whichever were added first.
    const keywords = extractKeywords(question);
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
      'Format your answer with markdown where it helps readability — **bold** for key terms, bullet or numbered lists for ' +
      'multi-part answers, short paragraphs. Keep answers concise.\n\n' +
      '--- COURSE MATERIALS ---\n' + contextBlock + '\n--- END COURSE MATERIALS ---';

    const trimmedMessages = historyWithQuestion
      .slice(-MAX_MESSAGES)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

    // Groq is OpenAI-compatible: the system prompt is just the first
    // message in the array (role "system"), not a separate top-level
    // field the way Gemini and Anthropic both wanted it.
    const groqMessages = [{ role: 'system', content: systemPrompt }, ...trimmedMessages];

    const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: groqMessages,
        max_tokens: 800,
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error('Groq API error:', apiRes.status, errBody);
      if (apiRes.status === 429) {
        return res.status(429).json({ error: "Groq's free tier has a request or token limit that's been hit for the moment — wait about a minute and try again. This isn't this app's own rate limit, it's Groq's free quota, and it's shared across everyone using the assistant right now." });
      }
      if (apiRes.status === 404 || apiRes.status === 400) {
        return res.status(500).json({ error: "The AI model this app points at (" + MODEL + ") isn't reachable right now — Groq's model lineup changes often. Check https://console.groq.com/docs/models for a current model name and update the MODEL constant in src/assistant.js." });
      }
      return res.status(502).json({ error: 'The study assistant had trouble answering — try again in a moment.' });
    }

    const json = await apiRes.json();
    const reply = ((json.choices || [])[0] && json.choices[0].message && json.choices[0].message.content || '').trim() || "I couldn't come up with an answer — try rephrasing your question.";
    const sources = included.map((s) => s.label);

    const saved = await db.appendToConversation(identity, convId, [...historyWithQuestion, { role: 'assistant', content: reply, sources }], question.trim());
    res.json({ reply, sources, history: saved.messages, conversationId: convId, title: saved.title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reach the study assistant — try again.' });
  }
}

async function listConversations(req, res) {
  const { courseId } = req.query || {};
  if (!courseId) return res.status(400).json({ error: 'courseId is required.' });
  const identity = req.auth.role === 'governor' ? 'governor' : 'student:' + req.auth.studentId;
  try {
    const conversations = await db.listConversations(identity, courseId);
    res.json({ conversations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your saved conversations.' });
  }
}

async function getConversationHandler(req, res) {
  const identity = req.auth.role === 'governor' ? 'governor' : 'student:' + req.auth.studentId;
  try {
    const conversation = await db.getConversation(identity, req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ conversation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load that conversation.' });
  }
}

async function deleteConversationHandler(req, res) {
  const identity = req.auth.role === 'governor' ? 'governor' : 'student:' + req.auth.studentId;
  try {
    const removed = await db.deleteConversation(identity, req.params.id);
    res.json({ ok: true, removed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete that conversation.' });
  }
}

module.exports = { askAssistant, listConversations, getConversationHandler, deleteConversationHandler };
