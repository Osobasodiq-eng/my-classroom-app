const db = require('./db');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONTEXT_CHARS = 40000; // ~10k tokens — keeps requests fast and cheap; see README for how to raise this
const MAX_MESSAGES = 8; // only the most recent turns are sent, so a long chat doesn't balloon token cost
const MAX_MESSAGE_CHARS = 2000;
const RATE_LIMIT_PER_HOUR = 30;

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

async function buildCourseContext(courseData) {
  const { course, materials } = courseData;
  const sections = [];

  if (course.outlineText && course.outlineText.trim()) {
    sections.push({ label: 'Course outline', text: course.outlineText.trim() });
  }
  if (course.outlineFileId) {
    const text = await db.getFileText(course.outlineFileId);
    if (text.trim()) sections.push({ label: 'Course outline document (' + (course.outlineFileName || 'file') + ')', text: text.trim() });
  }
  for (const m of materials) {
    let text = '';
    if (m.notes && m.notes.trim()) text += m.notes.trim() + '\n\n';
    if (m.fileId) {
      const fileText = await db.getFileText(m.fileId);
      if (fileText.trim()) text += fileText.trim();
    }
    if (text.trim()) sections.push({ label: 'Material: ' + m.title, text: text.trim() });
  }
  return sections;
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
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'The study assistant is not configured yet — ANTHROPIC_API_KEY is missing on the server.' });
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

    const sections = await buildCourseContext({ course, materials });
    if (sections.length === 0) {
      return res.json({
        reply: "There's nothing uploaded for " + course.name + " yet — no outline text or readable material files. Ask your Governor to add some, then try again.",
        sources: [],
      });
    }

    const included = packContext(sections, MAX_CONTEXT_CHARS);
    const contextBlock = included.map((s) => '### ' + s.label + '\n' + s.text).join('\n\n');

    const systemPrompt =
      'You are a study assistant for the course "' + course.name + '"' + (course.code ? ' (' + course.code + ')' : '') + '.\n' +
      'Answer ONLY using the course material excerpts below. Do not use outside knowledge, even if you know the answer — ' +
      "this is a strict rule. If the excerpts don't cover what's asked, say plainly that it isn't covered in the uploaded " +
      'materials for this course, and suggest the student ask their lecturer. Keep answers concise. When it helps, mention ' +
      'which material an answer came from (e.g. "According to the course outline..." or "Based on <material title>...").\n\n' +
      '--- COURSE MATERIALS ---\n' + contextBlock + '\n--- END COURSE MATERIALS ---';

    const trimmedMessages = messages
      .slice(-MAX_MESSAGES)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

    if (trimmedMessages.length === 0 || trimmedMessages[trimmedMessages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Ask a question to get a response.' });
    }

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: systemPrompt,
        messages: trimmedMessages,
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errBody);
      return res.status(502).json({ error: 'The study assistant had trouble answering — try again in a moment.' });
    }

    const json = await apiRes.json();
    const reply = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

    res.json({ reply: reply || "I couldn't come up with an answer — try rephrasing your question.", sources: included.map((s) => s.label) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reach the study assistant — try again.' });
  }
}

module.exports = { askAssistant };
